import type { RecordKey } from "@simpletab/core/ops";
import type { SubmitErrorCode } from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import { t } from "../i18n";

export interface InlineOpErrorData {
  code: SubmitErrorCode;
  errors: string[];
  current?: Record<RecordKey, number>;
  currentSummary?: string;
  blockingSeqs?: number[];
}

export interface InlineOpErrorProps {
  error: InlineOpErrorData;
  onRetry?: () => void;
  onDismiss?: () => void;
}

function errorCodeLabel(code: SubmitErrorCode): string {
  switch (code) {
    case "VERSION_CONFLICT":
      return t("opError.versionConflict");
    case "OVERRIDDEN_BY_HOST":
      return t("opError.overriddenByHost");
    case "LOCKED":
      return t("opError.locked");
    case "FORBIDDEN":
      return t("opError.forbidden");
    case "INVALID":
      return t("opError.invalid");
    case "CANNOT_UNDO":
      return t("opError.cannotUndo");
    default:
      return t("opError.generic");
  }
}

export const InlineOpError: React.FC<InlineOpErrorProps> = ({
  error,
  onRetry,
  onDismiss,
}) => {
  const versionEntries = error.current ? Object.entries(error.current) : [];
  const versionsText = versionEntries
    .map(([key, ver]) => `${key} v${ver}`)
    .join(", ");

  return (
    <div className="simpletab-inline-error" role="alert">
      <div className="simpletab-inline-error-header">
        <span className="simpletab-badge simpletab-badge-error">
          {errorCodeLabel(error.code)}
        </span>
        <span className="simpletab-inline-error-code">{error.code}</span>
      </div>
      {error.errors.length > 0 ? (
        <ul className="simpletab-issue-list">
          {error.errors.map((msg, idx) => (
            <li key={idx}>{msg}</li>
          ))}
        </ul>
      ) : null}
      {error.currentSummary ? (
        <div className="simpletab-inline-error-meta">
          {t("opError.currentValue", { value: error.currentSummary })}
        </div>
      ) : null}
      {versionsText.length > 0 ? (
        <div className="simpletab-hint">
          {t("opError.currentVersions", { versions: versionsText })}
        </div>
      ) : null}
      {error.blockingSeqs && error.blockingSeqs.length > 0 ? (
        <div className="simpletab-inline-error-meta">
          {t("opError.blockedByOps", {
            seqs: error.blockingSeqs.map((seq) => `#${seq}`).join(", "),
          })}
        </div>
      ) : null}
      {onRetry !== undefined || onDismiss !== undefined ? (
        <div className="simpletab-actions">
          {onRetry !== undefined ? (
            <button type="button" className="theia-button" data-view-only onClick={onRetry}>
              {t("opError.retry")}
            </button>
          ) : null}
          {onDismiss !== undefined ? (
            <button
              type="button"
              className="theia-button secondary"
              data-view-only
              onClick={onDismiss}
            >
              {t("opError.dismiss")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
