import type { IssuedPairingCode } from "@simpletab/host/lib/common/collab-protocol";
import type { DevicesStatus } from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import { t } from "../i18n";

export interface DevicesViewProps {
  open: boolean;
  canManage: boolean;
  loadStatus: () => Promise<DevicesStatus>;
  onSetEnabled: (enabled: boolean) => Promise<DevicesStatus>;
  onIssueCode: (roleId: string) => Promise<IssuedPairingCode>;
  onCancelCode: (code: string) => Promise<void>;
  onApprove: (joinId: string) => Promise<void>;
  onReject: (joinId: string) => Promise<void>;
  onRemove: (deviceId: string) => Promise<void>;
  /** Sets the succession list (tab-director device ids, rank 1 first). */
  onSetSuccession?: (order: string[]) => Promise<void>;
  /** Asks the user to confirm removing a device; tests pass a stub. */
  confirmRemove?: (name: string) => boolean;
  pollMs?: number;
}

function formatTime(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString() : iso;
}

function groupCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}

function shortFingerprint(fp: string): string {
  return (fp.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ");
}

/**
 * The Devices page (design section 4, amendment 7): lets tab directors' and helpers' laptops join
 * the host over the tab-room network. A device joins with an 8-digit code, and the host user
 * approves it only when both screens show the same six words.
 */
export const DevicesView: React.FC<DevicesViewProps> = ({
  open,
  canManage,
  loadStatus,
  onSetEnabled,
  onIssueCode,
  onCancelCode,
  onApprove,
  onReject,
  onRemove,
  onSetSuccession,
  confirmRemove = (name) => window.confirm(t("devices.removeConfirm", { name })),
  pollMs = 2000,
}) => {
  const [status, setStatus] = React.useState<DevicesStatus | null>(null);
  const [roleId, setRoleId] = React.useState<string>("tab_director");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      setStatus(await loadStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [loadStatus]);

  React.useEffect(() => {
    if (!open || !canManage) return undefined;
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, pollMs);
    return () => clearInterval(timer);
  }, [open, canManage, refresh, pollMs]);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return <p className="simpletab-hint">{t("devices.noTournament")}</p>;
  }
  if (!canManage) {
    return <p className="simpletab-hint">{t("devices.noPermission")}</p>;
  }

  const running = status?.running === true;

  return (
    <div className="simpletab-page">
      <h2 className="simpletab-title">{t("devices.title")}</h2>
      <p className="simpletab-hint">{t("devices.hint")}</p>

      {error !== null ? (
        <p className="simpletab-alert simpletab-alert-error" role="alert">
          {error}
        </p>
      ) : null}
      {status?.error !== undefined ? (
        <p className="simpletab-alert simpletab-alert-error" role="alert">
          {status.error}
        </p>
      ) : null}

      <section className="simpletab-section" aria-labelledby="simpletab-devices-server">
        <h3 id="simpletab-devices-server" className="simpletab-subtitle">
          {t("devices.serverTitle")}
        </h3>
        <label className="simpletab-switch">
          <input
            type="checkbox"
            checked={running}
            disabled={busy || status === null}
            onChange={(e) => {
              const on = e.target.checked;
              void run(() => onSetEnabled(on));
            }}
          />
          <span>{t("devices.allow")}</span>
        </label>
        <p role="status">
          {running
            ? t("devices.listening", { port: status?.port ?? 0 })
            : t("devices.notListening")}
        </p>
        {running && status !== null ? (
          <>
            {status.addresses.length > 0 ? (
              <ul aria-label={t("devices.addressesLabel")}>
                {status.addresses.map((address) => (
                  <li key={address}>
                    <code>{`${address}:${status.port ?? ""}`}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="simpletab-hint">{t("devices.noAddresses")}</p>
            )}
            {status.hostFingerprint !== undefined ? (
              <p className="simpletab-hint">
                {t("devices.fingerprint", { fingerprint: shortFingerprint(status.hostFingerprint) })}
              </p>
            ) : null}
          </>
        ) : null}
      </section>

      {running && status !== null ? (
        <section className="simpletab-section" aria-labelledby="simpletab-devices-codes">
          <h3 id="simpletab-devices-codes" className="simpletab-subtitle">
            {t("devices.codesTitle")}
          </h3>
          <div className="simpletab-actions">
            <label>
              {t("devices.roleLabel")}{" "}
              <select
                value={roleId}
                disabled={busy}
                onChange={(e) => {
                  setRoleId(e.target.value);
                }}
              >
                {status.pairableRoles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="theia-button"
              disabled={busy}
              onClick={() => {
                void run(() => onIssueCode(roleId));
              }}
            >
              {t("devices.createCode")}
            </button>
          </div>
          {status.codes.length === 0 ? (
            <p className="simpletab-hint">{t("devices.noCodes")}</p>
          ) : (
            <ul>
              {status.codes.map((code) => (
                <li key={code.code}>
                  <strong className="simpletab-pairing-code">{groupCode(code.code)}</strong>{" "}
                  {t("devices.codeFor", {
                    role: status.pairableRoles.find((r) => r.id === code.roleId)?.name ?? code.roleId,
                    time: formatTime(code.expiresAt),
                  })}{" "}
                  <button
                    type="button"
                    className="theia-button secondary"
                    disabled={busy}
                    onClick={() => {
                      void run(() => onCancelCode(code.code));
                    }}
                  >
                    {t("devices.cancelCode")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {status !== null && status.pendingJoins.length > 0 ? (
        <section className="simpletab-section" aria-labelledby="simpletab-devices-pending">
          <h3 id="simpletab-devices-pending" className="simpletab-subtitle">
            {t("devices.pendingTitle")}
          </h3>
          <p className="simpletab-alert simpletab-alert-warning" role="note">
            {t("devices.compareWords")}
          </p>
          {status.pendingJoins.map((join) => (
            <div key={join.joinId} className="simpletab-card" aria-label={t("devices.pendingLabel", { name: join.deviceName })}>
              <p>
                <strong>{join.deviceName}</strong>{" "}
                {t("devices.pendingRole", {
                  role: status.pairableRoles.find((r) => r.id === join.roleId)?.name ?? join.roleId,
                })}
              </p>
              <ol className="simpletab-pairing-words">
                {join.words.map((word, index) => (
                  <li key={`${index}-${word}`}>{word}</li>
                ))}
              </ol>
              <div className="simpletab-actions">
                <button
                  type="button"
                  className="theia-button"
                  disabled={busy}
                  onClick={() => {
                    void run(() => onApprove(join.joinId));
                  }}
                >
                  {t("devices.approve")}
                </button>
                <button
                  type="button"
                  className="theia-button secondary"
                  disabled={busy}
                  onClick={() => {
                    void run(() => onReject(join.joinId));
                  }}
                >
                  {t("devices.reject")}
                </button>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {status !== null && status.succession.length > 0 && onSetSuccession !== undefined ? (
        <section className="simpletab-section" aria-labelledby="simpletab-devices-succession">
          <h3 id="simpletab-devices-succession" className="simpletab-subtitle">
            {t("devices.successionTitle")}
          </h3>
          <p className="simpletab-hint">{t("devices.successionHint")}</p>
          <ol aria-label={t("devices.successionTitle")}>
            {status.succession.map((deviceId, index) => {
              const name = status.devices.find((d) => d.deviceId === deviceId)?.name ?? deviceId;
              const move = (to: number): void => {
                const next = [...status.succession];
                next.splice(index, 1);
                next.splice(to, 0, deviceId);
                void run(() => onSetSuccession(next));
              };
              return (
                <li key={deviceId}>
                  {name}{" "}
                  <button
                    type="button"
                    className="theia-button secondary"
                    disabled={busy || index === 0}
                    aria-label={t("devices.moveUp", { name })}
                    onClick={() => move(index - 1)}
                  >
                    {t("devices.up")}
                  </button>{" "}
                  <button
                    type="button"
                    className="theia-button secondary"
                    disabled={busy || index === status.succession.length - 1}
                    aria-label={t("devices.moveDown", { name })}
                    onClick={() => move(index + 1)}
                  >
                    {t("devices.down")}
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      <section className="simpletab-section" aria-labelledby="simpletab-devices-paired">
        <h3 id="simpletab-devices-paired" className="simpletab-subtitle">
          {t("devices.pairedTitle")}
        </h3>
        {status === null || status.devices.length === 0 ? (
          <p className="simpletab-hint">{t("devices.noDevices")}</p>
        ) : (
          <div className="simpletab-table-wrap">
            <table className="simpletab-table">
              <thead>
                <tr>
                  <th scope="col">{t("devices.colName")}</th>
                  <th scope="col">{t("devices.colRole")}</th>
                  <th scope="col">{t("devices.colConnection")}</th>
                  <th scope="col">{t("devices.colPaired")}</th>
                  <th scope="col">
                    <span className="simpletab-sr-only">{t("devices.colActions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {status.devices.map((device) => (
                  <tr key={device.deviceId}>
                    <td>{device.name}</td>
                    <td>{device.roleName}</td>
                    <td>{device.connected ? t("devices.connected") : t("devices.disconnected")}</td>
                    <td>{new Date(device.approvedAt).toLocaleString()}</td>
                    <td>
                      <button
                        type="button"
                        className="theia-button secondary"
                        disabled={busy}
                        aria-label={t("devices.removeLabel", { name: device.name })}
                        onClick={() => {
                          if (confirmRemove(device.name)) {
                            void run(() => onRemove(device.deviceId));
                          }
                        }}
                      >
                        {t("devices.remove")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
