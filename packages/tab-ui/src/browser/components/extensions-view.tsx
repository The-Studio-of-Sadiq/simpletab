import type {
  ExtensionEntryStatus,
  ExtensionsLoadingReason,
  ExtensionsStatus,
} from "@simpletab/extensions/lib/common/extensions-protocol";
import * as React from "@theia/core/shared/react";
import type { ActionResult, ActionRunner, SimpleTabAction } from "../actions/action";
import {
  installExtensionAction,
  installExtensionFromFileAction,
  removeExtensionAction,
  restartSimpleTabAction,
  setExtensionOnAction,
} from "../actions/extensions-actions";
import { t } from "../i18n";

export interface ExtensionsViewProps {
  /** The live status, refreshed by the widget whenever an action finishes. */
  status: ExtensionsStatus;
  available: boolean;
  /** The widget owns the file dialog; the page only runs the action with its result. */
  onPickVsix?: () => Promise<string | undefined>;
  run: ActionRunner;
}

function reasonLabel(reason: ExtensionsLoadingReason): string {
  switch (reason) {
    case "may-host":
      return t("extensions.reasonMayHost");
    case "staff-device":
      return t("extensions.reasonStaffDevice");
    case "developer-mode":
      return t("extensions.reasonDeveloperMode");
  }
}

function ignoredReasonLabel(
  reason: ExtensionsStatus["ignoredFiles"][number]["reason"],
): string {
  switch (reason) {
    case "not-listed":
      return t("extensions.ignoredNotListed");
    case "hash-mismatch":
      return t("extensions.ignoredHashMismatch");
  }
}

function stateLabel(entry: ExtensionEntryStatus): string {
  if (!entry.installed) {
    return t("extensions.stateNotInstalled");
  }
  if (entry.loaded) {
    return t("extensions.stateLoadedNow");
  }
  return entry.on
    ? t("extensions.stateInstalledOn")
    : t("extensions.stateInstalledOff");
}

export const ExtensionsView: React.FC<ExtensionsViewProps> = ({
  status,
  available,
  onPickVsix,
  run,
}) => {
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const busy = busyKey !== null;

  const perform = async <A, R extends ActionResult>(
    key: string,
    action: SimpleTabAction<A, R>,
    args: A,
  ): Promise<void> => {
    setErrorMessage(null);
    setBusyKey(key);
    try {
      const result = await run(action, args);
      if (!result.ok) {
        setErrorMessage(result.errors.join(" "));
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(null);
    }
  };

  const handleInstallFromFile = async (): Promise<void> => {
    setErrorMessage(null);
    if (onPickVsix === undefined) {
      setErrorMessage(t("extensions.fileDialogUnavailable"));
      return;
    }
    setBusyKey("install-from-file");
    try {
      const path = await onPickVsix();
      if (path === undefined) {
        return;
      }
      const result = await run(installExtensionFromFileAction, { path });
      if (!result.ok) {
        setErrorMessage(result.errors.join(" "));
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="simpletab-page">
      <div className="simpletab-header">
        <h2 className="simpletab-title">{t("extensions.title")}</h2>
      </div>

      {!available ? (
        <div className="simpletab-alert simpletab-alert-warning" role="alert">
          {t("extensions.unavailable")}
        </div>
      ) : null}

      {errorMessage !== null ? (
        <div className="simpletab-alert simpletab-alert-error" role="alert">
          {errorMessage}
        </div>
      ) : null}

      {busy ? (
        <div className="simpletab-hint" role="status">
          {t("extensions.working")}
        </div>
      ) : null}

      <section className="simpletab-section">
        <div className="simpletab-status-grid">
          <div className="simpletab-status-label">
            {t("extensions.reasonLabel")}
          </div>
          <div className="simpletab-status-value">
            {reasonLabel(status.reason)}
          </div>
        </div>

        {status.reason === "developer-mode" ? (
          <div className="simpletab-alert simpletab-alert-warning" role="note">
            {t("extensions.developerWarning")}
          </div>
        ) : null}

        {status.restartNeeded ? (
          <div className="simpletab-alert simpletab-alert-warning" role="status">
            <span>{t("extensions.restartNeeded")}</span>{" "}
            <button
              type="button"
              className="theia-button secondary"
              data-action={restartSimpleTabAction.id}
              disabled={!available || busy}
              onClick={() => {
                void perform("restart", restartSimpleTabAction, {});
              }}
            >
              {t("extensions.restart")}
            </button>
          </div>
        ) : null}
      </section>

      <section className="simpletab-section">
        <h3 className="simpletab-subtitle">{t("extensions.title")}</h3>
        <div className="simpletab-table-wrap">
          <table className="simpletab-table">
            <thead>
              <tr>
                <th>{t("extensions.tableName")}</th>
                <th>{t("extensions.tableVersion")}</th>
                <th>{t("extensions.tableLicense")}</th>
                <th>{t("extensions.tablePurpose")}</th>
                <th>{t("extensions.tableState")}</th>
                <th>{t("extensions.tableActions")}</th>
              </tr>
            </thead>
            <tbody>
              {status.extensions.length === 0 ? (
                <tr>
                  <td colSpan={6}>{t("extensions.empty")}</td>
                </tr>
              ) : (
                status.extensions.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.name}</td>
                    <td>{entry.version}</td>
                    <td>{entry.license}</td>
                    <td>{entry.purpose}</td>
                    <td>{stateLabel(entry)}</td>
                    <td>
                      <div className="simpletab-actions">
                        {!entry.installed ? (
                          <button
                            type="button"
                            className="theia-button"
                            data-action={installExtensionAction.id}
                            disabled={!available || busy}
                            onClick={() => {
                              void perform(`install:${entry.id}`, installExtensionAction, {
                                id: entry.id,
                              });
                            }}
                          >
                            {t("extensions.install")}
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="theia-button secondary"
                              data-action={setExtensionOnAction.id}
                              disabled={!available || busy}
                              onClick={() => {
                                void perform(
                                  `set-on:${entry.id}`,
                                  setExtensionOnAction,
                                  { id: entry.id, on: !entry.on },
                                );
                              }}
                            >
                              {entry.on
                                ? t("extensions.turnOff")
                                : t("extensions.turnOn")}
                            </button>
                            <button
                              type="button"
                              className="theia-button secondary"
                              data-action={removeExtensionAction.id}
                              disabled={!available || busy}
                              onClick={() => {
                                void perform(`remove:${entry.id}`, removeExtensionAction, {
                                  id: entry.id,
                                });
                              }}
                            >
                              {t("extensions.remove")}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="simpletab-actions">
          <button
            type="button"
            className="theia-button secondary"
            data-action={installExtensionFromFileAction.id}
            disabled={!available || busy}
            onClick={() => {
              void handleInstallFromFile();
            }}
          >
            {t("extensions.installFromFile")}
          </button>
        </div>
      </section>

      {status.ignoredFiles.length > 0 ? (
        <section className="simpletab-section">
          <h3 className="simpletab-subtitle">{t("extensions.ignoredTitle")}</h3>
          <ul>
            {status.ignoredFiles.map((ignored) => (
              <li key={ignored.file}>
                {t("extensions.ignoredItem", {
                  file: ignored.file,
                  reason: ignoredReasonLabel(ignored.reason),
                })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
};
