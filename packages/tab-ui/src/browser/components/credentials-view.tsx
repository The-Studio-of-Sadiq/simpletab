import {
  CREDENTIAL_NAMES,
  type CredentialName,
  type CredentialStatusEntry,
  type CredentialTestResult,
  type SmtpCredentialPayload,
} from "@simpletab/host/lib/common/credentials-protocol";
import {
  DEFAULT_ONLINE_SETTINGS,
  type BallotCollectionMode,
  type HostStatus,
  type OnlineSettings,
  type ProjectedState,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import { t } from "../i18n";
import { stateHasPermission } from "../lib/permissions";

export interface CredentialsViewProps {
  state: ProjectedState | null;
  status: HostStatus;
  available: boolean;
  credentialsStatus: readonly CredentialStatusEntry[];
  onRefreshCredentials: () => Promise<CredentialStatusEntry[]>;
  onSetCredential: (name: CredentialName, value: string) => Promise<void>;
  onClearCredential: (name: CredentialName) => Promise<void>;
  onTestCredential: (name: CredentialName) => Promise<CredentialTestResult>;
  onUpdateOnlineSettings: (
    patch: Partial<OnlineSettings>,
  ) => Promise<OnlineSettings>;
}

interface SmtpFormValues {
  host: string;
  port: string;
  user: string;
  password: string;
  from: string;
}

const EMPTY_SMTP_FORM: SmtpFormValues = {
  host: "",
  port: "587",
  user: "",
  password: "",
  from: "",
};

const EMAIL_RE = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
const DISPLAY_EMAIL_RE = /^[^<>]+<\s*([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)\s*>$/;

function isValidEmail(value: string): boolean {
  const trimmed = value.trim();
  if (EMAIL_RE.test(trimmed)) {
    return true;
  }
  const match = DISPLAY_EMAIL_RE.exec(trimmed);
  return match !== null && EMAIL_RE.test(match[1] ?? "");
}

function credentialLabel(name: CredentialName): string {
  switch (name) {
    case "tournamentKey":
      return t("credentials.fieldTournamentKey");
    case "cdnToken":
      return t("credentials.fieldCdnToken");
    case "smtp":
      return t("credentials.fieldSmtp");
    case "githubToken":
      return t("credentials.fieldGithubToken");
    case "ownWorkerToken":
      return t("credentials.fieldOwnWorkerToken");
  }
}

function credentialDescription(name: CredentialName): string {
  switch (name) {
    case "tournamentKey":
      return t("credentials.fieldTournamentKeyDesc");
    case "cdnToken":
      return t("credentials.fieldCdnTokenDesc");
    case "smtp":
      return t("credentials.fieldSmtpDesc");
    case "githubToken":
      return t("credentials.fieldGithubTokenDesc");
    case "ownWorkerToken":
      return t("credentials.fieldOwnWorkerTokenDesc");
  }
}

function formatLastTested(entry: CredentialStatusEntry | undefined): string {
  if (entry?.testedAt === undefined) {
    return t("credentials.lastTestedNever");
  }
  const timestamp = t("credentials.lastTested", { testedAt: entry.testedAt });
  if (entry.ok === true) {
    return `${timestamp} — ${t("credentials.testPassed")}`;
  }
  if (entry.ok === false) {
    const failed = entry.error
      ? t("credentials.testFailed", { error: entry.error })
      : t("credentials.testFailedGeneric");
    return `${timestamp} — ${failed}`;
  }
  return timestamp;
}

function stepStateLabel(entry: CredentialStatusEntry | undefined): string {
  if (!entry?.set) {
    return t("credentials.stepIncomplete");
  }
  if (entry.ok === true) {
    return t("credentials.stepReady");
  }
  if (entry.ok === false) {
    return t("credentials.stepFailed");
  }
  return t("credentials.statusSet");
}

export const CredentialsView: React.FC<CredentialsViewProps> = ({
  state,
  status,
  available,
  credentialsStatus,
  onSetCredential,
  onClearCredential,
  onTestCredential,
  onUpdateOnlineSettings,
}) => {
  const baseId = React.useId();
  const canManage =
    state === null || stateHasPermission(state, "credentials.manage");

  const [editingName, setEditingName] = React.useState<CredentialName | null>(
    null,
  );
  const [tokenInput, setTokenInput] = React.useState("");
  const [smtpForm, setSmtpForm] = React.useState<SmtpFormValues>(EMPTY_SMTP_FORM);
  const [busyName, setBusyName] = React.useState<CredentialName | null>(null);
  const [feedbackMessage, setFeedbackMessage] = React.useState<string | null>(
    null,
  );
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [onlineBusy, setOnlineBusy] = React.useState(false);

  const entryMap = React.useMemo(() => {
    const map = new Map<CredentialName, CredentialStatusEntry>();
    for (const entry of credentialsStatus) {
      map.set(entry.name, entry);
    }
    return map;
  }, [credentialsStatus]);

  if (!canManage) {
    return (
      <div className="simpletab-page">
        <div className="simpletab-header">
          <h2 className="simpletab-title">{t("credentials.title")}</h2>
        </div>
        <div className="simpletab-alert simpletab-alert-error" role="alert">
          <strong>{t("credentials.restrictedTitle")}: </strong>
          {t("credentials.restrictedBody")}
        </div>
      </div>
    );
  }

  const onlineSettings: OnlineSettings =
    status.onlineSettings ?? DEFAULT_ONLINE_SETTINGS;

  const beginEdit = (name: CredentialName): void => {
    setErrorMessage(null);
    setFeedbackMessage(null);
    setTokenInput("");
    setSmtpForm(EMPTY_SMTP_FORM);
    setEditingName(name);
  };

  const cancelEdit = (): void => {
    setEditingName(null);
    setTokenInput("");
    setSmtpForm(EMPTY_SMTP_FORM);
  };

  const handleSaveSecret = async (name: CredentialName): Promise<void> => {
    setErrorMessage(null);
    setFeedbackMessage(null);

    let serialized = "";
    if (name === "smtp") {
      const host = smtpForm.host.trim();
      const port = Number(smtpForm.port.trim());
      const user = smtpForm.user.trim();
      const password = smtpForm.password;
      const from = smtpForm.from.trim();
      if (
        host.length === 0 ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        user.length === 0 ||
        password.length === 0 ||
        !isValidEmail(from)
      ) {
        setErrorMessage(t("credentials.validationSmtp"));
        return;
      }
      const payload: SmtpCredentialPayload = {
        host,
        port,
        user,
        password,
        from,
      };
      serialized = JSON.stringify(payload);
    } else {
      const trimmed = tokenInput.trim();
      if (trimmed.length === 0) {
        setErrorMessage(t("credentials.validationEmpty"));
        return;
      }
      serialized = trimmed;
    }

    setBusyName(name);
    try {
      await onSetCredential(name, serialized);
      // Clear sensitive inputs immediately after sending to electron-main.
      setTokenInput("");
      setSmtpForm(EMPTY_SMTP_FORM);
      setEditingName(null);
      setFeedbackMessage(
        t("credentials.secretSaved", { label: credentialLabel(name) }),
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyName(null);
    }
  };

  const handleClear = async (name: CredentialName): Promise<void> => {
    setErrorMessage(null);
    setFeedbackMessage(null);
    setBusyName(name);
    try {
      await onClearCredential(name);
      if (editingName === name) {
        cancelEdit();
      }
      setFeedbackMessage(
        t("credentials.secretCleared", { label: credentialLabel(name) }),
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyName(null);
    }
  };

  const handleTest = async (name: CredentialName): Promise<void> => {
    setErrorMessage(null);
    setFeedbackMessage(null);
    setBusyName(name);
    try {
      const result = await onTestCredential(name);
      if (result.ok) {
        setFeedbackMessage(
          `${credentialLabel(name)}: ${t("credentials.testPassed")}`,
        );
      } else {
        setErrorMessage(
          `${credentialLabel(name)}: ${
            result.error
              ? t("credentials.testFailed", { error: result.error })
              : t("credentials.testFailedGeneric")
          }`,
        );
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyName(null);
    }
  };

  const handleOnlinePatch = async (
    patch: Partial<OnlineSettings>,
  ): Promise<void> => {
    if (!status.open) {
      return;
    }
    setErrorMessage(null);
    setOnlineBusy(true);
    try {
      await onUpdateOnlineSettings(patch);
      setFeedbackMessage(t("credentials.onlineSaved"));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setOnlineBusy(false);
    }
  };

  const keyEntry = entryMap.get("tournamentKey");
  const cdnEntry = entryMap.get("cdnToken");
  const smtpEntry = entryMap.get("smtp");
  const githubEntry = entryMap.get("githubToken");

  const keyStepStatus = keyEntry?.set
    ? t("credentials.stepKeyReady")
    : onlineSettings.keyRequestedAt
      ? t("credentials.stepPendingSince", {
          since: onlineSettings.keyRequestedAt,
        })
      : t("credentials.stepKeyNotSet");

  return (
    <div className="simpletab-page">
      <div className="simpletab-header">
        <h2 className="simpletab-title">{t("credentials.title")}</h2>
      </div>

      {!available ? (
        <div className="simpletab-alert simpletab-alert-warning" role="alert">
          {t("credentials.unavailable")}
        </div>
      ) : null}

      {errorMessage !== null ? (
        <div className="simpletab-alert simpletab-alert-error" role="alert">
          {errorMessage}
        </div>
      ) : null}

      {feedbackMessage !== null ? (
        <div className="simpletab-alert simpletab-alert-success" role="status">
          {feedbackMessage}
        </div>
      ) : null}

      <section className="simpletab-section">
        <h3 className="simpletab-subtitle">{t("credentials.secretsTitle")}</h3>
        <p className="simpletab-hint">{t("credentials.secretsHint")}</p>

        <div className="simpletab-table-wrap">
          <table className="simpletab-table">
            <thead>
              <tr>
                <th>{t("credentials.secretsTitle")}</th>
                <th>{t("status.addonColState")}</th>
                <th>{t("credentials.lastTestedNever").split(":")[0]}</th>
                <th>{t("common.edit")}</th>
              </tr>
            </thead>
            <tbody>
              {CREDENTIAL_NAMES.map((name) => {
                const entry = entryMap.get(name);
                const isSet = Boolean(entry?.set);
                const isBusy = busyName === name;
                const isEditing = editingName === name;
                return (
                  <React.Fragment key={name}>
                    <tr>
                      <td>
                        <div>
                          <strong>{credentialLabel(name)}</strong>
                        </div>
                        <div className="simpletab-hint">
                          {credentialDescription(name)}
                        </div>
                      </td>
                      <td>
                        <span
                          className={`simpletab-badge ${
                            isSet ? "simpletab-badge-add" : ""
                          }`}
                        >
                          {isSet
                            ? t("credentials.statusSet")
                            : t("credentials.statusNotSet")}
                        </span>
                      </td>
                      <td>{formatLastTested(entry)}</td>
                      <td>
                        <div className="simpletab-actions">
                          <button
                            type="button"
                            className="theia-button"
                            disabled={!available || isBusy}
                            onClick={() => beginEdit(name)}
                          >
                            {isSet
                              ? t("credentials.updateAction")
                              : t("credentials.setAction")}
                          </button>
                          <button
                            type="button"
                            className="theia-button secondary"
                            disabled={!available || !isSet || isBusy}
                            onClick={() => {
                              void handleClear(name);
                            }}
                          >
                            {t("credentials.clearAction")}
                          </button>
                          <button
                            type="button"
                            className="theia-button secondary"
                            disabled={!available || isBusy}
                            onClick={() => {
                              void handleTest(name);
                            }}
                          >
                            {isBusy
                              ? t("credentials.testing")
                              : t("credentials.testAction")}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isEditing ? (
                      <tr>
                        <td colSpan={4}>
                          <form
                            className="simpletab-form"
                            onSubmit={(e) => {
                              e.preventDefault();
                              void handleSaveSecret(name);
                            }}
                          >
                            {name === "smtp" ? (
                              <div className="simpletab-form-grid">
                                <div className="simpletab-field">
                                  <label htmlFor={`${baseId}-smtp-host`}>
                                    {t("credentials.smtpHost")}
                                  </label>
                                  <input
                                    id={`${baseId}-smtp-host`}
                                    type="text"
                                    value={smtpForm.host}
                                    onChange={(e) =>
                                      setSmtpForm((prev) => ({
                                        ...prev,
                                        host: e.target.value,
                                      }))
                                    }
                                    autoComplete="off"
                                  />
                                </div>
                                <div className="simpletab-field">
                                  <label htmlFor={`${baseId}-smtp-port`}>
                                    {t("credentials.smtpPort")}
                                  </label>
                                  <input
                                    id={`${baseId}-smtp-port`}
                                    type="number"
                                    min={1}
                                    max={65535}
                                    value={smtpForm.port}
                                    onChange={(e) =>
                                      setSmtpForm((prev) => ({
                                        ...prev,
                                        port: e.target.value,
                                      }))
                                    }
                                  />
                                </div>
                                <div className="simpletab-field">
                                  <label htmlFor={`${baseId}-smtp-user`}>
                                    {t("credentials.smtpUser")}
                                  </label>
                                  <input
                                    id={`${baseId}-smtp-user`}
                                    type="text"
                                    value={smtpForm.user}
                                    onChange={(e) =>
                                      setSmtpForm((prev) => ({
                                        ...prev,
                                        user: e.target.value,
                                      }))
                                    }
                                    autoComplete="off"
                                  />
                                </div>
                                <div className="simpletab-field">
                                  <label htmlFor={`${baseId}-smtp-password`}>
                                    {t("credentials.smtpPassword")}
                                  </label>
                                  <input
                                    id={`${baseId}-smtp-password`}
                                    type="password"
                                    value={smtpForm.password}
                                    onChange={(e) =>
                                      setSmtpForm((prev) => ({
                                        ...prev,
                                        password: e.target.value,
                                      }))
                                    }
                                    autoComplete="new-password"
                                  />
                                </div>
                                <div className="simpletab-field">
                                  <label htmlFor={`${baseId}-smtp-from`}>
                                    {t("credentials.smtpFrom")}
                                  </label>
                                  <input
                                    id={`${baseId}-smtp-from`}
                                    type="email"
                                    value={smtpForm.from}
                                    onChange={(e) =>
                                      setSmtpForm((prev) => ({
                                        ...prev,
                                        from: e.target.value,
                                      }))
                                    }
                                    autoComplete="off"
                                  />
                                </div>
                              </div>
                            ) : (
                              <div className="simpletab-field">
                                <label htmlFor={`${baseId}-${name}-secret`}>
                                  {t("credentials.secretInputLabel", {
                                    label: credentialLabel(name),
                                  })}
                                </label>
                                <input
                                  id={`${baseId}-${name}-secret`}
                                  type="password"
                                  value={tokenInput}
                                  placeholder={t(
                                    "credentials.secretInputPlaceholder",
                                  )}
                                  onChange={(e) =>
                                    setTokenInput(e.target.value)
                                  }
                                  autoComplete="new-password"
                                />
                              </div>
                            )}

                            <div className="simpletab-actions">
                              <button
                                type="submit"
                                className="theia-button"
                                disabled={isBusy}
                              >
                                {isBusy
                                  ? t("credentials.saving")
                                  : t("credentials.saveAction")}
                              </button>
                              <button
                                type="button"
                                className="theia-button secondary"
                                onClick={cancelEdit}
                              >
                                {t("credentials.cancelAction")}
                              </button>
                            </div>
                          </form>
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="simpletab-section">
        <h3 className="simpletab-subtitle">
          {t("credentials.onlineSectionTitle")}
        </h3>
        <p className="simpletab-hint">{t("credentials.onlineSectionHint")}</p>
        {!status.open ? (
          <div className="simpletab-hint">
            {t("credentials.noTournamentOnline")}
          </div>
        ) : null}

        <div className="simpletab-form">
          <label className="simpletab-checkbox-item">
            <input
              type="checkbox"
              checked={onlineSettings.ballotPortal}
              disabled={!status.open || onlineBusy}
              onChange={(e) => {
                void handleOnlinePatch({ ballotPortal: e.target.checked });
              }}
            />
            <span>{t("credentials.switchBallotPortal")}</span>
            <span className="simpletab-badge">
              {onlineSettings.ballotPortal
                ? t("credentials.switchOn")
                : t("credentials.switchOff")}
            </span>
          </label>

          <label className="simpletab-checkbox-item">
            <input
              type="checkbox"
              checked={onlineSettings.livePublicSite}
              disabled={!status.open || onlineBusy}
              onChange={(e) => {
                void handleOnlinePatch({ livePublicSite: e.target.checked });
              }}
            />
            <span>{t("credentials.switchLiveSite")}</span>
            <span className="simpletab-badge">
              {onlineSettings.livePublicSite
                ? t("credentials.switchOn")
                : t("credentials.switchOff")}
            </span>
          </label>

          <label className="simpletab-checkbox-item">
            <input
              type="checkbox"
              checked={onlineSettings.githubArchive}
              disabled={!status.open || onlineBusy}
              onChange={(e) => {
                void handleOnlinePatch({ githubArchive: e.target.checked });
              }}
            />
            <span>{t("credentials.switchGithubArchive")}</span>
            <span className="simpletab-badge">
              {onlineSettings.githubArchive
                ? t("credentials.switchOn")
                : t("credentials.switchOff")}
            </span>
          </label>

          <label className="simpletab-checkbox-item">
            <input
              type="checkbox"
              checked={onlineSettings.onlineRegistration}
              disabled={!status.open || onlineBusy}
              onChange={(e) => {
                void handleOnlinePatch({
                  onlineRegistration: e.target.checked,
                });
              }}
            />
            <span>{t("credentials.switchOnlineRegistration")}</span>
            <span className="simpletab-badge">
              {onlineSettings.onlineRegistration
                ? t("credentials.switchOn")
                : t("credentials.switchOff")}
            </span>
          </label>

          <div className="simpletab-field">
            <label htmlFor={`${baseId}-ballot-collection`}>
              {t("credentials.ballotCollectionLabel")}
            </label>
            <select
              id={`${baseId}-ballot-collection`}
              value={onlineSettings.ballotCollection}
              disabled={!status.open || onlineBusy}
              onChange={(e) => {
                void handleOnlinePatch({
                  ballotCollection: e.target.value as BallotCollectionMode,
                });
              }}
            >
              <option value="online">
                {t("credentials.collectionOnline")}
              </option>
              <option value="online_qr">
                {t("credentials.collectionOnlineQr")}
              </option>
              <option value="qr_only">
                {t("credentials.collectionQrOnly")}
              </option>
            </select>
          </div>

          <label className="simpletab-checkbox-item">
            <input
              type="checkbox"
              checked={onlineSettings.trustSignedBallots}
              disabled={!status.open || onlineBusy}
              onChange={(e) => {
                void handleOnlinePatch({
                  trustSignedBallots: e.target.checked,
                });
              }}
            />
            <span>{t("credentials.switchTrustSignedBallots")}</span>
            <span className="simpletab-badge">
              {onlineSettings.trustSignedBallots
                ? t("credentials.switchOn")
                : t("credentials.switchOff")}
            </span>
          </label>
        </div>
      </section>

      <section className="simpletab-section">
        <h3 className="simpletab-subtitle">{t("credentials.checklistTitle")}</h3>
        <div className="simpletab-alert simpletab-alert-warning" role="note">
          {t("credentials.key48hWarning")}
        </div>

        <div className="simpletab-table-wrap">
          <table className="simpletab-table">
            <tbody>
              <tr>
                <td>
                  <strong>{t("credentials.stepRequestKey")}</strong>
                  <div className="simpletab-hint">
                    {t("credentials.stepRequestKeyM3Note")}
                  </div>
                </td>
                <td>{keyStepStatus}</td>
                <td>
                  <div className="simpletab-actions">
                    <button
                      type="button"
                      className="theia-button secondary"
                      disabled
                      title={t("credentials.stepRequestKeyM3Note")}
                    >
                      {t("credentials.stepRequestKeyAction")}
                    </button>
                    <button
                      type="button"
                      className="theia-button secondary"
                      disabled={!available || busyName === "tournamentKey"}
                      onClick={() => {
                        void handleTest("tournamentKey");
                      }}
                    >
                      {t("credentials.stepTestButton")}
                    </button>
                  </div>
                </td>
              </tr>

              <tr>
                <td>
                  <strong>{t("credentials.stepConnectCdn")}</strong>
                </td>
                <td>{stepStateLabel(cdnEntry)}</td>
                <td>
                  <button
                    type="button"
                    className="theia-button secondary"
                    disabled={!available || busyName === "cdnToken"}
                    onClick={() => {
                      void handleTest("cdnToken");
                    }}
                  >
                    {t("credentials.stepTestButton")}
                  </button>
                </td>
              </tr>

              <tr>
                <td>
                  <strong>{t("credentials.stepConnectSmtp")}</strong>
                </td>
                <td>{stepStateLabel(smtpEntry)}</td>
                <td>
                  <button
                    type="button"
                    className="theia-button secondary"
                    disabled={!available || busyName === "smtp"}
                    onClick={() => {
                      void handleTest("smtp");
                    }}
                  >
                    {t("credentials.stepTestButton")}
                  </button>
                </td>
              </tr>

              <tr>
                <td>
                  <strong>{t("credentials.stepConnectGithub")}</strong>
                </td>
                <td>{stepStateLabel(githubEntry)}</td>
                <td>
                  <button
                    type="button"
                    className="theia-button secondary"
                    disabled={!available || busyName === "githubToken"}
                    onClick={() => {
                      void handleTest("githubToken");
                    }}
                  >
                    {t("credentials.stepTestButton")}
                  </button>
                </td>
              </tr>

              <tr>
                <td>
                  <strong>{t("credentials.stepTestPublish")}</strong>
                  <div className="simpletab-hint">
                    {t("credentials.stepTestPublishM4Note")}
                  </div>
                </td>
                <td>{stepStateLabel(cdnEntry)}</td>
                <td>
                  <button
                    type="button"
                    className="theia-button secondary"
                    disabled={!available || busyName === "cdnToken"}
                    onClick={() => {
                      void handleTest("cdnToken");
                    }}
                  >
                    {t("credentials.stepTestButton")}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
