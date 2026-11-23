import {
  roundResults,
} from "@/features/tournament/application/draws";
import {
  concurrentBookings,
  isEarlierScheduleSlot,
  roundRobinIndex,
} from "@/features/tournament/application/schedule";
import {
  checkDebateEdits,
  checkDrawGeneration,
  type RuleOverride,
} from "@/features/tournament/application/stateGuards";
import {
  moveTeam,
  sameLocation,
  type PickedTeam,
  type TeamLocation,
} from "@/lib/draw/drawEditing";
import { generateRoundDraw } from "@/lib/draw/generator";
import { resolveRecordedSides } from "@/lib/draw/manualSides";
import { legacyRoundRobinInProgress } from "@/lib/draw/roundRobin";
import { orderRoundMotions } from "@/lib/motions/roundMotions";
import { calculateStandings } from "@/lib/standings/calculator";
import type { BallotSubmission, Debate, DebateSide } from "@/types";
import {
  cloneValue,
  dedupeKeys,
  isFiniteNumber,
  isNonEmptyText,
  isValidIsoInstant,
  violationsToErrors,
} from "../setup/helpers";
import {
  recordKey,
  type OpDef,
  type OpRound,
  type RecordKey,
  type TournamentState,
} from "../types";

export interface DrawGeneratePayload {
  roundId: string;
  seed: number;
  discardExisting?: boolean;
  override?: RuleOverride;
  discardedAt?: string;
  generatedDebateIds?: string[];
  previous?: Debate[];
  previousRound?: OpRound;
  discardedBallots?: BallotSubmission[];
  discardedBallotIds?: string[];
}

export interface DrawRestorePayload {
  roundId: string;
  debates: Debate[];
  override?: RuleOverride;
  restoreRound?: OpRound;
  restoreBallots?: BallotSubmission[];
  previous?: Debate[];
  previousRound?: OpRound;
  previousBallots?: BallotSubmission[];
}

export interface DrawUpdateDebatePayload {
  debate: Debate;
  override?: RuleOverride;
  previous?: Debate;
  previousAdjudicatorsRevealed?: boolean | null;
  restoreAdjudicatorsRevealed?: boolean | null;
}

export interface DrawMoveTeamPayload {
  pick: PickedTeam;
  target: TeamLocation;
  override?: RuleOverride;
  restoreDebates?: Debate[];
  previousDebates?: Debate[];
  changedDebateIds?: string[];
}

export interface DebateTeamSlotRef {
  debateId: string;
  side: DebateSide;
}

export interface DrawSwapTeamsPayload {
  slotA: DebateTeamSlotRef;
  slotB: DebateTeamSlotRef;
  override?: RuleOverride;
  restoreDebates?: Debate[];
  previousDebates?: Debate[];
}

interface GeneratedDrawComputation {
  debates: Debate[];
  twoTeamRoundRobin: boolean;
  legacyRoundRobin: boolean;
}

function computeGeneratedDraw(
  state: TournamentState,
  round: OpRound,
  seed: number,
): GeneratedDrawComputation {
  const previousRoundIds = new Set(
    state.rounds
      .filter((item) => !item.cancelled && isEarlierScheduleSlot(item, round))
      .map((item) => item.id),
  );
  const earlierRounds = state.rounds.filter((item) => previousRoundIds.has(item.id));
  const earlierDebates = state.debates.filter((debate) => previousRoundIds.has(debate.roundId));
  const booked = concurrentBookings(round, state.rounds, state.debates);
  const pastDebates = resolveRecordedSides(earlierDebates, state.ballots);
  const standings = calculateStandings(
    state.tournament,
    earlierRounds,
    state.teams,
    earlierDebates,
    state.ballots,
  ).teams;

  const twoTeamRoundRobin =
    round.drawType === "round_robin" && state.tournament.format !== "bp";
  const legacyRoundRobin =
    twoTeamRoundRobin &&
    legacyRoundRobinInProgress(
      round,
      earlierRounds,
      new Set(state.debates.map((debate) => debate.roundId)),
    );

  const venues =
    booked.size > 0
      ? state.venues.filter((venue) => !booked.has(`venue:${venue.id}`))
      : state.venues;

  const rawDebates = generateRoundDraw({
    tournament: state.tournament,
    round,
    teams: state.teams,
    institutions: state.institutions,
    venues,
    pastDebates,
    standings,
    seed,
    roundRobinIndex: roundRobinIndex(round, state.rounds),
    ...(legacyRoundRobin ? { legacyRoundRobin: true } : {}),
  });

  const roundMotionsInOrder = orderRoundMotions(state.motions, round.id);
  const roundMotion =
    roundMotionsInOrder.length === 1 ? roundMotionsInOrder[0] : undefined;

  const debates = rawDebates.map((debate) => {
    const cloned = cloneValue(debate);
    if (roundMotion) {
      cloned.motionId = roundMotion.id;
      cloned.motionText = roundMotion.text;
    }
    return cloned;
  });

  return {
    debates,
    twoTeamRoundRobin,
    legacyRoundRobin,
  };
}

function debateSlotTeamId(debate: Debate, side: DebateSide): string {
  return debate.teams[side]?.teamId ?? "";
}

function debateSlotTeamName(debate: Debate, side: DebateSide): string {
  return debate.teams[side]?.teamName ?? "";
}

function findChangedDebates(
  before: readonly Debate[],
  after: readonly Debate[],
): { beforeChanged: Debate[]; afterChanged: Debate[] } {
  const afterById = new Map(after.map((debate) => [debate.id, debate]));
  const beforeChanged: Debate[] = [];
  const afterChanged: Debate[] = [];
  for (const prev of before) {
    const next = afterById.get(prev.id);
    if (next && next !== prev) {
      beforeChanged.push(prev);
      afterChanged.push(next);
    }
  }
  return { beforeChanged, afterChanged };
}

function applyRestoreDebates(
  existingDebates: readonly Debate[],
  restoreDebates: readonly Debate[],
): { nextDebates: Debate[]; previousDebates: Debate[]; changedDebateIds: string[] } {
  const restoreById = new Map(
    restoreDebates.map((debate) => [debate.id, cloneValue(debate)]),
  );
  const previousDebates: Debate[] = [];
  const changedDebateIds: string[] = [];
  const nextDebates = existingDebates.map((debate) => {
    const restored = restoreById.get(debate.id);
    if (!restored) {
      return debate;
    }
    previousDebates.push(cloneValue(debate));
    changedDebateIds.push(debate.id);
    return restored;
  });
  return { nextDebates, previousDebates, changedDebateIds };
}

export const drawGenerateOp: OpDef<DrawGeneratePayload> = {
  type: "draw.generate",
  permission: "draw.generate",
  category: "draw",
  visibility: "public",
  releaseGate: "draw_released",
  lock: true,
  reads(state, payload) {
    return dedupeKeys([
      recordKey("tournament", state.tournament.id),
      recordKey("round", payload.roundId),
      ...state.rounds.map((round) => recordKey("round", round.id)),
      ...state.teams.map((team) => recordKey("team", team.id)),
      ...state.venues.map((venue) => recordKey("venue", venue.id)),
      ...state.debates.map((debate) => recordKey("debate", debate.id)),
      ...state.ballots.map((ballot) => recordKey("ballot", ballot.id)),
    ]);
  },
  writes(state, payload) {
    const existingRoundDebates = state.debates
      .filter((debate) => debate.roundId === payload.roundId)
      .map((debate) => recordKey("debate", debate.id));
    const generatedKeys = (payload.generatedDebateIds ?? []).map((id) =>
      recordKey("debate", id),
    );
    const discardedBallotKeys = (payload.discardedBallotIds ?? []).map((id) =>
      recordKey("ballot", id),
    );
    return dedupeKeys([
      recordKey("round", payload.roundId),
      ...existingRoundDebates,
      ...generatedKeys,
      ...discardedBallotKeys,
    ]);
  },
  validate(state, payload) {
    const errors: string[] = [];
    const round = state.rounds.find((item) => item.id === payload.roundId);
    if (!round) {
      return [`Round ${payload.roundId} does not exist.`];
    }
    if (!isFiniteNumber(payload.seed)) {
      errors.push("Draw seed must be a finite number.");
    }
    if (state.tournament.format === "poly") {
      errors.push("Only BP and two-team formats are supported.");
    }
    if (payload.discardedAt !== undefined && !isValidIsoInstant(payload.discardedAt)) {
      errors.push("discardedAt must be a valid ISO 8601 instant.");
    }

    errors.push(
      ...violationsToErrors(
        checkDrawGeneration(round, {
          rounds: state.rounds,
          debates: state.debates,
          ballots: state.ballots,
        }),
        payload.override,
      ),
    );

    const existingResults = roundResults(
      payload.roundId,
      state.debates,
      state.ballots,
    );
    if (existingResults.length > 0 && !payload.discardExisting) {
      errors.push(
        `This round already has ${existingResults.length} ballot(s); pass discardExisting: true to discard them.`,
      );
    }

    if (errors.length > 0) {
      return errors;
    }

    try {
      computeGeneratedDraw(state, round, payload.seed);
    } catch (error) {
      errors.push(
        error instanceof Error ? error.message : "Failed to generate draw.",
      );
    }
    return errors;
  },
  apply(state, payload) {
    const round = state.rounds.find((item) => item.id === payload.roundId)!;
    const previousRound = cloneValue(round);
    const previous = cloneValue(
      state.debates.filter((debate) => debate.roundId === payload.roundId),
    );
    const { debates: generated, twoTeamRoundRobin, legacyRoundRobin } =
      computeGeneratedDraw(state, round, payload.seed);

    const updatedRound: OpRound = {
      ...cloneValue(round),
      drawStatus: "draft",
      adjudicatorsRevealed: false,
      drawSeed: payload.seed,
    };
    if (twoTeamRoundRobin && !legacyRoundRobin) {
      updatedRound.roundRobinAlgorithm = "berger_seed";
    } else {
      delete updatedRound.roundRobinAlgorithm;
    }

    const existingResults = roundResults(
      payload.roundId,
      state.debates,
      state.ballots,
    );
    const discardedBallots = cloneValue(existingResults);
    const discardedBallotIds = existingResults.map((ballot) => ballot.id);
    const discardedTimestamp =
      payload.discardedAt ?? state.tournament.updatedAt;
    const discardedById = new Map<string, BallotSubmission>(
      existingResults.map((ballot) => [
        ballot.id,
        {
          ...cloneValue(ballot),
          confirmed: false,
          discarded: true,
          discardedBy: "draw regenerated",
          discardedTimestamp,
        },
      ]),
    );

    const nextBallots =
      discardedById.size > 0
        ? state.ballots.map((ballot) => discardedById.get(ballot.id) ?? ballot)
        : state.ballots;

    const nextDebates = [
      ...state.debates.filter((debate) => debate.roundId !== payload.roundId),
      ...generated,
    ];
    const nextRounds = state.rounds.map((item) =>
      item.id === round.id ? updatedRound : item,
    );

    return {
      state: {
        ...state,
        rounds: nextRounds,
        debates: nextDebates,
        ballots: nextBallots,
      },
      committedPayload: {
        ...cloneValue(payload),
        generatedDebateIds: generated.map((debate) => debate.id),
        previous,
        previousRound,
        ...(discardedBallots.length > 0
          ? { discardedBallots, discardedBallotIds }
          : {}),
      },
    };
  },
  inverse(committedPayload) {
    if (!committedPayload.previous) {
      return null;
    }
    return {
      type: "draw.restore",
      payload: {
        roundId: committedPayload.roundId,
        debates: cloneValue(committedPayload.previous),
        ...(committedPayload.previousRound
          ? { restoreRound: cloneValue(committedPayload.previousRound) }
          : {}),
        ...(committedPayload.discardedBallots &&
        committedPayload.discardedBallots.length > 0
          ? { restoreBallots: cloneValue(committedPayload.discardedBallots) }
          : {}),
        override: { reason: "Undo draw.generate" },
      },
    };
  },
};

export const drawRestoreOp: OpDef<DrawRestorePayload> = {
  type: "draw.restore",
  permission: "draw.generate",
  category: "draw",
  visibility: "public",
  releaseGate: "draw_released",
  lock: false,
  reads(state, payload) {
    const roundBallots = state.ballots
      .filter((ballot) => ballot.roundId === payload.roundId)
      .map((ballot) => recordKey("ballot", ballot.id));
    return dedupeKeys([
      recordKey("round", payload.roundId),
      ...state.debates
        .filter((debate) => debate.roundId === payload.roundId)
        .map((debate) => recordKey("debate", debate.id)),
      ...payload.debates.map((debate) => recordKey("debate", debate.id)),
      ...roundBallots,
    ]);
  },
  writes(state, payload) {
    const existingKeys = state.debates
      .filter((debate) => debate.roundId === payload.roundId)
      .map((debate) => recordKey("debate", debate.id));
    const nextKeys = payload.debates.map((debate) =>
      recordKey("debate", debate.id),
    );
    const ballotKeys = (payload.restoreBallots ?? []).map((ballot) =>
      recordKey("ballot", ballot.id),
    );
    return dedupeKeys([
      ...(payload.restoreRound ? [recordKey("round", payload.roundId)] : []),
      ...existingKeys,
      ...nextKeys,
      ...ballotKeys,
    ]);
  },
  validate(state, payload) {
    const errors: string[] = [];
    const round = state.rounds.find((item) => item.id === payload.roundId);
    if (!round) {
      errors.push(`Round ${payload.roundId} does not exist.`);
    }
    if (!Array.isArray(payload.debates)) {
      errors.push("debates must be an array.");
      return errors;
    }

    const seenIds = new Set<string>();
    for (const debate of payload.debates) {
      if (!isNonEmptyText(debate.id)) {
        errors.push("Restored debate id must not be empty.");
        continue;
      }
      if (seenIds.has(debate.id)) {
        errors.push(`Duplicate debate id in restore payload: ${debate.id}.`);
      }
      seenIds.add(debate.id);
      if (debate.roundId !== payload.roundId) {
        errors.push(
          `Debate ${debate.id} belongs to round ${debate.roundId}, expected ${payload.roundId}.`,
        );
      }
    }
    if (
      payload.restoreRound !== undefined &&
      payload.restoreRound.id !== payload.roundId
    ) {
      errors.push("restoreRound.id must match payload.roundId.");
    }
    if (errors.length > 0 || !round) {
      return errors;
    }

    const existingRoundDebates = state.debates.filter(
      (debate) => debate.roundId === payload.roundId,
    );
    return violationsToErrors(
      checkDebateEdits(existingRoundDebates, payload.debates, {
        rounds: state.rounds,
        ballots: state.ballots,
      }),
      payload.override,
    );
  },
  apply(state, payload) {
    const existingRoundDebates = cloneValue(
      state.debates.filter((debate) => debate.roundId === payload.roundId),
    );
    const restoredDebates = cloneValue(payload.debates);
    const nextDebates = [
      ...state.debates.filter((debate) => debate.roundId !== payload.roundId),
      ...restoredDebates,
    ];

    let nextRounds = state.rounds;
    let previousRound: OpRound | undefined;
    if (payload.restoreRound) {
      const currentRound = state.rounds.find(
        (item) => item.id === payload.roundId,
      )!;
      previousRound = cloneValue(currentRound);
      const restoredRound = cloneValue(payload.restoreRound);
      nextRounds = state.rounds.map((item) =>
        item.id === payload.roundId ? restoredRound : item,
      );
    }

    let nextBallots = state.ballots;
    let previousBallots: BallotSubmission[] | undefined;
    if (payload.restoreBallots && payload.restoreBallots.length > 0) {
      const restoreMap = new Map(
        payload.restoreBallots.map((ballot) => [ballot.id, cloneValue(ballot)]),
      );
      previousBallots = state.ballots
        .filter((ballot) => restoreMap.has(ballot.id))
        .map((ballot) => cloneValue(ballot));
      const replacedIds = new Set<string>();
      nextBallots = state.ballots.map((ballot) => {
        const replacement = restoreMap.get(ballot.id);
        if (!replacement) {
          return ballot;
        }
        replacedIds.add(ballot.id);
        return replacement;
      });
      for (const ballot of payload.restoreBallots) {
        if (!replacedIds.has(ballot.id)) {
          nextBallots = [...nextBallots, cloneValue(ballot)];
        }
      }
    }

    return {
      state: {
        ...state,
        rounds: nextRounds,
        debates: nextDebates,
        ballots: nextBallots,
      },
      committedPayload: {
        ...cloneValue(payload),
        previous: existingRoundDebates,
        ...(previousRound ? { previousRound } : {}),
        ...(previousBallots ? { previousBallots } : {}),
      },
    };
  },
  inverse(committedPayload) {
    if (!committedPayload.previous) {
      return null;
    }
    return {
      type: "draw.restore",
      payload: {
        roundId: committedPayload.roundId,
        debates: cloneValue(committedPayload.previous),
        ...(committedPayload.previousRound
          ? { restoreRound: cloneValue(committedPayload.previousRound) }
          : {}),
        ...(committedPayload.previousBallots &&
        committedPayload.previousBallots.length > 0
          ? { restoreBallots: cloneValue(committedPayload.previousBallots) }
          : {}),
        override: { reason: "Undo draw.restore" },
      },
    };
  },
};

export const drawUpdateDebateOp: OpDef<DrawUpdateDebatePayload> = {
  type: "draw.update_debate",
  permission: "draw.generate",
  category: "draw",
  visibility: "public",
  releaseGate: "draw_released",
  lock: false,
  reads(state, payload) {
    const ballotKeys = state.ballots
      .filter((ballot) => ballot.debateId === payload.debate.id)
      .map((ballot) => recordKey("ballot", ballot.id));
    return dedupeKeys([
      recordKey("debate", payload.debate.id),
      recordKey("round", payload.debate.roundId),
      ...ballotKeys,
    ]);
  },
  writes(state, payload) {
    const existing = state.debates.find((item) => item.id === payload.debate.id);
    const round = state.rounds.find((item) => item.id === payload.debate.roundId);
    const panelChanged =
      existing !== undefined &&
      JSON.stringify(existing.adjudicators) !==
        JSON.stringify(payload.debate.adjudicators);
    const hidesRevealed = panelChanged && round?.adjudicatorsRevealed === true;
    const changesRoundRevealed =
      payload.restoreAdjudicatorsRevealed !== undefined ||
      payload.previousAdjudicatorsRevealed !== undefined ||
      hidesRevealed;
    return dedupeKeys([
      recordKey("debate", payload.debate.id),
      ...(changesRoundRevealed ? [recordKey("round", payload.debate.roundId)] : []),
    ]);
  },
  validate(state, payload) {
    if (!isNonEmptyText(payload.debate.id)) {
      return ["Debate id must not be empty."];
    }
    const existing = state.debates.find((item) => item.id === payload.debate.id);
    if (!existing) {
      return [`Debate ${payload.debate.id} does not exist.`];
    }
    if (payload.debate.roundId !== existing.roundId) {
      return ["Debate roundId cannot be changed."];
    }
    if (!state.rounds.some((round) => round.id === existing.roundId)) {
      return [`Round ${existing.roundId} does not exist.`];
    }
    return violationsToErrors(
      checkDebateEdits([existing], [payload.debate], {
        rounds: state.rounds,
        ballots: state.ballots,
      }),
      payload.override,
    );
  },
  apply(state, payload) {
    const existing = state.debates.find((item) => item.id === payload.debate.id)!;
    const previous = cloneValue(existing);
    const updated = cloneValue(payload.debate);
    const round = state.rounds.find((item) => item.id === existing.roundId)!;
    const panelChanged =
      JSON.stringify(existing.adjudicators) !==
      JSON.stringify(updated.adjudicators);

    let nextRounds = state.rounds;
    let previousAdjudicatorsRevealed: boolean | null | undefined;
    if (payload.restoreAdjudicatorsRevealed !== undefined) {
      previousAdjudicatorsRevealed = round.adjudicatorsRevealed ?? null;
      const nextRound = cloneValue(round);
      if (payload.restoreAdjudicatorsRevealed === null) {
        delete nextRound.adjudicatorsRevealed;
      } else {
        nextRound.adjudicatorsRevealed = payload.restoreAdjudicatorsRevealed;
      }
      nextRounds = state.rounds.map((item) =>
        item.id === round.id ? nextRound : item,
      );
    } else if (panelChanged && round.adjudicatorsRevealed === true) {
      previousAdjudicatorsRevealed = true;
      const nextRound: OpRound = {
        ...cloneValue(round),
        adjudicatorsRevealed: false,
      };
      nextRounds = state.rounds.map((item) =>
        item.id === round.id ? nextRound : item,
      );
    }

    return {
      state: {
        ...state,
        rounds: nextRounds,
        debates: state.debates.map((item) =>
          item.id === updated.id ? updated : item,
        ),
      },
      committedPayload: {
        ...cloneValue(payload),
        debate: cloneValue(updated),
        previous,
        ...(previousAdjudicatorsRevealed !== undefined
          ? { previousAdjudicatorsRevealed }
          : {}),
      },
    };
  },
  inverse(committedPayload) {
    if (!committedPayload.previous) {
      return null;
    }
    return {
      type: "draw.update_debate",
      payload: {
        debate: cloneValue(committedPayload.previous),
        ...(committedPayload.previousAdjudicatorsRevealed !== undefined
          ? {
              restoreAdjudicatorsRevealed:
                committedPayload.previousAdjudicatorsRevealed,
            }
          : {}),
        override: { reason: "Undo draw.update_debate" },
      },
    };
  },
};

export const drawMoveTeamOp: OpDef<DrawMoveTeamPayload> = {
  type: "draw.move_team",
  permission: "draw.generate",
  category: "draw",
  visibility: "public",
  releaseGate: "draw_released",
  lock: false,
  reads(state, payload) {
    const keys: RecordKey[] = [];
    if (payload.restoreDebates) {
      for (const debate of payload.restoreDebates) {
        keys.push(recordKey("debate", debate.id));
        keys.push(recordKey("round", debate.roundId));
      }
      const restoreIds = new Set(payload.restoreDebates.map((debate) => debate.id));
      for (const ballot of state.ballots) {
        if (restoreIds.has(ballot.debateId)) {
          keys.push(recordKey("ballot", ballot.id));
        }
      }
      return dedupeKeys(keys);
    }

    const debateIds = new Set<string>();
    if (payload.pick.from.kind === "slot") {
      debateIds.add(payload.pick.from.debateId);
    } else if (isNonEmptyText(payload.pick.teamId)) {
      keys.push(recordKey("team", payload.pick.teamId));
    }
    if (payload.target.kind === "slot") {
      debateIds.add(payload.target.debateId);
    }
    for (const debateId of debateIds) {
      keys.push(recordKey("debate", debateId));
      const debate = state.debates.find((item) => item.id === debateId);
      if (debate) {
        keys.push(recordKey("round", debate.roundId));
      }
    }
    for (const ballot of state.ballots) {
      if (debateIds.has(ballot.debateId)) {
        keys.push(recordKey("ballot", ballot.id));
      }
    }
    return dedupeKeys(keys);
  },
  writes(_state, payload) {
    if (payload.changedDebateIds) {
      return dedupeKeys(
        payload.changedDebateIds.map((id) => recordKey("debate", id)),
      );
    }
    if (payload.restoreDebates) {
      return dedupeKeys(
        payload.restoreDebates.map((debate) => recordKey("debate", debate.id)),
      );
    }
    const ids: string[] = [];
    if (payload.pick.from.kind === "slot") {
      ids.push(payload.pick.from.debateId);
    }
    if (payload.target.kind === "slot") {
      ids.push(payload.target.debateId);
    }
    return dedupeKeys(ids.map((id) => recordKey("debate", id)));
  },
  validate(state, payload) {
    if (payload.restoreDebates !== undefined) {
      if (!Array.isArray(payload.restoreDebates) || payload.restoreDebates.length === 0) {
        return ["restoreDebates must be a non-empty array."];
      }
      const existingById = new Map(state.debates.map((debate) => [debate.id, debate]));
      const beforeAffected: Debate[] = [];
      for (const restored of payload.restoreDebates) {
        const existing = existingById.get(restored.id);
        if (!existing) {
          return [`Debate ${restored.id} does not exist.`];
        }
        beforeAffected.push(existing);
      }
      return violationsToErrors(
        checkDebateEdits(beforeAffected, payload.restoreDebates, {
          rounds: state.rounds,
          ballots: state.ballots,
        }),
        payload.override,
      );
    }

    if (sameLocation(payload.pick.from, payload.target)) {
      return ["Source and target locations are the same."];
    }
    if (!isNonEmptyText(payload.pick.teamId)) {
      return ["teamId must not be empty."];
    }

    let sourceDebate: Debate | undefined;
    if (payload.pick.from.kind === "slot") {
      const fromSlot = payload.pick.from;
      sourceDebate = state.debates.find((debate) => debate.id === fromSlot.debateId);
      if (!sourceDebate) {
        return [`Debate ${fromSlot.debateId} does not exist.`];
      }
      if (!Object.prototype.hasOwnProperty.call(sourceDebate.teams, fromSlot.side)) {
        return [`Side ${fromSlot.side} does not exist in debate ${fromSlot.debateId}.`];
      }
      if (debateSlotTeamId(sourceDebate, fromSlot.side) !== payload.pick.teamId) {
        return [
          `Team ${payload.pick.teamId} is not in ${fromSlot.debateId} ${fromSlot.side}.`,
        ];
      }
    } else if (!state.teams.some((team) => team.id === payload.pick.teamId)) {
      return [`Team ${payload.pick.teamId} does not exist.`];
    }

    let targetDebate: Debate | undefined;
    if (payload.target.kind === "slot") {
      const targetSlot = payload.target;
      targetDebate = state.debates.find((debate) => debate.id === targetSlot.debateId);
      if (!targetDebate) {
        return [`Debate ${targetSlot.debateId} does not exist.`];
      }
      if (!Object.prototype.hasOwnProperty.call(targetDebate.teams, targetSlot.side)) {
        return [`Side ${targetSlot.side} does not exist in debate ${targetSlot.debateId}.`];
      }
    }

    if (sourceDebate && targetDebate && sourceDebate.roundId !== targetDebate.roundId) {
      return ["Cannot move a team between different rounds."];
    }

    const moved = moveTeam(state.debates, payload.pick, payload.target);
    if (moved.debates === state.debates) {
      return ["Team move produces no change."];
    }
    const { beforeChanged, afterChanged } = findChangedDebates(
      state.debates,
      moved.debates,
    );
    return violationsToErrors(
      checkDebateEdits(beforeChanged, afterChanged, {
        rounds: state.rounds,
        ballots: state.ballots,
      }),
      payload.override,
    );
  },
  apply(state, payload) {
    if (payload.restoreDebates !== undefined) {
      const restored = applyRestoreDebates(state.debates, payload.restoreDebates);
      return {
        state: {
          ...state,
          debates: restored.nextDebates,
        },
        committedPayload: {
          ...cloneValue(payload),
          previousDebates: restored.previousDebates,
          changedDebateIds: restored.changedDebateIds,
        },
      };
    }

    const moved = moveTeam(state.debates, payload.pick, payload.target);
    const { beforeChanged, afterChanged } = findChangedDebates(
      state.debates,
      moved.debates,
    );
    const previousDebates = beforeChanged.map((debate) => cloneValue(debate));
    const changedDebateIds = afterChanged.map((debate) => debate.id);

    return {
      state: {
        ...state,
        debates: moved.debates,
      },
      committedPayload: {
        ...cloneValue(payload),
        previousDebates,
        changedDebateIds,
      },
    };
  },
  inverse(committedPayload) {
    if (!committedPayload.previousDebates || committedPayload.previousDebates.length === 0) {
      return null;
    }
    return {
      type: "draw.move_team",
      payload: {
        pick: {
          teamId: committedPayload.pick.teamId,
          teamName: committedPayload.pick.teamName,
          from: cloneValue(committedPayload.target),
        },
        target: cloneValue(committedPayload.pick.from),
        restoreDebates: cloneValue(committedPayload.previousDebates),
        override: { reason: "Undo draw.move_team" },
      },
    };
  },
};

export const drawSwapTeamsOp: OpDef<DrawSwapTeamsPayload> = {
  type: "draw.swap_teams",
  permission: "draw.generate",
  category: "draw",
  visibility: "public",
  releaseGate: "draw_released",
  lock: false,
  reads(state, payload) {
    const debateIds = new Set([payload.slotA.debateId, payload.slotB.debateId]);
    const keys: RecordKey[] = [
      recordKey("debate", payload.slotA.debateId),
      recordKey("debate", payload.slotB.debateId),
    ];
    for (const debateId of debateIds) {
      const debate = state.debates.find((item) => item.id === debateId);
      if (debate) {
        keys.push(recordKey("round", debate.roundId));
      }
    }
    for (const ballot of state.ballots) {
      if (debateIds.has(ballot.debateId)) {
        keys.push(recordKey("ballot", ballot.id));
      }
    }
    return dedupeKeys(keys);
  },
  writes(_state, payload) {
    return dedupeKeys([
      recordKey("debate", payload.slotA.debateId),
      recordKey("debate", payload.slotB.debateId),
    ]);
  },
  validate(state, payload) {
    if (payload.restoreDebates !== undefined) {
      if (!Array.isArray(payload.restoreDebates) || payload.restoreDebates.length === 0) {
        return ["restoreDebates must be a non-empty array."];
      }
      const existingById = new Map(state.debates.map((debate) => [debate.id, debate]));
      const beforeAffected: Debate[] = [];
      for (const restored of payload.restoreDebates) {
        const existing = existingById.get(restored.id);
        if (!existing) {
          return [`Debate ${restored.id} does not exist.`];
        }
        beforeAffected.push(existing);
      }
      return violationsToErrors(
        checkDebateEdits(beforeAffected, payload.restoreDebates, {
          rounds: state.rounds,
          ballots: state.ballots,
        }),
        payload.override,
      );
    }

    const { slotA, slotB } = payload;
    if (slotA.debateId === slotB.debateId && slotA.side === slotB.side) {
      return ["Cannot swap a debate slot with itself."];
    }
    const debateA = state.debates.find((item) => item.id === slotA.debateId);
    if (!debateA) {
      return [`Debate ${slotA.debateId} does not exist.`];
    }
    const debateB = state.debates.find((item) => item.id === slotB.debateId);
    if (!debateB) {
      return [`Debate ${slotB.debateId} does not exist.`];
    }
    if (debateA.roundId !== debateB.roundId) {
      return ["Cannot swap teams between different rounds."];
    }
    if (!Object.prototype.hasOwnProperty.call(debateA.teams, slotA.side)) {
      return [`Side ${slotA.side} does not exist in debate ${slotA.debateId}.`];
    }
    if (!Object.prototype.hasOwnProperty.call(debateB.teams, slotB.side)) {
      return [`Side ${slotB.side} does not exist in debate ${slotB.debateId}.`];
    }
    const teamAId = debateSlotTeamId(debateA, slotA.side);
    const teamBId = debateSlotTeamId(debateB, slotB.side);
    if (!isNonEmptyText(teamAId) || !isNonEmptyText(teamBId)) {
      return ["Both slots must contain assigned teams to swap."];
    }

    const moved = moveTeam(
      state.debates,
      {
        teamId: teamAId,
        teamName: debateSlotTeamName(debateA, slotA.side),
        from: { kind: "slot", debateId: slotA.debateId, side: slotA.side },
      },
      { kind: "slot", debateId: slotB.debateId, side: slotB.side },
    );
    const { beforeChanged, afterChanged } = findChangedDebates(
      state.debates,
      moved.debates,
    );
    return violationsToErrors(
      checkDebateEdits(beforeChanged, afterChanged, {
        rounds: state.rounds,
        ballots: state.ballots,
      }),
      payload.override,
    );
  },
  apply(state, payload) {
    if (payload.restoreDebates !== undefined) {
      const restored = applyRestoreDebates(state.debates, payload.restoreDebates);
      return {
        state: {
          ...state,
          debates: restored.nextDebates,
        },
        committedPayload: {
          ...cloneValue(payload),
          previousDebates: restored.previousDebates,
        },
      };
    }

    const { slotA, slotB } = payload;
    const debateA = state.debates.find((item) => item.id === slotA.debateId)!;
    const moved = moveTeam(
      state.debates,
      {
        teamId: debateSlotTeamId(debateA, slotA.side),
        teamName: debateSlotTeamName(debateA, slotA.side),
        from: { kind: "slot", debateId: slotA.debateId, side: slotA.side },
      },
      { kind: "slot", debateId: slotB.debateId, side: slotB.side },
    );
    const { beforeChanged } = findChangedDebates(state.debates, moved.debates);

    return {
      state: {
        ...state,
        debates: moved.debates,
      },
      committedPayload: {
        ...cloneValue(payload),
        previousDebates: beforeChanged.map((debate) => cloneValue(debate)),
      },
    };
  },
  inverse(committedPayload) {
    if (!committedPayload.previousDebates || committedPayload.previousDebates.length === 0) {
      return null;
    }
    return {
      type: "draw.swap_teams",
      payload: {
        slotA: cloneValue(committedPayload.slotA),
        slotB: cloneValue(committedPayload.slotB),
        restoreDebates: cloneValue(committedPayload.previousDebates),
        override: { reason: "Undo draw.swap_teams" },
      },
    };
  },
};
