import {
  computeAutoAllocation,
  type AutoAllocateSettings,
  type AutoAllocationResult,
} from "@/features/tournament/application/allocation";
import { isEarlierScheduleSlot } from "@/features/tournament/application/schedule";
import {
  checkAutoAllocation,
  checkDebateEdits,
  type RuleOverride,
} from "@/features/tournament/application/stateGuards";
import { calculateStandings } from "@/lib/standings/calculator";
import type { Adjudicator, Debate, DebateAdjudicatorSlot } from "@/types";
import {
  cloneValue,
  dedupeKeys,
  violationsToErrors,
} from "../setup/helpers";
import { recordKey, type OpDef, type OpRound, type TournamentState } from "../types";

export interface DebateVenueSnapshot {
  venueId?: string;
  venueName?: string;
  requiredVenueCategory?: string;
  requiredVenueCapacity?: number;
  requiresAccessibleVenue?: boolean;
  requiresOnlineVenue?: boolean;
  requiresNearTabRoom?: boolean;
}

export interface DebatePanelSnapshot {
  debateId: string;
  adjudicators: DebateAdjudicatorSlot;
  venue?: DebateVenueSnapshot;
}

export interface AllocationAutoPayload {
  roundId: string;
  panelSize: number;
  /**
   * Accepted for compatibility with older callers and ignored: CrabbyTab's allocator is
   * deterministic for a given state, so allocation.auto needs no seed. Do not use it to reorder
   * adjudicators — that would make SimpleTab's allocation differ from CrabbyTab's.
   */
  seed?: number;
  settings?: AutoAllocateSettings;
  override?: RuleOverride;
  previous?: DebatePanelSnapshot[];
  previousAdjudicatorsRevealed?: boolean;
  warnings?: string[];
}

export interface AllocationRestorePayload {
  roundId: string;
  panels: DebatePanelSnapshot[];
  override?: RuleOverride;
  restoreAdjudicatorsRevealed?: boolean;
  previous?: DebatePanelSnapshot[];
  previousAdjudicatorsRevealed?: boolean;
}

export interface AllocationAssignManualPayload {
  debateId: string;
  chairId?: string;
  panellistIds: string[];
  traineeIds: string[];
  override?: RuleOverride;
  previous?: DebateAdjudicatorSlot;
  previousAdjudicatorsRevealed?: boolean | null;
  restoreAdjudicatorsRevealed?: boolean | null;
}

export type AdjudicatorPanelRole = "chair" | "panellist" | "trainee";

export interface AdjudicatorRoomMove {
  adjudicatorId: string;
  fromDebateId: string;
  toDebateId: string;
  toRole: AdjudicatorPanelRole;
}

export interface AllocationSwapRoomsPayload {
  debateIdA: string;
  debateIdB: string;
  moves?: AdjudicatorRoomMove[];
  override?: RuleOverride;
  previousPanelA?: DebateAdjudicatorSlot;
  previousPanelB?: DebateAdjudicatorSlot;
  restorePanelA?: DebateAdjudicatorSlot;
  restorePanelB?: DebateAdjudicatorSlot;
  previousAdjudicatorsRevealed?: boolean | null;
  restoreAdjudicatorsRevealed?: boolean | null;
}

function captureVenueSnapshot(debate: Debate): DebateVenueSnapshot {
  return {
    ...(debate.venueId !== undefined ? { venueId: debate.venueId } : {}),
    ...(debate.venueName !== undefined ? { venueName: debate.venueName } : {}),
    ...(debate.requiredVenueCategory !== undefined
      ? { requiredVenueCategory: debate.requiredVenueCategory }
      : {}),
    ...(debate.requiredVenueCapacity !== undefined
      ? { requiredVenueCapacity: debate.requiredVenueCapacity }
      : {}),
    ...(debate.requiresAccessibleVenue !== undefined
      ? { requiresAccessibleVenue: debate.requiresAccessibleVenue }
      : {}),
    ...(debate.requiresOnlineVenue !== undefined
      ? { requiresOnlineVenue: debate.requiresOnlineVenue }
      : {}),
    ...(debate.requiresNearTabRoom !== undefined
      ? { requiresNearTabRoom: debate.requiresNearTabRoom }
      : {}),
  };
}

function applyVenueSnapshot(debate: Debate, venue: DebateVenueSnapshot): Debate {
  const next = cloneValue(debate);
  const assignOrDelete = <K extends keyof DebateVenueSnapshot>(key: K) => {
    const val = venue[key];
    if (val === undefined) {
      delete next[key];
    } else {
      (next as unknown as Record<string, unknown>)[key] = val;
    }
  };
  assignOrDelete("venueId");
  assignOrDelete("venueName");
  assignOrDelete("requiredVenueCategory");
  assignOrDelete("requiredVenueCapacity");
  assignOrDelete("requiresAccessibleVenue");
  assignOrDelete("requiresOnlineVenue");
  assignOrDelete("requiresNearTabRoom");
  return next;
}

function venueDiffers(before: Debate, after: Debate): boolean {
  return (
    JSON.stringify(captureVenueSnapshot(before)) !==
    JSON.stringify(captureVenueSnapshot(after))
  );
}

function runAutoAllocation(
  state: TournamentState,
  round: OpRound,
  payload: AllocationAutoPayload,
): AutoAllocationResult | null {
  const earlierRoundIds = new Set(
    state.rounds
      .filter((item) => !item.cancelled && isEarlierScheduleSlot(item, round))
      .map((item) => item.id),
  );
  const earlierRounds = state.rounds.filter((item) => earlierRoundIds.has(item.id));
  const earlierDebates = state.debates.filter((debate) =>
    earlierRoundIds.has(debate.roundId),
  );
  const standings = calculateStandings(
    state.tournament,
    earlierRounds,
    state.teams,
    earlierDebates,
    state.ballots,
  ).teams;

  return computeAutoAllocation({
    tournament: state.tournament,
    rounds: state.rounds,
    teams: state.teams,
    debates: state.debates,
    adjudicators: state.adjudicators,
    standings,
    breakCategories: state.breakCategories,
    feedback: state.feedback,
    venues: state.venues,
    institutions: state.institutions,
    roundId: payload.roundId,
    panelSize: payload.panelSize,
    settings: payload.settings,
  });
}

function buildManualPanelSlot(
  payload: Pick<AllocationAssignManualPayload, "chairId" | "panellistIds" | "traineeIds">,
  adjById: ReadonlyMap<string, Adjudicator>,
): DebateAdjudicatorSlot {
  const chair = payload.chairId ? adjById.get(payload.chairId) : undefined;
  return {
    ...(chair ? { chairId: chair.id, chairName: chair.name } : {}),
    panellistIds: [...payload.panellistIds],
    panellistNames: payload.panellistIds.map(
      (id) => adjById.get(id)?.name ?? id,
    ),
    traineeIds: [...payload.traineeIds],
    traineeNames: payload.traineeIds.map((id) => adjById.get(id)?.name ?? id),
  };
}

function panelMemberIdsOfDebate(panel: DebateAdjudicatorSlot): Set<string> {
  const ids = new Set<string>();
  if (panel.chairId) ids.add(panel.chairId);
  for (const id of panel.panellistIds) ids.add(id);
  for (const id of panel.traineeIds) ids.add(id);
  return ids;
}

function existingNameLookup(
  debateA: Debate,
  debateB: Debate,
  adjudicators: readonly Adjudicator[],
): Map<string, string> {
  const names = new Map<string, string>();
  const addFromPanel = (panel: DebateAdjudicatorSlot) => {
    if (panel.chairId) {
      names.set(panel.chairId, panel.chairName ?? panel.chairId);
    }
    panel.panellistIds.forEach((id, idx) => {
      names.set(id, panel.panellistNames[idx] ?? id);
    });
    panel.traineeIds.forEach((id, idx) => {
      names.set(id, panel.traineeNames[idx] ?? id);
    });
  };
  addFromPanel(debateA.adjudicators);
  addFromPanel(debateB.adjudicators);
  for (const adj of adjudicators) {
    names.set(adj.id, adj.name);
  }
  return names;
}

function removeMembersFromPanel(
  panel: DebateAdjudicatorSlot,
  toRemove: ReadonlySet<string>,
  nameOf: (id: string) => string,
): DebateAdjudicatorSlot {
  const keepChair =
    panel.chairId && !toRemove.has(panel.chairId) ? panel.chairId : undefined;
  const panellistIds = panel.panellistIds.filter((id) => !toRemove.has(id));
  const traineeIds = panel.traineeIds.filter((id) => !toRemove.has(id));
  return {
    ...(keepChair ? { chairId: keepChair, chairName: nameOf(keepChair) } : {}),
    panellistIds,
    panellistNames: panellistIds.map(nameOf),
    traineeIds,
    traineeNames: traineeIds.map(nameOf),
  };
}

function addMemberToPanel(
  panel: DebateAdjudicatorSlot,
  adjudicatorId: string,
  role: AdjudicatorPanelRole,
  nameOf: (id: string) => string,
): DebateAdjudicatorSlot {
  if (role === "chair") {
    const panellistIds = panel.chairId
      ? [...panel.panellistIds, panel.chairId]
      : [...panel.panellistIds];
    return {
      chairId: adjudicatorId,
      chairName: nameOf(adjudicatorId),
      panellistIds,
      panellistNames: panellistIds.map(nameOf),
      traineeIds: [...panel.traineeIds],
      traineeNames: [...panel.traineeNames],
    };
  }
  if (role === "panellist") {
    const panellistIds = [...panel.panellistIds, adjudicatorId];
    return {
      ...panel,
      panellistIds,
      panellistNames: panellistIds.map(nameOf),
    };
  }
  const traineeIds = [...panel.traineeIds, adjudicatorId];
  return {
    ...panel,
    traineeIds,
    traineeNames: traineeIds.map(nameOf),
  };
}

function computeSwappedPanels(
  debateA: Debate,
  debateB: Debate,
  moves: readonly AdjudicatorRoomMove[] | undefined,
  adjudicators: readonly Adjudicator[],
): { nextPanelA: DebateAdjudicatorSlot; nextPanelB: DebateAdjudicatorSlot } {
  if (!moves) {
    return {
      nextPanelA: cloneValue(debateB.adjudicators),
      nextPanelB: cloneValue(debateA.adjudicators),
    };
  }

  const names = existingNameLookup(debateA, debateB, adjudicators);
  const nameOf = (id: string) => names.get(id) ?? id;
  const movingFromA = new Set(
    moves
      .filter((move) => move.fromDebateId === debateA.id)
      .map((move) => move.adjudicatorId),
  );
  const movingFromB = new Set(
    moves
      .filter((move) => move.fromDebateId === debateB.id)
      .map((move) => move.adjudicatorId),
  );

  let nextPanelA = removeMembersFromPanel(
    debateA.adjudicators,
    movingFromA,
    nameOf,
  );
  let nextPanelB = removeMembersFromPanel(
    debateB.adjudicators,
    movingFromB,
    nameOf,
  );

  for (const move of moves) {
    if (move.toDebateId === debateA.id) {
      nextPanelA = addMemberToPanel(
        nextPanelA,
        move.adjudicatorId,
        move.toRole,
        nameOf,
      );
    } else {
      nextPanelB = addMemberToPanel(
        nextPanelB,
        move.adjudicatorId,
        move.toRole,
        nameOf,
      );
    }
  }

  return { nextPanelA, nextPanelB };
}

function updateRoundAdjudicatorsRevealed(
  rounds: readonly OpRound[],
  round: OpRound,
  restoreValue: boolean | null | undefined,
): {
  nextRounds: OpRound[];
  previousAdjudicatorsRevealed?: boolean | null;
} {
  if (restoreValue !== undefined) {
    const previousAdjudicatorsRevealed = round.adjudicatorsRevealed ?? null;
    const nextRound = cloneValue(round);
    if (restoreValue === null) {
      delete nextRound.adjudicatorsRevealed;
    } else {
      nextRound.adjudicatorsRevealed = restoreValue;
    }
    return {
      nextRounds: rounds.map((item) =>
        item.id === round.id ? nextRound : item,
      ),
      previousAdjudicatorsRevealed,
    };
  }

  if (round.adjudicatorsRevealed === true) {
    const nextRound: OpRound = {
      ...cloneValue(round),
      adjudicatorsRevealed: false,
    };
    return {
      nextRounds: rounds.map((item) =>
        item.id === round.id ? nextRound : item,
      ),
      previousAdjudicatorsRevealed: true,
    };
  }

  return { nextRounds: [...rounds] };
}

export const allocationAutoOp: OpDef<AllocationAutoPayload> = {
  type: "allocation.auto",
  permission: "allocation.edit",
  category: "allocation",
  visibility: "public",
  releaseGate: "draw_released",
  lock: true,
  reads(state, payload) {
    const roundDebates = state.debates.filter(
      (debate) => debate.roundId === payload.roundId,
    );
    const roundBallots = state.ballots.filter(
      (ballot) => ballot.roundId === payload.roundId,
    );
    return dedupeKeys([
      recordKey("round", payload.roundId),
      ...roundDebates.map((debate) => recordKey("debate", debate.id)),
      ...state.adjudicators.map((adj) => recordKey("adjudicator", adj.id)),
      ...state.venues.map((venue) => recordKey("venue", venue.id)),
      ...roundBallots.map((ballot) => recordKey("ballot", ballot.id)),
    ]);
  },
  writes(state, payload) {
    const round = state.rounds.find((item) => item.id === payload.roundId);
    const roundDebates = state.debates.filter(
      (debate) => debate.roundId === payload.roundId,
    );
    const updatesRound =
      round?.adjudicatorsRevealed === true ||
      payload.previousAdjudicatorsRevealed === true;
    return dedupeKeys([
      ...roundDebates.map((debate) => recordKey("debate", debate.id)),
      ...(updatesRound ? [recordKey("round", payload.roundId)] : []),
    ]);
  },
  validate(state, payload) {
    const errors: string[] = [];
    const round = state.rounds.find((item) => item.id === payload.roundId);
    if (!round) {
      return [`Round ${payload.roundId} does not exist.`];
    }
    if (!Number.isInteger(payload.panelSize) || payload.panelSize < 1) {
      errors.push("panelSize must be a positive integer.");
    }
    const roundDebates = state.debates.filter(
      (debate) => debate.roundId === payload.roundId,
    );
    if (roundDebates.length === 0) {
      errors.push(`${round.name} has no debates to allocate adjudicators to.`);
    }

    errors.push(
      ...violationsToErrors(
        checkAutoAllocation(round, {
          rounds: state.rounds,
          debates: state.debates,
          ballots: state.ballots,
        }),
        payload.override,
      ),
    );
    if (errors.length > 0) {
      return errors;
    }

    try {
      const result = runAutoAllocation(state, round, payload);
      if (!result) {
        errors.push(`No debates found for ${round.name}.`);
      }
    } catch (error) {
      errors.push(
        error instanceof Error
          ? error.message
          : "Failed to allocate adjudicators.",
      );
    }
    return errors;
  },
  apply(state, payload) {
    const round = state.rounds.find((item) => item.id === payload.roundId)!;
    const result = runAutoAllocation(state, round, payload)!;
    const generatedById = new Map(
      result.roundDebates.map((debate) => [debate.id, cloneValue(debate)]),
    );

    const previous: DebatePanelSnapshot[] = [];
    const nextDebates = state.debates.map((debate) => {
      if (debate.roundId !== payload.roundId) {
        return debate;
      }
      const next = generatedById.get(debate.id);
      if (!next) {
        return debate;
      }
      const snapshot: DebatePanelSnapshot = {
        debateId: debate.id,
        adjudicators: cloneValue(debate.adjudicators),
        ...(venueDiffers(debate, next)
          ? { venue: captureVenueSnapshot(debate) }
          : {}),
      };
      previous.push(snapshot);
      return next;
    });

    let nextRounds = state.rounds;
    let previousAdjudicatorsRevealed: boolean | undefined;
    if (round.adjudicatorsRevealed === true) {
      previousAdjudicatorsRevealed = true;
      const updatedRound: OpRound = {
        ...cloneValue(round),
        adjudicatorsRevealed: false,
      };
      nextRounds = state.rounds.map((item) =>
        item.id === round.id ? updatedRound : item,
      );
    }

    return {
      state: {
        ...state,
        rounds: nextRounds,
        debates: nextDebates,
      },
      committedPayload: {
        ...cloneValue(payload),
        previous,
        ...(previousAdjudicatorsRevealed !== undefined
          ? { previousAdjudicatorsRevealed }
          : {}),
        warnings: [...result.details.warnings],
      },
    };
  },
  inverse(committedPayload) {
    if (!committedPayload.previous) {
      return null;
    }
    return {
      type: "allocation.restore",
      payload: {
        roundId: committedPayload.roundId,
        panels: cloneValue(committedPayload.previous),
        ...(committedPayload.previousAdjudicatorsRevealed !== undefined
          ? {
              restoreAdjudicatorsRevealed:
                committedPayload.previousAdjudicatorsRevealed,
            }
          : {}),
        override: { reason: "Undo allocation.auto" },
      },
    };
  },
};

export const allocationRestoreOp: OpDef<AllocationRestorePayload> = {
  type: "allocation.restore",
  permission: "allocation.edit",
  category: "allocation",
  visibility: "public",
  releaseGate: "draw_released",
  lock: false,
  reads(state, payload) {
    const panelIds = new Set(payload.panels.map((panel) => panel.debateId));
    const ballotKeys = state.ballots
      .filter((ballot) => panelIds.has(ballot.debateId))
      .map((ballot) => recordKey("ballot", ballot.id));
    return dedupeKeys([
      recordKey("round", payload.roundId),
      ...payload.panels.map((panel) => recordKey("debate", panel.debateId)),
      ...ballotKeys,
    ]);
  },
  writes(_state, payload) {
    return dedupeKeys([
      ...payload.panels.map((panel) => recordKey("debate", panel.debateId)),
      ...(payload.restoreAdjudicatorsRevealed !== undefined
        ? [recordKey("round", payload.roundId)]
        : []),
    ]);
  },
  validate(state, payload) {
    const round = state.rounds.find((item) => item.id === payload.roundId);
    if (!round) {
      return [`Round ${payload.roundId} does not exist.`];
    }
    if (!Array.isArray(payload.panels)) {
      return ["panels must be an array."];
    }
    const existingById = new Map(state.debates.map((debate) => [debate.id, debate]));
    const seenIds = new Set<string>();
    const beforeAffected: Debate[] = [];
    const afterAffected: Debate[] = [];

    for (const panel of payload.panels) {
      if (seenIds.has(panel.debateId)) {
        return [`Duplicate debateId in panels: ${panel.debateId}.`];
      }
      seenIds.add(panel.debateId);
      const existing = existingById.get(panel.debateId);
      if (!existing) {
        return [`Debate ${panel.debateId} does not exist.`];
      }
      if (existing.roundId !== payload.roundId) {
        return [
          `Debate ${panel.debateId} belongs to round ${existing.roundId}, expected ${payload.roundId}.`,
        ];
      }
      beforeAffected.push(existing);
      const nextBase = panel.venue
        ? applyVenueSnapshot(existing, panel.venue)
        : cloneValue(existing);
      nextBase.adjudicators = cloneValue(panel.adjudicators);
      afterAffected.push(nextBase);
    }

    return violationsToErrors(
      checkDebateEdits(beforeAffected, afterAffected, {
        rounds: state.rounds,
        ballots: state.ballots,
      }),
      payload.override,
    );
  },
  apply(state, payload) {
    const panelByDebateId = new Map(
      payload.panels.map((panel) => [panel.debateId, panel]),
    );
    const previous: DebatePanelSnapshot[] = [];

    const nextDebates = state.debates.map((debate) => {
      const panel = panelByDebateId.get(debate.id);
      if (!panel) {
        return debate;
      }
      previous.push({
        debateId: debate.id,
        adjudicators: cloneValue(debate.adjudicators),
        ...(panel.venue !== undefined
          ? { venue: captureVenueSnapshot(debate) }
          : {}),
      });
      const next = panel.venue
        ? applyVenueSnapshot(debate, panel.venue)
        : cloneValue(debate);
      next.adjudicators = cloneValue(panel.adjudicators);
      return next;
    });

    let nextRounds = state.rounds;
    let previousAdjudicatorsRevealed: boolean | undefined;
    if (payload.restoreAdjudicatorsRevealed !== undefined) {
      const round = state.rounds.find((item) => item.id === payload.roundId)!;
      previousAdjudicatorsRevealed = round.adjudicatorsRevealed ?? false;
      const updatedRound: OpRound = {
        ...cloneValue(round),
        adjudicatorsRevealed: payload.restoreAdjudicatorsRevealed,
      };
      nextRounds = state.rounds.map((item) =>
        item.id === round.id ? updatedRound : item,
      );
    }

    return {
      state: {
        ...state,
        rounds: nextRounds,
        debates: nextDebates,
      },
      committedPayload: {
        ...cloneValue(payload),
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
      type: "allocation.restore",
      payload: {
        roundId: committedPayload.roundId,
        panels: cloneValue(committedPayload.previous),
        ...(committedPayload.previousAdjudicatorsRevealed !== undefined
          ? {
              restoreAdjudicatorsRevealed:
                committedPayload.previousAdjudicatorsRevealed,
            }
          : {}),
        override: { reason: "Undo allocation.restore" },
      },
    };
  },
};

export const allocationAssignManualOp: OpDef<AllocationAssignManualPayload> = {
  type: "allocation.assign_manual",
  permission: "allocation.edit",
  category: "allocation",
  visibility: "public",
  releaseGate: "draw_released",
  lock: false,
  reads(state, payload) {
    const debate = state.debates.find((item) => item.id === payload.debateId);
    const adjIds = [
      ...(payload.chairId ? [payload.chairId] : []),
      ...payload.panellistIds,
      ...payload.traineeIds,
    ];
    const ballotKeys = state.ballots
      .filter((ballot) => ballot.debateId === payload.debateId)
      .map((ballot) => recordKey("ballot", ballot.id));
    return dedupeKeys([
      recordKey("debate", payload.debateId),
      ...(debate ? [recordKey("round", debate.roundId)] : []),
      ...adjIds.map((id) => recordKey("adjudicator", id)),
      ...ballotKeys,
    ]);
  },
  writes(state, payload) {
    const debate = state.debates.find((item) => item.id === payload.debateId);
    const round = debate
      ? state.rounds.find((item) => item.id === debate.roundId)
      : undefined;
    const adjById = new Map(state.adjudicators.map((adj) => [adj.id, adj]));
    const nextAdjudicators = buildManualPanelSlot(payload, adjById);
    const panelChanged =
      debate !== undefined &&
      JSON.stringify(debate.adjudicators) !== JSON.stringify(nextAdjudicators);
    const updatesRound =
      debate !== undefined &&
      (payload.restoreAdjudicatorsRevealed !== undefined ||
        payload.previousAdjudicatorsRevealed !== undefined ||
        (panelChanged && round?.adjudicatorsRevealed === true));
    return dedupeKeys([
      recordKey("debate", payload.debateId),
      ...(updatesRound && debate ? [recordKey("round", debate.roundId)] : []),
    ]);
  },
  validate(state, payload) {
    const debate = state.debates.find((item) => item.id === payload.debateId);
    if (!debate) {
      return [`Debate ${payload.debateId} does not exist.`];
    }
    const round = state.rounds.find((item) => item.id === debate.roundId);
    if (!round) {
      return [`Round ${debate.roundId} does not exist.`];
    }
    if (!Array.isArray(payload.panellistIds) || !Array.isArray(payload.traineeIds)) {
      return ["panellistIds and traineeIds must be arrays."];
    }

    const adjById = new Map(state.adjudicators.map((adj) => [adj.id, adj]));
    const errors: string[] = [];
    const seen = new Set<string>();
    const checkId = (id: string, roleLabel: string) => {
      if (!adjById.has(id)) {
        errors.push(`Adjudicator ${id} (${roleLabel}) does not exist.`);
      }
      if (seen.has(id)) {
        errors.push(`Adjudicator ${id} cannot appear twice on the same panel.`);
      }
      seen.add(id);
    };

    if (payload.chairId !== undefined && payload.chairId !== "") {
      checkId(payload.chairId, "chair");
    }
    for (const id of payload.panellistIds) {
      checkId(id, "panellist");
    }
    for (const id of payload.traineeIds) {
      checkId(id, "trainee");
    }
    if (errors.length > 0) {
      return errors;
    }

    const nextDebate: Debate = {
      ...cloneValue(debate),
      adjudicators: buildManualPanelSlot(payload, adjById),
    };
    return violationsToErrors(
      checkDebateEdits([debate], [nextDebate], {
        rounds: state.rounds,
        ballots: state.ballots,
      }),
      payload.override,
    );
  },
  apply(state, payload) {
    const existing = state.debates.find((item) => item.id === payload.debateId)!;
    const round = state.rounds.find((item) => item.id === existing.roundId)!;
    const adjById = new Map(state.adjudicators.map((adj) => [adj.id, adj]));
    const previous = cloneValue(existing.adjudicators);
    const nextAdjudicators = buildManualPanelSlot(payload, adjById);
    const panelChanged =
      JSON.stringify(existing.adjudicators) !== JSON.stringify(nextAdjudicators);

    const updatedDebate: Debate = {
      ...cloneValue(existing),
      adjudicators: nextAdjudicators,
    };

    let nextRounds = state.rounds;
    let previousAdjudicatorsRevealed: boolean | null | undefined;
    if (payload.restoreAdjudicatorsRevealed !== undefined || panelChanged) {
      const roundUpdate = updateRoundAdjudicatorsRevealed(
        state.rounds,
        round,
        payload.restoreAdjudicatorsRevealed,
      );
      nextRounds = roundUpdate.nextRounds;
      previousAdjudicatorsRevealed = roundUpdate.previousAdjudicatorsRevealed;
    }

    return {
      state: {
        ...state,
        rounds: nextRounds,
        debates: state.debates.map((item) =>
          item.id === updatedDebate.id ? updatedDebate : item,
        ),
      },
      committedPayload: {
        ...cloneValue(payload),
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
      type: "allocation.assign_manual",
      payload: {
        debateId: committedPayload.debateId,
        ...(committedPayload.previous.chairId
          ? { chairId: committedPayload.previous.chairId }
          : {}),
        panellistIds: [...committedPayload.previous.panellistIds],
        traineeIds: [...committedPayload.previous.traineeIds],
        ...(committedPayload.previousAdjudicatorsRevealed !== undefined
          ? {
              restoreAdjudicatorsRevealed:
                committedPayload.previousAdjudicatorsRevealed,
            }
          : {}),
        override: { reason: "Undo allocation.assign_manual" },
      },
    };
  },
};

export const allocationSwapRoomsOp: OpDef<AllocationSwapRoomsPayload> = {
  type: "allocation.swap_rooms",
  permission: "allocation.edit",
  category: "allocation",
  visibility: "public",
  releaseGate: "draw_released",
  lock: false,
  reads(state, payload) {
    const debateA = state.debates.find((item) => item.id === payload.debateIdA);
    const debateB = state.debates.find((item) => item.id === payload.debateIdB);
    const roundIds = [
      ...(debateA ? [recordKey("round", debateA.roundId)] : []),
      ...(debateB ? [recordKey("round", debateB.roundId)] : []),
    ];
    const ballotKeys = state.ballots
      .filter(
        (ballot) =>
          ballot.debateId === payload.debateIdA ||
          ballot.debateId === payload.debateIdB,
      )
      .map((ballot) => recordKey("ballot", ballot.id));
    return dedupeKeys([
      recordKey("debate", payload.debateIdA),
      recordKey("debate", payload.debateIdB),
      ...roundIds,
      ...ballotKeys,
    ]);
  },
  writes(state, payload) {
    const debateA = state.debates.find((item) => item.id === payload.debateIdA);
    const round = debateA
      ? state.rounds.find((item) => item.id === debateA.roundId)
      : undefined;
    const updatesRound =
      debateA !== undefined &&
      (payload.restoreAdjudicatorsRevealed !== undefined ||
        payload.previousAdjudicatorsRevealed !== undefined ||
        round?.adjudicatorsRevealed === true);
    return dedupeKeys([
      recordKey("debate", payload.debateIdA),
      recordKey("debate", payload.debateIdB),
      ...(updatesRound && debateA ? [recordKey("round", debateA.roundId)] : []),
    ]);
  },
  validate(state, payload) {
    if (payload.debateIdA === payload.debateIdB) {
      return ["debateIdA and debateIdB must be different debates."];
    }
    const debateA = state.debates.find((item) => item.id === payload.debateIdA);
    if (!debateA) {
      return [`Debate ${payload.debateIdA} does not exist.`];
    }
    const debateB = state.debates.find((item) => item.id === payload.debateIdB);
    if (!debateB) {
      return [`Debate ${payload.debateIdB} does not exist.`];
    }
    if (debateA.roundId !== debateB.roundId) {
      return ["Cannot swap adjudicators between different rounds."];
    }

    if (payload.restorePanelA && payload.restorePanelB) {
      const nextA: Debate = {
        ...cloneValue(debateA),
        adjudicators: cloneValue(payload.restorePanelA),
      };
      const nextB: Debate = {
        ...cloneValue(debateB),
        adjudicators: cloneValue(payload.restorePanelB),
      };
      return violationsToErrors(
        checkDebateEdits([debateA, debateB], [nextA, nextB], {
          rounds: state.rounds,
          ballots: state.ballots,
        }),
        payload.override,
      );
    }

    if (payload.moves !== undefined) {
      if (!Array.isArray(payload.moves) || payload.moves.length === 0) {
        return ["moves must be a non-empty array when provided."];
      }
      const membersA = panelMemberIdsOfDebate(debateA.adjudicators);
      const membersB = panelMemberIdsOfDebate(debateB.adjudicators);
      const movedIds = new Set<string>();
      const chairTargetDebates = new Set<string>();

      for (const move of payload.moves) {
        const validPair =
          (move.fromDebateId === debateA.id && move.toDebateId === debateB.id) ||
          (move.fromDebateId === debateB.id && move.toDebateId === debateA.id);
        if (!validPair) {
          return [
            `Move for ${move.adjudicatorId} must go between ${debateA.id} and ${debateB.id}.`,
          ];
        }
        if (
          move.toRole !== "chair" &&
          move.toRole !== "panellist" &&
          move.toRole !== "trainee"
        ) {
          return [`Invalid target role: ${String(move.toRole)}.`];
        }
        if (movedIds.has(move.adjudicatorId)) {
          return [`Adjudicator ${move.adjudicatorId} appears in multiple moves.`];
        }
        movedIds.add(move.adjudicatorId);
        const sourceMembers = move.fromDebateId === debateA.id ? membersA : membersB;
        if (!sourceMembers.has(move.adjudicatorId)) {
          return [
            `Adjudicator ${move.adjudicatorId} is not assigned to debate ${move.fromDebateId}.`,
          ];
        }
        if (move.toRole === "chair") {
          if (chairTargetDebates.has(move.toDebateId)) {
            return [`Cannot move multiple chairs into debate ${move.toDebateId}.`];
          }
          chairTargetDebates.add(move.toDebateId);
        }
      }
    }

    const { nextPanelA, nextPanelB } = computeSwappedPanels(
      debateA,
      debateB,
      payload.moves,
      state.adjudicators,
    );
    const nextA: Debate = { ...cloneValue(debateA), adjudicators: nextPanelA };
    const nextB: Debate = { ...cloneValue(debateB), adjudicators: nextPanelB };
    return violationsToErrors(
      checkDebateEdits([debateA, debateB], [nextA, nextB], {
        rounds: state.rounds,
        ballots: state.ballots,
      }),
      payload.override,
    );
  },
  apply(state, payload) {
    const debateA = state.debates.find((item) => item.id === payload.debateIdA)!;
    const debateB = state.debates.find((item) => item.id === payload.debateIdB)!;
    const round = state.rounds.find((item) => item.id === debateA.roundId)!;
    const previousPanelA = cloneValue(debateA.adjudicators);
    const previousPanelB = cloneValue(debateB.adjudicators);

    const { nextPanelA, nextPanelB } =
      payload.restorePanelA && payload.restorePanelB
        ? {
            nextPanelA: cloneValue(payload.restorePanelA),
            nextPanelB: cloneValue(payload.restorePanelB),
          }
        : computeSwappedPanels(debateA, debateB, payload.moves, state.adjudicators);

    const nextDebateA: Debate = {
      ...cloneValue(debateA),
      adjudicators: nextPanelA,
    };
    const nextDebateB: Debate = {
      ...cloneValue(debateB),
      adjudicators: nextPanelB,
    };

    const panelChanged =
      JSON.stringify(previousPanelA) !== JSON.stringify(nextPanelA) ||
      JSON.stringify(previousPanelB) !== JSON.stringify(nextPanelB);

    let nextRounds = state.rounds;
    let previousAdjudicatorsRevealed: boolean | null | undefined;
    if (payload.restoreAdjudicatorsRevealed !== undefined || panelChanged) {
      const roundUpdate = updateRoundAdjudicatorsRevealed(
        state.rounds,
        round,
        payload.restoreAdjudicatorsRevealed,
      );
      nextRounds = roundUpdate.nextRounds;
      previousAdjudicatorsRevealed = roundUpdate.previousAdjudicatorsRevealed;
    }

    return {
      state: {
        ...state,
        rounds: nextRounds,
        debates: state.debates.map((item) => {
          if (item.id === nextDebateA.id) return nextDebateA;
          if (item.id === nextDebateB.id) return nextDebateB;
          return item;
        }),
      },
      committedPayload: {
        ...cloneValue(payload),
        previousPanelA,
        previousPanelB,
        ...(previousAdjudicatorsRevealed !== undefined
          ? { previousAdjudicatorsRevealed }
          : {}),
      },
    };
  },
  inverse(committedPayload) {
    if (!committedPayload.previousPanelA || !committedPayload.previousPanelB) {
      return null;
    }
    return {
      type: "allocation.swap_rooms",
      payload: {
        debateIdA: committedPayload.debateIdA,
        debateIdB: committedPayload.debateIdB,
        restorePanelA: cloneValue(committedPayload.previousPanelA),
        restorePanelB: cloneValue(committedPayload.previousPanelB),
        ...(committedPayload.previousAdjudicatorsRevealed !== undefined
          ? {
              restoreAdjudicatorsRevealed:
                committedPayload.previousAdjudicatorsRevealed,
            }
          : {}),
        override: { reason: "Undo allocation.swap_rooms" },
      },
    };
  },
};
