import {
  setRelease,
  type BooleanReleaseKind,
} from "@/lib/publicRelease";
import { tabReleasePreferences } from "@/lib/setup/presets";
import type { TournamentPreferences } from "@/types";
import { cloneValue, isNonEmptyText } from "../setup/helpers";
import { recordKey, type OpDef } from "../types";

export type ReleaseGateName =
  | BooleanReleaseKind
  | "break"
  | "tab_team"
  | "tab_speaker"
  | "tab_replies"
  | "tab_speaker_categories"
  | "tab_adjudicator"
  | "tab_break_categories"
  | "tab_motions"
  | "results_all_rounds"
  | "break_category_published"
  | "public_participants"
  | "public_institutions"
  | "public_adjudicator_core"
  | "public_breaking_adjudicators"
  | "public_ballots"
  | "public_private_ballots"
  | "public_record_pages"
  | "public_side_allocations"
  | "public_bracket"
  | "public_diversity"
  | "public_veto_statistics"
  | "public_feedback_progress";

export interface ReleaseSetGatePayload {
  gate: ReleaseGateName;
  released: boolean;
  categoryId?: string;
  restoreAbsent?: boolean;
  previousValue?: boolean | null;
  previousBreakCategoryIds?: string[] | null;
}

export interface ReleaseTabBundlePayload {
  breakCategoryIds: string[];
  restorePreferences?: Partial<TournamentPreferences>;
  removePreferenceKeys?: (keyof TournamentPreferences)[];
  previousPreferences?: Partial<TournamentPreferences>;
  previousAbsentKeys?: (keyof TournamentPreferences)[];
}

const GATE_TO_BOOLEAN_KIND: ReadonlyMap<string, BooleanReleaseKind> = new Map([
  ["teamTab", "teamTab"],
  ["tab_team", "teamTab"],
  ["speakerTab", "speakerTab"],
  ["tab_speaker", "speakerTab"],
  ["repliesTab", "repliesTab"],
  ["tab_replies", "repliesTab"],
  ["speakerCategoryTabs", "speakerCategoryTabs"],
  ["tab_speaker_categories", "speakerCategoryTabs"],
  ["allResults", "allResults"],
  ["results_all_rounds", "allResults"],
  ["participants", "participants"],
  ["public_participants", "participants"],
  ["institutions", "institutions"],
  ["public_institutions", "institutions"],
  ["adjudicatorCore", "adjudicatorCore"],
  ["public_adjudicator_core", "adjudicatorCore"],
  ["breakingAdjudicators", "breakingAdjudicators"],
  ["public_breaking_adjudicators", "breakingAdjudicators"],
  ["adjudicatorTab", "adjudicatorTab"],
  ["tab_adjudicator", "adjudicatorTab"],
  ["ballots", "ballots"],
  ["public_ballots", "ballots"],
  ["privateBallots", "privateBallots"],
  ["public_private_ballots", "privateBallots"],
  ["breakCategoryTabs", "breakCategoryTabs"],
  ["tab_break_categories", "breakCategoryTabs"],
  ["recordPages", "recordPages"],
  ["public_record_pages", "recordPages"],
  ["sideAllocations", "sideAllocations"],
  ["public_side_allocations", "sideAllocations"],
  ["bracket", "bracket"],
  ["public_bracket", "bracket"],
  ["diversity", "diversity"],
  ["public_diversity", "diversity"],
  ["vetoStatistics", "vetoStatistics"],
  ["public_veto_statistics", "vetoStatistics"],
  ["feedbackProgress", "feedbackProgress"],
  ["public_feedback_progress", "feedbackProgress"],
  ["motionTab", "motionTab"],
  ["tab_motions", "motionTab"],
]);

const BOOLEAN_KIND_TO_PREF_KEY: Record<BooleanReleaseKind, keyof TournamentPreferences> = {
  teamTab: "releaseTeamTab",
  speakerTab: "releaseSpeakerTab",
  repliesTab: "releaseRepliesTab",
  speakerCategoryTabs: "releaseSpeakerCategoryTabs",
  allResults: "releaseAllResults",
  participants: "publicParticipants",
  institutions: "publicInstitutionsList",
  adjudicatorCore: "publicAdjudicatorCore",
  breakingAdjudicators: "publicBreakingAdjudicators",
  adjudicatorTab: "releaseAdjudicatorTab",
  ballots: "releaseBallots",
  privateBallots: "releasePrivateBallots",
  breakCategoryTabs: "releaseBreakCategoryTabs",
  recordPages: "publicRecordPages",
  sideAllocations: "publicSideAllocations",
  bracket: "publicBracket",
  diversity: "publicDiversity",
  vetoStatistics: "publicVetoStatistics",
  feedbackProgress: "publicFeedbackProgress",
  motionTab: "motionTabReleased",
};

function isBreakGate(gate: string): boolean {
  return gate === "break" || gate === "break_category_published";
}

export const releaseSetGateOp: OpDef<ReleaseSetGatePayload> = {
  type: "release.set_gate",
  permission: "releases.manage",
  category: "releases",
  visibility: "public",
  lock: false,
  reads(state, payload) {
    return [
      recordKey("tournament", state.tournament.id),
      ...(isBreakGate(payload.gate) && payload.categoryId
        ? [recordKey("breakCategory", payload.categoryId)]
        : []),
    ];
  },
  writes(state) {
    return [recordKey("tournament", state.tournament.id)];
  },
  validate(state, payload) {
    if (typeof payload.released !== "boolean") {
      return ["released must be a boolean."];
    }
    if (isBreakGate(payload.gate)) {
      if (!isNonEmptyText(payload.categoryId)) {
        return ["categoryId is required for break release gates."];
      }
      if (!state.breakCategories.some((cat) => cat.id === payload.categoryId)) {
        return [`Break category ${payload.categoryId} does not exist.`];
      }
      return [];
    }
    if (!GATE_TO_BOOLEAN_KIND.has(payload.gate)) {
      return [`Unknown release gate: ${String(payload.gate)}.`];
    }
    return [];
  },
  apply(state, payload) {
    const prefs = cloneValue(state.tournament.preferences);

    if (isBreakGate(payload.gate)) {
      const categoryId = payload.categoryId!;
      const previousBreakCategoryIds =
        prefs.releasedBreakCategoryIds !== undefined
          ? [...prefs.releasedBreakCategoryIds]
          : null;
      const previousValue =
        prefs.releasedBreakCategoryIds?.includes(categoryId) ?? false;

      let nextPrefs: TournamentPreferences;
      if (payload.restoreAbsent) {
        nextPrefs = { ...prefs };
        delete nextPrefs.releasedBreakCategoryIds;
      } else {
        nextPrefs = setRelease(prefs, {
          kind: "break",
          categoryId,
          released: payload.released,
        });
      }

      return {
        state: {
          ...state,
          tournament: {
            ...cloneValue(state.tournament),
            preferences: nextPrefs,
          },
        },
        committedPayload: {
          ...cloneValue(payload),
          previousValue,
          previousBreakCategoryIds,
        },
      };
    }

    const kind = GATE_TO_BOOLEAN_KIND.get(payload.gate)!;
    const prefKey = BOOLEAN_KIND_TO_PREF_KEY[kind];
    const rawPrev = (prefs as unknown as Record<string, unknown>)[prefKey];
    const previousValue = typeof rawPrev === "boolean" ? rawPrev : null;

    let nextPrefs: TournamentPreferences;
    if (payload.restoreAbsent) {
      nextPrefs = { ...prefs };
      delete (nextPrefs as unknown as Record<string, unknown>)[prefKey];
    } else {
      nextPrefs = setRelease(prefs, {
        kind,
        released: payload.released,
      });
    }

    return {
      state: {
        ...state,
        tournament: {
          ...cloneValue(state.tournament),
          preferences: nextPrefs,
        },
      },
      committedPayload: {
        ...cloneValue(payload),
        previousValue,
      },
    };
  },
  inverse(committedPayload) {
    if (isBreakGate(committedPayload.gate)) {
      if (committedPayload.previousValue === undefined) {
        return null;
      }
      if (committedPayload.previousBreakCategoryIds === null) {
        return {
          type: "release.set_gate",
          payload: {
            gate: committedPayload.gate,
            categoryId: committedPayload.categoryId,
            released: false,
            restoreAbsent: true,
          },
        };
      }
      return {
        type: "release.set_gate",
        payload: {
          gate: committedPayload.gate,
          categoryId: committedPayload.categoryId,
          released: Boolean(committedPayload.previousValue),
        },
      };
    }

    if (committedPayload.previousValue === undefined) {
      return null;
    }
    if (committedPayload.previousValue === null) {
      return {
        type: "release.set_gate",
        payload: {
          gate: committedPayload.gate,
          released: false,
          restoreAbsent: true,
        },
      };
    }
    return {
      type: "release.set_gate",
      payload: {
        gate: committedPayload.gate,
        released: committedPayload.previousValue,
      },
    };
  },
};

export const releaseTabBundleOp: OpDef<ReleaseTabBundlePayload> = {
  type: "release.tab_bundle",
  permission: "releases.manage",
  category: "releases",
  visibility: "public",
  lock: false,
  reads(state) {
    return [
      recordKey("tournament", state.tournament.id),
      ...state.breakCategories.map((cat) => recordKey("breakCategory", cat.id)),
    ];
  },
  writes(state) {
    return [recordKey("tournament", state.tournament.id)];
  },
  validate(state, payload) {
    if (payload.restorePreferences !== undefined) {
      return [];
    }
    if (!Array.isArray(payload.breakCategoryIds)) {
      return ["breakCategoryIds must be an array."];
    }
    const known = new Set(state.breakCategories.map((cat) => cat.id));
    for (const categoryId of payload.breakCategoryIds) {
      if (!known.has(categoryId)) {
        return [`Break category ${categoryId} does not exist.`];
      }
    }
    return [];
  },
  apply(state, payload) {
    const currentPrefs = cloneValue(state.tournament.preferences);
    const currentRecord = currentPrefs as unknown as Record<string, unknown>;

    if (payload.restorePreferences !== undefined) {
      const nextRecord: Record<string, unknown> = { ...currentRecord };
      for (const key of payload.removePreferenceKeys ?? []) {
        delete nextRecord[key];
      }
      for (const [key, value] of Object.entries(payload.restorePreferences)) {
        if (value !== undefined) {
          nextRecord[key] = cloneValue(value);
        }
      }
      return {
        state: {
          ...state,
          tournament: {
            ...cloneValue(state.tournament),
            preferences: nextRecord as unknown as TournamentPreferences,
          },
        },
        committedPayload: cloneValue(payload),
      };
    }

    const patch = tabReleasePreferences(payload.breakCategoryIds);
    const previousPreferences: Record<string, unknown> = {};
    const previousAbsentKeys: (keyof TournamentPreferences)[] = [];
    const nextRecord: Record<string, unknown> = { ...currentRecord };

    for (const [key, value] of Object.entries(patch)) {
      if (
        Object.prototype.hasOwnProperty.call(currentRecord, key) &&
        currentRecord[key] !== undefined
      ) {
        previousPreferences[key] = cloneValue(currentRecord[key]);
      } else {
        previousAbsentKeys.push(key as keyof TournamentPreferences);
      }
      nextRecord[key] = cloneValue(value);
    }

    return {
      state: {
        ...state,
        tournament: {
          ...cloneValue(state.tournament),
          preferences: nextRecord as unknown as TournamentPreferences,
        },
      },
      committedPayload: {
        ...cloneValue(payload),
        previousPreferences: previousPreferences as Partial<TournamentPreferences>,
        previousAbsentKeys,
      },
    };
  },
  inverse(committedPayload) {
    if (
      committedPayload.previousPreferences === undefined &&
      committedPayload.previousAbsentKeys === undefined
    ) {
      return null;
    }
    return {
      type: "release.tab_bundle",
      payload: {
        breakCategoryIds: [],
        restorePreferences: cloneValue(committedPayload.previousPreferences ?? {}),
        ...(committedPayload.previousAbsentKeys &&
        committedPayload.previousAbsentKeys.length > 0
          ? { removePreferenceKeys: [...committedPayload.previousAbsentKeys] }
          : {}),
      },
    };
  },
};
