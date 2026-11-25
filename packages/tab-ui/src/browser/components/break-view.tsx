import {
  getBreakCategoryDeletionBlocker,
  upsertBreakCategory,
  validateBreakCategoryDraft,
  type BreakCategoryDraft,
} from "@simpletab/core/features/tournament/application/breaks";
import {
  BREAK_EXCLUSION_LABELS,
  BREAK_OVERRIDE_LABELS,
  calculateBreaks,
  isGeneratedBreakStale,
  type BreakCategoryResult,
  type BreakExclusionReason,
} from "@simpletab/core/lib/breakqual/calculator";
import { teamsInDebateFor } from "@simpletab/core/lib/debateSides";
import { drawStageOf } from "@simpletab/core/lib/draw/drawStatus";
import { calculateStandings } from "@simpletab/core/lib/standings/calculator";
import { resolveTeamPrecedence } from "@simpletab/core/lib/standings/precedence";
import type {
  BreakCategory,
  BreakQualificationRule,
  BreakTeamOverride,
  TournamentFormat,
} from "@simpletab/core/types";
import type {
  HostStatus,
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import type { ActionRunner, SimpleTabAction } from "../actions/action";
import {
  advanceRoundAction,
  clearBreakAction,
  computeBreakAction,
  saveBreakCategoriesAction,
  setTeamOverrideAction,
  type AdvanceRoundArgs,
  type ClearBreakArgs,
  type ComputeBreakArgs,
  type SaveCategoriesArgs,
  type SetTeamOverrideArgs,
} from "../actions/break-actions";
import { openSetupAction } from "../actions/releases-actions";
import { t } from "../i18n";
import { stateHasPermission } from "../lib/permissions";
import { InlineOpError, type InlineOpErrorData } from "./inline-op-error";
import { LockBanner } from "./lock-banner";

export interface BreakViewProps {
  state: ProjectedState | null;
  status: HostStatus;
  /** Break actions are the only way this page changes tournament data. */
  run: ActionRunner;
  nowIso?: string;
}

interface ErrorEntry {
  error: InlineOpErrorData;
  retry?: () => void;
}

type CategoryActionArgs =
  | SaveCategoriesArgs
  | SetTeamOverrideArgs
  | ComputeBreakArgs
  | ClearBreakArgs;

const ALL_OVERRIDE_OPTIONS: readonly BreakTeamOverride[] = [
  "include",
  "ineligible",
  "withdrawn",
  "different_break",
  "disqualified",
  "lost_coin_toss",
];

function qualificationRuleLabel(rule: BreakQualificationRule): string {
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

function exclusionLabel(reason: BreakExclusionReason): string {
  switch (reason) {
    case "ineligible":
    case "withdrawn":
    case "different_break":
    case "disqualified":
    case "lost_coin_toss":
    case "capped":
      return BREAK_EXCLUSION_LABELS[reason];
  }
}

function defaultDraft(teamsInDebate: number): BreakCategoryDraft {
  return {
    name: "",
    breakSize: teamsInDebate === 4 ? 8 : 4,
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

function formatBreakRank(rank: number | undefined, ranks: readonly (number | undefined)[]): string {
  if (rank === undefined || rank <= 0) {
    return "—";
  }
  const count = ranks.filter((r) => r === rank).length;
  return count > 1 ? `=${rank}` : String(rank);
}

export const BreakView: React.FC<BreakViewProps> = ({
  state,
  status,
  run,
  nowIso,
}) => {
  const baseId = React.useId();
  const [editingCategoryId, setEditingCategoryId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<BreakCategoryDraft>(() =>
    defaultDraft(state ? teamsInDebateFor(state.tournament) : 4),
  );
  const [categoriesError, setCategoriesError] = React.useState<ErrorEntry | null>(null);
  const [categoriesSuccess, setCategoriesSuccess] = React.useState<string | null>(null);

  const [overrideReasonByCategory, setOverrideReasonByCategory] = React.useState<
    Record<string, string>
  >({});
  const [categoryErrors, setCategoryErrors] = React.useState<Record<string, ErrorEntry>>(
    {},
  );
  const [categorySuccess, setCategorySuccess] = React.useState<Record<string, string>>({});
  const [computingCategoryId, setComputingCategoryId] = React.useState<string | null>(null);

  const [manualTeamByCategory, setManualTeamByCategory] = React.useState<Record<string, string>>(
    {},
  );
  const [manualOverrideByCategory, setManualOverrideByCategory] = React.useState<
    Record<string, BreakTeamOverride>
  >({});

  const [elimError, setElimError] = React.useState<ErrorEntry | null>(null);
  const [elimSuccess, setElimSuccess] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (state === null) {
      return;
    }
    if (editingCategoryId === null) {
      setDraft(defaultDraft(teamsInDebateFor(state.tournament)));
    }
  }, [state?.tournament.id, state?.tournament.format, editingCategoryId]);

  if (state === null) {
    return (
      <div className="simpletab-page">
        <div className="simpletab-header">
          <h1 className="simpletab-title">{t("break.title")}</h1>
        </div>
        <div className="simpletab-alert">
          <p>{t("common.noTournamentPrompt")}</p>
          <button
            type="button"
            className="theia-button"
            data-action={openSetupAction.id}
            onClick={() => {
              void run(openSetupAction, {});
            }}
          >
            {t("common.openSetupButton")}
          </button>
        </div>
      </div>
    );
  }

  const isHostOwner = state.roleId === "host_owner";
  const canManageBreak = stateHasPermission(state, "break.manage");
  const teamsInDebate = teamsInDebateFor(state.tournament);
  const isBp = state.tournament.format === "bp";

  const availableRules: readonly BreakQualificationRule[] = isBp
    ? ["standard", "aida_1996"]
    : [
        "standard",
        "aida_1996",
        "aida_2016_australs",
        "aida_2016_easters",
        "aida_2019_australs_open",
      ];

  const standings = calculateStandings(
    state.tournament,
    state.rounds,
    state.teams,
    state.debates,
    state.ballots,
  ).teams;
  const teamPrecedence = resolveTeamPrecedence(
    state.tournament.format,
    state.tournament.preferences,
  );

  let breakResults: BreakCategoryResult[] = [];
  let calculationError: string | null = null;
  try {
    breakResults = calculateBreaks(
      state.breakCategories,
      state.teams,
      standings,
      state.tournament.format as TournamentFormat,
      teamPrecedence,
    );
  } catch (error) {
    calculationError = error instanceof Error ? error.message : String(error);
  }

  const submitCategoriesSave = async (categories: BreakCategory[]): Promise<boolean> => {
    setCategoriesError(null);
    setCategoriesSuccess(null);
    const res = await run(saveBreakCategoriesAction, { categories });
    if (!res.ok) {
      setCategoriesError({
        error: { code: res.code, errors: res.errors, current: res.current },
        retry: () => {
          void submitCategoriesSave(categories);
        },
      });
      return false;
    }
    setCategoriesSuccess(t("break.categoriesSaved"));
    return true;
  };

  const handleSaveCategoryDraft = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setCategoriesError(null);
    setCategoriesSuccess(null);

    const validationError = validateBreakCategoryDraft(
      draft,
      state.breakCategories,
      teamsInDebate,
      editingCategoryId ?? undefined,
    );
    if (validationError.length > 0) {
      setCategoriesError({ error: { code: "INVALID", errors: [validationError] } });
      return;
    }

    const nextCategories = upsertBreakCategory(
      state.breakCategories,
      draft,
      state.tournament.id,
      editingCategoryId ?? undefined,
      createCategoryId,
    );
    const ok = await submitCategoriesSave(nextCategories);
    if (ok) {
      setEditingCategoryId(null);
      setDraft(defaultDraft(teamsInDebate));
    }
  };

  const handleStartEditCategory = (cat: BreakCategory): void => {
    setEditingCategoryId(cat.id);
    setDraft({
      name: cat.name,
      breakSize: cat.breakSize,
      reserveSize: cat.reserveSize,
      priority: cat.priority,
      isGeneral: cat.isGeneral,
      maxPerInstitution: cat.maxPerInstitution ?? 0,
      qualificationRule: cat.qualificationRule ?? "standard",
      limit: cat.limit ?? 0,
    });
    setCategoriesError(null);
    setCategoriesSuccess(null);
  };

  const handleDeleteCategory = async (cat: BreakCategory): Promise<void> => {
    const nextCategories = state.breakCategories.filter((item) => item.id !== cat.id);
    const ok = await submitCategoriesSave(nextCategories);
    if (ok && editingCategoryId === cat.id) {
      setEditingCategoryId(null);
      setDraft(defaultDraft(teamsInDebate));
    }
  };

  const submitCategoryOp = async <A extends CategoryActionArgs>(
    action: SimpleTabAction<A, SubmitResult>,
    args: A,
    categoryId: string,
    successMessage: string,
  ): Promise<void> => {
    setCategoryErrors((prev) => {
      const next = { ...prev };
      delete next[categoryId];
      return next;
    });
    setCategorySuccess((prev) => {
      const next = { ...prev };
      delete next[categoryId];
      return next;
    });

    const res = await run(action, args);
    if (!res.ok) {
      setCategoryErrors((prev) => ({
        ...prev,
        [categoryId]: {
          error: { code: res.code, errors: res.errors, current: res.current },
          retry: () => {
            void submitCategoryOp(action, args, categoryId, successMessage);
          },
        },
      }));
      return;
    }
    setCategorySuccess((prev) => ({ ...prev, [categoryId]: successMessage }));
  };

  const handleTeamOverride = async (
    category: BreakCategory,
    teamId: string,
    override: BreakTeamOverride | null,
  ): Promise<void> => {
    await submitCategoryOp(
      setTeamOverrideAction,
      { categoryId: category.id, teamId, override },
      category.id,
      t("break.overrideSuccess", { category: category.name }),
    );
  };

  const handleComputeBreak = async (category: BreakCategory): Promise<void> => {
    const reason = (overrideReasonByCategory[category.id] ?? "").trim();
    const args: ComputeBreakArgs = {
      categoryId: category.id,
      generatedAt: nowIso ?? new Date().toISOString(),
      ...(reason.length > 0 ? { reason } : {}),
    };
    setComputingCategoryId(category.id);
    try {
      await submitCategoryOp(
        computeBreakAction,
        args,
        category.id,
        t("break.computeSuccess", { category: category.name }),
      );
    } finally {
      setComputingCategoryId((prev) => (prev === category.id ? null : prev));
    }
  };

  const handleClearBreak = async (category: BreakCategory): Promise<void> => {
    const args: ClearBreakArgs = { categoryId: category.id };
    await submitCategoryOp(
      clearBreakAction,
      args,
      category.id,
      t("break.clearSuccess", { category: category.name }),
    );
  };

  const handleAdvanceRound = async (roundId: string, roundName: string): Promise<void> => {
    setElimError(null);
    setElimSuccess(null);
    const args: AdvanceRoundArgs = { roundId };
    const res = await run(advanceRoundAction, args);
    if (!res.ok) {
      setElimError({
        error: { code: res.code, errors: res.errors, current: res.current },
        retry: () => {
          void handleAdvanceRound(roundId, roundName);
        },
      });
      return;
    }
    setElimSuccess(t("break.advanceSuccess", { round: roundName }));
  };

  const eliminationRounds = state.rounds
    .filter((round) => round.stage === "elimination" && round.cancelled !== true)
    .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  const categoryNameById = new Map(state.breakCategories.map((cat) => [cat.id, cat.name]));
  const nonSwingTeams = state.teams.filter((team) => team.isSwing !== true);

  return (
    <div className="simpletab-page">
      <div className="simpletab-header">
        <h1 className="simpletab-title">{t("break.title")}</h1>
      </div>

      <LockBanner
        locks={status.locks}
        rounds={state.rounds}
        isHostOwner={isHostOwner}
        run={run}
      />

      {calculationError !== null ? (
        <div className="simpletab-alert simpletab-alert-error" role="alert">
          {calculationError}
        </div>
      ) : null}

      <section
        className="simpletab-section"
        aria-labelledby={`${baseId}-cats-h`}
      >
        <h2 id={`${baseId}-cats-h`} className="simpletab-subtitle">
          {t("break.categoriesSectionTitle")}
        </h2>

        {state.breakCategories.length === 0 ? (
          <p className="simpletab-empty">{t("break.noCategories")}</p>
        ) : (
          <div className="simpletab-table-wrap">
            <table className="simpletab-table">
              <caption>{t("break.categoriesTableCaption")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("break.colName")}</th>
                  <th scope="col">{t("break.colBreakSize")}</th>
                  <th scope="col">{t("break.colReserveSize")}</th>
                  <th scope="col">{t("break.colPriority")}</th>
                  <th scope="col">{t("break.colScope")}</th>
                  <th scope="col">{t("break.colRule")}</th>
                  <th scope="col">{t("break.colCap")}</th>
                  <th scope="col">{t("break.colLimit")}</th>
                  <th scope="col">{t("break.colStatus")}</th>
                  {canManageBreak ? (
                    <th scope="col">{t("break.colActions")}</th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {state.breakCategories.map((cat) => {
                  const res = breakResults.find((item) => item.category.id === cat.id);
                  const stale = res !== undefined && isGeneratedBreakStale(res);
                  const statusLabel = cat.generatedBreak
                    ? stale
                      ? t("break.statusStale")
                      : t("break.statusGenerated")
                    : t("break.statusPreview");
                  const blocker = getBreakCategoryDeletionBlocker(
                    cat,
                    state.teams,
                    state.rounds,
                  );

                  return (
                    <tr key={cat.id}>
                      <td>{cat.name}</td>
                      <td>{cat.breakSize}</td>
                      <td>{cat.reserveSize}</td>
                      <td>{cat.priority}</td>
                      <td>
                        {cat.isGeneral ? t("break.scopeGeneral") : t("break.scopeCategory")}
                      </td>
                      <td>
                        {qualificationRuleLabel(cat.qualificationRule ?? "standard")}
                      </td>
                      <td>
                        {cat.maxPerInstitution ? String(cat.maxPerInstitution) : t("break.noLimit")}
                      </td>
                      <td>{cat.limit ? String(cat.limit) : t("break.noLimit")}</td>
                      <td>
                        <span
                          className={`simpletab-badge ${
                            cat.generatedBreak
                              ? stale
                                ? "simpletab-badge-conflict"
                                : "simpletab-badge-add"
                              : ""
                          }`}
                        >
                          {statusLabel}
                        </span>
                      </td>
                      {canManageBreak ? (
                        <td>
                          <div className="simpletab-actions">
                            <button
                              type="button"
                              className="theia-button secondary simpletab-compact-btn"
                              data-view-only
                              onClick={() => handleStartEditCategory(cat)}
                            >
                              {t("common.edit")}
                            </button>
                            <button
                              type="button"
                              className="theia-button secondary simpletab-compact-btn"
                              data-action={saveBreakCategoriesAction.id}
                              disabled={blocker.length > 0}
                              title={blocker || undefined}
                              onClick={() => {
                                void handleDeleteCategory(cat);
                              }}
                            >
                              {t("common.delete")}
                            </button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {canManageBreak ? (
          <form
            className="simpletab-form"
            onSubmit={(e) => {
              void handleSaveCategoryDraft(e);
            }}
          >
            <h3 className="simpletab-subtitle">
              {editingCategoryId !== null
                ? t("break.editCategoryTitle", { name: draft.name })
                : t("break.addCategoryTitle")}
            </h3>
            <div className="simpletab-form-grid">
              <div className="simpletab-field">
                <label htmlFor={`${baseId}-cat-name`}>{t("break.fieldName")}</label>
                <input
                  id={`${baseId}-cat-name`}
                  type="text"
                  value={draft.name}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, name: e.target.value }))
                  }
                />
              </div>
              <div className="simpletab-field">
                <label htmlFor={`${baseId}-cat-size`}>{t("break.fieldBreakSize")}</label>
                <input
                  id={`${baseId}-cat-size`}
                  type="number"
                  min={2}
                  step={1}
                  value={draft.breakSize}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      breakSize: Number(e.target.value),
                    }))
                  }
                />
              </div>
              <div className="simpletab-field">
                <label htmlFor={`${baseId}-cat-res`}>{t("break.fieldReserveSize")}</label>
                <input
                  id={`${baseId}-cat-res`}
                  type="number"
                  min={0}
                  step={1}
                  value={draft.reserveSize}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      reserveSize: Number(e.target.value),
                    }))
                  }
                />
              </div>
              <div className="simpletab-field">
                <label htmlFor={`${baseId}-cat-prio`}>{t("break.fieldPriority")}</label>
                <input
                  id={`${baseId}-cat-prio`}
                  type="number"
                  step={1}
                  value={draft.priority}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      priority: Number(e.target.value),
                    }))
                  }
                />
              </div>
              <div className="simpletab-field">
                <label htmlFor={`${baseId}-cat-rule`}>{t("break.fieldRule")}</label>
                <select
                  id={`${baseId}-cat-rule`}
                  value={draft.qualificationRule}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      qualificationRule: e.target.value as BreakQualificationRule,
                    }))
                  }
                >
                  {availableRules.map((rule) => (
                    <option key={rule} value={rule}>
                      {qualificationRuleLabel(rule)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="simpletab-field">
                <label htmlFor={`${baseId}-cat-cap`}>
                  {t("break.fieldMaxPerInstitution")}
                </label>
                <input
                  id={`${baseId}-cat-cap`}
                  type="number"
                  min={0}
                  step={1}
                  value={draft.maxPerInstitution}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      maxPerInstitution: Number(e.target.value),
                    }))
                  }
                />
              </div>
              <div className="simpletab-field">
                <label htmlFor={`${baseId}-cat-limit`}>{t("break.fieldPublicLimit")}</label>
                <input
                  id={`${baseId}-cat-limit`}
                  type="number"
                  min={0}
                  step={1}
                  value={draft.limit ?? 0}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      limit: Number(e.target.value),
                    }))
                  }
                />
              </div>
            </div>

            <div className="simpletab-checkbox-row">
              <label className="simpletab-checkbox-item">
                <input
                  type="checkbox"
                  checked={draft.isGeneral}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, isGeneral: e.target.checked }))
                  }
                />
                <span>{t("break.fieldGeneral")}</span>
              </label>
            </div>

            <div className="simpletab-actions">
              <button
                type="submit"
                className="theia-button"
                data-action={saveBreakCategoriesAction.id}
              >
                {editingCategoryId !== null
                  ? t("break.updateCategoryButton")
                  : t("break.addCategoryButton")}
              </button>
              {editingCategoryId !== null ? (
                <button
                  type="button"
                  className="theia-button secondary"
                  data-view-only
                  onClick={() => {
                    setEditingCategoryId(null);
                    setDraft(defaultDraft(teamsInDebate));
                  }}
                >
                  {t("break.cancelEditButton")}
                </button>
              ) : null}
            </div>
          </form>
        ) : null}

        {categoriesSuccess !== null ? (
          <div className="simpletab-alert simpletab-alert-success" role="status">
            {categoriesSuccess}
          </div>
        ) : null}
        {categoriesError !== null ? (
          <InlineOpError
            error={categoriesError.error}
            onRetry={categoriesError.retry}
            onDismiss={() => setCategoriesError(null)}
          />
        ) : null}
      </section>

      {breakResults.map((result) => {
        const cat = result.category;
        const catError = categoryErrors[cat.id];
        const catSuccess = categorySuccess[cat.id];
        const breakRanks = result.breakingTeams.map((entry) => entry.breakRank);
        const existingOverrides = cat.teamOverrides ?? {};
        const candidateTeams = nonSwingTeams.filter(
          (team) => cat.isGeneral || team.breakCategories.includes(cat.id),
        );
        const selectedManualTeamId =
          manualTeamByCategory[cat.id] &&
          candidateTeams.some((tm) => tm.id === manualTeamByCategory[cat.id])
            ? manualTeamByCategory[cat.id]
            : (candidateTeams[0]?.id ?? "");
        const selectedManualOverride: BreakTeamOverride =
          manualOverrideByCategory[cat.id] ?? "include";

        return (
          <section
            key={cat.id}
            className="simpletab-section"
            aria-labelledby={`${baseId}-cat-${cat.id}`}
          >
            <div className="simpletab-toolbar">
              <div>
                <h2 id={`${baseId}-cat-${cat.id}`} className="simpletab-subtitle">
                  {cat.name} ({cat.breakSize} / {cat.reserveSize})
                </h2>
                <div className="simpletab-stage-bar">
                  <span
                    className={`simpletab-badge ${
                      cat.generatedBreak
                        ? isGeneratedBreakStale(result)
                          ? "simpletab-badge-conflict"
                          : "simpletab-badge-add"
                        : ""
                    }`}
                  >
                    {cat.generatedBreak
                      ? isGeneratedBreakStale(result)
                        ? t("break.statusStale")
                        : t("break.statusGenerated")
                      : t("break.statusPreview")}
                  </span>
                </div>
              </div>

              {canManageBreak ? (
                <div className="simpletab-actions">
                  <button
                    type="button"
                    className="theia-button"
                    data-action={computeBreakAction.id}
                    disabled={computingCategoryId === cat.id}
                    onClick={() => {
                      void handleComputeBreak(cat);
                    }}
                  >
                    {cat.generatedBreak
                      ? t("break.recomputeButton")
                      : t("break.computeButton")}
                  </button>
                  {cat.generatedBreak ? (
                    <button
                      type="button"
                      className="theia-button secondary"
                      data-action={clearBreakAction.id}
                      onClick={() => {
                        void handleClearBreak(cat);
                      }}
                    >
                      {t("break.clearButton")}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>

            {canManageBreak ? (
              <div className="simpletab-field">
                <label htmlFor={`${baseId}-reason-${cat.id}`}>
                  {t("break.overrideReasonLabel")}
                </label>
                <input
                  id={`${baseId}-reason-${cat.id}`}
                  type="text"
                  placeholder={t("break.overrideReasonPlaceholder")}
                  value={overrideReasonByCategory[cat.id] ?? ""}
                  onChange={(e) =>
                    setOverrideReasonByCategory((prev) => ({
                      ...prev,
                      [cat.id]: e.target.value,
                    }))
                  }
                />
              </div>
            ) : null}

            {result.tooFewEligible ? (
              <div className="simpletab-alert simpletab-alert-warning" role="status">
                {t("break.tooFewEligible", {
                  eligible: result.tooFewEligible.eligible,
                  breakSize: result.tooFewEligible.breakSize,
                })}
              </div>
            ) : null}

            {result.cutoffTies.map((tie, tieIdx) => (
              <div key={tieIdx} className="simpletab-cutoff-tie" role="region">
                <strong>
                  {t("break.cutoffTieTitle", {
                    cutoff:
                      tie.cutoff === "break"
                        ? t("break.cutoffBreak")
                        : t("break.cutoffReserve"),
                    rank: tie.teams[0]?.rank ?? 0,
                  })}
                </strong>
                <div className="simpletab-hint">
                  {t("break.cutoffTieDetail", {
                    count: tie.teams.length,
                    places: tie.places,
                  })}
                </div>
                <ul className="simpletab-issue-list">
                  {tie.teams.map((entry) => {
                    const currentOverride = existingOverrides[entry.team.id] ?? "";
                    return (
                      <li key={entry.team.id}>
                        <div className="simpletab-actions">
                          <span>
                            {entry.team.name} (#{entry.rank}, {entry.standing.points} pts /{" "}
                            {entry.standing.totalSpeakerScore})
                          </span>
                          {canManageBreak ? (
                            <>
                              <button
                                type="button"
                                className="theia-button secondary simpletab-compact-btn"
                                data-action={setTeamOverrideAction.id}
                                onClick={() => {
                                  void handleTeamOverride(cat, entry.team.id, "include");
                                }}
                              >
                                {t("break.quickInclude")}
                              </button>
                              <button
                                type="button"
                                className="theia-button secondary simpletab-compact-btn"
                                data-action={setTeamOverrideAction.id}
                                onClick={() => {
                                  void handleTeamOverride(
                                    cat,
                                    entry.team.id,
                                    "lost_coin_toss",
                                  );
                                }}
                              >
                                {t("break.quickCoinToss")}
                              </button>
                              <select
                                aria-label={`${entry.team.name} ${t("break.colOverride")}`}
                                value={currentOverride}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  void handleTeamOverride(
                                    cat,
                                    entry.team.id,
                                    val === "" ? null : (val as BreakTeamOverride),
                                  );
                                }}
                              >
                                <option value="">{t("break.overrideNone")}</option>
                                {ALL_OVERRIDE_OPTIONS.map((opt) => (
                                  <option key={opt} value={opt}>
                                    {BREAK_OVERRIDE_LABELS[opt]}
                                  </option>
                                ))}
                              </select>
                            </>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}

            {result.breakingTeams.length === 0 ? (
              <p className="simpletab-empty">{t("break.noBreakingTeams")}</p>
            ) : (
              <div className="simpletab-table-wrap">
                <table className="simpletab-table">
                  <caption>{t("break.breakingCaption", { category: cat.name })}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("break.colSeed")}</th>
                      <th scope="col">{t("break.colBreakRank")}</th>
                      <th scope="col">{t("break.colStandingsRank")}</th>
                      <th scope="col">{t("break.colTeam")}</th>
                      <th scope="col">{t("break.colScore")}</th>
                      <th scope="col">{t("break.colRemark")}</th>
                      {canManageBreak ? (
                        <th scope="col">{t("break.colOverride")}</th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {result.breakingTeams.map((entry) => {
                      const currentOverride = existingOverrides[entry.team.id] ?? "";
                      return (
                        <tr key={entry.team.id}>
                          <td>{entry.seed}</td>
                          <td>{formatBreakRank(entry.breakRank, breakRanks)}</td>
                          <td>{entry.rank}</td>
                          <td>{entry.team.name}</td>
                          <td>
                            {entry.standing.points} / {entry.standing.totalSpeakerScore}
                          </td>
                          <td>
                            {entry.manuallyIncluded ? (
                              <span className="simpletab-badge simpletab-badge-match">
                                {t("break.remarkManualInclude")}
                              </span>
                            ) : (
                              <span className="simpletab-badge simpletab-badge-add">
                                {t("break.remarkQualifies")}
                              </span>
                            )}
                          </td>
                          {canManageBreak ? (
                            <td>
                              <select
                                aria-label={`${entry.team.name} ${t("break.colOverride")}`}
                                value={currentOverride}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  void handleTeamOverride(
                                    cat,
                                    entry.team.id,
                                    val === "" ? null : (val as BreakTeamOverride),
                                  );
                                }}
                              >
                                <option value="">{t("break.overrideNone")}</option>
                                {ALL_OVERRIDE_OPTIONS.map((opt) => (
                                  <option key={opt} value={opt}>
                                    {BREAK_OVERRIDE_LABELS[opt]}
                                  </option>
                                ))}
                              </select>
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {result.reserveTeams.length > 0 ? (
              <div className="simpletab-table-wrap">
                <table className="simpletab-table">
                  <caption>{t("break.reservesCaption", { category: cat.name })}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("break.colReserveNumber")}</th>
                      <th scope="col">{t("break.colStandingsRank")}</th>
                      <th scope="col">{t("break.colTeam")}</th>
                      <th scope="col">{t("break.colScore")}</th>
                      {canManageBreak ? (
                        <th scope="col">{t("break.colOverride")}</th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {result.reserveTeams.map((entry) => {
                      const currentOverride = existingOverrides[entry.team.id] ?? "";
                      return (
                        <tr key={entry.team.id}>
                          <td>{entry.reserveIndex ?? entry.seed}</td>
                          <td>{entry.rank}</td>
                          <td>{entry.team.name}</td>
                          <td>
                            {entry.standing.points} / {entry.standing.totalSpeakerScore}
                          </td>
                          {canManageBreak ? (
                            <td>
                              <select
                                aria-label={`${entry.team.name} ${t("break.colOverride")}`}
                                value={currentOverride}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  void handleTeamOverride(
                                    cat,
                                    entry.team.id,
                                    val === "" ? null : (val as BreakTeamOverride),
                                  );
                                }}
                              >
                                <option value="">{t("break.overrideNone")}</option>
                                {ALL_OVERRIDE_OPTIONS.map((opt) => (
                                  <option key={opt} value={opt}>
                                    {BREAK_OVERRIDE_LABELS[opt]}
                                  </option>
                                ))}
                              </select>
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}

            {result.excludedTeams.length > 0 ? (
              <div className="simpletab-table-wrap">
                <table className="simpletab-table">
                  <caption>{t("break.excludedCaption", { category: cat.name })}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("break.colStandingsRank")}</th>
                      <th scope="col">{t("break.colTeam")}</th>
                      <th scope="col">{t("break.colRemark")}</th>
                      <th scope="col">{t("break.colSource")}</th>
                      {canManageBreak ? (
                        <th scope="col">{t("break.colOverride")}</th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {result.excludedTeams.map((entry) => {
                      const currentOverride = existingOverrides[entry.team.id] ?? "";
                      return (
                        <tr key={entry.team.id}>
                          <td>{entry.rank}</td>
                          <td>{entry.team.name}</td>
                          <td>
                            <span className="simpletab-badge simpletab-badge-conflict">
                              {exclusionLabel(entry.reason)}
                            </span>
                          </td>
                          <td>
                            {entry.manual
                              ? t("break.sourceManual")
                              : t("break.sourceAutomatic")}
                          </td>
                          {canManageBreak ? (
                            <td>
                              <select
                                aria-label={`${entry.team.name} ${t("break.colOverride")}`}
                                value={currentOverride}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  void handleTeamOverride(
                                    cat,
                                    entry.team.id,
                                    val === "" ? null : (val as BreakTeamOverride),
                                  );
                                }}
                              >
                                <option value="">{t("break.overrideNone")}</option>
                                {ALL_OVERRIDE_OPTIONS.map((opt) => (
                                  <option key={opt} value={opt}>
                                    {BREAK_OVERRIDE_LABELS[opt]}
                                  </option>
                                ))}
                              </select>
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}

            {canManageBreak && candidateTeams.length > 0 ? (
              <div className="simpletab-filter-bar">
                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-ov-team-${cat.id}`}>
                    {t("break.addOverrideTeamLabel", { category: cat.name })}
                  </label>
                  <select
                    id={`${baseId}-ov-team-${cat.id}`}
                    value={selectedManualTeamId}
                    onChange={(e) =>
                      setManualTeamByCategory((prev) => ({
                        ...prev,
                        [cat.id]: e.target.value,
                      }))
                    }
                  >
                    {candidateTeams.map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-ov-val-${cat.id}`}>
                    {t("break.addOverrideValueLabel")}
                  </label>
                  <select
                    id={`${baseId}-ov-val-${cat.id}`}
                    value={selectedManualOverride}
                    onChange={(e) =>
                      setManualOverrideByCategory((prev) => ({
                        ...prev,
                        [cat.id]: e.target.value as BreakTeamOverride,
                      }))
                    }
                  >
                    {ALL_OVERRIDE_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {BREAK_OVERRIDE_LABELS[opt]}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  className="theia-button secondary"
                  data-action={setTeamOverrideAction.id}
                  onClick={() => {
                    if (selectedManualTeamId.length > 0) {
                      void handleTeamOverride(
                        cat,
                        selectedManualTeamId,
                        selectedManualOverride,
                      );
                    }
                  }}
                >
                  {t("break.applyOverrideButton")}
                </button>
              </div>
            ) : null}

            {catSuccess !== undefined ? (
              <div className="simpletab-alert simpletab-alert-success" role="status">
                {catSuccess}
              </div>
            ) : null}
            {catError !== undefined ? (
              <InlineOpError
                error={catError.error}
                onRetry={catError.retry}
                onDismiss={() => {
                  setCategoryErrors((prev) => {
                    const next = { ...prev };
                    delete next[cat.id];
                    return next;
                  });
                }}
              />
            ) : null}
          </section>
        );
      })}

      <section
        className="simpletab-section"
        aria-labelledby={`${baseId}-elim-h`}
      >
        <h2 id={`${baseId}-elim-h`} className="simpletab-subtitle">
          {t("break.eliminationSectionTitle")}
        </h2>

        {eliminationRounds.length === 0 ? (
          <p className="simpletab-empty">{t("break.noEliminationRounds")}</p>
        ) : (
          <div className="simpletab-table-wrap">
            <table className="simpletab-table">
              <caption>{t("break.eliminationTableCaption")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("break.colRound")}</th>
                  <th scope="col">{t("break.colCategories")}</th>
                  <th scope="col">{t("break.colDrawStage")}</th>
                  <th scope="col">{t("break.colAdvancement")}</th>
                  {canManageBreak ? (
                    <th scope="col">{t("break.colActions")}</th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {eliminationRounds.map((round) => {
                  const categoryNames = (round.breakCategoryIds ?? [])
                    .map((id) => categoryNameById.get(id) ?? id)
                    .join(", ");
                  const advanced = round.eliminationAdvanced === true;
                  return (
                    <tr key={round.id}>
                      <td>{round.name}</td>
                      <td>{categoryNames || t("common.none")}</td>
                      <td>{drawStageOf(round)}</td>
                      <td>
                        <span
                          className={`simpletab-badge ${
                            advanced ? "simpletab-badge-add" : ""
                          }`}
                        >
                          {advanced
                            ? t("break.advancementDone")
                            : t("break.advancementPending")}
                        </span>
                      </td>
                      {canManageBreak ? (
                        <td>
                          <button
                            type="button"
                            className="theia-button"
                            data-action={advanceRoundAction.id}
                            disabled={advanced}
                            onClick={() => {
                              void handleAdvanceRound(round.id, round.name);
                            }}
                          >
                            {t("break.advanceButton")}
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {elimSuccess !== null ? (
          <div className="simpletab-alert simpletab-alert-success" role="status">
            {elimSuccess}
          </div>
        ) : null}
        {elimError !== null ? (
          <InlineOpError
            error={elimError.error}
            onRetry={elimError.retry}
            onDismiss={() => setElimError(null)}
          />
        ) : null}
      </section>
    </div>
  );
};
