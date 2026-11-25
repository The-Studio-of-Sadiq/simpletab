import {
  buildImportCommit,
  planImport,
  type ImportChoices,
  type ImportKind,
} from "@simpletab/core/lib/csv/importPlan";
import type { OpRequest } from "@simpletab/core/ops";
import type { ProjectedState } from "@simpletab/host/lib/common/host-protocol";
import { t } from "../i18n";
import type { SimpleTabAction } from "./action";
import { defineAction } from "./action";
import { PARTICIPANTS_PAGE } from "./participants-actions";
import { pickYesNo } from "./prompt-helpers";

export interface CsvFailureReport {
  label: string;
  opType: string;
  code: string;
  errors: string[];
}

export interface CsvApplySummary {
  succeeded: number;
  failures: CsvFailureReport[];
  skipped: number;
}

export interface CsvApplyInput {
  kind: ImportKind;
  csvText: string;
  choices: ImportChoices;
}

export type CsvApplyResult =
  | { ok: true; commitErrors: string[]; summary: CsvApplySummary | null }
  | { ok: false; code: "INVALID"; errors: string[] }
  /** Some rows were saved and some refused: the summary says which. */
  | { ok: false; code: "PARTIAL"; errors: string[]; summary: CsvApplySummary };

let idCounter = 0;
function createImportId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now()}-${idCounter}`;
}

function importContext(state: ProjectedState) {
  return {
    institutions: state.institutions,
    teams: state.teams,
    adjudicators: state.adjudicators,
    breakCategories: state.breakCategories,
    speakerCategories: state.tournament.preferences.speakerCategories ?? [],
    substantiveSpeakers: state.tournament.preferences.substantiveSpeakers,
    teamSeedMode: state.tournament.preferences.teamSeedMode,
  };
}

/**
 * Builds the same ordered ops the import preview applies. Shared by the panel's Apply
 * button and the palette command so they can never diverge.
 */
export function buildCsvOps(
  state: ProjectedState,
  kind: ImportKind,
  csvText: string,
  choices: ImportChoices,
): { ops: Array<{ label: string; request: OpRequest }>; errors: string[]; skipped: number } {
  const plan = planImport(kind, csvText, importContext(state));
  const built = buildImportCommit(plan, choices, {
    ...importContext(state),
    tournamentId: state.tournament.id,
    createId: createImportId,
  });
  if (built.errors.length > 0 || built.commit === undefined) {
    return { ops: [], errors: built.errors, skipped: 0 };
  }
  const { commit } = built;
  const ops: Array<{ label: string; request: OpRequest }> = [
    ...commit.institutionsCreated.map((institution) => ({
      label: institution.name,
      request: { type: "institution.create", payload: { institution } } as OpRequest,
    })),
    ...commit.institutionsUpdated.map((institution) => ({
      label: institution.name,
      request: { type: "institution.update", payload: { institution } } as OpRequest,
    })),
    ...commit.teamsCreated.map((team) => ({
      label: team.name,
      request: { type: "team.create", payload: { team } } as OpRequest,
    })),
    ...commit.teamsUpdated.map((team) => ({
      label: team.name,
      request: { type: "team.update", payload: { team } } as OpRequest,
    })),
    ...commit.adjudicatorsCreated.map((adjudicator) => ({
      label: adjudicator.name,
      request: { type: "adjudicator.create", payload: { adjudicator } } as OpRequest,
    })),
    ...commit.adjudicatorsUpdated.map((adjudicator) => ({
      label: adjudicator.name,
      request: { type: "adjudicator.update", payload: { adjudicator } } as OpRequest,
    })),
  ];
  if (commit.speakerCategories !== undefined) {
    ops.push({
      label: t("action.participants.speakerCategories"),
      request: {
        type: "settings.update",
        payload: { preferences: { speakerCategories: commit.speakerCategories } },
      } as OpRequest,
    });
  }
  return { ops, errors: [], skipped: commit.skipped };
}

export const applyCsvImportAction: SimpleTabAction<CsvApplyInput, CsvApplyResult> = defineAction({
  id: "simpletab.participants.import-csv",
  labelKey: "action.participants.applyCsvImport",
  page: PARTICIPANTS_PAGE,
  isEnabled: (snapshot) => snapshot.state !== null,
  prompt: async (ctx) => {
    const state = ctx.store.getState();
    if (state === null) return undefined;
    const kinds: ImportKind[] = ["institutions", "teams", "adjudicators"];
    const kind = await ctx.prompts.pick(
      kinds.map((item) => ({
        label: t(`participants.csv.kind${item.charAt(0).toUpperCase()}${item.slice(1)}`),
        value: item,
      })),
      t("action.participants.pickCsvKind"),
    );
    if (kind === undefined) return undefined;
    const csvText = await ctx.prompts.openTextFile(t("action.participants.csvFile"), ["csv", "txt"]);
    if (csvText === undefined) return undefined;
    const validRowsOnly = await pickYesNo(ctx, t("action.participants.importValidOnlyTitle"), false);
    if (validRowsOnly === undefined) return undefined;
    // The panel shows a preview before Apply; the palette states what will happen and asks.
    const choices: ImportChoices = { actions: {}, validRowsOnly };
    const built = buildCsvOps(state, kind, csvText, choices);
    if (built.errors.length === 0) {
      const confirmed = await ctx.prompts.confirm(
        t("action.participants.applyCsvImport"),
        t("action.participants.csvSummary", { count: built.ops.length, skipped: built.skipped }),
      );
      if (!confirmed) return undefined;
    }
    return { kind, csvText, choices };
  },
  run: async (ctx, args) => {
    const state = ctx.store.getState();
    if (state === null) {
      return { ok: false, code: "INVALID", errors: [t("common.noTournamentPrompt")] };
    }
    const built = buildCsvOps(state, args.kind, args.csvText, args.choices);
    if (built.errors.length > 0) {
      return { ok: false, code: "INVALID", errors: built.errors };
    }
    const failures: CsvFailureReport[] = [];
    let succeeded = 0;
    for (const item of built.ops) {
      const result = await ctx.store.submit(item.request);
      if (result.ok) {
        succeeded += 1;
      } else {
        failures.push({
          label: item.label,
          opType: item.request.type,
          code: result.code,
          errors: result.errors,
        });
      }
    }
    const summary: CsvApplySummary = { succeeded, failures, skipped: built.skipped };
    if (failures.length > 0) {
      return {
        ok: false,
        code: "PARTIAL",
        summary,
        errors: [
          t("action.participants.csvPartial", { succeeded, failed: failures.length }),
          ...failures.map((failure) => `${failure.label}: ${failure.errors.join("; ")}`),
        ],
      };
    }
    return { ok: true, commitErrors: [], summary };
  },
});

export const CSV_IMPORT_ACTIONS = [applyCsvImportAction] as const;
