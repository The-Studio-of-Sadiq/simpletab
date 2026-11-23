import { hasPermission } from "@/permissions";
import type {
  Actor,
  ApplyResult,
  CanUndoResult,
  OpDef,
  OpLogEntry,
  OpRegistryLookup,
  OpRequest,
  RecordKey,
  TournamentState,
} from "./types";

function dedupeRecordKeys(keys: readonly RecordKey[]): RecordKey[] {
  const seen = new Set<RecordKey>();
  const out: RecordKey[] = [];
  for (const key of keys) {
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/**
 * Pure operation engine (design section 4):
 * 1. Unknown op check
 * 2. Actor and permission check (AI / proposalsOnly require aiAllowed)
 * 3. Expected-version check (skipped only for forced host-owner ops)
 * 4. Domain guard validation
 * 5. Pure apply + version bumps for written records + inverse generation
 */
export function applyOp<P = unknown>(
  state: TournamentState,
  request: OpRequest<P>,
  actor: Actor,
  registry: OpRegistryLookup,
): ApplyResult<P> {
  const rawOp = registry.get(request.type);
  if (!rawOp) {
    return {
      ok: false,
      code: "UNKNOWN_OP",
      errors: [`Unknown operation: ${request.type}`],
    };
  }
  const op = rawOp as unknown as OpDef<P>;

  if ((actor.type === "ai" || actor.role.proposalsOnly === true) && !op.aiAllowed) {
    return {
      ok: false,
      code: "FORBIDDEN",
      errors: ["proposal required"],
    };
  }

  const requiredPermission =
    typeof op.permission === "function"
      ? op.permission(state, request.payload, registry)
      : op.permission;

  if (requiredPermission === "service") {
    if (actor.type !== "service") {
      return {
        ok: false,
        code: "FORBIDDEN",
        errors: [`Operation ${op.type} requires a service actor.`],
      };
    }
  } else if (requiredPermission === "proposal") {
    // Proposals are how the AI acts (design section 6). People apply ops directly.
    if (actor.type !== "ai" && actor.role.proposalsOnly !== true) {
      return {
        ok: false,
        code: "FORBIDDEN",
        errors: [
          `Only AI or proposals-only roles create proposals; "${actor.role.name}" can apply ops directly.`,
        ],
      };
    }
  } else if (requiredPermission === null) {
    // Deny by default: an op whose permission cannot be resolved (for example, a proposal
    // that does not exist) is never allowed, whatever the actor's role.
    return {
      ok: false,
      code: "FORBIDDEN",
      errors: [`${op.type} is not permitted: its required permission could not be determined.`],
    };
  } else if (!hasPermission(actor.role, requiredPermission)) {
    return {
      ok: false,
      code: "FORBIDDEN",
      errors: [
        `Role "${actor.role.name}" does not have permission "${requiredPermission}" for ${op.type}.`,
      ],
    };
  }

  if (op.checkActor) {
    const actorError = op.checkActor(actor, state, request.payload);
    if (actorError !== null) {
      return {
        ok: false,
        code: "FORBIDDEN",
        errors: [actorError],
      };
    }
  }

  const skipVersionCheck = request.forced === true && actor.isHostOwner === true;
  if (!skipVersionCheck && request.expectedVersions !== undefined) {
    const current: Record<RecordKey, number> = {};
    const conflictErrors: string[] = [];
    for (const [rawKey, expected] of Object.entries(request.expectedVersions)) {
      if (expected === undefined) continue;
      const key = rawKey as RecordKey;
      const actual = state.versions[key] ?? 0;
      if (actual !== expected) {
        current[key] = actual;
        conflictErrors.push(
          `Version conflict on ${key}: expected ${expected}, current is ${actual}.`,
        );
      }
    }
    if (conflictErrors.length > 0) {
      return {
        ok: false,
        code: "VERSION_CONFLICT",
        errors: conflictErrors,
        current,
      };
    }
  }

  const validationErrors = op.validate(state, request.payload, registry);
  if (validationErrors.length > 0) {
    return {
      ok: false,
      code: "INVALID",
      errors: validationErrors,
    };
  }

  if (op.applyWithEngine) {
    return op.applyWithEngine(state, request.payload, actor, registry, applyOp);
  }

  const applied = op.apply(state, request.payload, actor, registry);
  const writes = dedupeRecordKeys(op.writes(state, applied.committedPayload));
  const nextVersions: Record<RecordKey, number> = { ...applied.state.versions };
  for (const key of writes) {
    nextVersions[key] = (nextVersions[key] ?? 0) + 1;
  }

  const nextState: TournamentState = {
    ...applied.state,
    versions: nextVersions,
  };
  const inverse = op.inverse(applied.committedPayload, state);

  return {
    ok: true,
    state: nextState,
    writes,
    committedPayload: applied.committedPayload,
    inverse,
  };
}

/**
 * Undo rule (design section 3): op `seq` can be undone only if no later op
 * wrote any record that op `seq` wrote (or already undid `seq`).
 */
export function canUndo(log: readonly OpLogEntry[], seq: number): CanUndoResult {
  const target = log.find((entry) => entry.seq === seq);
  if (!target) {
    return { ok: false, blockingSeqs: [] };
  }

  const targetWrites = new Set<RecordKey>(target.writes);
  const blockingSeqs = log
    .filter(
      (entry) =>
        entry.seq > seq &&
        (entry.inverseOf === seq ||
          entry.writes.some((key) => targetWrites.has(key))),
    )
    .map((entry) => entry.seq)
    .sort((left, right) => left - right);

  if (blockingSeqs.length > 0) {
    return { ok: false, blockingSeqs };
  }

  return { ok: true };
}
