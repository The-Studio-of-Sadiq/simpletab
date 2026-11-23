import {
  validateBreakCategoryDraft,
  withTeamOverride,
  type BreakCategoryDraft,
} from "@/features/tournament/application/breaks";
import {
  checkBreakCategoryDeletion,
  checkBreakClear,
  checkBreakGeneration,
  type RuleOverride,
} from "@/features/tournament/application/stateGuards";
import {
  applyCategoryBreakStatus,
  calculateBreaks,
  snapshotBreak,
  type BreakCategoryResult,
} from "@/lib/breakqual/calculator";
import { teamsInDebateFor } from "@/lib/debateSides";
import {
  applyEliminationAdvancement,
  getAdvancingTeamIds,
} from "@/lib/draw/elimination";
import { getEligibleTeamsForRound } from "@/lib/draw/generator";
import {
  buildBreakCategorySchedule,
  eliminationRoundCount,
} from "@/lib/setup/presets";
import { calculateStandings } from "@/lib/standings/calculator";
import type {
  BreakCategory,
  BreakTeamOverride,
  Team,
} from "@/types";
import {
  cloneValue,
  dedupeKeys,
  isNonEmptyText,
  isValidIsoInstant,
  violationsToErrors,
} from "../setup/helpers";
import {
  recordKey,
  type OpDef,
  type OpRound,
  type TournamentState,
} from "../types";

export interface BreakCategoriesSavePayload {
  categories: BreakCategory[];
  previous?: BreakCategory[];
}

export interface BreakTeamOverridePayload {
  categoryId: string;
  teamId: string;
  override: BreakTeamOverride | null;
  previousOverride?: BreakTeamOverride | null;
  hadTeamOverridesField?: boolean;
  restoreAbsentField?: boolean;
}

export interface BreakComputePayload {
  categoryId: string;
  override?: RuleOverride;
  generatedAt?: string;
  breakingTeamIds?: string[];
  reserveTeamIds?: string[];
  updatedTeamIds?: string[];
  updatedRoundIds?: string[];
}

export interface BreakClearPayload {
  categoryId: string;
  updatedTeamIds?: string[];
  updatedRoundIds?: string[];
}

export interface EliminationAdvancePayload {
  roundId: string;
  nextRoundId?: string | null;
  advancingTeamIds?: string[];
  participatingTeamIds?: string[];
}

const VALID_BREAK_OVERRIDES: ReadonlySet<BreakTeamOverride> = new Set([
  "include",
  "ineligible",
  "withdrawn",
  "different_break",
  "disqualified",
  "lost_coin_toss",
]);

function categoryToDraft(category: BreakCategory): BreakCategoryDraft {
  return {
    name: category.name,
    breakSize: category.breakSize,
    reserveSize: category.reserveSize,
    priority: category.priority,
    isGeneral: category.isGeneral,
    maxPerInstitution: category.maxPerInstitution ?? 0,
    qualificationRule: category.qualificationRule ?? "standard",
    ...(category.limit !== undefined ? { limit: category.limit } : {}),
  };
}

interface PlannedBreakComputation {
  category: BreakCategory;
  categoryResult: BreakCategoryResult;
  updatedRounds: OpRound[];
  firstCategoryRound: OpRound;
  errors: string[];
}

function planBreakComputation(
  state: TournamentState,
  categoryId: string,
  override?: RuleOverride,
): PlannedBreakComputation | { errors: string[] } {
  if (state.tournament.format === "poly") {
    return { errors: ["Only BP and two-team formats are supported."] };
  }
  const category = state.breakCategories.find((item) => item.id === categoryId);
  if (!category) {
    return { errors: [`Break category ${categoryId} does not exist.`] };
  }

  const standings = calculateStandings(
    state.tournament,
    state.rounds,
    state.teams,
    state.debates,
    state.ballots,
  ).teams;

  let breakResults: BreakCategoryResult[];
  try {
    breakResults = calculateBreaks(
      state.breakCategories,
      state.teams,
      standings,
      state.tournament.format,
      state.tournament.preferences.teamStandingsPrecedence,
    );
  } catch (error) {
    return {
      errors: [
        error instanceof Error ? error.message : "Failed to calculate break.",
      ],
    };
  }

  const categoryResult = breakResults.find(
    (result) => result.category.id === categoryId,
  );
  if (!categoryResult) {
    return {
      errors: [`The ${category.name} break has not been calculated yet.`],
    };
  }

  const teamsInDebate = teamsInDebateFor(state.tournament);
  const maxBreakSize = Math.max(
    0,
    ...state.breakCategories.map((item) => item.breakSize),
  );
  const eliminationRounds = state.rounds
    .filter((round) => round.stage === "elimination" && !round.cancelled)
    .sort((left, right) => left.seq - right.seq);
  const roundCount = eliminationRoundCount(maxBreakSize, teamsInDebate);
  if (roundCount === 0) {
    return {
      errors: [
        "No valid elimination-round sequence is configured for these break sizes.",
      ],
    };
  }
  if (eliminationRounds.length < roundCount) {
    return {
      errors: [
        "The pre-created elimination rounds do not cover the configured break size.",
      ],
    };
  }

  const schedule = buildBreakCategorySchedule(
    state.breakCategories,
    roundCount,
    teamsInDebate,
  );
  const roundIndexById = new Map(
    eliminationRounds.map((round, index) => [round.id, index]),
  );
  const updatedRounds: OpRound[] = state.rounds.map((round) => {
    if (round.stage !== "elimination" || round.cancelled) {
      return round;
    }
    const index = roundIndexById.get(round.id);
    if (index === undefined) {
      return round;
    }
    const breakCategoryIds = index < roundCount ? schedule[index] : [];
    const unchanged =
      JSON.stringify(round.breakCategoryIds ?? []) ===
      JSON.stringify(breakCategoryIds);
    return {
      ...cloneValue(round),
      breakCategoryIds,
      eliminationAdvanced: unchanged ? (round.eliminationAdvanced ?? false) : false,
    };
  });

  const guardErrors = violationsToErrors(
    checkBreakGeneration(
      category,
      {
        rounds: state.rounds,
        debates: state.debates,
        ballots: state.ballots,
      },
      updatedRounds,
      categoryResult,
    ),
    override,
  );
  if (guardErrors.length > 0) {
    return { errors: guardErrors };
  }

  const firstCategoryRound = updatedRounds.find(
    (round) =>
      round.stage === "elimination" &&
      round.breakCategoryIds?.includes(categoryId),
  );
  if (!firstCategoryRound) {
    return {
      errors: [
        `${category.name} does not fit the configured elimination-round sequence.`,
      ],
    };
  }

  return {
    category,
    categoryResult,
    updatedRounds,
    firstCategoryRound,
    errors: [],
  };
}

function cleanTeamEliminationField(team: Team): Team {
  if ("eliminatedInRoundId" in team && team.eliminatedInRoundId === undefined) {
    const cleaned = cloneValue(team);
    delete cleaned.eliminatedInRoundId;
    return cleaned;
  }
  return team;
}

export const breakCategoriesSaveOp: OpDef<BreakCategoriesSavePayload> = {
  type: "break.categories_save",
  permission: "break.manage",
  category: "break",
  visibility: "public",
  releaseGate: "break_category_published",
  lock: false,
  reads(state, payload) {
    return dedupeKeys([
      ...state.breakCategories.map((cat) => recordKey("breakCategory", cat.id)),
      ...payload.categories.map((cat) => recordKey("breakCategory", cat.id)),
      ...state.teams.map((team) => recordKey("team", team.id)),
      ...state.rounds.map((round) => recordKey("round", round.id)),
    ]);
  },
  writes(state, payload) {
    return dedupeKeys([
      ...state.breakCategories.map((cat) => recordKey("breakCategory", cat.id)),
      ...payload.categories.map((cat) => recordKey("breakCategory", cat.id)),
    ]);
  },
  validate(state, payload) {
    if (!Array.isArray(payload.categories)) {
      return ["categories must be an array."];
    }
    const errors: string[] = [];
    const seenIds = new Set<string>();
    const teamsInDebate = teamsInDebateFor(state.tournament);

    for (const category of payload.categories) {
      if (!isNonEmptyText(category.id)) {
        errors.push("Break category id must not be empty.");
        continue;
      }
      if (seenIds.has(category.id)) {
        errors.push(`Duplicate break category id: ${category.id}.`);
      }
      seenIds.add(category.id);
      if (!isNonEmptyText(category.slug)) {
        errors.push(`Break category ${category.id} slug must not be empty.`);
      }
      const draftError = validateBreakCategoryDraft(
        categoryToDraft(category),
        payload.categories,
        teamsInDebate,
        category.id,
      );
      if (draftError) {
        errors.push(draftError);
      }
    }

    const removed = state.breakCategories.filter(
      (existing) => !payload.categories.some((next) => next.id === existing.id),
    );
    for (const category of removed) {
      errors.push(
        ...violationsToErrors(
          checkBreakCategoryDeletion(category, state.teams, state.rounds),
        ),
      );
    }

    return errors;
  },
  apply(state, payload) {
    const previous = cloneValue(state.breakCategories);
    const categories = cloneValue(payload.categories);
    return {
      state: {
        ...state,
        breakCategories: categories,
      },
      committedPayload: {
        categories: cloneValue(categories),
        previous,
      },
    };
  },
  inverse(committedPayload) {
    if (!committedPayload.previous) {
      return null;
    }
    return {
      type: "break.categories_save",
      payload: {
        categories: cloneValue(committedPayload.previous),
      },
    };
  },
};

export const breakTeamOverrideOp: OpDef<BreakTeamOverridePayload> = {
  type: "break.team_override",
  permission: "break.manage",
  category: "break",
  visibility: "public",
  releaseGate: "break_category_published",
  lock: false,
  reads(_state, payload) {
    return [
      recordKey("breakCategory", payload.categoryId),
      recordKey("team", payload.teamId),
    ];
  },
  writes(_state, payload) {
    return [recordKey("breakCategory", payload.categoryId)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    if (!isNonEmptyText(payload.categoryId)) {
      errors.push("categoryId must not be empty.");
    } else if (
      !state.breakCategories.some((item) => item.id === payload.categoryId)
    ) {
      errors.push(`Break category ${payload.categoryId} does not exist.`);
    }
    if (!isNonEmptyText(payload.teamId)) {
      errors.push("teamId must not be empty.");
    } else if (!state.teams.some((item) => item.id === payload.teamId)) {
      errors.push(`Team ${payload.teamId} does not exist.`);
    }
    if (
      payload.override !== null &&
      !VALID_BREAK_OVERRIDES.has(payload.override)
    ) {
      errors.push(`Invalid break override: ${String(payload.override)}.`);
    }
    return errors;
  },
  apply(state, payload) {
    const existingCategory = state.breakCategories.find(
      (item) => item.id === payload.categoryId,
    )!;
    const hadTeamOverridesField = existingCategory.teamOverrides !== undefined;
    const previousOverride =
      existingCategory.teamOverrides?.[payload.teamId] ?? null;

    let nextCategories = withTeamOverride(
      cloneValue(state.breakCategories),
      payload.categoryId,
      payload.teamId,
      payload.override,
    );

    if (payload.restoreAbsentField) {
      nextCategories = nextCategories.map((cat) => {
        if (cat.id !== payload.categoryId) {
          return cat;
        }
        if (
          cat.teamOverrides &&
          Object.keys(cat.teamOverrides).length === 0
        ) {
          const cleaned = cloneValue(cat);
          delete cleaned.teamOverrides;
          return cleaned;
        }
        return cat;
      });
    }

    return {
      state: {
        ...state,
        breakCategories: nextCategories,
      },
      committedPayload: {
        ...cloneValue(payload),
        previousOverride,
        hadTeamOverridesField,
      },
    };
  },
  inverse(committedPayload) {
    if (committedPayload.previousOverride === undefined) {
      return null;
    }
    return {
      type: "break.team_override",
      payload: {
        categoryId: committedPayload.categoryId,
        teamId: committedPayload.teamId,
        override: committedPayload.previousOverride,
        ...(committedPayload.hadTeamOverridesField === false
          ? { restoreAbsentField: true }
          : {}),
      },
    };
  },
};

export const breakComputeOp: OpDef<BreakComputePayload> = {
  type: "break.compute",
  permission: "break.manage",
  category: "break",
  visibility: "public",
  releaseGate: "break_category_published",
  lock: true,
  reads(state, payload) {
    return dedupeKeys([
      recordKey("tournament", state.tournament.id),
      recordKey("breakCategory", payload.categoryId),
      ...state.breakCategories.map((cat) => recordKey("breakCategory", cat.id)),
      ...state.teams.map((team) => recordKey("team", team.id)),
      ...state.rounds.map((round) => recordKey("round", round.id)),
      ...state.debates.map((debate) => recordKey("debate", debate.id)),
      ...state.ballots.map((ballot) => recordKey("ballot", ballot.id)),
    ]);
  },
  writes(state, payload) {
    if (payload.updatedTeamIds && payload.updatedRoundIds) {
      return dedupeKeys([
        recordKey("breakCategory", payload.categoryId),
        ...payload.updatedTeamIds.map((id) => recordKey("team", id)),
        ...payload.updatedRoundIds.map((id) => recordKey("round", id)),
      ]);
    }
    const planned = planBreakComputation(
      state,
      payload.categoryId,
      payload.override,
    );
    if ("categoryResult" in planned) {
      const updatedTeams = applyCategoryBreakStatus(
        state.teams,
        planned.categoryResult,
      ).map(cleanTeamEliminationField);
      const updatedTeamIds = updatedTeams
        .filter((team, idx) => team !== state.teams[idx])
        .map((team) => team.id);
      const updatedRoundIds = planned.updatedRounds
        .filter((round, idx) => round !== state.rounds[idx])
        .map((round) => round.id);
      return dedupeKeys([
        recordKey("breakCategory", payload.categoryId),
        ...updatedTeamIds.map((id) => recordKey("team", id)),
        ...updatedRoundIds.map((id) => recordKey("round", id)),
      ]);
    }
    return [recordKey("breakCategory", payload.categoryId)];
  },
  validate(state, payload) {
    if (!isNonEmptyText(payload.categoryId)) {
      return ["categoryId must not be empty."];
    }
    if (
      payload.generatedAt !== undefined &&
      !isValidIsoInstant(payload.generatedAt)
    ) {
      return ["generatedAt must be a valid ISO 8601 instant."];
    }
    const planned = planBreakComputation(
      state,
      payload.categoryId,
      payload.override,
    );
    return planned.errors;
  },
  apply(state, payload) {
    const planned = planBreakComputation(
      state,
      payload.categoryId,
      payload.override,
    );
    if (!("categoryResult" in planned)) {
      throw new Error(planned.errors.join(" "));
    }

    const generatedAt =
      payload.generatedAt ?? state.runtime?.now ?? state.tournament.updatedAt;
    const rawUpdatedTeams = applyCategoryBreakStatus(
      cloneValue(state.teams),
      planned.categoryResult,
    ).map(cleanTeamEliminationField);

    const updatedTeamIds: string[] = [];
    rawUpdatedTeams.forEach((team, idx) => {
      if (JSON.stringify(team) !== JSON.stringify(state.teams[idx])) {
        updatedTeamIds.push(team.id);
      }
    });

    const updatedRoundIds: string[] = [];
    planned.updatedRounds.forEach((round, idx) => {
      if (JSON.stringify(round) !== JSON.stringify(state.rounds[idx])) {
        updatedRoundIds.push(round.id);
      }
    });

    const generated = snapshotBreak(planned.categoryResult, generatedAt);
    const updatedCategories = state.breakCategories.map((item) =>
      item.id === payload.categoryId
        ? { ...cloneValue(item), generatedBreak: generated }
        : item,
    );

    return {
      state: {
        ...state,
        teams: rawUpdatedTeams,
        rounds: planned.updatedRounds,
        breakCategories: updatedCategories,
      },
      committedPayload: {
        ...cloneValue(payload),
        generatedAt,
        breakingTeamIds: [...generated.breakingTeamIds],
        reserveTeamIds: [...generated.reserveTeamIds],
        updatedTeamIds,
        updatedRoundIds,
      },
    };
  },
  inverse(committedPayload) {
    return {
      type: "break.clear",
      payload: {
        categoryId: committedPayload.categoryId,
      },
    };
  },
};

export const breakClearOp: OpDef<BreakClearPayload> = {
  type: "break.clear",
  permission: "break.manage",
  category: "break",
  visibility: "public",
  releaseGate: "break_category_published",
  lock: false,
  reads(state, payload) {
    return dedupeKeys([
      recordKey("breakCategory", payload.categoryId),
      ...state.rounds.map((round) => recordKey("round", round.id)),
      ...state.debates.map((debate) => recordKey("debate", debate.id)),
      ...state.teams.map((team) => recordKey("team", team.id)),
    ]);
  },
  writes(state, payload) {
    if (payload.updatedTeamIds && payload.updatedRoundIds) {
      return dedupeKeys([
        recordKey("breakCategory", payload.categoryId),
        ...payload.updatedTeamIds.map((id) => recordKey("team", id)),
        ...payload.updatedRoundIds.map((id) => recordKey("round", id)),
      ]);
    }
    const teamIds = state.teams
      .filter(
        (team) =>
          team.breakStatus !== undefined ||
          team.breakCategoryIds !== undefined,
      )
      .map((team) => team.id);
    const roundIds = state.rounds
      .filter((round) => round.breakCategoryIds?.includes(payload.categoryId))
      .map((round) => round.id);
    return dedupeKeys([
      recordKey("breakCategory", payload.categoryId),
      ...teamIds.map((id) => recordKey("team", id)),
      ...roundIds.map((id) => recordKey("round", id)),
    ]);
  },
  validate(state, payload) {
    const category = state.breakCategories.find(
      (item) => item.id === payload.categoryId,
    );
    if (!category) {
      return [`Break category ${payload.categoryId} does not exist.`];
    }
    return violationsToErrors(
      checkBreakClear(category, state.rounds, state.debates),
    );
  },
  apply(state, payload) {
    const categories = state.breakCategories.map((item) => {
      if (item.id !== payload.categoryId) {
        return item;
      }
      const next = cloneValue(item);
      delete next.generatedBreak;
      return next;
    });

    const anyBreakLeft = categories.some((item) => item.generatedBreak);
    const updatedTeamIds: string[] = [];
    const teams = state.teams.map((team) => {
      const had = team.breakCategoryIds?.includes(payload.categoryId) ?? false;
      if (!anyBreakLeft) {
        if (
          team.breakStatus === undefined &&
          team.breakCategoryIds === undefined &&
          team.eliminatedInRoundId === undefined
        ) {
          return team;
        }
        updatedTeamIds.push(team.id);
        const cleaned = cloneValue(team);
        delete cleaned.breakStatus;
        delete cleaned.breakCategoryIds;
        delete cleaned.eliminatedInRoundId;
        return cleaned;
      }
      if (!had) {
        return team;
      }
      updatedTeamIds.push(team.id);
      const breakCategoryIds = (team.breakCategoryIds ?? []).filter(
        (id) => id !== payload.categoryId,
      );
      return {
        ...cloneValue(team),
        breakCategoryIds,
        breakStatus:
          breakCategoryIds.length > 0
            ? ("breaking" as const)
            : ("eliminated" as const),
      };
    });

    const updatedRoundIds: string[] = [];
    const rounds = state.rounds.map((round) => {
      if (!round.breakCategoryIds?.includes(payload.categoryId)) {
        return round;
      }
      updatedRoundIds.push(round.id);
      return {
        ...cloneValue(round),
        breakCategoryIds: round.breakCategoryIds.filter(
          (id) => id !== payload.categoryId,
        ),
      };
    });

    return {
      state: {
        ...state,
        breakCategories: categories,
        teams,
        rounds,
      },
      committedPayload: {
        ...cloneValue(payload),
        updatedTeamIds,
        updatedRoundIds,
      },
    };
  },
  inverse() {
    return null;
  },
};

function findNextEliminationRound(
  rounds: readonly OpRound[],
  current: OpRound,
): OpRound | null {
  return (
    rounds
      .filter(
        (item) =>
          item.stage === "elimination" &&
          item.seq > current.seq &&
          !item.cancelled,
      )
      .sort((left, right) => left.seq - right.seq)
      .find(
        (item) =>
          !current.breakCategoryIds?.length ||
          item.breakCategoryIds?.some((id) =>
            current.breakCategoryIds!.includes(id),
          ),
      ) ?? null
  );
}

function validateEliminationAdvance(
  state: TournamentState,
  roundId: string,
): {
  round?: OpRound;
  roundDebates?: typeof state.debates;
  nextRound?: OpRound | null;
  advancingTeamIds?: Set<string>;
  participatingTeamIds?: Set<string>;
  errors: string[];
} {
  const round = state.rounds.find(
    (item) => item.id === roundId && item.stage === "elimination",
  );
  if (!round) {
    return { errors: ["Select an elimination round before proceeding."] };
  }
  if (round.cancelled) {
    return { errors: [`${round.name} is cancelled.`] };
  }
  if (round.eliminationAdvanced) {
    return {
      errors: [`Teams have already advanced from ${round.name}.`],
    };
  }

  const roundDebates = state.debates.filter(
    (debate) => debate.roundId === round.id,
  );
  if (roundDebates.length === 0) {
    return {
      errors: [
        "Generate this elimination round's draw before proceeding.",
      ],
    };
  }

  const expectedTeamIds = new Set(
    getEligibleTeamsForRound(state.teams, round)
      .filter((team) => team.checkedIn !== false)
      .map((team) => team.id),
  );
  const assignedTeamIds = new Set(
    roundDebates.flatMap((debate) =>
      Object.values(debate.teams)
        .map((slot) => slot?.teamId)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  if ([...expectedTeamIds].some((teamId) => !assignedTeamIds.has(teamId))) {
    return {
      errors: [
        "Every eligible team must be assigned to a debate before proceeding.",
      ],
    };
  }
  if ([...assignedTeamIds].some((teamId) => !expectedTeamIds.has(teamId))) {
    return {
      errors: [
        "This round contains a team that did not qualify for this elimination stage.",
      ],
    };
  }

  const nextRound = findNextEliminationRound(state.rounds, round);
  const isFinalRound = nextRound === null;

  try {
    const advancingTeamIds = getAdvancingTeamIds(
      roundDebates,
      state.ballots,
      state.tournament.format,
      isFinalRound,
    );
    return {
      round,
      roundDebates,
      nextRound,
      advancingTeamIds,
      participatingTeamIds: assignedTeamIds,
      errors: [],
    };
  } catch (error) {
    return {
      errors: [
        error instanceof Error
          ? error.message
          : "Cannot advance teams from elimination round.",
      ],
    };
  }
}

export const eliminationAdvanceOp: OpDef<EliminationAdvancePayload> = {
  type: "elimination.advance",
  permission: "break.manage",
  category: "break",
  visibility: "public",
  releaseGate: "draw_released",
  lock: false,
  reads(state, payload) {
    return dedupeKeys([
      recordKey("round", payload.roundId),
      ...state.rounds
        .filter((round) => round.stage === "elimination")
        .map((round) => recordKey("round", round.id)),
      ...state.debates
        .filter((debate) => debate.roundId === payload.roundId)
        .map((debate) => recordKey("debate", debate.id)),
      ...state.ballots
        .filter((ballot) => ballot.roundId === payload.roundId)
        .map((ballot) => recordKey("ballot", ballot.id)),
      ...state.teams.map((team) => recordKey("team", team.id)),
    ]);
  },
  writes(state, payload) {
    if (payload.participatingTeamIds) {
      return dedupeKeys([
        recordKey("round", payload.roundId),
        ...payload.participatingTeamIds.map((id) => recordKey("team", id)),
      ]);
    }
    const roundDebates = state.debates.filter(
      (debate) => debate.roundId === payload.roundId,
    );
    const teamIds = roundDebates.flatMap((debate) =>
      Object.values(debate.teams)
        .map((slot) => slot?.teamId)
        .filter((id): id is string => Boolean(id)),
    );
    return dedupeKeys([
      recordKey("round", payload.roundId),
      ...teamIds.map((id) => recordKey("team", id)),
    ]);
  },
  validate(state, payload) {
    if (!isNonEmptyText(payload.roundId)) {
      return ["roundId must not be empty."];
    }
    return validateEliminationAdvance(state, payload.roundId).errors;
  },
  apply(state, payload) {
    const plan = validateEliminationAdvance(state, payload.roundId);
    if (
      plan.errors.length > 0 ||
      !plan.round ||
      !plan.roundDebates ||
      !plan.advancingTeamIds ||
      !plan.participatingTeamIds
    ) {
      throw new Error(plan.errors.join(" "));
    }

    const updatedTeams = applyEliminationAdvancement(
      cloneValue(state.teams),
      plan.roundDebates,
      plan.advancingTeamIds,
      plan.round.id,
    ).map(cleanTeamEliminationField);

    const updatedRound: OpRound = {
      ...cloneValue(plan.round),
      eliminationAdvanced: true,
      completed: true,
    };

    const nextRounds = state.rounds.map((item) =>
      item.id === updatedRound.id ? updatedRound : item,
    );

    return {
      state: {
        ...state,
        teams: updatedTeams,
        rounds: nextRounds,
      },
      committedPayload: {
        ...cloneValue(payload),
        nextRoundId: plan.nextRound?.id ?? null,
        advancingTeamIds: [...plan.advancingTeamIds],
        participatingTeamIds: [...plan.participatingTeamIds],
      },
    };
  },
  inverse() {
    return null;
  },
};
