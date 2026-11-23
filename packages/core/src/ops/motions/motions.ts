import {
  MOTIONS_STATUSES,
  motionsStatusOf,
  planMotionsStatusChange,
} from "@/features/tournament/application/motionRelease";
import { withValidInfoSlideMedia } from "@/lib/motions/infoSlideMedia";
import type { Motion, MotionsStatus } from "@/types";
import {
  cloneValue,
  dedupeKeys,
  insertAt,
  isNonEmptyText,
  isValidIsoInstant,
} from "../setup/helpers";
import { recordKey, type OpDef, type OpRound } from "../types";

export interface MotionCreatePayload {
  motion: Motion;
  index?: number;
}

export interface MotionUpdatePayload {
  motion: Motion;
  previous?: Motion;
}

export interface MotionDeletePayload {
  motionId: string;
  previous?: Motion;
  previousIndex?: number;
}

export interface MotionSetRoundStatusPayload {
  roundId: string;
  status: MotionsStatus;
  now?: string;
  previousStatus?: MotionsStatus;
  previousMotionsStatusField?: MotionsStatus | null;
  previousStartsAt?: string | null;
  changedMotionIds?: string[];
  previousMotionReleased?: Record<string, boolean>;
  restoreMotionsStatusField?: MotionsStatus | null;
  restoreStartsAt?: string | null;
  restoreMotionReleased?: Record<string, boolean>;
}

function validateMotionFields(
  motion: Motion,
  rounds: readonly OpRound[],
): string[] {
  const errors: string[] = [];
  if (!isNonEmptyText(motion.text)) {
    errors.push("Motion text must not be empty.");
  }
  if (!Array.isArray(motion.rounds)) {
    errors.push("Motion rounds must be an array.");
  } else {
    const knownRounds = new Set(rounds.map((round) => round.id));
    for (const roundId of motion.rounds) {
      if (!knownRounds.has(roundId)) {
        errors.push(`Motion references unknown round ${roundId}.`);
      }
    }
  }
  if (typeof motion.released !== "boolean") {
    errors.push("Motion released must be a boolean.");
  }
  try {
    withValidInfoSlideMedia(motion);
  } catch (error) {
    errors.push(
      error instanceof Error ? error.message : "Invalid info slide media.",
    );
  }
  return errors;
}

export const motionCreateOp: OpDef<MotionCreatePayload> = {
  type: "motion.create",
  permission: "motions.manage",
  category: "motions",
  visibility: "private",
  lock: false,
  reads(_state, payload) {
    return dedupeKeys([
      recordKey("motion", payload.motion.id),
      ...(payload.motion.rounds ?? []).map((roundId) =>
        recordKey("round", roundId),
      ),
    ]);
  },
  writes(_state, payload) {
    return [recordKey("motion", payload.motion.id)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    const { motion } = payload;
    if (!isNonEmptyText(motion.id)) {
      errors.push("Motion id must not be empty.");
    } else if (state.motions.some((item) => item.id === motion.id)) {
      errors.push(`Motion ${motion.id} already exists.`);
    }
    errors.push(...validateMotionFields(motion, state.rounds));
    return errors;
  },
  apply(state, payload) {
    const created = withValidInfoSlideMedia(cloneValue(payload.motion));
    return {
      state: {
        ...state,
        motions: insertAt(state.motions, created, payload.index),
      },
      committedPayload: {
        motion: cloneValue(created),
        ...(payload.index !== undefined ? { index: payload.index } : {}),
      },
    };
  },
  inverse(committedPayload) {
    return {
      type: "motion.delete",
      payload: {
        motionId: committedPayload.motion.id,
      },
    };
  },
};

export const motionUpdateOp: OpDef<MotionUpdatePayload> = {
  type: "motion.update",
  permission: "motions.manage",
  category: "motions",
  visibility: "private",
  lock: false,
  reads(_state, payload) {
    return dedupeKeys([
      recordKey("motion", payload.motion.id),
      ...(payload.motion.rounds ?? []).map((roundId) =>
        recordKey("round", roundId),
      ),
    ]);
  },
  writes(_state, payload) {
    return [recordKey("motion", payload.motion.id)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    const { motion } = payload;
    if (!isNonEmptyText(motion.id)) {
      errors.push("Motion id must not be empty.");
    } else if (!state.motions.some((item) => item.id === motion.id)) {
      errors.push(`Motion ${motion.id} does not exist.`);
    }
    errors.push(...validateMotionFields(motion, state.rounds));
    return errors;
  },
  apply(state, payload) {
    const existing = state.motions.find((item) => item.id === payload.motion.id)!;
    const previous = cloneValue(existing);
    const updated = withValidInfoSlideMedia(cloneValue(payload.motion));
    return {
      state: {
        ...state,
        motions: state.motions.map((item) =>
          item.id === updated.id ? updated : item,
        ),
      },
      committedPayload: {
        motion: cloneValue(updated),
        previous,
      },
    };
  },
  inverse(committedPayload) {
    if (!committedPayload.previous) {
      return null;
    }
    return {
      type: "motion.update",
      payload: {
        motion: cloneValue(committedPayload.previous),
      },
    };
  },
};

export const motionDeleteOp: OpDef<MotionDeletePayload> = {
  type: "motion.delete",
  permission: "motions.manage",
  category: "motions",
  visibility: "private",
  lock: false,
  reads(state, payload) {
    return dedupeKeys([
      recordKey("motion", payload.motionId),
      ...state.ballots.map((ballot) => recordKey("ballot", ballot.id)),
    ]);
  },
  writes(_state, payload) {
    return [recordKey("motion", payload.motionId)];
  },
  validate(state, payload) {
    const existing = state.motions.find((item) => item.id === payload.motionId);
    if (!existing) {
      return [`Motion ${payload.motionId} does not exist.`];
    }
    const referencedByBallot = state.ballots.some(
      (ballot) => !ballot.discarded && ballot.motionId === payload.motionId,
    );
    if (referencedByBallot) {
      return [
        `Motion ${payload.motionId} is used by a live ballot and cannot be deleted.`,
      ];
    }
    return [];
  },
  apply(state, payload) {
    const index = state.motions.findIndex((item) => item.id === payload.motionId);
    const previous = cloneValue(state.motions[index]!);
    return {
      state: {
        ...state,
        motions: state.motions.filter((item) => item.id !== payload.motionId),
      },
      committedPayload: {
        motionId: payload.motionId,
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
      type: "motion.create",
      payload: {
        motion: cloneValue(committedPayload.previous),
        index: committedPayload.previousIndex,
      },
    };
  },
};

export const motionSetRoundStatusOp: OpDef<MotionSetRoundStatusPayload> = {
  type: "motion.set_round_status",
  permission: "motions.manage",
  category: "motions",
  visibility: "public",
  lock: false,
  reads(state, payload) {
    return dedupeKeys([
      recordKey("round", payload.roundId),
      ...state.rounds.map((round) => recordKey("round", round.id)),
      ...state.motions
        .filter((motion) => motion.rounds?.includes(payload.roundId))
        .map((motion) => recordKey("motion", motion.id)),
    ]);
  },
  writes(state, payload) {
    if (payload.changedMotionIds) {
      return dedupeKeys([
        recordKey("round", payload.roundId),
        ...payload.changedMotionIds.map((id) => recordKey("motion", id)),
      ]);
    }
    if (payload.restoreMotionReleased) {
      return dedupeKeys([
        recordKey("round", payload.roundId),
        ...Object.keys(payload.restoreMotionReleased).map((id) =>
          recordKey("motion", id),
        ),
      ]);
    }
    const round = state.rounds.find((item) => item.id === payload.roundId);
    if (!round) {
      return [recordKey("round", payload.roundId)];
    }
    try {
      const planned = planMotionsStatusChange(round, payload.status, {
        rounds: state.rounds,
        motions: state.motions,
        preferences: state.tournament.preferences,
        now: new Date(payload.now ?? state.tournament.updatedAt),
      });
      return dedupeKeys([
        recordKey("round", payload.roundId),
        ...planned.motions.map((motion) => recordKey("motion", motion.id)),
      ]);
    } catch {
      return [recordKey("round", payload.roundId)];
    }
  },
  validate(state, payload) {
    const round = state.rounds.find((item) => item.id === payload.roundId);
    if (!round) {
      return [`Round ${payload.roundId} does not exist.`];
    }
    if (!MOTIONS_STATUSES.includes(payload.status)) {
      return [`Invalid motions status: ${String(payload.status)}.`];
    }
    if (round.cancelled) {
      return [`${round.name} is cancelled.`];
    }
    if (payload.now !== undefined && !isValidIsoInstant(payload.now)) {
      return ["now must be a valid ISO 8601 instant."];
    }
    const effectiveNow = new Date(payload.now ?? state.tournament.updatedAt);
    try {
      planMotionsStatusChange(round, payload.status, {
        rounds: state.rounds,
        motions: state.motions,
        preferences: state.tournament.preferences,
        now: effectiveNow,
      });
    } catch (error) {
      return [
        error instanceof Error
          ? error.message
          : "Cannot update round motions status.",
      ];
    }
    return [];
  },
  apply(state, payload) {
    const existing = state.rounds.find((item) => item.id === payload.roundId)!;
    const previousStatus = motionsStatusOf(existing);
    const previousMotionsStatusField = existing.motionsStatus ?? null;
    const previousStartsAt = existing.startsAt ?? null;
    const effectiveNow = new Date(payload.now ?? state.tournament.updatedAt);

    const planned = planMotionsStatusChange(existing, payload.status, {
      rounds: state.rounds,
      motions: state.motions,
      preferences: state.tournament.preferences,
      now: effectiveNow,
    });

    const nextRound: OpRound = {
      ...cloneValue(existing),
      ...cloneValue(planned.round),
    };
    if (payload.restoreMotionsStatusField !== undefined) {
      if (payload.restoreMotionsStatusField === null) {
        delete nextRound.motionsStatus;
      } else {
        nextRound.motionsStatus = payload.restoreMotionsStatusField;
      }
    }
    if (payload.restoreStartsAt !== undefined) {
      if (payload.restoreStartsAt === null) {
        delete nextRound.startsAt;
      } else {
        nextRound.startsAt = payload.restoreStartsAt;
      }
    }

    const previousMotionReleased: Record<string, boolean> = {};
    let nextMotions = state.motions;

    if (payload.restoreMotionReleased) {
      const restoreMap = payload.restoreMotionReleased;
      nextMotions = state.motions.map((motion) => {
        if (!Object.prototype.hasOwnProperty.call(restoreMap, motion.id)) {
          return motion;
        }
        previousMotionReleased[motion.id] = motion.released;
        return {
          ...cloneValue(motion),
          released: restoreMap[motion.id]!,
        };
      });
    } else if (planned.motions.length > 0) {
      const changedById = new Map(
        planned.motions.map((motion) => [motion.id, cloneValue(motion)]),
      );
      nextMotions = state.motions.map((motion) => {
        const changed = changedById.get(motion.id);
        if (!changed) {
          return motion;
        }
        previousMotionReleased[motion.id] = motion.released;
        return changed;
      });
    }

    const changedMotionIds = Object.keys(previousMotionReleased);

    return {
      state: {
        ...state,
        rounds: state.rounds.map((item) =>
          item.id === nextRound.id ? nextRound : item,
        ),
        motions: nextMotions,
      },
      committedPayload: {
        ...cloneValue(payload),
        previousStatus,
        previousMotionsStatusField,
        previousStartsAt,
        changedMotionIds,
        previousMotionReleased,
      },
    };
  },
  inverse(committedPayload) {
    if (committedPayload.previousStatus === undefined) {
      return null;
    }
    return {
      type: "motion.set_round_status",
      payload: {
        roundId: committedPayload.roundId,
        status: committedPayload.previousStatus,
        ...(committedPayload.previousMotionsStatusField !== undefined
          ? {
              restoreMotionsStatusField:
                committedPayload.previousMotionsStatusField,
            }
          : {}),
        ...(committedPayload.previousStartsAt !== undefined
          ? { restoreStartsAt: committedPayload.previousStartsAt }
          : {}),
        ...(committedPayload.previousMotionReleased
          ? {
              restoreMotionReleased: cloneValue(
                committedPayload.previousMotionReleased,
              ),
            }
          : {}),
      },
    };
  },
};
