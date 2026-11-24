import type {
  ArchiveStatus,
  OnlineSettings,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import { t } from "../i18n";

export interface ArchivePanelProps {
  open: boolean;
  canManage: boolean;
  onlineSettings: OnlineSettings;
  loadStatus: () => Promise<ArchiveStatus>;
  onArchiveNow: () => Promise<ArchiveStatus>;
  onSetMirror: (on: boolean) => Promise<void>;
  /** Poll interval while the panel is shown; tests pass a small value. */
  pollMs?: number;
}

const BUSY_STATES: ReadonlySet<ArchiveStatus["state"]> = new Set(["building", "uploading", "confirming"]);

function formatTime(iso: string | undefined): string {
  if (iso === undefined) return "";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : iso;
}

/**
 * Permanent GitHub archive controls on the Releases page (design section 10.1). The archive is
 * committed by the host backend and electron-main; this panel only asks for it and shows the result.
 */
export const ArchivePanel: React.FC<ArchivePanelProps> = ({
  open,
  canManage,
  onlineSettings,
  loadStatus,
  onArchiveNow,
  onSetMirror,
  pollMs = 5000,
}) => {
  const [status, setStatus] = React.useState<ArchiveStatus | null>(null);
  const [requesting, setRequesting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const enabled = onlineSettings.githubArchive;

  React.useEffect(() => {
    if (!open || !enabled) return undefined;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const next = await loadStatus();
        if (!cancelled) setStatus(next);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, enabled, loadStatus, pollMs]);

  if (!enabled) {
    return (
      <section className="simpletab-section" aria-labelledby="simpletab-archive-title">
        <h3 id="simpletab-archive-title" className="simpletab-subtitle">
          {t("releases.archiveTitle")}
        </h3>
        <p className="simpletab-hint">{t("releases.archiveOff")}</p>
      </section>
    );
  }

  const busy = requesting || (status !== null && BUSY_STATES.has(status.state));

  const archive = async (): Promise<void> => {
    setError(null);
    setRequesting(true);
    try {
      setStatus(await onArchiveNow());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRequesting(false);
    }
  };

  const toggleMirror = async (on: boolean): Promise<void> => {
    setError(null);
    try {
      await onSetMirror(on);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const stateLabel =
    status === null
      ? t("releases.publishStateLoading")
      : status.state === "done" && status.unchanged === true
        ? t("releases.archiveUnchanged")
        : t(`releases.archiveState.${status.state}`);

  return (
    <section className="simpletab-section" aria-labelledby="simpletab-archive-title">
      <h3 id="simpletab-archive-title" className="simpletab-subtitle">
        {t("releases.archiveTitle")}
      </h3>
      <p className="simpletab-hint">
        {t("releases.archiveHint", { repo: onlineSettings.githubRepo ?? "—" })}
      </p>

      <label className="simpletab-switch">
        <input
          type="checkbox"
          checked={onlineSettings.githubArchiveMirror === true}
          disabled={!open || !canManage}
          onChange={(e) => {
            void toggleMirror(e.target.checked);
          }}
        />
        <span>{t("releases.archiveMirror")}</span>
      </label>

      <p role="status" aria-live="polite">
        <strong>{t("releases.publishStatusLabel")}: </strong>
        {stateLabel}
        {status?.at !== undefined ? ` (${formatTime(status.at)})` : ""}
        {status?.commitSha !== undefined ? ` · ${t("releases.archiveCommit", { sha: status.commitSha.slice(0, 7) })}` : ""}
      </p>
      {status?.reason !== undefined ? (
        <p
          className={status.state === "failed" ? "simpletab-alert simpletab-alert-error" : "simpletab-hint"}
          role={status.state === "failed" ? "alert" : undefined}
        >
          {status.reason}
        </p>
      ) : null}
      {error !== null ? (
        <p className="simpletab-alert simpletab-alert-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="simpletab-actions">
        <button
          type="button"
          className="theia-button"
          disabled={!open || !canManage || busy}
          onClick={() => {
            void archive();
          }}
        >
          {busy ? t("releases.archiveRunning") : t("releases.archiveNow")}
        </button>
        {status?.url !== undefined ? (
          <a href={status.url} target="_blank" rel="noreferrer noopener">
            {t("releases.archiveOpen")}
          </a>
        ) : null}
      </div>
    </section>
  );
};
