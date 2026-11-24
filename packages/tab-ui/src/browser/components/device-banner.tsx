import type { DeviceModeStatus } from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import { t } from "../i18n";

export interface DeviceBannerProps {
  device: DeviceModeStatus;
  onLeave: () => Promise<void>;
  onDismissRejected: () => Promise<void>;
  confirmLeave?: () => boolean;
}

function formatTime(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString() : iso;
}

/**
 * Shown on a staff device (design section 4.1): which host it follows, whether the connection is up,
 * edits waiting to be sent and edits the host refused. Every state has words, not only a colour.
 */
export const DeviceBanner: React.FC<DeviceBannerProps> = ({
  device,
  onLeave,
  onDismissRejected,
  confirmLeave = () => window.confirm(t("deviceMode.leaveConfirm")),
}) => {
  const connectionText = t(`deviceMode.connection.${device.connection}`);
  const tone =
    device.connection === "connected"
      ? "simpletab-alert"
      : device.connection === "removed"
        ? "simpletab-alert simpletab-alert-error"
        : "simpletab-alert simpletab-alert-warning";

  return (
    <section className={tone} aria-label={t("deviceMode.bannerLabel")}>
      <p role="status" aria-live="polite">
        <strong>{connectionText}</strong>{" "}
        {t("deviceMode.bannerHost", {
          host: device.hostAddress,
          name: device.deviceName,
          role: device.roleName,
        })}
      </p>
      {device.error !== undefined ? <p>{device.error}</p> : null}
      {device.queued.length > 0 ? (
        <p>{t("deviceMode.queued", { count: device.queued.length })}</p>
      ) : null}
      {device.rejected.length > 0 ? (
        <div role="alert">
          <p>
            <strong>{t("deviceMode.rejectedTitle", { count: device.rejected.length })}</strong>
          </p>
          <ul>
            {device.rejected.map((item) => (
              <li key={item.id}>
                {t("deviceMode.rejectedItem", { op: item.opType, time: formatTime(item.queuedAt) })}{" "}
                {item.errors.join(" ")}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="theia-button secondary"
            onClick={() => {
              void onDismissRejected();
            }}
          >
            {t("deviceMode.dismissRejected")}
          </button>
        </div>
      ) : null}
      <div className="simpletab-actions">
        <button
          type="button"
          className="theia-button secondary"
          onClick={() => {
            if (confirmLeave()) void onLeave();
          }}
        >
          {t("deviceMode.leave")}
        </button>
      </div>
    </section>
  );
};
