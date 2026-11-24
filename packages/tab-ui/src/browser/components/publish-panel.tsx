import type {
  OnlineSettings,
  PublishStatus,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import { t } from "../i18n";

export interface PublishPanelProps {
  open: boolean;
  canManage: boolean;
  onlineSettings: OnlineSettings;
  loadStatus: () => Promise<PublishStatus>;
  onPublishNow: () => Promise<PublishStatus>;
  onSetLive: (on: boolean) => Promise<void>;
  /** Poll interval while the panel is shown; tests pass a small value. */
  pollMs?: number;
}

const BUSY_STATES: ReadonlySet<PublishStatus["state"]> = new Set([
  "building",
  "uploading",
  "anchoring",
  "confirming",
]);

function formatTime(iso: string | undefined): string {
  if (iso === undefined) return "";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : iso;
}

/**
 * Live public site controls on the Releases page (design section 10). Publishing runs in the host
 * backend's queue; this panel only asks for it and shows where it stands. It never blocks tabbing.
 */
export const PublishPanel: React.FC<PublishPanelProps> = ({
  open,
  canManage,
  onlineSettings,
  loadStatus,
  onPublishNow,
  onSetLive,
  pollMs = 5000,
}) => {
  const [status, setStatus] = React.useState<PublishStatus | null>(null);
  const [requesting, setRequesting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return undefined;
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
  }, [open, loadStatus, pollMs]);

  const busy = requesting || (status !== null && BUSY_STATES.has(status.state));
  const cdnUrl = onlineSettings.cdnHost ? `https://${onlineSettings.cdnHost}/` : null;

  const publish = async (): Promise<void> => {
    setError(null);
    setRequesting(true);
    try {
      setStatus(await onPublishNow());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRequesting(false);
    }
  };

  const toggleLive = async (on: boolean): Promise<void> => {
    setError(null);
    try {
      await onSetLive(on);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const stateLabel = status === null ? t("releases.publishStateLoading") : t(`releases.publishState.${status.state}`);

  return (
    <section className="simpletab-section" aria-labelledby="simpletab-publish-title">
      <h3 id="simpletab-publish-title" className="simpletab-subtitle">
        {t("releases.publishTitle")}
      </h3>
      <p className="simpletab-hint">{t("releases.publishHint")}</p>

      <label className="simpletab-switch">
        <input
          type="checkbox"
          checked={onlineSettings.livePublicSite}
          disabled={!open || !canManage}
          onChange={(e) => {
            void toggleLive(e.target.checked);
          }}
        />
        <span>{t("releases.publishLive")}</span>
      </label>

      <p role="status" aria-live="polite">
        <strong>{t("releases.publishStatusLabel")}: </strong>
        {stateLabel}
        {status?.at !== undefined ? ` (${formatTime(status.at)})` : ""}
      </p>
      {status?.reason !== undefined ? (
        <p className={status.state === "failed" ? "simpletab-alert simpletab-alert-error" : "simpletab-hint"} role={status.state === "failed" ? "alert" : undefined}>
          {status.reason}
          {status.nextRetryAt !== undefined
            ? ` ${t("releases.publishRetryAt", { time: formatTime(status.nextRetryAt) })}`
            : ""}
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
            void publish();
          }}
        >
          {busy ? t("releases.publishRunning") : t("releases.publishNow")}
        </button>
        {cdnUrl !== null ? (
          <a href={cdnUrl} target="_blank" rel="noreferrer noopener">
            {t("releases.publishOpenSite", { host: onlineSettings.cdnHost ?? "" })}
          </a>
        ) : null}
      </div>
    </section>
  );
};
