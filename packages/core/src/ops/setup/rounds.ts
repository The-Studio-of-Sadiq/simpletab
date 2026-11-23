import {
  createRoundRecord,
  roundStageDrawTypeProblem,
} from "@/features/tournament/application/rounds";
import {
  preliminaryPanelsOf,
  slotNewPreliminaryRounds,
} from "@/features/tournament/application/schedule";
import {
  checkPreliminaryRoundCount,
  checkRoundCancellation,
  checkRoundCompletion,
  checkRoundDeletion,
  checkRoundReopen,
  checkRoundUpdate,
  roundsCancelledByPreliminaryCount,
  type RuleOverride,
} from "@/features/tournament/application/stateGuards";
import { validateDraw } from "@/lib/draw/validateDraw";
import {
  recordKey,
  type OpDef,
  type OpRound,
  type RecordKey,
  type SimpleTabRoundExtension,
} from "../types";
import {
  cloneValue,
  isNonEmptyText,
  isValidIanaTimeZone,
  isValidIsoInstant,
  violationsToErrors,
} from "./helpers";

export interface RoundCreatePayload {
  round: OpRound;
}

export interface RoundUpdatePayload {
  round: OpRound;
  override?: RuleOverride;
  previous?: OpRound;
}

export interface RoundDeletePayload {
  roundId: string;
  override?: RuleOverride;
  deletedDebateIds?: string[];
  deletedBallotIds?: string[];
  deletedFeedbackIds?: string[];
}

export interface RoundSetPrelimCountPayload {
  count: number;
  override?: RuleOverride;
  createdAt?: string;
  previousCount?: number;
  createdRoundIds?: string[];
  cancelledRoundIds?: string[];
  previousCancelled?: Record<string, boolean | null>;
  restoreCancelled?: Record<string, boolean | null>;
  removeRoundIds?: string[];
}

export interface RoundSetCompletionPayload {
  roundId: string;
  completed: boolean;
  override?: RuleOverride;
  previousCompleted?: boolean;
}

export interface RoundCancelPayload {
  roundId: string;
  cancelled: boolean;
  override?: RuleOverride;
  clearCancelled?: boolean;
  previousCancelled?: boolean | null;
}

export interface RoundSetBallotDeadlinePayload {
  roundId: string;
  ballotDeadline: string | null;
  feedbackDeadline?: string | null;
  timeZone: string;
  restoreSimpletab?: SimpleTabRoundExtension | null;
  previous?: SimpleTabRoundExtension | null;
}

function nextUniqueRoundId(
  tournamentId: string,
  seq: number,
  taken: ReadonlySet<string>,
): string {
  const base = `round-${tournamentId}-${seq}`;
  if (!taken.has(base)) {
    return base;
  }
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

export const roundCreateOp: OpDef<RoundCreatePayload> = {
  type: "round.create",
  permission: "rounds.manage",
  category: "rounds",
  visibility: "public",
  lock: false,
  reads(_state, payload) {
    return [recordKey("round", payload.round.id)];
  },
  writes(_state, payload) {
    return [recordKey("round", payload.round.id)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    const { round } = payload;
    if (!isNonEmptyText(round.id)) {
      errors.push("Round id must not be empty.");
    } else if (state.rounds.some((item) => item.id === round.id)) {
      errors.push(`Round ${round.id} already exists.`);
    }
    if (!isNonEmptyText(round.name)) {
      errors.push("Round name must not be empty.");
    }
    if (!isNonEmptyText(round.abbreviation)) {
      errors.push("Round abbreviation must not be empty.");
    }
    if (!Number.isInteger(round.seq) || round.seq < 1) {
      errors.push("Round seq must be a positive integer.");
    }
    const stageProblem = roundStageDrawTypeProblem(round.stage, round.drawType);
    if (stageProblem) {
      errors.push(stageProblem);
    }
    return errors;
  },
  apply(state, payload) {
    const created = cloneValue(payload.round);
    return {
      state: {
        ...state,
        rounds: [...state.rounds, created],
      },
      committedPayload: {
        round: cloneValue(created),
      },
    };
  },
  inverse(committedPayload) {
    return {
      type: "round.delete",
      payload: {
        roundId: committedPayload.round.id,
      },
    };
  },
};

export const roundUpdateOp: OpDef<RoundUpdatePayload> = {
  type: "round.update",
  permission: "rounds.manage",
  category: "rounds",
  visibility: "public",
  lock: false,
  reads(state, payload) {
    return [
      recordKey("round", payload.round.id),
      ...state.debates
        .filter((debate) => debate.roundId === payload.round.id)
        .map((debate) => recordKey("debate", debate.id)),
    ];
  },
  writes(_state, payload) {
    return [recordKey("round", payload.round.id)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    const { round } = payload;
    const existing = isNonEmptyText(round.id)
      ? state.rounds.find((item) => item.id === round.id)
      : undefined;
    if (!isNonEmptyText(round.id)) {
      errors.push("Round id must not be empty.");
    } else if (!existing) {
      errors.push(`Round ${round.id} does not exist.`);
    }
    if (!isNonEmptyText(round.name)) {
      errors.push("Round name must not be empty.");
    }
    if (!isNonEmptyText(round.abbreviation)) {
      errors.push("Round abbreviation must not be empty.");
    }
    if (!existing) {
      return errors;
    }
    if (existing.stage !== round.stage || existing.drawType !== round.drawType) {
      const problem = roundStageDrawTypeProblem(round.stage, round.drawType);
      if (problem) {
        errors.push(problem);
      }
    }
    if (errors.length > 0) {
      return errors;
    }

    const guardViolations = checkRoundUpdate(
      existing,
      round,
      {
        rounds: state.rounds,
        debates: state.debates,
        ballots: state.ballots,
      },
      () =>
        validateDraw({
          tournament: state.tournament,
          round,
          debates: state.debates,
          rounds: state.rounds,
          teams: state.teams,
          adjudicators: state.adjudicators,
          venues: state.venues,
          ballots: state.ballots,
          institutions: state.institutions,
        }),
    );
    return violationsToErrors(guardViolations, payload.override);
  },
  apply(state, payload) {
    const existing = state.rounds.find((item) => item.id === payload.round.id)!;
    const previous = cloneValue(existing);
    const updated = cloneValue(payload.round);
    return {
      state: {
        ...state,
        rounds: state.rounds.map((item) =>
          item.id === updated.id ? updated : item,
        ),
      },
      committedPayload: {
        round: cloneValue(updated),
        previous,
      },
    };
  },
  inverse(committedPayload) {
    if (!committedPayload.previous) {
      return null;
    }
    return {
      type: "round.update",
      payload: {
        round: cloneValue(committedPayload.previous),
        override: { reason: "Undo round.update" },
      },
    };
  },
};

export const roundDeleteOp: OpDef<RoundDeletePayload> = {
  type: "round.delete",
  permission: "rounds.manage",
  category: "rounds",
  visibility: "public",
  lock: true,
  reads(state, payload) {
    return [
      recordKey("round", payload.roundId),
      ...state.debates
        .filter((debate) => debate.roundId === payload.roundId)
        .map((debate) => recordKey("debate", debate.id)),
      ...state.ballots
        .filter((ballot) => ballot.roundId === payload.roundId)
        .map((ballot) => recordKey("ballot", ballot.id)),
    ];
  },
  writes(state, payload) {
    const debateIds =
      payload.deletedDebateIds ??
      state.debates
        .filter((debate) => debate.roundId === payload.roundId)
        .map((debate) => debate.id);
    const ballotIds =
      payload.deletedBallotIds ??
      state.ballots
        .filter((ballot) => ballot.roundId === payload.roundId)
        .map((ballot) => ballot.id);
    const feedbackIds =
      payload.deletedFeedbackIds ??
      state.feedback
        .filter((item) => item.roundId === payload.roundId)
        .map((item) => item.id);
    return [
      recordKey("round", payload.roundId),
      ...debateIds.map((id) => recordKey("debate", id)),
      ...ballotIds.map((id) => recordKey("ballot", id)),
      ...feedbackIds.map((id) => recordKey("feedback", id)),
    ];
  },
  validate(state, payload) {
    const existing = state.rounds.find((item) => item.id === payload.roundId);
    if (!existing) {
      return [`Round ${payload.roundId} does not exist.`];
    }
    return violationsToErrors(
      checkRoundDeletion(existing, {
        rounds: state.rounds,
        debates: state.debates,
        ballots: state.ballots,
      }),
      payload.override,
    );
  },
  apply(state, payload) {
    const deletedDebateIds = state.debates
      .filter((debate) => debate.roundId === payload.roundId)
      .map((debate) => debate.id);
    const deletedBallotIds = state.ballots
      .filter((ballot) => ballot.roundId === payload.roundId)
      .map((ballot) => ballot.id);
    const deletedFeedbackIds = state.feedback
      .filter((item) => item.roundId === payload.roundId)
      .map((item) => item.id);

    return {
      state: {
        ...state,
        rounds: state.rounds.filter((item) => item.id !== payload.roundId),
        debates: state.debates.filter(
          (debate) => debate.roundId !== payload.roundId,
        ),
        ballots: state.ballots.filter(
          (ballot) => ballot.roundId !== payload.roundId,
        ),
        feedback: state.feedback.filter(
          (item) => item.roundId !== payload.roundId,
        ),
      },
      committedPayload: {
        ...cloneValue(payload),
        deletedDebateIds,
        deletedBallotIds,
        deletedFeedbackIds,
      },
    };
  },
  inverse() {
    return null;
  },
};

export const roundSetPrelimCountOp: OpDef<RoundSetPrelimCountPayload> = {
  type: "round.set_prelim_count",
  permission: "rounds.manage",
  category: "rounds",
  visibility: "public",
  lock: true,
  reads(state) {
    return state.rounds.map((round) => recordKey("round", round.id));
  },
  writes(state, payload) {
    if (
      payload.createdRoundIds ||
      payload.cancelledRoundIds ||
      payload.restoreCancelled ||
      payload.removeRoundIds
    ) {
      const keys: RecordKey[] = [];
      for (const id of payload.createdRoundIds ?? []) {
        keys.push(recordKey("round", id));
      }
      for (const id of payload.cancelledRoundIds ?? []) {
        keys.push(recordKey("round", id));
      }
      for (const id of Object.keys(payload.restoreCancelled ?? {})) {
        keys.push(recordKey("round", id));
      }
      for (const id of payload.removeRoundIds ?? []) {
        keys.push(recordKey("round", id));
      }
      return keys;
    }

    const activePrelims = state.rounds.filter(
      (round) => round.stage === "preliminary" && !round.cancelled,
    );
    if (payload.count < activePrelims.length) {
      return roundsCancelledByPreliminaryCount(state.rounds, payload.count).map(
        (round) => recordKey("round", round.id),
      );
    }
    return [];
  },
  validate(state, payload) {
    if (!Number.isInteger(payload.count) || payload.count < 0 || payload.count > 20) {
      return ["Preliminary round count must be a whole number between 0 and 20."];
    }

    const errors: string[] = [];
    if (payload.removeRoundIds) {
      for (const roundId of payload.removeRoundIds) {
        const round = state.rounds.find((item) => item.id === roundId);
        if (!round) {
          errors.push(`Round ${roundId} does not exist.`);
          continue;
        }
        errors.push(
          ...violationsToErrors(
            checkRoundDeletion(round, {
              rounds: state.rounds,
              debates: state.debates,
              ballots: state.ballots,
            }),
            payload.override,
          ),
        );
      }
      return errors;
    }

    if (payload.restoreCancelled !== undefined) {
      return [];
    }

    return violationsToErrors(
      checkPreliminaryRoundCount(payload.count, {
        rounds: state.rounds,
        debates: state.debates,
        ballots: state.ballots,
      }),
      payload.override,
    );
  },
  apply(state, payload) {
    const activePrelims = state.rounds.filter(
      (round) => round.stage === "preliminary" && !round.cancelled,
    );
    const previousCount = activePrelims.length;

    if (payload.removeRoundIds || payload.restoreCancelled) {
      const removeSet = new Set(payload.removeRoundIds ?? []);
      const restoreMap = payload.restoreCancelled ?? {};
      const nextRounds = state.rounds
        .filter((round) => !removeSet.has(round.id))
        .map((round) => {
          if (!Object.prototype.hasOwnProperty.call(restoreMap, round.id)) {
            return round;
          }
          const next = cloneValue(round);
          const prevVal = restoreMap[round.id];
          if (prevVal === null || prevVal === undefined) {
            delete next.cancelled;
          } else {
            next.cancelled = prevVal;
          }
          return next;
        });

      return {
        state: {
          ...state,
          rounds: nextRounds,
        },
        committedPayload: {
          ...cloneValue(payload),
          previousCount,
        },
      };
    }

    const target = payload.count;
    const previousCancelled: Record<string, boolean | null> = {};
    const cancelledRoundIds: string[] = [];
    const createdRoundIds: string[] = [];

    if (target < activePrelims.length) {
      const toCancel = roundsCancelledByPreliminaryCount(state.rounds, target);
      const cancelSet = new Set(toCancel.map((round) => round.id));
      const nextRounds = state.rounds.map((round) => {
        if (!cancelSet.has(round.id)) {
          return round;
        }
        previousCancelled[round.id] = round.cancelled ?? null;
        cancelledRoundIds.push(round.id);
        return {
          ...cloneValue(round),
          cancelled: true,
        };
      });

      return {
        state: {
          ...state,
          rounds: nextRounds,
        },
        committedPayload: {
          ...cloneValue(payload),
          previousCount,
          cancelledRoundIds,
          previousCancelled,
        },
      };
    }

    if (target > activePrelims.length) {
      let needed = target - activePrelims.length;
      const cancelledPrelims = state.rounds
        .filter((round) => round.stage === "preliminary" && round.cancelled)
        .sort((left, right) => left.seq - right.seq);

      const uncancelSet = new Set<string>();
      for (const round of cancelledPrelims) {
        if (needed <= 0) break;
        uncancelSet.add(round.id);
        previousCancelled[round.id] = round.cancelled ?? null;
        cancelledRoundIds.push(round.id);
        needed -= 1;
      }

      const baseRounds = state.rounds.map((round) => {
        if (!uncancelSet.has(round.id)) {
          return round;
        }
        return {
          ...cloneValue(round),
          cancelled: false,
        };
      });

      const createdRounds: OpRound[] = [];
      if (needed > 0) {
        const takenIds = new Set(baseRounds.map((round) => round.id));
        let nextSeq =
          baseRounds.reduce((max, round) => Math.max(max, round.seq), 0) + 1;
        const createdAt = payload.createdAt ?? state.tournament.createdAt;
        const panels = preliminaryPanelsOf(state.tournament.preferences);

        const rawCreated: OpRound[] = [];
        for (let idx = 0; idx < needed; idx += 1) {
          const seq = nextSeq;
          nextSeq += 1;
          const id = nextUniqueRoundId(state.tournament.id, seq, takenIds);
          takenIds.add(id);
          const record = createRoundRecord({
            tournamentId: state.tournament.id,
            roundSeq: seq,
            name: `Round ${seq}`,
            abbr: `R${seq}`,
            stage: "preliminary",
            defaultDrawRule: state.tournament.preferences.drawRule,
            id,
          });
          rawCreated.push({
            ...record,
            createdAt,
          });
        }

        const slotted = slotNewPreliminaryRounds(baseRounds, rawCreated, panels);
        for (const round of slotted) {
          createdRounds.push(round);
          createdRoundIds.push(round.id);
        }
      }

      return {
        state: {
          ...state,
          rounds: [...baseRounds, ...createdRounds],
        },
        committedPayload: {
          ...cloneValue(payload),
          previousCount,
          ...(createdRoundIds.length > 0 ? { createdRoundIds } : {}),
          ...(cancelledRoundIds.length > 0 ? { cancelledRoundIds } : {}),
          ...(Object.keys(previousCancelled).length > 0 ? { previousCancelled } : {}),
        },
      };
    }

    return {
      state,
      committedPayload: {
        ...cloneValue(payload),
        previousCount,
      },
    };
  },
  inverse(committedPayload) {
    if (committedPayload.previousCount === undefined) {
      return null;
    }
    const hasCreated = (committedPayload.createdRoundIds?.length ?? 0) > 0;
    const hasCancelled =
      committedPayload.previousCancelled !== undefined &&
      Object.keys(committedPayload.previousCancelled).length > 0;
    if (!hasCreated && !hasCancelled) {
      return {
        type: "round.set_prelim_count",
        payload: {
          count: committedPayload.previousCount,
        },
      };
    }
    return {
      type: "round.set_prelim_count",
      payload: {
        count: committedPayload.previousCount,
        ...(hasCreated ? { removeRoundIds: [...committedPayload.createdRoundIds!] } : {}),
        ...(hasCancelled
          ? { restoreCancelled: cloneValue(committedPayload.previousCancelled!) }
          : {}),
        override: { reason: "Undo round.set_prelim_count" },
      },
    };
  },
};

export const roundSetCompletionOp: OpDef<RoundSetCompletionPayload> = {
  type: "round.set_completion",
  permission: "rounds.manage",
  category: "rounds",
  visibility: "public",
  lock: false,
  reads(state, payload) {
    return [
      recordKey("round", payload.roundId),
      ...state.debates
        .filter((debate) => debate.roundId === payload.roundId)
        .map((debate) => recordKey("debate", debate.id)),
      ...state.ballots
        .filter((ballot) => ballot.roundId === payload.roundId)
        .map((ballot) => recordKey("ballot", ballot.id)),
    ];
  },
  writes(_state, payload) {
    return [recordKey("round", payload.roundId)];
  },
  validate(state, payload) {
    const existing = state.rounds.find((item) => item.id === payload.roundId);
    if (!existing) {
      return [`Round ${payload.roundId} does not exist.`];
    }
    if (typeof payload.completed !== "boolean") {
      return ["completed must be a boolean."];
    }
    const guardState = {
      rounds: state.rounds,
      debates: state.debates,
      ballots: state.ballots,
    };
    if (!existing.completed && payload.completed) {
      return violationsToErrors(
        checkRoundCompletion(existing, guardState),
        payload.override,
      );
    }
    if (existing.completed && !payload.completed) {
      return violationsToErrors(
        checkRoundReopen(existing, guardState),
        payload.override,
      );
    }
    return [];
  },
  apply(state, payload) {
    const existing = state.rounds.find((item) => item.id === payload.roundId)!;
    const previousCompleted = existing.completed;
    const updated: OpRound = {
      ...cloneValue(existing),
      completed: payload.completed,
    };
    return {
      state: {
        ...state,
        rounds: state.rounds.map((item) =>
          item.id === updated.id ? updated : item,
        ),
      },
      committedPayload: {
        ...cloneValue(payload),
        previousCompleted,
      },
    };
  },
  inverse(committedPayload) {
    if (committedPayload.previousCompleted === undefined) {
      return null;
    }
    return {
      type: "round.set_completion",
      payload: {
        roundId: committedPayload.roundId,
        completed: committedPayload.previousCompleted,
        override: { reason: "Undo round.set_completion" },
      },
    };
  },
};

export const roundCancelOp: OpDef<RoundCancelPayload> = {
  type: "round.cancel",
  permission: "rounds.manage",
  category: "rounds",
  visibility: "public",
  lock: false,
  reads(state, payload) {
    return [
      recordKey("round", payload.roundId),
      ...state.debates
        .filter((debate) => debate.roundId === payload.roundId)
        .map((debate) => recordKey("debate", debate.id)),
      ...state.ballots
        .filter((ballot) => ballot.roundId === payload.roundId)
        .map((ballot) => recordKey("ballot", ballot.id)),
    ];
  },
  writes(_state, payload) {
    return [recordKey("round", payload.roundId)];
  },
  validate(state, payload) {
    const existing = state.rounds.find((item) => item.id === payload.roundId);
    if (!existing) {
      return [`Round ${payload.roundId} does not exist.`];
    }
    if (typeof payload.cancelled !== "boolean") {
      return ["cancelled must be a boolean."];
    }
    if (!existing.cancelled && payload.cancelled) {
      return violationsToErrors(
        checkRoundCancellation(existing, {
          rounds: state.rounds,
          debates: state.debates,
          ballots: state.ballots,
        }),
        payload.override,
      );
    }
    return [];
  },
  apply(state, payload) {
    const existing = state.rounds.find((item) => item.id === payload.roundId)!;
    const previousCancelled = existing.cancelled ?? null;
    const updated = cloneValue(existing);
    if (payload.clearCancelled) {
      delete updated.cancelled;
    } else {
      updated.cancelled = payload.cancelled;
    }
    return {
      state: {
        ...state,
        rounds: state.rounds.map((item) =>
          item.id === updated.id ? updated : item,
        ),
      },
      committedPayload: {
        ...cloneValue(payload),
        previousCancelled,
      },
    };
  },
  inverse(committedPayload) {
    if (committedPayload.previousCancelled === undefined) {
      return null;
    }
    if (committedPayload.previousCancelled === null) {
      return {
        type: "round.cancel",
        payload: {
          roundId: committedPayload.roundId,
          cancelled: false,
          clearCancelled: true,
        },
      };
    }
    return {
      type: "round.cancel",
      payload: {
        roundId: committedPayload.roundId,
        cancelled: committedPayload.previousCancelled,
      },
    };
  },
};

export const roundSetBallotDeadlineOp: OpDef<RoundSetBallotDeadlinePayload> = {
  type: "round.set_ballot_deadline",
  permission: "rounds.manage",
  category: "rounds",
  visibility: "public",
  lock: false,
  reads(_state, payload) {
    return [recordKey("round", payload.roundId)];
  },
  writes(_state, payload) {
    return [recordKey("round", payload.roundId)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    if (!isNonEmptyText(payload.roundId)) {
      errors.push("roundId must not be empty.");
    } else if (!state.rounds.some((item) => item.id === payload.roundId)) {
      errors.push(`Round ${payload.roundId} does not exist.`);
    }
    if (payload.restoreSimpletab !== undefined) {
      return errors;
    }
    if (
      payload.ballotDeadline !== null &&
      !isValidIsoInstant(payload.ballotDeadline)
    ) {
      errors.push(
        "ballotDeadline must be a valid ISO 8601 instant with offset or null.",
      );
    }
    if (
      payload.feedbackDeadline !== undefined &&
      payload.feedbackDeadline !== null &&
      !isValidIsoInstant(payload.feedbackDeadline)
    ) {
      errors.push(
        "feedbackDeadline must be a valid ISO 8601 instant with offset or null.",
      );
    }
    if (!isValidIanaTimeZone(payload.timeZone)) {
      errors.push("timeZone must be a valid IANA time zone name.");
    }
    return errors;
  },
  apply(state, payload) {
    const existing = state.rounds.find((item) => item.id === payload.roundId)!;
    const previous = existing.simpletab ? cloneValue(existing.simpletab) : null;
    const updated = cloneValue(existing);

    if (payload.restoreSimpletab !== undefined) {
      if (payload.restoreSimpletab === null) {
        delete updated.simpletab;
      } else {
        updated.simpletab = cloneValue(payload.restoreSimpletab);
      }
    } else {
      const normalizedBallotDeadline =
        payload.ballotDeadline === null
          ? null
          : new Date(payload.ballotDeadline).toISOString();
      const nextExtension: SimpleTabRoundExtension = {
        ...(existing.simpletab ? cloneValue(existing.simpletab) : {}),
        ballotDeadline: normalizedBallotDeadline,
        timeZone: payload.timeZone,
      };
      if (payload.feedbackDeadline !== undefined) {
        nextExtension.feedbackDeadline =
          payload.feedbackDeadline === null
            ? null
            : new Date(payload.feedbackDeadline).toISOString();
      }
      updated.simpletab = nextExtension;
    }

    return {
      state: {
        ...state,
        rounds: state.rounds.map((item) =>
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
    if (committedPayload.previous === undefined) {
      return null;
    }
    return {
      type: "round.set_ballot_deadline",
      payload: {
        roundId: committedPayload.roundId,
        ballotDeadline: committedPayload.previous?.ballotDeadline ?? null,
        timeZone: committedPayload.previous?.timeZone ?? "UTC",
        restoreSimpletab: committedPayload.previous
          ? cloneValue(committedPayload.previous)
          : null,
      },
    };
  },
};
