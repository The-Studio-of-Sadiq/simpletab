import { createHash } from "node:crypto";
import {
  GENESIS_HASH,
  canonicalize,
  verifyChain,
  type ActorType,
  type ChangelogEntry,
  type PublicChainItem,
} from "@simpletab/core/changelog";
import {
  applyOp,
  defaultRegistry,
  type Actor,
  type OpRegistryLookup,
  type OpRequest,
  type RecordKey,
  type TournamentState,
} from "@simpletab/core/ops";
import { BUILT_IN_ROLES, PRESET_ROLES, type Role } from "@simpletab/core/permissions";
import type { SqliteDatabase } from "../db/database";
import { fromContentOnlyState, loadState, loadVersions } from "../state/load";
import { stateHash, stateHashFromState } from "../state/state-hash";
import {
  decodeSnapshot,
  readAllSnapshots,
  readLatestSnapshot,
  readSeedState,
  type StoredSnapshotRow,
} from "./snapshots";

export type IntegrityStage = "changelog" | "snapshot" | "replay" | "live_state";

export type IntegrityCheckResult =
  | { ok: true }
  | { ok: false; stage: IntegrityStage; seq?: number; reason: string };

export type IntegrityStateResult =
  | { ok: true; state: TournamentState | null }
  | { ok: false; stage: IntegrityStage; seq?: number; reason: string };

export interface IntegrityCheckOptions {
  registry?: OpRegistryLookup;
}

export interface StoredOpRowFull {
  seq: number;
  ts: string;
  actor_ref: string;
  actor_type: string;
  actor_role_id: string;
  actor_role: string | null;
  actor_is_host_owner: number;
  type: string;
  payload: string;
  request_payload: string | null;
  request_forced: number;
  writes: string;
  inverse: string | null;
  inverse_of: number | null;
  host_number: number;
}

interface StoredChangelogRow {
  seq: number;
  entry: string;
  salt: Buffer;
  entry_hash: string;
}

interface ParsedLogData {
  ops: StoredOpRowFull[];
  chainItems: PublicChainItem[];
  entriesBySeq: Map<number, ChangelogEntry>;
}

const ENTRY_DOMAIN_PREFIX = "simpletab-changelog-v2\n";

function fail(stage: IntegrityStage, reason: string, seq?: number): IntegrityCheckResult {
  return seq === undefined ? { ok: false, stage, reason } : { ok: false, stage, seq, reason };
}

function parseJsonSafe(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid JSON",
    };
  }
}

/** Reconstructs the `Actor` needed to replay a stored op row. */
export function resolveReplayActor(row: StoredOpRowFull, state: TournamentState): Actor {
  if (row.actor_role !== null) {
    const parsed = JSON.parse(row.actor_role) as Role;
    return {
      ref: row.actor_ref,
      type: row.actor_type as ActorType,
      role: parsed,
      isHostOwner: row.actor_is_host_owner === 1,
    };
  }
  const builtIn = (BUILT_IN_ROLES as Record<string, Role | undefined>)[row.actor_role_id];
  const preset = (PRESET_ROLES as Record<string, Role | undefined>)[row.actor_role_id];
  const custom = state.roles.find((role) => role.id === row.actor_role_id);
  const role: Role =
    builtIn ??
    preset ??
    (custom
      ? { id: custom.id, name: custom.name, permissions: custom.permissions }
      : BUILT_IN_ROLES.host_owner);
  return {
    ref: row.actor_ref,
    type: row.actor_type as ActorType,
    role,
    isHostOwner: row.actor_is_host_owner === 1 || role.id === "host_owner",
  };
}

/** Replays a single stored op row against `state` and asserts it reproduces the recorded outcome. */
export function replayOpRow(
  state: TournamentState,
  row: StoredOpRowFull,
  registry: OpRegistryLookup,
): { ok: true; state: TournamentState } | { ok: false; reason: string } {
  const parsedCommitted = parseJsonSafe(row.payload);
  if (!parsedCommitted.ok) {
    return { ok: false, reason: `Op ${row.seq} has invalid committed payload JSON: ${parsedCommitted.error}` };
  }
  const parsedRequestPayload =
    row.request_payload !== null ? parseJsonSafe(row.request_payload) : parsedCommitted;
  if (!parsedRequestPayload.ok) {
    return { ok: false, reason: `Op ${row.seq} has invalid request payload JSON: ${parsedRequestPayload.error}` };
  }
  const parsedWrites = parseJsonSafe(row.writes);
  if (!parsedWrites.ok || !Array.isArray(parsedWrites.value)) {
    return { ok: false, reason: `Op ${row.seq} has invalid writes JSON.` };
  }

  let actor: Actor;
  try {
    actor = resolveReplayActor(row, state);
  } catch (error) {
    return {
      ok: false,
      reason: `Op ${row.seq} has invalid actor metadata: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const request: OpRequest<unknown> = {
    type: row.type,
    payload: parsedRequestPayload.value,
    ...(row.request_forced === 1 ? { forced: true } : {}),
  };

  const committedObj =
    parsedCommitted.value !== null &&
    typeof parsedCommitted.value === "object" &&
    !Array.isArray(parsedCommitted.value)
      ? (parsedCommitted.value as Record<string, unknown>)
      : null;
  const committedBallot =
    committedObj !== null &&
    committedObj.ballot !== null &&
    typeof committedObj.ballot === "object" &&
    !Array.isArray(committedObj.ballot)
      ? (committedObj.ballot as Record<string, unknown>)
      : null;
  const needsPortalEnforcing =
    (row.type === "ballot.receive_online" && committedObj?.routedToLate === true) ||
    ((row.type === "ballot.enter" || row.type === "ballot.receive_online") &&
      committedBallot?.late === true);
  const replayState: TournamentState = needsPortalEnforcing
    ? { ...state, runtime: { portalEnforcing: true, now: row.ts } }
    : state;

  const result = applyOp(replayState, request, actor, registry);
  if (!result.ok) {
    return {
      ok: false,
      reason: `Replay of op ${row.seq} (${row.type}) failed with ${result.code}: ${result.errors.join("; ")}`,
    };
  }

  if (canonicalize(result.committedPayload) !== canonicalize(parsedCommitted.value)) {
    return {
      ok: false,
      reason: `Replay of op ${row.seq} (${row.type}) produced a different committed payload.`,
    };
  }
  if (canonicalize(result.writes) !== canonicalize(parsedWrites.value)) {
    return {
      ok: false,
      reason: `Replay of op ${row.seq} (${row.type}) produced different written record keys.`,
    };
  }

  const nextState: TournamentState = { ...result.state };
  delete nextState.runtime;
  return { ok: true, state: nextState };
}

function loadLogForVerification(
  database: SqliteDatabase,
): { ok: true; data: ParsedLogData } | { ok: false; failure: IntegrityCheckResult } {
  const changelogRows = database.prepare(
    "SELECT seq, entry, salt, entry_hash FROM changelog ORDER BY seq ASC",
  ).all() as StoredChangelogRow[];
  const opsRows = database.prepare(
    "SELECT seq, ts, actor_ref, actor_type, actor_role_id, actor_role, actor_is_host_owner, " +
    "type, payload, request_payload, request_forced, writes, inverse, inverse_of, host_number " +
    "FROM ops ORDER BY seq ASC",
  ).all() as StoredOpRowFull[];

  if (changelogRows.length !== opsRows.length) {
    return {
      ok: false,
      failure: fail(
        "changelog",
        `Changelog row count (${changelogRows.length}) does not match ops row count (${opsRows.length}).`,
      ),
    };
  }

  const chainItems: PublicChainItem[] = [];
  const entriesBySeq = new Map<number, ChangelogEntry>();

  for (let i = 0; i < changelogRows.length; i += 1) {
    const expectedSeq = i + 1;
    const clRow = changelogRows[i]!;
    const opRow = opsRows[i]!;

    if (clRow.seq !== expectedSeq || opRow.seq !== expectedSeq) {
      return {
        ok: false,
        failure: fail(
          "changelog",
          `Sequence gap or mismatch at seq ${expectedSeq} (changelog=${clRow.seq}, ops=${opRow.seq}).`,
          expectedSeq,
        ),
      };
    }

    const parsedEntry = parseJsonSafe(clRow.entry);
    if (!parsedEntry.ok || typeof parsedEntry.value !== "object" || parsedEntry.value === null) {
      return {
        ok: false,
        failure: fail("changelog", `Invalid changelog entry JSON at seq ${expectedSeq}.`, expectedSeq),
      };
    }
    const entry = parsedEntry.value as ChangelogEntry;

    if (
      opRow.type !== entry.opType ||
      opRow.ts !== entry.ts ||
      opRow.actor_ref !== entry.actorRef ||
      opRow.actor_type !== entry.actorType
    ) {
      return {
        ok: false,
        failure: fail(
          "changelog",
          `Op row metadata at seq ${expectedSeq} does not match its changelog entry.`,
          expectedSeq,
        ),
      };
    }

    const parsedPayload = parseJsonSafe(opRow.payload);
    if (!parsedPayload.ok) {
      return {
        ok: false,
        failure: fail(
          "changelog",
          `Op payload at seq ${expectedSeq} is not valid JSON: ${parsedPayload.error}`,
          expectedSeq,
        ),
      };
    }

    const saltBytes = Buffer.isBuffer(clRow.salt) ? clRow.salt : Buffer.from(clRow.salt);
    const saltB64Url = saltBytes.toString("base64url");
    chainItems.push({
      entry,
      entryHash: clRow.entry_hash,
      payload: parsedPayload.value,
      salt: saltB64Url,
    });
    entriesBySeq.set(expectedSeq, entry);
  }

  return { ok: true, data: { ops: opsRows, chainItems, entriesBySeq } };
}

/**
 * Synchronous equivalent of core's `verifyChain` using Node's `node:crypto`, used exclusively
 * by synchronous `HostEngine.open()` so `engine.integrity` is immediately populated.
 */
function verifyChainSync(items: readonly PublicChainItem[]): IntegrityCheckResult {
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < items.length; i += 1) {
    const expectedSeq = i + 1;
    const item = items[i]!;
    const { entry } = item;

    if (entry.v !== 2) {
      return fail("changelog", `Unsupported entry version: ${String(entry.v)}`, expectedSeq);
    }
    if (entry.seq !== expectedSeq) {
      return fail("changelog", `Expected seq ${expectedSeq}, got ${entry.seq}`, expectedSeq);
    }

    const hasPayload = item.payload !== undefined;
    const hasSalt = item.salt !== undefined;
    if (hasPayload !== hasSalt) {
      return fail(
        "changelog",
        hasPayload ? "Revealed payload is missing salt" : "Salt provided without payload",
        expectedSeq,
      );
    }
    if (hasPayload && hasSalt) {
      const saltStr = item.salt!;
      if (saltStr.length % 4 === 1 || !/^[A-Za-z0-9_-]*$/.test(saltStr)) {
        return fail("changelog", "Revealed payload does not match payloadCommit", expectedSeq);
      }
      const saltBytes = Buffer.from(saltStr, "base64url");
      try {
        const payloadBytes = Buffer.from(canonicalize(item.payload), "utf8");
        const commitDigest = createHash("sha256").update(saltBytes).update(payloadBytes).digest();
        const commit = commitDigest.toString("base64url");
        if (commit !== entry.payloadCommit) {
          return fail("changelog", "Revealed payload does not match payloadCommit", expectedSeq);
        }
      } catch {
        return fail("changelog", "Revealed payload does not match payloadCommit", expectedSeq);
      }
    }

    const preimage = `${ENTRY_DOMAIN_PREFIX}${prevHash}\n${canonicalize(entry)}`;
    const expectedEntryHash = createHash("sha256").update(preimage, "utf8").digest("hex");
    if (item.entryHash !== expectedEntryHash) {
      return fail("changelog", "entryHash mismatch", expectedSeq);
    }
    prevHash = item.entryHash;
  }
  return { ok: true };
}

function verifySnapshotAndTailReplay(
  database: SqliteDatabase,
  log: ParsedLogData,
  registry: OpRegistryLookup,
): IntegrityStateResult {
  const latestSnapshot = readLatestSnapshot(database);

  let state: TournamentState;
  let replayStartSeq: number;

  if (latestSnapshot !== null) {
    const entry = log.entriesBySeq.get(latestSnapshot.seq);
    if (entry === undefined || entry.stateHash === undefined) {
      return {
        ok: false,
        stage: "snapshot",
        seq: latestSnapshot.seq,
        reason: `Snapshot at seq ${latestSnapshot.seq} has no matching changelog stateHash.`,
      };
    }
    if (entry.stateHash !== latestSnapshot.state_hash) {
      return {
        ok: false,
        stage: "snapshot",
        seq: latestSnapshot.seq,
        reason: `Snapshot state_hash at seq ${latestSnapshot.seq} does not match changelog entry stateHash.`,
      };
    }

    let decoded;
    try {
      decoded = decodeSnapshot(latestSnapshot.data);
    } catch (error) {
      return {
        ok: false,
        stage: "snapshot",
        seq: latestSnapshot.seq,
        reason: `Failed to decode snapshot at seq ${latestSnapshot.seq}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    const computedSnapshotHash = stateHashFromState(decoded);
    if (computedSnapshotHash !== latestSnapshot.state_hash) {
      return {
        ok: false,
        stage: "snapshot",
        seq: latestSnapshot.seq,
        reason: `Snapshot content hash at seq ${latestSnapshot.seq} does not match recorded state_hash.`,
      };
    }

    state = fromContentOnlyState(decoded);
    replayStartSeq = latestSnapshot.seq;
  } else {
    // No snapshot row exists; verify no changelog entry claims one.
    for (const [seq, entry] of log.entriesBySeq.entries()) {
      if (entry.stateHash !== undefined) {
        return {
          ok: false,
          stage: "snapshot",
          seq,
          reason: `Changelog entry at seq ${seq} records a stateHash but no snapshot row exists.`,
        };
      }
    }

    let seedState: TournamentState | null;
    try {
      seedState = readSeedState(database);
    } catch (error) {
      return {
        ok: false,
        stage: "snapshot",
        seq: 0,
        reason: `Failed to decode initial seed state: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    if (seedState === null) {
      // Uninitialized DB or imported handover without snapshots/seed_state.
      const loaded = loadState(database);
      return { ok: true, state: loaded };
    }

    state = seedState;
    replayStartSeq = 0;
  }

  for (const opRow of log.ops) {
    if (opRow.seq <= replayStartSeq) {
      continue;
    }
    const step = replayOpRow(state, opRow, registry);
    if (!step.ok) {
      return { ok: false, stage: "replay", seq: opRow.seq, reason: step.reason };
    }
    state = step.state;
  }

  let liveHash: string;
  try {
    liveHash = stateHash(database);
  } catch (error) {
    return {
      ok: false,
      stage: "live_state",
      reason: `Failed to hash live tables: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const expectedHash = stateHashFromState(state);
  if (liveHash !== expectedHash) {
    return {
      ok: false,
      stage: "live_state",
      reason: `Live tables state hash (${liveHash}) does not match replayed state hash (${expectedHash}).`,
    };
  }

  const liveVersions = loadVersions(database);
  return {
    ok: true,
    state: {
      ...state,
      versions: liveVersions,
    },
  };
}

/**
 * Synchronous fast startup check used inside `HostEngine.open()`.
 * Verifies the changelog chain, latest snapshot, tail replay, and live state hash,
 * and returns the reconstructed `TournamentState` on success.
 */
export function fastCheckWithStateSync(
  database: SqliteDatabase,
  options: IntegrityCheckOptions = {},
): IntegrityStateResult {
  const registry = options.registry ?? defaultRegistry();
  const loaded = loadLogForVerification(database);
  if (!loaded.ok) {
    return loaded.failure as Extract<IntegrityStateResult, { ok: false }>;
  }

  const chainCheck = verifyChainSync(loaded.data.chainItems);
  if (!chainCheck.ok) {
    return chainCheck;
  }

  return verifySnapshotAndTailReplay(database, loaded.data, registry);
}

/**
 * Fast startup integrity check (design section 3):
 * 1. Verifies the changelog chain via core's `verifyChain`.
 * 2. Verifies the latest snapshot's hash against its changelog entry and decoded content.
 * 3. Replays ops after the latest snapshot through core's `applyOp`.
 * 4. Compares the resulting state hash against the live SQLite tables.
 */
export async function fastCheck(
  database: SqliteDatabase,
  options: IntegrityCheckOptions = {},
): Promise<IntegrityCheckResult> {
  const registry = options.registry ?? defaultRegistry();
  const loaded = loadLogForVerification(database);
  if (!loaded.ok) {
    return loaded.failure;
  }

  const chainResult = await verifyChain(loaded.data.chainItems);
  if (!chainResult.ok) {
    return fail("changelog", chainResult.reason, chainResult.seq);
  }

  const replayResult = verifySnapshotAndTailReplay(database, loaded.data, registry);
  return replayResult.ok ? { ok: true } : replayResult;
}

/**
 * Full background integrity check (design section 3):
 * 1. Verifies the changelog chain via core's `verifyChain`.
 * 2. Replays every op from seq 1 starting from the initial seed state.
 * 3. Verifies EVERY snapshot along the way against both its changelog entry and the replayed state.
 * 4. Compares the final replayed state hash against the live SQLite tables.
 */
export async function fullCheck(
  database: SqliteDatabase,
  options: IntegrityCheckOptions = {},
): Promise<IntegrityCheckResult> {
  const registry = options.registry ?? defaultRegistry();
  const loaded = loadLogForVerification(database);
  if (!loaded.ok) {
    return loaded.failure;
  }

  const chainResult = await verifyChain(loaded.data.chainItems);
  if (!chainResult.ok) {
    return fail("changelog", chainResult.reason, chainResult.seq);
  }

  const snapshots = readAllSnapshots(database);
  const snapshotsBySeq = new Map<number, StoredSnapshotRow>();
  for (const snapshot of snapshots) {
    snapshotsBySeq.set(snapshot.seq, snapshot);
    const entry = loaded.data.entriesBySeq.get(snapshot.seq);
    if (entry === undefined || entry.stateHash === undefined) {
      return fail(
        "snapshot",
        `Snapshot at seq ${snapshot.seq} has no matching changelog stateHash.`,
        snapshot.seq,
      );
    }
    if (entry.stateHash !== snapshot.state_hash) {
      return fail(
        "snapshot",
        `Snapshot state_hash at seq ${snapshot.seq} does not match changelog entry stateHash.`,
        snapshot.seq,
      );
    }
  }

  for (const [seq, entry] of loaded.data.entriesBySeq.entries()) {
    if (entry.stateHash !== undefined && !snapshotsBySeq.has(seq)) {
      return fail(
        "snapshot",
        `Changelog entry at seq ${seq} records a stateHash but no snapshot row exists.`,
        seq,
      );
    }
  }

  let seedState: TournamentState | null;
  try {
    seedState = readSeedState(database);
  } catch (error) {
    return fail(
      "snapshot",
      `Failed to decode initial seed state: ${error instanceof Error ? error.message : String(error)}`,
      0,
    );
  }

  if (seedState === null) {
    if (loaded.data.ops.length === 0) {
      return { ok: true };
    }
    return fail("replay", "Initial seed state is missing; cannot replay from op 1.", 0);
  }

  let state = seedState;
  for (const opRow of loaded.data.ops) {
    const step = replayOpRow(state, opRow, registry);
    if (!step.ok) {
      return fail("replay", step.reason, opRow.seq);
    }
    state = step.state;

    const snapshot = snapshotsBySeq.get(opRow.seq);
    if (snapshot !== undefined) {
      let decoded;
      try {
        decoded = decodeSnapshot(snapshot.data);
      } catch (error) {
        return fail(
          "snapshot",
          `Failed to decode snapshot at seq ${opRow.seq}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          opRow.seq,
        );
      }
      const decodedHash = stateHashFromState(decoded);
      if (decodedHash !== snapshot.state_hash) {
        return fail(
          "snapshot",
          `Snapshot content hash at seq ${opRow.seq} does not match recorded state_hash.`,
          opRow.seq,
        );
      }
      const replayedHash = stateHashFromState(state);
      if (replayedHash !== snapshot.state_hash) {
        return fail(
          "snapshot",
          `Replayed state hash at seq ${opRow.seq} does not match snapshot state_hash.`,
          opRow.seq,
        );
      }
    }
  }

  let liveHash: string;
  try {
    liveHash = stateHash(database);
  } catch (error) {
    return fail(
      "live_state",
      `Failed to hash live tables: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const finalReplayedHash = stateHashFromState(state);
  if (liveHash !== finalReplayedHash) {
    return fail(
      "live_state",
      `Live tables state hash (${liveHash}) does not match full replayed state hash (${finalReplayedHash}).`,
    );
  }

  return { ok: true };
}
