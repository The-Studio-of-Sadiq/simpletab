import { concurrentRounds } from "@/features/tournament/application/schedule";
import {
  checkConcurrentRoundClashes,
  checkDrawConfirmation,
  checkDrawRelease,
  type RuleOverride,
} from "@/features/tournament/application/stateGuards";
import {
  drawStageActions,
  drawStageOf,
  drawStatusAfter,
  type DrawStageAction,
} from "@/lib/draw/drawStatus";
import { validateDraw } from "@/lib/draw/validateDraw";
import type { DrawStatus } from "@/types";
import { cloneValue, dedupeKeys, violationsToErrors } from "../setup/helpers";
import {
  recordKey,
  type OpDef,
  type OpRound,
  type ReleaseGate,
  type TournamentState,
} from "../types";

export interface DrawStagePayload {
  roundId: string;
  override?: RuleOverride;
  restoreDrawStatus?: DrawStatus;
  previousDrawStatus?: DrawStatus;
}

function validateStageAction(
  state: TournamentState,
  round: OpRound,
  action: DrawStageAction,
): string[] {
  const stage = drawStageOf(round);
  if (!drawStageActions(stage).includes(action)) {
    return [
      `Cannot ${action.replace("_", " ")} ${round.name} when draw status is "${stage}".`,
    ];
  }
  return [];
}

function applyStageChange(
  state: TournamentState,
  payload: DrawStagePayload,
  action: DrawStageAction,
) {
  const existing = state.rounds.find((item) => item.id === payload.roundId)!;
  const previousDrawStatus = existing.drawStatus;
  const nextDrawStatus = payload.restoreDrawStatus ?? drawStatusAfter(action);
  const updated: OpRound = {
    ...cloneValue(existing),
    drawStatus: nextDrawStatus,
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
      previousDrawStatus,
    },
  };
}

function makeStageOp(options: {
  type: string;
  action: DrawStageAction;
  releaseGate?: ReleaseGate;
  readsConcurrent?: boolean;
  validateGuards: (state: TournamentState, round: OpRound, payload: DrawStagePayload) => string[];
  makeInverse: (committedPayload: DrawStagePayload) => OpDef<DrawStagePayload>["inverse"] extends (c: DrawStagePayload, s: TournamentState) => infer R ? R : never;
}): OpDef<DrawStagePayload> {
  return {
    type: options.type,
    permission: "draw.release",
    category: "draw",
    visibility: "public",
    ...(options.releaseGate !== undefined ? { releaseGate: options.releaseGate } : {}),
    lock: false,
    reads(state, payload) {
      const round = state.rounds.find((item) => item.id === payload.roundId);
      const relevantRoundIds = new Set<string>([payload.roundId]);
      if (options.readsConcurrent && round) {
        for (const other of concurrentRounds(round, state.rounds)) {
          relevantRoundIds.add(other.id);
        }
      }
      return dedupeKeys([
        recordKey("round", payload.roundId),
        ...state.debates
          .filter((debate) => relevantRoundIds.has(debate.roundId))
          .map((debate) => recordKey("debate", debate.id)),
      ]);
    },
    writes(_state, payload) {
      return [recordKey("round", payload.roundId)];
    },
    validate(state, payload) {
      const round = state.rounds.find((item) => item.id === payload.roundId);
      if (!round) {
        return [`Round ${payload.roundId} does not exist.`];
      }
      const transitionErrors = validateStageAction(state, round, options.action);
      if (transitionErrors.length > 0) {
        return transitionErrors;
      }
      return options.validateGuards(state, round, payload);
    },
    apply(state, payload) {
      return applyStageChange(state, payload, options.action);
    },
    inverse(committedPayload) {
      if (committedPayload.previousDrawStatus === undefined) {
        return null;
      }
      return options.makeInverse(committedPayload);
    },
  };
}

export const drawLockOp: OpDef<DrawStagePayload> = makeStageOp({
  type: "draw.lock",
  action: "lock",
  releaseGate: "draw_released",
  validateGuards(state, round, payload) {
    return violationsToErrors(
      checkDrawConfirmation(round, {
        rounds: state.rounds,
        debates: state.debates,
        ballots: state.ballots,
      }),
      payload.override,
    );
  },
  makeInverse(committedPayload) {
    return {
      type: "draw.unlock",
      payload: {
        roundId: committedPayload.roundId,
        restoreDrawStatus: committedPayload.previousDrawStatus,
      },
    };
  },
});

export const drawUnlockOp: OpDef<DrawStagePayload> = makeStageOp({
  type: "draw.unlock",
  action: "unlock",
  releaseGate: "draw_released",
  validateGuards(_state, round) {
    if (round.cancelled) {
      return [`${round.name} is cancelled.`];
    }
    return [];
  },
  makeInverse(committedPayload) {
    return {
      type: "draw.lock",
      payload: {
        roundId: committedPayload.roundId,
        restoreDrawStatus: committedPayload.previousDrawStatus,
      },
    };
  },
});

function validateDrawReleaseGuards(
  state: TournamentState,
  round: OpRound,
  payload: DrawStagePayload,
): string[] {
  const guardState = {
    rounds: state.rounds,
    debates: state.debates,
    ballots: state.ballots,
  };
  const drawIssues = validateDraw({
    tournament: state.tournament,
    round,
    debates: state.debates,
    rounds: state.rounds,
    teams: state.teams,
    adjudicators: state.adjudicators,
    venues: state.venues,
    ballots: state.ballots,
    institutions: state.institutions,
  });
  return violationsToErrors(
    [
      ...checkDrawRelease(round, guardState, drawIssues),
      ...checkConcurrentRoundClashes(round, guardState),
    ],
    payload.override,
  );
}

export const drawReleaseTeamsOp: OpDef<DrawStagePayload> = makeStageOp({
  type: "draw.release_teams",
  action: "release_teams",
  readsConcurrent: true,
  validateGuards: validateDrawReleaseGuards,
  makeInverse(committedPayload) {
    return {
      type: "draw.unrelease",
      payload: {
        roundId: committedPayload.roundId,
        restoreDrawStatus: committedPayload.previousDrawStatus,
      },
    };
  },
});

export const drawReleaseOp: OpDef<DrawStagePayload> = makeStageOp({
  type: "draw.release",
  action: "release",
  readsConcurrent: true,
  validateGuards: validateDrawReleaseGuards,
  makeInverse(committedPayload) {
    return {
      type: "draw.unrelease",
      payload: {
        roundId: committedPayload.roundId,
        restoreDrawStatus: committedPayload.previousDrawStatus,
      },
    };
  },
});

export const drawUnreleaseOp: OpDef<DrawStagePayload> = makeStageOp({
  type: "draw.unrelease",
  action: "unrelease",
  validateGuards(_state, round) {
    if (round.cancelled) {
      return [`${round.name} is cancelled.`];
    }
    return [];
  },
  makeInverse(committedPayload) {
    const targetType =
      committedPayload.previousDrawStatus === "teams_released"
        ? "draw.release_teams"
        : "draw.release";
    return {
      type: targetType,
      payload: {
        roundId: committedPayload.roundId,
        restoreDrawStatus: committedPayload.previousDrawStatus,
        override: { reason: "Undo draw.unrelease" },
      },
    };
  },
});
