import type { DeviceModeStatus, HostStatus, PromoteParams, ReplacedInfo } from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import { t } from "../i18n";

export interface PromotePanelProps {
  device: DeviceModeStatus;
  onPromote: (params: PromoteParams) => Promise<HostStatus>;
  onExportCopy: (directory: string) => Promise<string>;
  onPickDirectory?: () => Promise<string | undefined>;
  onPickFile?: () => Promise<string | undefined>;
  confirmPromote?: () => boolean;
}

/**
 * "Promote this laptop to host" on a tab director's laptop (design section 4). Promotion is for when
 * the host laptop is gone for good: it is refused while the host is reachable, and it names the
 * better-ranked laptops so the right one is promoted.
 */
export const PromotePanel: React.FC<PromotePanelProps> = ({
  device,
  onPromote,
  onExportCopy,
  onPickDirectory,
  onPickFile,
  confirmPromote = () => window.confirm(t("promote.confirm")),
}) => {
  const baseId = React.useId();
  const [directory, setDirectory] = React.useState("");
  const [newerCopy, setNewerCopy] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  if (device.roleId !== "tab_director") return null;
  const connected = device.connection === "connected";
  const better = device.betterRanked ?? [];

  const run = async (action: () => Promise<void>): Promise<void> => {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="simpletab-section" aria-labelledby={`${baseId}-title`}>
      <h3 id={`${baseId}-title`} className="simpletab-subtitle">
        {t("promote.title")}
      </h3>
      <p className="simpletab-hint">
        {device.copy !== undefined
          ? t("promote.copyState", { seq: device.copy.lastSeq })
          : t("promote.noCopy")}
        {device.successionRank !== undefined ? ` ${t("promote.rank", { rank: device.successionRank })}` : ""}
      </p>
      {device.copy?.error !== undefined ? (
        <p className="simpletab-alert simpletab-alert-warning" role="note">
          {device.copy.error}
        </p>
      ) : null}
      {better.length > 0 ? (
        <p className="simpletab-alert simpletab-alert-warning" role="note">
          {t("promote.betterRanked", { names: better.join(", ") })}
        </p>
      ) : null}

      <div className="simpletab-field">
        <label htmlFor={`${baseId}-dir`}>{t("promote.folderLabel")}</label>
        <div className="simpletab-actions">
          <input
            id={`${baseId}-dir`}
            type="text"
            value={directory}
            disabled={busy}
            onChange={(e) => setDirectory(e.target.value)}
          />
          {onPickDirectory !== undefined ? (
            <button
              type="button"
              className="theia-button secondary"
              disabled={busy}
              onClick={() => {
                void onPickDirectory().then((picked) => {
                  if (picked !== undefined) setDirectory(picked);
                });
              }}
            >
              {t("promote.choose")}
            </button>
          ) : null}
        </div>
        <label htmlFor={`${baseId}-copy`}>{t("promote.newerCopyLabel")}</label>
        <div className="simpletab-actions">
          <input
            id={`${baseId}-copy`}
            type="text"
            value={newerCopy}
            disabled={busy}
            onChange={(e) => setNewerCopy(e.target.value)}
          />
          {onPickFile !== undefined ? (
            <button
              type="button"
              className="theia-button secondary"
              disabled={busy}
              onClick={() => {
                void onPickFile().then((picked) => {
                  if (picked !== undefined) setNewerCopy(picked);
                });
              }}
            >
              {t("promote.choose")}
            </button>
          ) : null}
        </div>
        <p className="simpletab-hint">{t("promote.newerCopyHint")}</p>
      </div>

      {connected ? <p className="simpletab-hint">{t("promote.hostReachable")}</p> : null}
      <div className="simpletab-actions">
        <button
          type="button"
          className="theia-button"
          disabled={busy || connected || directory.trim().length === 0 || device.copy === undefined}
          onClick={() => {
            if (!confirmPromote()) return;
            void run(async () => {
              await onPromote({
                directory,
                ...(newerCopy.trim().length > 0 ? { newerCopyPath: newerCopy.trim() } : {}),
              });
            });
          }}
        >
          {t("promote.promote")}
        </button>
        <button
          type="button"
          className="theia-button secondary"
          disabled={busy || directory.trim().length === 0 || device.copy === undefined}
          onClick={() => {
            void run(async () => {
              const file = await onExportCopy(directory);
              setMessage(t("promote.saved", { file }));
            });
          }}
        >
          {t("promote.saveCopy")}
        </button>
      </div>
      {message !== null ? <p role="status">{message}</p> : null}
      {error !== null ? (
        <p className="simpletab-alert simpletab-alert-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
};

/** On a host that another, promoted host replaced: read-only, with the file to review. */
export const ReplacedBanner: React.FC<{ info: ReplacedInfo }> = ({ info }) => (
  <section className="simpletab-alert simpletab-alert-error" role="alert">
    <p>
      <strong>{t("promote.replacedTitle", { number: info.hostNumber })}</strong>
    </p>
    <p>{t("promote.replacedBody")}</p>
    {info.divergentFile !== undefined ? <p>{t("promote.replacedFile", { file: info.divergentFile })}</p> : null}
  </section>
);
