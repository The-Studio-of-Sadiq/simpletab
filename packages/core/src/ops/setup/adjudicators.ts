import { checkAdjudicatorDeletion } from "@/features/tournament/application/stateGuards";
import { withScoreHistory } from "@/lib/feedback/scoreHistory";
import { mayEditAdjudicatorScores } from "@/lib/staffPermissions";
import type { Adjudicator, AdjudicatorScoreChange } from "@/types";
import { recordKey, type Actor, type OpDef } from "../types";
import {
  cloneValue,
  insertAt,
  isFiniteNumber,
  isNonEmptyText,
  violationsToErrors,
} from "./helpers";

export interface AdjudicatorCreatePayload {
  adjudicator: Adjudicator;
  index?: number;
}

export interface AdjudicatorUpdatePayload {
  adjudicator: Adjudicator;
  previous?: Adjudicator;
}

export interface AdjudicatorDeletePayload {
  adjudicatorId: string;
  previous?: Adjudicator;
  previousIndex?: number;
}

export interface AdjudicatorScoresPrevious {
  baseScore: number;
  testScore: number | null;
  breaking: boolean | null;
  isTester: boolean | null;
  scoreHistory: AdjudicatorScoreChange[] | null;
}

export interface AdjudicatorUpdateScoresPayload {
  adjudicatorId: string;
  baseScore?: number;
  testScore?: number | null;
  breaking?: boolean | null;
  isTester?: boolean | null;
  reason?: string;
  timestamp?: string;
  roundId?: string;
  restoreScoreHistory?: AdjudicatorScoreChange[] | null;
  previous?: AdjudicatorScoresPrevious;
}

export const adjudicatorCreateOp: OpDef<AdjudicatorCreatePayload> = {
  type: "adjudicator.create",
  permission: "participants.edit",
  category: "participants",
  visibility: "private",
  lock: false,
  reads(_state, payload) {
    return [recordKey("adjudicator", payload.adjudicator.id)];
  },
  writes(_state, payload) {
    return [recordKey("adjudicator", payload.adjudicator.id)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    const { adjudicator } = payload;
    if (!isNonEmptyText(adjudicator.id)) {
      errors.push("Adjudicator id must not be empty.");
    } else if (state.adjudicators.some((item) => item.id === adjudicator.id)) {
      errors.push(`Adjudicator ${adjudicator.id} already exists.`);
    }
    if (!isNonEmptyText(adjudicator.name)) {
      errors.push("Adjudicator name must not be empty.");
    }
    if (!isFiniteNumber(adjudicator.baseScore)) {
      errors.push("Adjudicator baseScore must be a finite number.");
    }
    return errors;
  },
  apply(state, payload) {
    const created = cloneValue(payload.adjudicator);
    return {
      state: {
        ...state,
        adjudicators: insertAt(state.adjudicators, created, payload.index),
      },
      committedPayload: {
        adjudicator: cloneValue(created),
        ...(payload.index !== undefined ? { index: payload.index } : {}),
      },
    };
  },
  inverse(committedPayload) {
    return {
      type: "adjudicator.delete",
      payload: {
        adjudicatorId: committedPayload.adjudicator.id,
      },
    };
  },
};

export const adjudicatorUpdateOp: OpDef<AdjudicatorUpdatePayload> = {
  type: "adjudicator.update",
  permission: "participants.edit",
  category: "participants",
  visibility: "private",
  lock: false,
  reads(_state, payload) {
    return [recordKey("adjudicator", payload.adjudicator.id)];
  },
  writes(_state, payload) {
    return [recordKey("adjudicator", payload.adjudicator.id)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    const { adjudicator } = payload;
    if (!isNonEmptyText(adjudicator.id)) {
      errors.push("Adjudicator id must not be empty.");
    } else if (!state.adjudicators.some((item) => item.id === adjudicator.id)) {
      errors.push(`Adjudicator ${adjudicator.id} does not exist.`);
    }
    if (!isNonEmptyText(adjudicator.name)) {
      errors.push("Adjudicator name must not be empty.");
    }
    if (!isFiniteNumber(adjudicator.baseScore)) {
      errors.push("Adjudicator baseScore must be a finite number.");
    }
    return errors;
  },
  apply(state, payload) {
    const existing = state.adjudicators.find(
      (item) => item.id === payload.adjudicator.id,
    )!;
    const previous = cloneValue(existing);
    const updated = cloneValue(payload.adjudicator);
    return {
      state: {
        ...state,
        adjudicators: state.adjudicators.map((item) =>
          item.id === updated.id ? updated : item,
        ),
      },
      committedPayload: {
        adjudicator: cloneValue(updated),
        previous,
      },
    };
  },
  inverse(committedPayload) {
    if (!committedPayload.previous) {
      return null;
    }
    return {
      type: "adjudicator.update",
      payload: {
        adjudicator: cloneValue(committedPayload.previous),
      },
    };
  },
};

export const adjudicatorDeleteOp: OpDef<AdjudicatorDeletePayload> = {
  type: "adjudicator.delete",
  permission: "participants.edit",
  category: "participants",
  visibility: "private",
  lock: false,
  reads(state, payload) {
    return [
      recordKey("adjudicator", payload.adjudicatorId),
      ...state.debates.map((debate) => recordKey("debate", debate.id)),
      ...state.ballots.map((ballot) => recordKey("ballot", ballot.id)),
      ...state.feedback.map((item) => recordKey("feedback", item.id)),
    ];
  },
  writes(_state, payload) {
    return [recordKey("adjudicator", payload.adjudicatorId)];
  },
  validate(state, payload) {
    const existing = state.adjudicators.find(
      (item) => item.id === payload.adjudicatorId,
    );
    if (!existing) {
      return [`Adjudicator ${payload.adjudicatorId} does not exist.`];
    }
    return violationsToErrors(
      checkAdjudicatorDeletion(existing, {
        debates: state.debates,
        ballots: state.ballots,
        feedback: state.feedback,
      }),
    );
  },
  apply(state, payload) {
    const index = state.adjudicators.findIndex(
      (item) => item.id === payload.adjudicatorId,
    );
    const previous = cloneValue(state.adjudicators[index]!);
    return {
      state: {
        ...state,
        adjudicators: state.adjudicators.filter(
          (item) => item.id !== payload.adjudicatorId,
        ),
      },
      committedPayload: {
        adjudicatorId: payload.adjudicatorId,
        previous,
        previousIndex: index,
      },
    };
  },
  inverse(committedPayload) {
    if (!committedPayload.previous) {
      return null;
    }
    return {
      type: "adjudicator.create",
      payload: {
        adjudicator: cloneValue(committedPayload.previous),
        index: committedPayload.previousIndex,
      },
    };
  },
};

export const adjudicatorUpdateScoresOp: OpDef<AdjudicatorUpdateScoresPayload> = {
  type: "adjudicator.update_scores",
  permission: "adjudicators.scores_edit",
  category: "participants",
  visibility: "private",
  lock: false,
  checkActor(actor: Actor) {
    const isOwnerOrAdmin =
      actor.isHostOwner ||
      actor.role.id === "host_owner" ||
      actor.role.id === "tab_director";
    const allowed = mayEditAdjudicatorScores({
      isOwnerOrAdmin,
      isDataEntryAssistant: true,
      permissions: actor.role.permissions,
    });
    return allowed
      ? null
      : "Editing adjudicator scores requires feedback.view as well as adjudicators.scores_edit.";
  },
  reads(_state, payload) {
    return [recordKey("adjudicator", payload.adjudicatorId)];
  },
  writes(_state, payload) {
    return [recordKey("adjudicator", payload.adjudicatorId)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    if (!isNonEmptyText(payload.adjudicatorId)) {
      errors.push("adjudicatorId must not be empty.");
    } else if (!state.adjudicators.some((item) => item.id === payload.adjudicatorId)) {
      errors.push(`Adjudicator ${payload.adjudicatorId} does not exist.`);
    }
    if (payload.baseScore !== undefined && !isFiniteNumber(payload.baseScore)) {
      errors.push("baseScore must be a finite number.");
    }
    if (
      payload.testScore !== undefined &&
      payload.testScore !== null &&
      !isFiniteNumber(payload.testScore)
    ) {
      errors.push("testScore must be a finite number or null.");
    }
    if (payload.reason !== undefined && typeof payload.reason !== "string") {
      errors.push("reason must be a string.");
    }
    return errors;
  },
  apply(state, payload, actor) {
    const existing = state.adjudicators.find(
      (item) => item.id === payload.adjudicatorId,
    )!;
    const previous: AdjudicatorScoresPrevious = {
      baseScore: existing.baseScore,
      testScore: existing.testScore ?? null,
      breaking: existing.breaking ?? null,
      isTester: existing.isTester ?? null,
      scoreHistory: existing.scoreHistory ? cloneValue(existing.scoreHistory) : null,
    };

    const candidate: Adjudicator = cloneValue(existing);
    if (payload.baseScore !== undefined) {
      candidate.baseScore = payload.baseScore;
    }
    if (payload.testScore === null) {
      delete candidate.testScore;
    } else if (payload.testScore !== undefined) {
      candidate.testScore = payload.testScore;
    }
    if (payload.breaking === null) {
      delete candidate.breaking;
    } else if (payload.breaking !== undefined) {
      candidate.breaking = payload.breaking;
    }
    if (payload.isTester === null) {
      delete candidate.isTester;
    } else if (payload.isTester !== undefined) {
      candidate.isTester = payload.isTester;
    }

    let updated: Adjudicator;
    if (payload.restoreScoreHistory !== undefined) {
      if (payload.restoreScoreHistory === null) {
        delete candidate.scoreHistory;
      } else {
        candidate.scoreHistory = cloneValue(payload.restoreScoreHistory);
      }
      updated = candidate;
    } else {
      updated = withScoreHistory(existing, candidate, {
        timestamp: payload.timestamp ?? state.tournament.updatedAt,
        ...(payload.roundId ? { roundId: payload.roundId } : {}),
        ...(actor?.ref ? { actorId: actor.ref } : {}),
        ...(payload.reason ? { reason: payload.reason } : {}),
      });
    }

    return {
      state: {
        ...state,
        adjudicators: state.adjudicators.map((item) =>
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
    const previous = committedPayload.previous;
    if (!previous) {
      return null;
    }
    return {
      type: "adjudicator.update_scores",
      payload: {
        adjudicatorId: committedPayload.adjudicatorId,
        baseScore: previous.baseScore,
        testScore: previous.testScore,
        breaking: previous.breaking,
        isTester: previous.isTester,
        restoreScoreHistory: previous.scoreHistory
          ? cloneValue(previous.scoreHistory)
          : null,
      },
    };
  },
};
