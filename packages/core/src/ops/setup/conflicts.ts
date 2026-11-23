import { applyConflictSelection } from "@/lib/adjudicators/conflicts";
import type { Adjudicator, AdjudicatorConflict } from "@/types";
import { recordKey, type OpDef } from "../types";
import { cloneValue, dedupeKeys, isNonEmptyText } from "./helpers";

export interface ConflictUpdateAdjudicatorPayload {
  adjudicatorId: string;
  teamIds: string[];
  adjudicatorIds: string[];
  institutionIds: string[];
  previousConflicts?: Record<string, AdjudicatorConflict[]>;
  restoreConflicts?: Record<string, AdjudicatorConflict[]>;
}

export interface ConflictSetTeamInstitutionsPayload {
  teamId: string;
  institutionIds: string[];
  clearWhenEmpty?: boolean;
  previous?: string[] | null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export const conflictUpdateAdjudicatorOp: OpDef<ConflictUpdateAdjudicatorPayload> = {
  type: "conflict.update_adjudicator",
  permission: "conflicts.edit",
  category: "conflicts",
  visibility: "private",
  lock: false,
  reads(state, payload) {
    return dedupeKeys([
      recordKey("adjudicator", payload.adjudicatorId),
      ...state.adjudicators.map((adj) => recordKey("adjudicator", adj.id)),
    ]);
  },
  writes(state, payload) {
    if (payload.previousConflicts) {
      return Object.keys(payload.previousConflicts).map((id) =>
        recordKey("adjudicator", id),
      );
    }
    if (payload.restoreConflicts) {
      return Object.keys(payload.restoreConflicts).map((id) =>
        recordKey("adjudicator", id),
      );
    }
    const existing = state.adjudicators.find(
      (item) => item.id === payload.adjudicatorId,
    );
    if (!existing) {
      return [recordKey("adjudicator", payload.adjudicatorId)];
    }
    const changed = applyConflictSelection(
      existing,
      {
        teamIds: payload.teamIds,
        adjudicatorIds: payload.adjudicatorIds,
        institutionIds: payload.institutionIds,
      },
      state.adjudicators,
    );
    return changed.map((adj) => recordKey("adjudicator", adj.id));
  },
  validate(state, payload) {
    const errors: string[] = [];
    if (!isNonEmptyText(payload.adjudicatorId)) {
      errors.push("adjudicatorId must not be empty.");
    } else if (!state.adjudicators.some((item) => item.id === payload.adjudicatorId)) {
      errors.push(`Adjudicator ${payload.adjudicatorId} does not exist.`);
    }
    if (!isStringArray(payload.teamIds)) {
      errors.push("teamIds must be a list of strings.");
    }
    if (!isStringArray(payload.adjudicatorIds)) {
      errors.push("adjudicatorIds must be a list of strings.");
    }
    if (!isStringArray(payload.institutionIds)) {
      errors.push("institutionIds must be a list of strings.");
    }
    if (payload.restoreConflicts) {
      for (const id of Object.keys(payload.restoreConflicts)) {
        if (!state.adjudicators.some((item) => item.id === id)) {
          errors.push(`Adjudicator ${id} in restoreConflicts does not exist.`);
        }
      }
    }
    return errors;
  },
  apply(state, payload) {
    const previousConflicts: Record<string, AdjudicatorConflict[]> = {};
    const updates = new Map<string, Adjudicator>();

    if (payload.restoreConflicts) {
      for (const [id, conflicts] of Object.entries(payload.restoreConflicts)) {
        const existing = state.adjudicators.find((item) => item.id === id)!;
        previousConflicts[id] = cloneValue(existing.conflicts);
        updates.set(id, {
          ...cloneValue(existing),
          conflicts: cloneValue(conflicts),
        });
      }
    } else {
      const existing = state.adjudicators.find(
        (item) => item.id === payload.adjudicatorId,
      )!;
      const changed = applyConflictSelection(
        cloneValue(existing),
        {
          teamIds: [...payload.teamIds],
          adjudicatorIds: [...payload.adjudicatorIds],
          institutionIds: [...payload.institutionIds],
        },
        cloneValue(state.adjudicators),
      );
      for (const nextAdj of changed) {
        const prevAdj = state.adjudicators.find((item) => item.id === nextAdj.id)!;
        previousConflicts[nextAdj.id] = cloneValue(prevAdj.conflicts);
        updates.set(nextAdj.id, nextAdj);
      }
    }

    return {
      state: {
        ...state,
        adjudicators: state.adjudicators.map(
          (item) => updates.get(item.id) ?? item,
        ),
      },
      committedPayload: {
        ...cloneValue(payload),
        previousConflicts,
      },
    };
  },
  inverse(committedPayload) {
    if (!committedPayload.previousConflicts) {
      return null;
    }
    return {
      type: "conflict.update_adjudicator",
      payload: {
        adjudicatorId: committedPayload.adjudicatorId,
        teamIds: [],
        adjudicatorIds: [],
        institutionIds: [],
        restoreConflicts: cloneValue(committedPayload.previousConflicts),
      },
    };
  },
};

export const conflictSetTeamInstitutionsOp: OpDef<ConflictSetTeamInstitutionsPayload> = {
  type: "conflict.set_team_institutions",
  permission: "conflicts.edit",
  category: "conflicts",
  visibility: "private",
  lock: false,
  reads(_state, payload) {
    return [recordKey("team", payload.teamId)];
  },
  writes(_state, payload) {
    return [recordKey("team", payload.teamId)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    if (!isNonEmptyText(payload.teamId)) {
      errors.push("teamId must not be empty.");
    } else if (!state.teams.some((item) => item.id === payload.teamId)) {
      errors.push(`Team ${payload.teamId} does not exist.`);
    }
    if (
      !Array.isArray(payload.institutionIds) ||
      !payload.institutionIds.every((id) => isNonEmptyText(id))
    ) {
      errors.push("institutionIds must be a list of non-empty institution ids.");
    }
    return errors;
  },
  apply(state, payload) {
    const existing = state.teams.find((item) => item.id === payload.teamId)!;
    const previous = existing.institutionConflictIds
      ? [...existing.institutionConflictIds]
      : null;
    const deduped = [...new Set(payload.institutionIds)];
    const updated = cloneValue(existing);
    if (payload.clearWhenEmpty && deduped.length === 0) {
      delete updated.institutionConflictIds;
    } else {
      updated.institutionConflictIds = deduped;
    }

    return {
      state: {
        ...state,
        teams: state.teams.map((item) =>
          item.id === updated.id ? updated : item,
        ),
      },
      committedPayload: {
        ...cloneValue(payload),
        institutionIds: deduped,
        previous,
      },
    };
  },
  inverse(committedPayload) {
    if (committedPayload.previous === undefined) {
      return null;
    }
    if (committedPayload.previous === null) {
      return {
        type: "conflict.set_team_institutions",
        payload: {
          teamId: committedPayload.teamId,
          institutionIds: [],
          clearWhenEmpty: true,
        },
      };
    }
    return {
      type: "conflict.set_team_institutions",
      payload: {
        teamId: committedPayload.teamId,
        institutionIds: [...committedPayload.previous],
      },
    };
  },
};
