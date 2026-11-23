import type { ActorType } from "@/changelog";
import {
  cloneValue,
  dedupeKeys,
  eraseOpType,
  isNonEmptyText,
  isValidIsoInstant,
} from "./setup/helpers";
import {
  recordKey,
  type Actor,
  type ApplyResult,
  type OpDef,
  type OpPermissionResolution,
  type OpRegistryLookup,
  type OpRequest,
  type OpRunner,
  type ProposalRecord,
  type RecordKey,
  type TournamentState,
} from "./types";

export interface ProposalCreatePayload {
  id: string;
  op: OpRequest<unknown>;
  createdAt?: string;
}

export interface ProposalAcceptPayload {
  proposalId: string;
  op?: OpRequest<unknown>;
  proposedBy?: Actor & { actorType: ActorType };
  acceptedBy?: string;
  appliedPayload?: unknown;
  appliedWrites?: RecordKey[];
}

export interface ProposalRejectPayload {
  proposalId: string;
  reason?: string;
  restorePending?: boolean;
  previous?: ProposalRecord;
}

function isOpRequestShape(value: unknown): value is OpRequest<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    isNonEmptyText((value as Record<string, unknown>).type) &&
    "payload" in value
  );
}

function resolveProposedOpPermission(
  state: TournamentState,
  proposalId: string,
  registry: OpRegistryLookup | undefined,
): OpPermissionResolution {
  const proposal = state.proposals.find((item) => item.id === proposalId);
  if (!proposal || !registry) {
    return null;
  }
  const inner = registry.get(proposal.op.type);
  if (!inner) {
    return null;
  }
  return typeof inner.permission === "function"
    ? inner.permission(state, proposal.op.payload, registry)
    : inner.permission;
}

export const proposalCreateOp: OpDef<ProposalCreatePayload> = {
  type: "proposal.create",
  permission: "proposal",
  category: "proposals",
  visibility: "private",
  lock: false,
  aiAllowed: true,
  reads(_state, payload) {
    return [recordKey("proposal", payload.id)];
  },
  writes(_state, payload) {
    return [recordKey("proposal", payload.id)];
  },
  validate(state, payload, registry) {
    const errors: string[] = [];
    if (!isNonEmptyText(payload.id)) {
      errors.push("Proposal id must not be empty.");
    } else if (state.proposals.some((item) => item.id === payload.id)) {
      errors.push(`Proposal ${payload.id} already exists.`);
    }
    if (!isOpRequestShape(payload.op)) {
      errors.push("Proposal op must include a non-empty type and payload.");
      return errors;
    }
    if (payload.op.type.startsWith("proposal.")) {
      errors.push("Cannot propose a proposal operation.");
    }
    if (registry && !registry.get(payload.op.type)) {
      errors.push(`Unknown proposed operation: ${payload.op.type}.`);
    }
    if (
      payload.createdAt !== undefined &&
      !isValidIsoInstant(payload.createdAt)
    ) {
      errors.push("createdAt must be a valid ISO 8601 instant.");
    }
    return errors;
  },
  apply(state, payload, actor) {
    const createdAt =
      payload.createdAt ?? state.runtime?.now ?? state.tournament.updatedAt;
    const record: ProposalRecord = {
      id: payload.id,
      op: cloneValue(payload.op),
      proposedBy: cloneValue(
        actor ?? {
          ref: "ai",
          type: "ai",
          role: { id: "ai", name: "AI", permissions: [], proposalsOnly: true },
          isHostOwner: false,
        },
      ),
      createdAt,
      status: "pending",
    };

    return {
      state: {
        ...state,
        proposals: [...state.proposals, record],
      },
      committedPayload: {
        ...cloneValue(payload),
        createdAt,
      },
    };
  },
  inverse() {
    return null;
  },
};

export const proposalAcceptOp: OpDef<ProposalAcceptPayload> = {
  type: "proposal.accept",
  permission(state, payload, registry) {
    return resolveProposedOpPermission(state, payload.proposalId, registry);
  },
  category: "proposals",
  visibility: "private",
  lock: false,
  aiAllowed: false,
  reads(state, payload) {
    return [
      recordKey("proposal", payload.proposalId),
      recordKey("tournament", state.tournament.id),
    ];
  },
  writes(state, payload) {
    return dedupeKeys([
      recordKey("proposal", payload.proposalId),
      ...(payload.appliedWrites ?? [recordKey("tournament", state.tournament.id)]),
    ]);
  },
  validate(state, payload, registry) {
    if (!isNonEmptyText(payload.proposalId)) {
      return ["proposalId must not be empty."];
    }
    const proposal = state.proposals.find(
      (item) => item.id === payload.proposalId,
    );
    if (!proposal) {
      return [`Proposal ${payload.proposalId} does not exist.`];
    }
    if (proposal.status !== "pending") {
      return [`Proposal ${payload.proposalId} is already ${proposal.status}.`];
    }
    if (proposal.op.type.startsWith("proposal.")) {
      return ["Cannot accept a nested proposal operation."];
    }
    if (registry && !registry.get(proposal.op.type)) {
      return [`Unknown proposed operation: ${proposal.op.type}.`];
    }
    return [];
  },
  apply(state, payload) {
    return {
      state,
      committedPayload: cloneValue(payload),
    };
  },
  applyWithEngine(
    state: TournamentState,
    payload: ProposalAcceptPayload,
    actor: Actor,
    registry: OpRegistryLookup,
    runOp: OpRunner,
  ): ApplyResult<ProposalAcceptPayload> {
    const proposal = state.proposals.find(
      (item) => item.id === payload.proposalId,
    )!;
    const innerResult = runOp(state, proposal.op, actor, registry);
    if (!innerResult.ok) {
      return innerResult;
    }

    const resolvedAt = state.runtime?.now ?? state.tournament.updatedAt;
    const updatedProposal: ProposalRecord = {
      ...cloneValue(proposal),
      status: "accepted",
      resolvedBy: actor.ref,
      resolvedAt,
    };
    const nextProposals = innerResult.state.proposals.map((item) =>
      item.id === updatedProposal.id ? updatedProposal : item,
    );
    const proposalKey = recordKey("proposal", updatedProposal.id);
    const nextVersions: Record<RecordKey, number> = {
      ...innerResult.state.versions,
      [proposalKey]: (innerResult.state.versions[proposalKey] ?? 0) + 1,
    };

    const nextState: TournamentState = {
      ...innerResult.state,
      proposals: nextProposals,
      versions: nextVersions,
    };
    const writes = dedupeKeys([proposalKey, ...innerResult.writes]);

    return {
      ok: true,
      state: nextState,
      writes,
      committedPayload: {
        ...cloneValue(payload),
        op: cloneValue(proposal.op),
        proposedBy: {
          ...cloneValue(proposal.proposedBy),
          type: "ai",
          actorType: "ai",
        },
        acceptedBy: actor.ref,
        appliedPayload: cloneValue(innerResult.committedPayload),
        appliedWrites: [...innerResult.writes],
      },
      inverse: innerResult.inverse,
    };
  },
  inverse() {
    return null;
  },
};

export const proposalRejectOp: OpDef<ProposalRejectPayload> = {
  type: "proposal.reject",
  permission(state, payload, registry) {
    return resolveProposedOpPermission(state, payload.proposalId, registry);
  },
  category: "proposals",
  visibility: "private",
  lock: false,
  aiAllowed: false,
  reads(_state, payload) {
    return [recordKey("proposal", payload.proposalId)];
  },
  writes(_state, payload) {
    return [recordKey("proposal", payload.proposalId)];
  },
  validate(state, payload) {
    if (!isNonEmptyText(payload.proposalId)) {
      return ["proposalId must not be empty."];
    }
    const proposal = state.proposals.find(
      (item) => item.id === payload.proposalId,
    );
    if (!proposal) {
      return [`Proposal ${payload.proposalId} does not exist.`];
    }
    if (payload.restorePending) {
      if (proposal.status !== "rejected") {
        return [
          `Proposal ${payload.proposalId} is ${proposal.status}, cannot restore to pending.`,
        ];
      }
      return [];
    }
    if (proposal.status !== "pending") {
      return [`Proposal ${payload.proposalId} is already ${proposal.status}.`];
    }
    return [];
  },
  apply(state, payload, actor) {
    const existing = state.proposals.find(
      (item) => item.id === payload.proposalId,
    )!;
    const previous = cloneValue(existing);
    const updated = cloneValue(existing);

    if (payload.restorePending) {
      updated.status = "pending";
      delete updated.resolvedBy;
      delete updated.resolvedAt;
      delete updated.reason;
    } else {
      updated.status = "rejected";
      updated.resolvedBy = actor?.ref ?? "tabroom";
      updated.resolvedAt = state.runtime?.now ?? state.tournament.updatedAt;
      if (payload.reason !== undefined) {
        updated.reason = payload.reason;
      }
    }

    return {
      state: {
        ...state,
        proposals: state.proposals.map((item) =>
          item.id === updated.id ? updated : item,
        ),
      },
      committedPayload: {
        ...cloneValue(payload),
        previous,
      },
    };
  },
  inverse(committedPayload) {
    if (committedPayload.restorePending || !committedPayload.previous) {
      return null;
    }
    return {
      type: "proposal.reject",
      payload: {
        proposalId: committedPayload.proposalId,
        restorePending: true,
      },
    };
  },
};

export const PROPOSAL_OPS: readonly OpDef<unknown>[] = [
  eraseOpType(proposalCreateOp),
  eraseOpType(proposalAcceptOp),
  eraseOpType(proposalRejectOp),
];
