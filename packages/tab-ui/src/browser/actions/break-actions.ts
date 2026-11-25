import {
  getBreakCategoryDeletionBlocker,
  upsertBreakCategory,
  validateBreakCategoryDraft,
  type BreakCategoryDraft,
} from "@simpletab/core/features/tournament/application/breaks";
import { BREAK_OVERRIDE_LABELS } from "@simpletab/core/lib/breakqual/calculator";
import { teamsInDebateFor } from "@simpletab/core/lib/debateSides";
import { recordKey, type RecordKey } from "@simpletab/core/ops";
import type {
  BreakCategory,
  BreakQualificationRule,
  BreakTeamOverride,
} from "@simpletab/core/types";
import type {
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import { t } from "../i18n";
import { stateHasPermission } from "../lib/permissions";
import type { TournamentStoreSnapshot } from "../store/tournament-store";
import { defineAction, type ActionContext } from "./action";

/** Widget id of the Break page. */
export const BREAK_PAGE = "simpletab-break-widget";

const OVERRIDE_OPTIONS: readonly BreakTeamOverride[] = [
  "include",
  "ineligible",
  "withdrawn",
  "different_break",
  "disqualified",
  "lost_coin_toss",
];

function stateOf(ctx: ActionContext): ProjectedState {
  const state = ctx.store.getState();
  if (state === null) {
    throw new Error(t("common.noTournamentPrompt"));
  }
  return state;
}

function versionOf(state: ProjectedState, key: RecordKey): number {
  return state.versions[key] ?? 0;
}

function canManage(snapshot: TournamentStoreSnapshot): boolean {
  return (
    snapshot.state !== null &&
    snapshot.status.open &&
    stateHasPermission(snapshot.state, "break.manage")
  );
}

function ruleLabel(rule: BreakQualificationRule): string {
  switch (rule) {
    case "standard":
      return t("break.ruleStandard");
    case "aida_1996":
      return t("break.ruleAida1996");
    case "aida_2016_australs":
      return t("break.ruleAida2016Australs");
    case "aida_2016_easters":
      return t("break.ruleAida2016Easters");
    case "aida_2019_australs_open":
      return t("break.ruleAida2019AustralsOpen");
  }
}

function availableRules(state: ProjectedState): readonly BreakQualificationRule[] {
  return state.tournament.format === "bp"
    ? ["standard", "aida_1996"]
    : [
        "standard",
        "aida_1996",
        "aida_2016_australs",
        "aida_2016_easters",
        "aida_2019_australs_open",
      ];
}

function defaultDraft(state: ProjectedState): BreakCategoryDraft {
  const teams = teamsInDebateFor(state.tournament);
  return {
    name: "",
    breakSize: teams === 4 ? 8 : 4,
    reserveSize: 0,
    priority: 1,
    isGeneral: false,
    maxPerInstitution: 0,
    qualificationRule: "standard",
    limit: 0,
  };
}

function createCategoryId(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return `bc-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  }
  return `bc-${Date.now()}`;
}

function categoryVersions(
  state: ProjectedState,
  categories: readonly BreakCategory[],
): Record<RecordKey, number> {
  const versions: Record<RecordKey, number> = {};
  for (const cat of state.breakCategories) {
    const key = recordKey("breakCategory", cat.id);
    versions[key] = versionOf(state, key);
  }
  for (const cat of categories) {
    const key = recordKey("breakCategory", cat.id);
    if (!(key in versions) && state.versions[key] !== undefined) {
      versions[key] = state.versions[key]!;
    }
  }
  return versions;
}

/** Asks for a whole number of at least `min`, asking again until it gets one; undefined cancels. */
async function inputInteger(
  ctx: ActionContext,
  label: string,
  value: number,
  min: number,
): Promise<number | undefined> {
  let current = String(value);
  for (;;) {
    const raw = await ctx.prompts.input(label, { value: current });
    if (raw === undefined) {
      return undefined;
    }
    const parsed = Number(raw.trim());
    if (raw.trim().length > 0 && Number.isInteger(parsed) && parsed >= min) {
      return parsed;
    }
    current = raw;
    label = t("action.break.wholeNumberAtLeast", { min });
  }
}

/** The checks the page runs before it saves categories, applied to what the save changes. */
export function categoriesSaveError(
  state: ProjectedState,
  categories: readonly BreakCategory[],
): string | null {
  const kept = new Set(categories.map((cat) => cat.id));
  for (const removed of state.breakCategories.filter((cat) => !kept.has(cat.id))) {
    const blocker = getBreakCategoryDeletionBlocker(removed, state.teams, state.rounds);
    if (blocker.length > 0) {
      return blocker;
    }
  }
  const stored = new Map(state.breakCategories.map((cat) => [cat.id, JSON.stringify(cat)]));
  for (const cat of categories) {
    if (stored.get(cat.id) === JSON.stringify(cat)) {
      continue;
    }
    const error = validateBreakCategoryDraft(
      {
        name: cat.name,
        breakSize: cat.breakSize,
        reserveSize: cat.reserveSize,
        priority: cat.priority,
        isGeneral: cat.isGeneral,
        maxPerInstitution: cat.maxPerInstitution ?? 0,
        qualificationRule: cat.qualificationRule ?? "standard",
        limit: cat.limit ?? 0,
      },
      [...categories],
      teamsInDebateFor(state.tournament),
      cat.id,
    );
    if (error.length > 0) {
      return error;
    }
  }
  return null;
}

async function pickCategory(
  ctx: ActionContext,
  state: ProjectedState,
  placeholder: string,
  include: (category: BreakCategory) => boolean = () => true,
): Promise<string | undefined> {
  return ctx.prompts.pick(
    state.breakCategories.filter(include).map((cat) => ({
      label: cat.name,
      description: cat.id,
      value: cat.id,
    })),
    placeholder,
  );
}

async function pickTeam(
  ctx: ActionContext,
  state: ProjectedState,
  categoryId: string,
): Promise<string | undefined> {
  const category = state.breakCategories.find((item) => item.id === categoryId);
  const teams = state.teams.filter(
    (team) =>
      team.isSwing !== true &&
      (category?.isGeneral === true || team.breakCategories.includes(categoryId)),
  );
  return ctx.prompts.pick(
    teams.map((team) => ({ label: team.name, description: team.id, value: team.id })),
    t("action.break.pickTeam"),
  );
}

async function pickEliminationRound(
  ctx: ActionContext,
  state: ProjectedState,
): Promise<string | undefined> {
  const rounds = state.rounds
    .filter(
      (round) =>
        round.stage === "elimination" &&
        round.cancelled !== true &&
        round.eliminationAdvanced !== true,
    )
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  return ctx.prompts.pick(
    rounds.map((round) => ({
      label: round.name,
      description: String(round.seq),
      value: round.id,
    })),
    t("action.break.pickEliminationRound"),
  );
}

export interface SaveCategoriesArgs {
  categories: BreakCategory[];
}

export const saveBreakCategoriesAction = defineAction<SaveCategoriesArgs, SubmitResult>({
  id: "simpletab.break.save-categories",
  labelKey: "action.break.saveCategories",
  page: BREAK_PAGE,
  isEnabled: canManage,
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const choice =
      state.breakCategories.length === 0
        ? "add"
        : await ctx.prompts.pick(
            [
              { label: t("action.break.addCategory"), value: "add" as const },
              { label: t("action.break.editCategory"), value: "edit" as const },
              { label: t("action.break.deleteCategory"), value: "delete" as const },
            ],
            t("action.break.pickCategoryAction"),
          );
    if (choice === undefined) {
      return undefined;
    }
    if (choice === "delete") {
      const categoryId = await pickCategory(ctx, state, t("action.break.pickCategoryToDelete"));
      if (categoryId === undefined) {
        return undefined;
      }
      const confirmed = await ctx.prompts.confirm(
        t("action.break.confirmDeleteCategoryTitle"),
        t("action.break.confirmDeleteCategoryMessage"),
      );
      return confirmed
        ? { categories: state.breakCategories.filter((item) => item.id !== categoryId) }
        : undefined;
    }

    const editingCategoryId =
      choice === "edit"
        ? await pickCategory(ctx, state, t("action.break.pickCategoryToEdit"))
        : undefined;
    if (choice === "edit" && editingCategoryId === undefined) {
      return undefined;
    }
    const existing = state.breakCategories.find((item) => item.id === editingCategoryId);
    const base = existing ?? defaultDraft(state);
    const name = await ctx.prompts.input(t("action.break.fieldName"), {
      value: existing?.name,
    });
    if (name === undefined || name.trim().length === 0) {
      return undefined;
    }
    const breakSize = await inputInteger(ctx, t("action.break.fieldBreakSize"), base.breakSize, 1);
    const reserveSize = await inputInteger(ctx, t("action.break.fieldReserveSize"), base.reserveSize, 0);
    const priority = await inputInteger(ctx, t("action.break.fieldPriority"), base.priority, Number.MIN_SAFE_INTEGER);
    if (breakSize === undefined || reserveSize === undefined || priority === undefined) {
      return undefined;
    }
    const rule = await ctx.prompts.pick(
      availableRules(state).map((item) => ({ label: ruleLabel(item), value: item })),
      t("action.break.fieldRule"),
    );
    if (rule === undefined) {
      return undefined;
    }
    const cap = await inputInteger(ctx, t("action.break.fieldCap"), base.maxPerInstitution ?? 0, 0);
    const limit = await inputInteger(ctx, t("action.break.fieldLimit"), base.limit ?? 0, 0);
    if (cap === undefined || limit === undefined) {
      return undefined;
    }
    const isGeneral = await ctx.prompts.pick(
      [
        { label: t("common.yes"), value: true },
        { label: t("common.no"), value: false },
      ],
      t("action.break.fieldGeneral"),
    );
    if (isGeneral === undefined) {
      return undefined;
    }
    const draft: BreakCategoryDraft = {
      name: name.trim(),
      breakSize,
      reserveSize,
      priority,
      isGeneral,
      maxPerInstitution: cap,
      qualificationRule: rule,
      limit,
    };
    return {
      categories: upsertBreakCategory(
        state.breakCategories,
        draft,
        state.tournament.id,
        editingCategoryId,
        createCategoryId,
      ),
    };
  },
  run(ctx, { categories }) {
    const state = stateOf(ctx);
    const invalid = categoriesSaveError(state, categories);
    if (invalid !== null) {
      return Promise.resolve({ ok: false, code: "INVALID", errors: [invalid] });
    }
    return ctx.store.submit({
      type: "break.categories_save",
      expectedVersions: categoryVersions(state, categories),
      payload: { categories },
    });
  },
});

export interface SetTeamOverrideArgs {
  categoryId: string;
  teamId: string;
  override: BreakTeamOverride | null;
}

export const setTeamOverrideAction = defineAction<SetTeamOverrideArgs, SubmitResult>({
  id: "simpletab.break.set-team-override",
  labelKey: "action.break.setTeamOverride",
  page: BREAK_PAGE,
  isEnabled: canManage,
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null || state.breakCategories.length === 0) {
      return undefined;
    }
    const categoryId = await pickCategory(ctx, state, t("action.break.pickCategory"));
    if (categoryId === undefined) {
      return undefined;
    }
    const teamId = await pickTeam(ctx, state, categoryId);
    if (teamId === undefined) {
      return undefined;
    }
    const override = await ctx.prompts.pick(
      [
        { label: t("action.break.overrideNone"), value: null },
        ...OVERRIDE_OPTIONS.map((item) => ({
          label: BREAK_OVERRIDE_LABELS[item],
          value: item,
        })),
      ],
      t("action.break.pickOverrideOption"),
    );
    return override === undefined ? undefined : { categoryId, teamId, override };
  },
  run(ctx, { categoryId, teamId, override }) {
    const state = stateOf(ctx);
    const catKey = recordKey("breakCategory", categoryId);
    const teamKey = recordKey("team", teamId);
    return ctx.store.submit({
      type: "break.team_override",
      expectedVersions: {
        [catKey]: versionOf(state, catKey),
        [teamKey]: versionOf(state, teamKey),
      },
      payload: { categoryId, teamId, override },
    });
  },
});

export interface ComputeBreakArgs {
  categoryId: string;
  generatedAt: string;
  reason?: string;
}

export const computeBreakAction = defineAction<ComputeBreakArgs, SubmitResult>({
  id: "simpletab.break.compute-break",
  labelKey: "action.break.computeBreak",
  page: BREAK_PAGE,
  isEnabled: canManage,
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null || state.breakCategories.length === 0) {
      return undefined;
    }
    const categoryId = await pickCategory(ctx, state, t("action.break.pickCategory"));
    if (categoryId === undefined) {
      return undefined;
    }
    const reason = await ctx.prompts.input(t("action.break.overrideReasonPrompt"), {
      optional: true,
    });
    if (reason === undefined) {
      return undefined;
    }
    return {
      categoryId,
      generatedAt: new Date().toISOString(),
      ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}),
    };
  },
  run(ctx, { categoryId, generatedAt, reason }) {
    const state = stateOf(ctx);
    const tournamentKey = recordKey("tournament", state.tournament.id);
    const catKey = recordKey("breakCategory", categoryId);
    return ctx.store.submit({
      type: "break.compute",
      expectedVersions: {
        [tournamentKey]: versionOf(state, tournamentKey),
        [catKey]: versionOf(state, catKey),
      },
      payload: {
        categoryId,
        generatedAt,
        ...(reason !== undefined ? { override: { reason } } : {}),
      },
    });
  },
});

export interface ClearBreakArgs {
  categoryId: string;
}

export const clearBreakAction = defineAction<ClearBreakArgs, SubmitResult>({
  id: "simpletab.break.clear-break",
  labelKey: "action.break.clearBreak",
  page: BREAK_PAGE,
  isEnabled: canManage,
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const categoryId = await pickCategory(
      ctx,
      state,
      t("action.break.pickCategory"),
      (cat) => cat.generatedBreak !== undefined && cat.generatedBreak !== null,
    );
    if (categoryId === undefined) {
      return undefined;
    }
    const confirmed = await ctx.prompts.confirm(
      t("action.break.confirmClearTitle"),
      t("action.break.confirmClearMessage"),
    );
    return confirmed ? { categoryId } : undefined;
  },
  run(ctx, { categoryId }) {
    const state = stateOf(ctx);
    const key = recordKey("breakCategory", categoryId);
    return ctx.store.submit({
      type: "break.clear",
      expectedVersions: { [key]: versionOf(state, key) },
      payload: { categoryId },
    });
  },
});

export interface AdvanceRoundArgs {
  roundId: string;
}

export const advanceRoundAction = defineAction<AdvanceRoundArgs, SubmitResult>({
  id: "simpletab.break.advance-round",
  labelKey: "action.break.advanceRound",
  page: BREAK_PAGE,
  isEnabled: canManage,
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const roundId = await pickEliminationRound(ctx, state);
    if (roundId === undefined) {
      return undefined;
    }
    const confirmed = await ctx.prompts.confirm(
      t("action.break.confirmAdvanceTitle"),
      t("action.break.confirmAdvanceMessage"),
    );
    return confirmed ? { roundId } : undefined;
  },
  run(ctx, { roundId }) {
    const state = stateOf(ctx);
    const key = recordKey("round", roundId);
    return ctx.store.submit({
      type: "elimination.advance",
      expectedVersions: { [key]: versionOf(state, key) },
      payload: { roundId },
    });
  },
});

export const BREAK_ACTIONS = [
  saveBreakCategoriesAction,
  setTeamOverrideAction,
  computeBreakAction,
  clearBreakAction,
  advanceRoundAction,
] as const;
