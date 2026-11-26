import {
  buildBreakCategories,
  getRulesPreset,
  RULES_PRESETS,
  slugify,
  validateSlug,
  type RulesPreset,
} from "@simpletab/core/lib/setup/presets";
import { SIDE_NAME_OPTIONS, SIDE_NAME_SETS } from "@simpletab/core/lib/sideNames";
import type { BreakCategory, SideNames, TournamentPreferences } from "@simpletab/core/types";
import type {
  CreateTournamentParams,
  CreateTournamentResult,
  HostStatus,
  SimpleTabFormatChoice,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import { t } from "../i18n";
import type { ActionContext, SimpleTabAction } from "./action";
import { defineAction } from "./action";
import { saveBreakCategoriesAction } from "./break-actions";
import { isExtensionsLoadedError } from "./extensions-actions";
import { inputNumber, inputRequired, pickYesNo } from "./prompt-helpers";

export const SETUP_PAGE = "simpletab-setup-widget";

export type SettingsFieldKey =
  | "name"
  | "minSpeakerScore"
  | "maxSpeakerScore"
  | "stepSpeakerScore"
  | "minReplyScore"
  | "maxReplyScore"
  | "sideNames"
  | "prelimRounds"
  | "breakSize";

export function mapSettingsErrorToField(
  message: string,
  target: Partial<Record<SettingsFieldKey, string[]>>,
): void {
  const lower = message.toLowerCase();
  const add = (field: SettingsFieldKey, text: string): void => {
    target[field] = [...(target[field] ?? []), text];
  };
  if (lower.includes("tournament name")) add("name", message);
  if (lower.includes("minspeakerscore")) add("minSpeakerScore", message);
  if (lower.includes("maxspeakerscore")) add("maxSpeakerScore", message);
  if (lower.includes("stepspeakerscore")) add("stepSpeakerScore", message);
  if (lower.includes("minreplyscore")) add("minReplyScore", message);
  if (lower.includes("maxreplyscore")) add("maxReplyScore", message);
  if (lower.includes("sidenames")) add("sideNames", message);
  if (lower.includes("preliminary round")) add("prelimRounds", message);
  if (lower.includes("break size") || lower.includes("break sizes")) add("breakSize", message);
}

function presetsForFormat(format: SimpleTabFormatChoice): RulesPreset[] {
  return RULES_PRESETS.filter((preset) => {
    if (preset.format === "poly") return false;
    return format === "bp" ? preset.format === "bp" : preset.format !== "bp";
  });
}

export interface CreateTournamentInput extends CreateTournamentParams {}

export function validateCreateInput(input: CreateTournamentInput): {
  name?: string;
  slug?: string;
  prelimRounds?: string;
} {
  const errors: { name?: string; slug?: string; prelimRounds?: string } = {};
  if (input.name.trim().length === 0) errors.name = t("setup.nameRequired");
  const slugError = validateSlug(input.slug.trim());
  if (slugError.length > 0) errors.slug = slugError;
  const prelimRounds = input.prelimRounds ?? Number.NaN;
  if (!Number.isInteger(prelimRounds) || prelimRounds < 0 || prelimRounds > 20) {
    errors.prelimRounds = t("setup.prelimRoundsError");
  }
  return errors;
}

export type CreateTournamentActionResult =
  | { ok: true; result: CreateTournamentResult }
  | { ok: false; code: "INVALID"; errors: string[] };

export type OpenTournamentActionResult =
  | { ok: true; status: HostStatus }
  | { ok: false; code: "INVALID"; errors: string[] };

/**
 * The backend refuses to host while extensions are loaded. Replace its English protocol error
 * with the translated instruction; every other error keeps its existing behaviour.
 */
function refusalResult(error: unknown): { ok: false; code: "INVALID"; errors: string[] } | null {
  const message = error instanceof Error ? error.message : String(error);
  return isExtensionsLoadedError(message)
    ? { ok: false, code: "INVALID", errors: [t("extensions.refusedToHost")] }
    : null;
}

export const createTournamentAction: SimpleTabAction<CreateTournamentInput, CreateTournamentActionResult> = defineAction({
  id: "simpletab.setup.create-tournament",
  labelKey: "action.setup.createTournament",
  page: SETUP_PAGE,
  // The Setup page always shows the create form and the Open button.
  isEnabled: () => true,
  prompt: async (ctx) => {
    const name = await inputRequired(ctx, t("setup.nameLabel"), undefined);
    if (name === undefined) return undefined;
    const slug = await ctx.prompts.input(t("setup.slugLabel"), { value: slugify(name.trim()) });
    if (slug === undefined) return undefined;
    const format = await ctx.prompts.pick(
      [
        { label: t("setup.formatBp"), value: "bp" as const },
        { label: t("setup.formatTwoTeam"), value: "two-team" as const },
      ],
      t("setup.formatLegend"),
    );
    if (format === undefined) return undefined;
    const presets = presetsForFormat(format);
    const presetId = await ctx.prompts.pick(
      presets.map((preset) => ({ label: preset.label, value: preset.id })),
      t("setup.presetLabel"),
    );
    if (presetId === undefined) return undefined;
    const prelimRounds = await inputNumber(ctx, t("setup.prelimRoundsLabel"), 4, {
      integer: true,
      min: 0,
      max: 20,
    });
    if (prelimRounds === undefined) return undefined;
    const directory = await ctx.prompts.input(t("setup.directoryLabel"), { optional: true });
    if (directory === undefined) return undefined;
    return {
      name,
      slug,
      format,
      presetId: getRulesPreset(presetId)?.id ?? presets[0]?.id ?? "bp",
      prelimRounds,
      directory,
    };
  },
  run: async (ctx, args) => {
    const fieldErrors = validateCreateInput(args);
    const errors = Object.values(fieldErrors);
    if (errors.length > 0) return { ok: false, code: "INVALID", errors };
    const params: CreateTournamentParams = {
      name: args.name.trim(),
      slug: args.slug.trim(),
      format: args.format,
      presetId: args.presetId,
      prelimRounds: args.prelimRounds,
      directory: args.directory.trim(),
    };
    try {
      const result = await ctx.store.createTournament(params);
      return { ok: true, result };
    } catch (error) {
      const refused = refusalResult(error);
      if (refused !== null) return refused;
      throw error;
    }
  },
});

export const openTournamentAction: SimpleTabAction<{ dbPath: string }, OpenTournamentActionResult> = defineAction({
  id: "simpletab.setup.open-tournament",
  labelKey: "action.setup.openTournament",
  page: SETUP_PAGE,
  isEnabled: () => true,
  prompt: async (ctx) => {
    // Picked, not typed, as on the page: a typed path that does not exist would create a new file.
    const dbPath = await ctx.prompts.pickFile(t("setup.openExisting"), ["db"]);
    return dbPath === undefined ? undefined : { dbPath };
  },
  run: async (ctx, args) => {
    try {
      return { ok: true, status: await ctx.store.openTournament(args.dbPath) };
    } catch (error) {
      const refused = refusalResult(error);
      if (refused !== null) return refused;
      throw error;
    }
  },
});

export interface SaveSettingsInput {
  name: string;
  minSpeakerScore: number;
  maxSpeakerScore: number;
  stepSpeakerScore: number;
  minReplyScore: number;
  maxReplyScore: number;
  replyScoresEnabled: boolean;
  sideNames: SideNames;
  prelimRounds: number;
  breakSize: number;
}

export type SaveSettingsResult =
  | { ok: true; seq: number; unchanged: boolean }
  | {
      ok: false;
      code: "INVALID";
      errors: string[];
      fieldErrors: Partial<Record<SettingsFieldKey, string[]>>;
    };

export const saveSettingsAction: SimpleTabAction<SaveSettingsInput, SaveSettingsResult> = defineAction({
  id: "simpletab.setup.save-settings",
  labelKey: "action.setup.saveSettings",
  page: SETUP_PAGE,
  isEnabled: (snapshot) => snapshot.state !== null,
  prompt: async (ctx) => {
    const state = ctx.store.getState();
    if (state === null) return undefined;
    const prefs = state.tournament.preferences;
    const currentBreak = state.breakCategories.find((cat) => cat.isGeneral) ?? state.breakCategories[0];
    const currentPrelims = state.rounds.filter(
      (round) => round.stage === "preliminary" && !round.cancelled,
    ).length;
    const name = await inputRequired(ctx, t("setup.nameLabel"), state.tournament.name);
    if (name === undefined) return undefined;
    const minSpeakerScore = await inputNumber(ctx, t("setup.minSpeakerScore"), prefs.minSpeakerScore);
    if (minSpeakerScore === undefined) return undefined;
    const maxSpeakerScore = await inputNumber(ctx, t("setup.maxSpeakerScore"), prefs.maxSpeakerScore);
    if (maxSpeakerScore === undefined) return undefined;
    const stepSpeakerScore = await inputNumber(ctx, t("setup.stepSpeakerScore"), prefs.stepSpeakerScore);
    if (stepSpeakerScore === undefined) return undefined;
    // Reply scores and side names are on the form only for two-team formats.
    const twoTeam = state.tournament.format !== "bp";
    const replyScoresEnabled = twoTeam
      ? await pickYesNo(ctx, t("setup.replyScoresEnabled"), prefs.replyScoresEnabled)
      : prefs.replyScoresEnabled;
    if (replyScoresEnabled === undefined) return undefined;
    const minReplyScore = twoTeam
      ? await inputNumber(ctx, t("setup.minReplyScore"), prefs.minReplyScore)
      : prefs.minReplyScore;
    if (minReplyScore === undefined) return undefined;
    const maxReplyScore = twoTeam
      ? await inputNumber(ctx, t("setup.maxReplyScore"), prefs.maxReplyScore)
      : prefs.maxReplyScore;
    if (maxReplyScore === undefined) return undefined;
    const sideNames = state.tournament.format !== "bp"
      ? await ctx.prompts.pick(
          SIDE_NAME_OPTIONS.map((option) => ({ label: SIDE_NAME_SETS[option].label, value: option })),
          t("setup.sideNamesLabel"),
        )
      : prefs.sideNames ?? "aff-neg";
    if (sideNames === undefined) return undefined;
    const prelimRounds = await inputNumber(ctx, t("setup.prelimRoundsLabel"), currentPrelims, {
      integer: true,
      min: 0,
    });
    if (prelimRounds === undefined) return undefined;
    const breakSize = await inputNumber(
      ctx,
      t("setup.breakSizeLabel"),
      currentBreak?.breakSize ?? (state.tournament.format === "bp" ? 8 : 4),
      { integer: true, min: 0 },
    );
    if (breakSize === undefined) return undefined;
    return {
      name,
      minSpeakerScore,
      maxSpeakerScore,
      stepSpeakerScore,
      replyScoresEnabled,
      minReplyScore,
      maxReplyScore,
      sideNames,
      prelimRounds,
      breakSize,
    };
  },
  run: async (ctx, args) => {
    const state = ctx.store.getState();
    if (state === null) {
      return { ok: false, code: "INVALID", errors: [t("common.noTournamentPrompt")], fieldErrors: {} };
    }
    const prefs = state.tournament.preferences;
    const partialPrefs: Partial<TournamentPreferences> = {};
    if (args.minSpeakerScore !== prefs.minSpeakerScore) partialPrefs.minSpeakerScore = args.minSpeakerScore;
    if (args.maxSpeakerScore !== prefs.maxSpeakerScore) partialPrefs.maxSpeakerScore = args.maxSpeakerScore;
    if (args.stepSpeakerScore !== prefs.stepSpeakerScore) partialPrefs.stepSpeakerScore = args.stepSpeakerScore;
    if (state.tournament.format !== "bp") {
      if (args.replyScoresEnabled !== prefs.replyScoresEnabled) {
        partialPrefs.replyScoresEnabled = args.replyScoresEnabled;
      }
      if (args.minReplyScore !== prefs.minReplyScore) partialPrefs.minReplyScore = args.minReplyScore;
      if (args.maxReplyScore !== prefs.maxReplyScore) partialPrefs.maxReplyScore = args.maxReplyScore;
      if (args.sideNames !== (prefs.sideNames ?? "aff-neg")) partialPrefs.sideNames = args.sideNames;
    }

    const currentBreak = state.breakCategories.find((cat) => cat.isGeneral) ?? state.breakCategories[0];
    const currentPrelims = state.rounds.filter(
      (round) => round.stage === "preliminary" && !round.cancelled,
    ).length;
    const nameChanged = args.name !== state.tournament.name;
    const prefsChanged = Object.keys(partialPrefs).length > 0;
    const prelimChanged = args.prelimRounds !== currentPrelims;
    const breakChanged = args.breakSize !== currentBreak?.breakSize;
    if (!nameChanged && !prefsChanged && !prelimChanged && !breakChanged) {
      return { ok: true, seq: state.seq, unchanged: true };
    }

    const fieldErrors: Partial<Record<SettingsFieldKey, string[]>> = {};
    const errors: string[] = [];
    let lastSeq = state.seq;
    if (nameChanged || prefsChanged) {
      const result: SubmitResult = await ctx.store.submit({
        type: "settings.update",
        payload: {
          ...(nameChanged ? { name: args.name } : {}),
          preferences: partialPrefs,
        },
      });
      if (!result.ok) {
        for (const err of result.errors) {
          mapSettingsErrorToField(err, fieldErrors);
          errors.push(`${result.code}: ${err}`);
        }
      } else {
        lastSeq = result.seq;
      }
    }
    if (prelimChanged) {
      const result: SubmitResult = await ctx.store.submit({
        type: "round.set_prelim_count",
        payload: { count: args.prelimRounds },
      });
      if (!result.ok) {
        for (const err of result.errors) {
          mapSettingsErrorToField(err, fieldErrors);
          errors.push(`${result.code}: ${err}`);
        }
      } else {
        lastSeq = result.seq;
      }
    }
    if (breakChanged) {
      let categories: BreakCategory[];
      if (currentBreak !== undefined) {
        categories = state.breakCategories.map((cat) =>
          cat.id === currentBreak.id ? { ...cat, breakSize: args.breakSize } : cat,
        );
      } else {
        categories = buildBreakCategories(state.tournament.id, [
          {
            key: "open",
            name: "Open",
            breakSize: args.breakSize,
            reserveSize: 0,
            isGeneral: true,
          },
        ]);
      }
      const result = await saveBreakCategoriesAction.run(ctx, { categories });
      if (!result.ok) {
        const code = "code" in result ? result.code : "INVALID";
        for (const err of result.errors) {
          mapSettingsErrorToField(err, fieldErrors);
          errors.push(`${code}: ${err}`);
        }
      } else {
        lastSeq = result.seq;
      }
    }
    if (errors.length > 0) {
      return { ok: false, code: "INVALID", errors, fieldErrors };
    }
    return { ok: true, seq: lastSeq, unchanged: false };
  },
});

export const SETUP_ACTIONS = [
  createTournamentAction,
  openTournamentAction,
  saveSettingsAction,
] as const;
