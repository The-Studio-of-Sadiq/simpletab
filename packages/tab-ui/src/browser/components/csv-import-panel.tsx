import {
  chosenAction,
  countRowsWithErrors,
  planImport,
  type ImportChoices,
  type ImportKind,
  type ImportPlan,
  type PlannedRow,
  type RowAction,
} from "@simpletab/core/lib/csv/importPlan";
import type { ProjectedState } from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import {
  applyCsvImportAction,
  type CsvApplyInput,
  type CsvApplyResult,
  type CsvApplySummary,
} from "../actions/csv-import-actions";
import type { ActionRunner } from "../actions/action";
import { t } from "../i18n";

export interface CsvImportPanelProps {
  kind: ImportKind;
  state: ProjectedState;
  run: ActionRunner;
  onClose?: () => void;
}

type RowVisualStatus = "add" | "match" | "conflict" | "error";

function getRowVisualStatus(row: PlannedRow): RowVisualStatus {
  if (row.issues.some((issue) => issue.severity === "error") || !row.draft) {
    return "error";
  }
  if (row.duplicateOfRow !== undefined) {
    return "conflict";
  }
  if (row.match !== undefined) {
    return "match";
  }
  return "add";
}

function statusBadgeLabel(status: RowVisualStatus): string {
  switch (status) {
    case "add":
      return t("participants.csv.statusAdd");
    case "match":
      return t("participants.csv.statusMatch");
    case "conflict":
      return t("participants.csv.statusConflict");
    case "error":
      return t("participants.csv.statusError");
  }
}

function actionLabel(action: RowAction): string {
  switch (action) {
    case "create":
      return t("participants.csv.actionCreate");
    case "update":
      return t("participants.csv.actionUpdate");
    case "skip":
      return t("participants.csv.actionSkip");
  }
}

function kindTitle(kind: ImportKind): string {
  switch (kind) {
    case "institutions":
      return t("participants.csv.kindInstitutions");
    case "teams":
      return t("participants.csv.kindTeams");
    case "adjudicators":
      return t("participants.csv.kindAdjudicators");
  }
}

export const CsvImportPanel: React.FC<CsvImportPanelProps> = ({
  kind,
  state,
  run,
  onClose,
}) => {
  const baseId = React.useId();
  const [csvText, setCsvText] = React.useState("");
  const [actionsByRow, setActionsByRow] = React.useState<Record<number, RowAction>>({});
  const [validRowsOnly, setValidRowsOnly] = React.useState(false);
  const [commitErrors, setCommitErrors] = React.useState<string[]>([]);
  const [applying, setApplying] = React.useState(false);
  const [applySummary, setApplySummary] = React.useState<CsvApplySummary | null>(null);

  const importContext = React.useMemo(
    () => ({
      institutions: state.institutions,
      teams: state.teams,
      adjudicators: state.adjudicators,
      breakCategories: state.breakCategories,
      speakerCategories: state.tournament.preferences.speakerCategories ?? [],
      substantiveSpeakers: state.tournament.preferences.substantiveSpeakers,
      teamSeedMode: state.tournament.preferences.teamSeedMode,
    }),
    [state],
  );

  const plan: ImportPlan | null = React.useMemo(() => {
    if (csvText.trim().length === 0) {
      return null;
    }
    return planImport(kind, csvText, importContext);
  }, [csvText, importContext, kind]);

  const choices: ImportChoices = React.useMemo(
    () => ({
      actions: actionsByRow,
      validRowsOnly,
    }),
    [actionsByRow, validRowsOnly],
  );

  const counts = React.useMemo(() => {
    if (plan === null) {
      return { total: 0, add: 0, match: 0, conflict: 0, error: 0, activeOps: 0 };
    }
    let add = 0;
    let match = 0;
    let conflict = 0;
    let error = 0;
    let activeOps = 0;
    for (const row of plan.rows) {
      const status = getRowVisualStatus(row);
      if (status === "add") add += 1;
      else if (status === "match") match += 1;
      else if (status === "conflict") conflict += 1;
      else error += 1;

      if (chosenAction(row, choices) !== "skip" && row.draft !== undefined) {
        activeOps += 1;
      }
    }
    return {
      total: plan.rows.length,
      add,
      match,
      conflict,
      error,
      activeOps,
    };
  }, [choices, plan]);

  const errorRowCount = plan ? countRowsWithErrors(plan) : 0;

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    void file.text().then((text) => {
      setCsvText(text);
      setActionsByRow({});
      setCommitErrors([]);
      setApplySummary(null);
    });
  };

  const handleTextChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setCsvText(event.target.value);
    setActionsByRow({});
    setCommitErrors([]);
    setApplySummary(null);
  };

  const handleRowActionChange = (rowNumber: number, action: RowAction): void => {
    setActionsByRow((prev) => ({ ...prev, [rowNumber]: action }));
    setCommitErrors([]);
  };

  const handleApply = async (): Promise<void> => {
    if (plan === null) {
      return;
    }
    setCommitErrors([]);
    setApplySummary(null);
    setApplying(true);
    try {
      const result = await run<CsvApplyInput, CsvApplyResult>(applyCsvImportAction, {
        kind,
        csvText,
        choices,
      });
      if (!result.ok) {
        // A partial import shows its summary (which rows failed), as before.
        if (result.code === "PARTIAL") setApplySummary(result.summary);
        else setCommitErrors(result.errors);
        return;
      }
      setCommitErrors(result.commitErrors);
      setApplySummary(result.summary);
    } finally {
      setApplying(false);
    }
  };

  const fileInputId = `${baseId}-file`;
  const textInputId = `${baseId}-text`;
  const validOnlyId = `${baseId}-valid-only`;

  return (
    <section className="simpletab-section" aria-labelledby={`${baseId}-heading`}>
      <div className="simpletab-header">
        <h3 id={`${baseId}-heading`} className="simpletab-subtitle">
          {t("participants.csv.title", { kind: kindTitle(kind) })}
        </h3>
        {onClose !== undefined ? (
          <button
            type="button"
            className="theia-button secondary"
            data-view-only
            onClick={onClose}
          >
            {t("common.close")}
          </button>
        ) : null}
      </div>

      <div className="simpletab-form">
        <div className="simpletab-field">
          <label htmlFor={fileInputId}>{t("participants.csv.fileLabel")}</label>
          <input
            id={fileInputId}
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
          />
        </div>

        <div className="simpletab-field">
          <label htmlFor={textInputId}>{t("participants.csv.textLabel")}</label>
          <textarea
            id={textInputId}
            rows={5}
            value={csvText}
            onChange={handleTextChange}
          />
        </div>
      </div>

      {plan !== null && plan.fileErrors.length > 0 ? (
        <div className="simpletab-alert simpletab-alert-error" role="alert">
          <ul className="simpletab-issue-list">
            {plan.fileErrors.map((err, index) => (
              <li key={index}>{err}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {plan !== null && plan.fileErrors.length === 0 ? (
        <div>
          <p role="status">
            {t("participants.csv.previewSummary", {
              total: counts.total,
              add: counts.add,
              match: counts.match,
              conflict: counts.conflict,
              error: counts.error,
            })}
          </p>

          {plan.ignoredColumns.length > 0 ? (
            <p className="simpletab-hint">
              {t("participants.csv.ignoredColumns", {
                columns: plan.ignoredColumns.join(", "),
              })}
            </p>
          ) : null}

          {plan.newInstitutions.length > 0 ? (
            <p className="simpletab-hint">
              {t("participants.csv.newInstitutions", {
                names: plan.newInstitutions
                  .map((item) => `${item.name} (${item.code})`)
                  .join(", "),
              })}
            </p>
          ) : null}

          {errorRowCount > 0 ? (
            <div className="simpletab-checkbox-item">
              <input
                id={validOnlyId}
                type="checkbox"
                checked={validRowsOnly}
                onChange={(event) => setValidRowsOnly(event.target.checked)}
              />
              <label htmlFor={validOnlyId}>
                {t("participants.csv.validOnly", { count: errorRowCount })}
              </label>
            </div>
          ) : null}

          <div className="simpletab-table-wrap">
            <table className="simpletab-table">
              <caption>{t("participants.csv.tableCaption")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("participants.csv.colRow")}</th>
                  <th scope="col">{t("participants.csv.colName")}</th>
                  <th scope="col">{t("participants.csv.colDetails")}</th>
                  <th scope="col">{t("participants.csv.colStatus")}</th>
                  <th scope="col">{t("participants.csv.colAction")}</th>
                  <th scope="col">{t("participants.csv.colIssues")}</th>
                </tr>
              </thead>
              <tbody>
                {plan.rows.map((row) => {
                  const status = getRowVisualStatus(row);
                  const currentAction = chosenAction(row, choices);
                  const actionSelectId = `${baseId}-action-${row.rowNumber}`;
                  return (
                    <tr key={row.rowNumber}>
                      <td>{row.rowNumber}</td>
                      <td>{row.label}</td>
                      <td>{row.details}</td>
                      <td>
                        <span className={`simpletab-badge simpletab-badge-${status}`}>
                          {statusBadgeLabel(status)}
                        </span>
                        {row.match ? (
                          <span className="simpletab-hint"> ({row.match.reason})</span>
                        ) : null}
                      </td>
                      <td>
                        <label htmlFor={actionSelectId} className="visually-hidden">
                          {`${t("participants.csv.colAction")} ${row.rowNumber}`}
                        </label>
                        <select
                          id={actionSelectId}
                          value={currentAction}
                          disabled={row.actions.length <= 1}
                          onChange={(event) =>
                            handleRowActionChange(
                              row.rowNumber,
                              event.target.value as RowAction,
                            )
                          }
                        >
                          {row.actions.map((action) => (
                            <option key={action} value={action}>
                              {actionLabel(action)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {row.issues.length > 0 ? (
                          <ul className="simpletab-issue-list">
                            {row.issues.map((issue, idx) => (
                              <li key={idx}>
                                <strong>{issue.severity}:</strong> {issue.message}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          t("common.none")
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {commitErrors.length > 0 ? (
            <div className="simpletab-alert simpletab-alert-error" role="alert">
              <ul className="simpletab-issue-list">
                {commitErrors.map((err, index) => (
                  <li key={index}>{err}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="simpletab-actions">
            <button
              type="button"
              className="theia-button"
              data-action={applyCsvImportAction.id}
              disabled={applying}
              onClick={() => {
                void handleApply();
              }}
            >
              {applying
                ? t("participants.csv.applying")
                : t("participants.csv.apply", { count: counts.activeOps })}
            </button>
          </div>
        </div>
      ) : null}

      {applySummary !== null ? (
        <div
          className={`simpletab-alert ${
            applySummary.failures.length > 0
              ? "simpletab-alert-warning"
              : "simpletab-alert-success"
          }`}
          role={applySummary.failures.length > 0 ? "alert" : "status"}
        >
          <p>
            {t("participants.csv.applyResult", {
              succeeded: applySummary.succeeded,
              failed: applySummary.failures.length,
              skipped: applySummary.skipped,
            })}
          </p>
          {applySummary.failures.length > 0 ? (
            <ul className="simpletab-issue-list">
              {applySummary.failures.map((failure, idx) => (
                <li key={idx}>
                  {t("participants.csv.applyFailureItem", {
                    label: failure.label,
                    opType: failure.opType,
                    code: failure.code,
                    errors: failure.errors.join("; "),
                  })}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
};
