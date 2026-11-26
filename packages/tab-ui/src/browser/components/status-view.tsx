import {
  DEFAULT_ONLINE_SETTINGS,
  type HostStatus,
  type OnlineSettings,
  type ProjectedState,
  type SyncPausedReason,
  type SyncStatus,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import type { ActionRunner } from "../actions/action";
import {
  createDemoTournamentAction,
  pullNowAction,
  runFullCheckAction,
} from "../actions/status-actions";
import { t } from "../i18n";
import { defaultTournamentTimeZone, formatDeadlineDateTime } from "../lib/deadline";
import { getDefaultRoundId } from "./round-picker";

export interface StatusViewProps {
  status: HostStatus;
  state: ProjectedState | null;
  loading: boolean;
  error: string | null;
  /** Refresh only reloads the view; it is deliberately not a command. */
  onRefresh: () => Promise<HostStatus | null | void>;
  /** Runs the same commands the palette offers. */
  run: ActionRunner;
  /** The pull-now command only applies when the host can sync. */
  canPullNow?: boolean;
}

interface AddonRow {
  key: string;
  label: string;
  enabled: boolean;
  active: boolean;
  pauseReason: string;
}

function summarizeOnlineStatusBar(status: HostStatus): string {
  if (!status.open) {
    return t("statusBar.onlineOff");
  }
  const settings = status.onlineSettings ?? DEFAULT_ONLINE_SETTINGS;
  const anyOn =
    settings.ballotPortal ||
    settings.livePublicSite ||
    settings.githubArchive ||
    settings.onlineRegistration;
  if (!anyOn) {
    return t("statusBar.onlineOff");
  }
  if (status.integrityOk === false) {
    return t("statusBar.onlinePaused");
  }
  if (settings.ballotPortal && status.syncStatus?.active === true) {
    return t("statusBar.onlineOk");
  }
  return t("statusBar.onlinePaused");
}

/** Formats the concise SimpleTab status bar label using current locale strings. */
export function formatStatusBarText(status: HostStatus): string {
  if (!status.open || !status.slug) {
    return t("statusBar.noTournament");
  }
  const integrity =
    status.integrityOk === false
      ? t("statusBar.integrityFailed")
      : t("statusBar.integrityOk");
  const online = summarizeOnlineStatusBar(status);
  return t("statusBar.tournament", {
    slug: status.slug,
    seq: status.headSeq ?? 0,
    integrity,
    online,
  });
}

function formatFastCheck(status: HostStatus): string {
  if (!status.open) {
    return t("status.integrityNa");
  }
  if (status.fastCheck !== undefined) {
    if (status.fastCheck.ok) {
      return t("status.integrityOk");
    }
    return status.fastCheck.reason
      ? t("status.integrityFailed", { reason: status.fastCheck.reason })
      : t("status.integrityFailedGeneric");
  }
  return status.integrityOk
    ? t("status.integrityOk")
    : t("status.integrityFailedGeneric");
}

function formatFullCheck(status: HostStatus): string {
  if (!status.open) {
    return t("status.integrityNa");
  }
  const check = status.fullCheck;
  if (check === undefined) {
    return t("status.fullCheckNotRun");
  }
  const checkedAt = check.checkedAt ?? "";
  if (check.ok) {
    return t("status.fullCheckPassedAt", { checkedAt });
  }
  return t("status.fullCheckFailedAt", {
    checkedAt,
    reason: check.reason ?? t("status.integrityFailedGeneric"),
  });
}

function ballotCollectionLabel(mode: OnlineSettings["ballotCollection"]): string {
  switch (mode) {
    case "online":
      return t("credentials.collectionOnline");
    case "online_qr":
      return t("credentials.collectionOnlineQr");
    case "qr_only":
      return t("credentials.collectionQrOnly");
  }
}

function formatSyncPausedReason(
  reason: SyncPausedReason | undefined,
  detail: string | undefined,
): string {
  switch (reason) {
    case "QR_ONLY":
      return t("status.pauseReasonQrOnly");
    case "INTEGRITY_FAILED":
      return t("status.pauseReasonIntegrity");
    case "NO_KEY":
      return t("status.pauseReasonNoKey");
    case "HOST_STALE":
      return t("status.pauseReasonHostStale");
    case "KEY_REVOKED":
      return t("status.pauseReasonKeyRevoked");
    case "QUOTA_EXHAUSTED":
      return t("status.pauseReasonQuota");
    case "OFFLINE":
      return detail
        ? t("status.pauseReasonOfflineDetail", { detail })
        : t("status.pauseReasonOffline");
    case "OFF":
    case undefined:
      return t("status.pauseReasonM3");
  }
}

function formatClockSkew(sync: SyncStatus | undefined): string {
  if (sync?.clockSkewMs === undefined) {
    return t("status.clockSkewOffline");
  }
  const absSeconds = Math.round(Math.abs(sync.clockSkewMs) / 1000);
  const signedSeconds =
    sync.clockSkewMs >= 0 ? `+${absSeconds}s` : `-${absSeconds}s`;
  if (sync.clockSkewWarning) {
    return t("status.clockSkewWarning", { skew: signedSeconds });
  }
  return t("status.clockSkewValue", { skew: signedSeconds });
}

export const StatusView: React.FC<StatusViewProps> = ({
  status,
  state,
  loading,
  error,
  onRefresh,
  run,
  canPullNow = false,
}) => {
  const [runningFullCheck, setRunningFullCheck] = React.useState(false);
  const [pulling, setPulling] = React.useState(false);

  const tournamentLabel = loading
    ? t("status.loading")
    : status.open
      ? t("status.open")
      : t("status.closed");

  const syncLabel = !status.open
    ? t("status.syncNa")
    : status.canSync
      ? t("status.syncOk")
      : t("status.syncBlocked");

  const onlineSettings: OnlineSettings =
    status.onlineSettings ?? DEFAULT_ONLINE_SETTINGS;

  const integrityBlocked = status.open && status.integrityOk === false;
  const syncStatus = status.syncStatus;

  const portalActive =
    !integrityBlocked &&
    onlineSettings.ballotPortal &&
    syncStatus?.active === true;

  const portalPauseReason = integrityBlocked
    ? t("status.pauseReasonIntegrity")
    : syncStatus === undefined
      ? t("status.pauseReasonM3")
      : formatSyncPausedReason(
          syncStatus.pausedReason,
          syncStatus.pausedDetail,
        );

  const addons: AddonRow[] = [
    {
      key: "portal",
      label: t("status.addonPortal"),
      enabled: onlineSettings.ballotPortal,
      active: portalActive,
      pauseReason: portalPauseReason,
    },
    {
      key: "liveSite",
      label: t("status.addonLiveSite"),
      enabled: onlineSettings.livePublicSite,
      active: false,
      pauseReason: integrityBlocked
        ? t("status.pauseReasonIntegrity")
        : t("status.pauseReasonM4"),
    },
    {
      key: "githubArchive",
      label: t("status.addonGithubArchive"),
      enabled: onlineSettings.githubArchive,
      active: false,
      pauseReason: integrityBlocked
        ? t("status.pauseReasonIntegrity")
        : t("status.pauseReasonM4"),
    },
    {
      key: "registration",
      label: t("status.addonRegistration"),
      enabled: onlineSettings.onlineRegistration,
      active: false,
      pauseReason: integrityBlocked
        ? t("status.pauseReasonIntegrity")
        : t("status.pauseReasonM10"),
    },
  ];

  const currentRoundId = state !== null ? getDefaultRoundId(state) : "";
  const currentRound =
    state !== null
      ? state.rounds.find((round) => round.id === currentRoundId)
      : undefined;

  const roomBallotRows = React.useMemo(() => {
    if (state === null || currentRound === undefined) {
      return [];
    }
    const roundDebates = state.debates
      .filter((d) => d.roundId === currentRound.id && !d.byeTeamId)
      .sort((a, b) => a.roomRank - b.roomRank || a.id.localeCompare(b.id));

    return roundDebates.map((debate) => {
      const debateBallots = state.ballots.filter(
        (b) => b.debateId === debate.id && b.discarded !== true,
      );
      const isConfirmed = debateBallots.some((b) => b.confirmed === true);
      const isEntered = debateBallots.length > 0;
      const roomLabel =
        debate.venueName || t("draw.roomFallback", { rank: debate.roomRank });
      const roomStatus: "confirmed" | "entered" | "missing" = isConfirmed
        ? "confirmed"
        : isEntered
          ? "entered"
          : "missing";
      return {
        id: debate.id,
        roomLabel,
        roomStatus,
      };
    });
  }, [state, currentRound]);

  const confirmedCount = roomBallotRows.filter(
    (r) => r.roomStatus === "confirmed",
  ).length;
  const enteredCount = roomBallotRows.filter(
    (r) => r.roomStatus === "confirmed" || r.roomStatus === "entered",
  ).length;

  const deadlineText = React.useMemo(() => {
    if (state === null || currentRound === undefined) {
      return null;
    }
    const rawDeadline = currentRound.simpletab?.ballotDeadline;
    if (!rawDeadline) {
      return t("status.ballotDeadlineNone");
    }
    const zone =
      currentRound.simpletab?.timeZone ?? defaultTournamentTimeZone(state);
    return t("status.ballotDeadline", {
      deadline: formatDeadlineDateTime(rawDeadline, zone),
    });
  }, [state, currentRound]);

  const handleFullCheck = async (): Promise<void> => {
    setRunningFullCheck(true);
    try {
      await run(runFullCheckAction, {});
    } finally {
      setRunningFullCheck(false);
    }
  };

  const handlePullNow = async (): Promise<void> => {
    setPulling(true);
    try {
      await run(pullNowAction, {});
    } finally {
      setPulling(false);
    }
  };

  return (
    <div>
      <div className="simpletab-status-header">
        <h2 className="simpletab-status-title">{t("status.title")}</h2>
        <div className="simpletab-status-actions">
          <button
            type="button"
            className="theia-button secondary"
            data-view-only
            onClick={() => {
              void onRefresh();
            }}
          >
            {t("status.refresh")}
          </button>
          {canPullNow ? (
            <button
              type="button"
              className="theia-button secondary"
              data-action={pullNowAction.id}
              disabled={!status.open || pulling}
              onClick={() => {
                void handlePullNow();
              }}
            >
              {pulling ? t("status.pulling") : t("status.pullNow")}
            </button>
          ) : null}
          <button
            type="button"
            className="theia-button secondary"
            data-action={runFullCheckAction.id}
            disabled={!status.open || runningFullCheck}
            onClick={() => {
              void handleFullCheck();
            }}
          >
            {runningFullCheck
              ? t("status.runningFullCheck")
              : t("status.runFullCheck")}
          </button>
          <button
            type="button"
            className="theia-button"
            data-action={createDemoTournamentAction.id}
            onClick={() => {
              void run(createDemoTournamentAction, { directory: "" });
            }}
          >
            {t("status.createDemo")}
          </button>
        </div>
      </div>

      <div className="simpletab-status-grid">
        <div className="simpletab-status-label">
          {t("status.tournamentState")}
        </div>
        <div className="simpletab-status-value">{tournamentLabel}</div>

        <div className="simpletab-status-label">{t("status.slug")}</div>
        <div className="simpletab-status-value">
          {status.open && status.slug ? status.slug : t("common.none")}
        </div>

        <div className="simpletab-status-label">{t("status.headSeq")}</div>
        <div className="simpletab-status-value">
          {status.open && status.headSeq !== undefined
            ? String(status.headSeq)
            : t("common.none")}
        </div>

        <div className="simpletab-status-label">{t("status.hostNumber")}</div>
        <div className="simpletab-status-value">
          {status.open && status.hostNumber !== undefined
            ? String(status.hostNumber)
            : t("common.none")}
        </div>

        <div className="simpletab-status-label">{t("status.fastCheck")}</div>
        <div className="simpletab-status-value">{formatFastCheck(status)}</div>

        <div className="simpletab-status-label">{t("status.fullCheck")}</div>
        <div className="simpletab-status-value">{formatFullCheck(status)}</div>

        <div className="simpletab-status-label">{t("status.onlineSync")}</div>
        <div className="simpletab-status-value">{syncLabel}</div>

        <div className="simpletab-status-label">{t("status.activeLocks")}</div>
        <div className="simpletab-status-value">
          {status.locks.length > 0 ? (
            <ul className="simpletab-status-locks">
              {status.locks.map((lock) => (
                <li key={lock.lockId}>
                  {t("status.lockItem", {
                    opType: lock.opType,
                    actorRef: lock.actorRef,
                  })}
                </li>
              ))}
            </ul>
          ) : (
            t("status.noLocks")
          )}
        </div>

        <div className="simpletab-status-label">{t("status.queuedOps")}</div>
        <div className="simpletab-status-value">
          {String(status.queuedOps ?? 0)}
        </div>

        <div className="simpletab-status-label">{t("status.devices")}</div>
        <div className="simpletab-status-value">{t("status.devicesNone")}</div>

        {status.extensionsLoaded !== undefined && status.extensionsLoaded.length > 0 ? (
          <>
            <div className="simpletab-status-label">{t("extensions.statusLoaded")}</div>
            <div className="simpletab-status-value">
              {status.extensionsLoaded.join(", ")}
            </div>
          </>
        ) : null}

        <div className="simpletab-status-label">{t("status.lastPush")}</div>
        <div className="simpletab-status-value">
          {syncStatus?.lastPushAt ?? t("status.never")}
        </div>

        <div className="simpletab-status-label">{t("status.lastPull")}</div>
        <div className="simpletab-status-value">
          {syncStatus?.lastPullAt ?? t("status.never")}
        </div>

        {syncStatus !== undefined ? (
          <>
            <div className="simpletab-status-label">{t("status.lastAck")}</div>
            <div className="simpletab-status-value">
              {syncStatus.lastAckAt
                ? t("status.lastAckValue", {
                    ackedThrough: syncStatus.ackedThrough,
                    at: syncStatus.lastAckAt,
                  })
                : t("status.never")}
            </div>
          </>
        ) : null}

        <div className="simpletab-status-label">{t("status.lastPublish")}</div>
        <div className="simpletab-status-value">
          {syncStatus?.lastPublishAt ?? t("status.never")}
        </div>

        <div className="simpletab-status-label">{t("status.shareLeft")}</div>
        <div className="simpletab-status-value">
          {syncStatus?.shareLeft !== undefined
            ? String(syncStatus.shareLeft)
            : t("status.shareLeftOffline")}
        </div>

        <div className="simpletab-status-label">{t("status.clockSkew")}</div>
        <div className="simpletab-status-value">
          {formatClockSkew(syncStatus)}
        </div>

        <div className="simpletab-status-label">
          {t("status.ballotCollection")}
        </div>
        <div className="simpletab-status-value">
          {status.open
            ? ballotCollectionLabel(onlineSettings.ballotCollection)
            : t("status.integrityNa")}
        </div>
      </div>

      <div className="simpletab-section" style={{ marginTop: "16px" }}>
        <h3 className="simpletab-subtitle">{t("status.onlineAddonsTitle")}</h3>
        <div className="simpletab-table-wrap">
          <table className="simpletab-table">
            <thead>
              <tr>
                <th>{t("status.addonColName")}</th>
                <th>{t("status.addonColSwitch")}</th>
                <th>{t("status.addonColState")}</th>
              </tr>
            </thead>
            <tbody>
              {addons.map((addon) => (
                <tr key={addon.key}>
                  <td>{addon.label}</td>
                  <td>
                    {addon.enabled
                      ? t("status.switchOn")
                      : t("status.switchOff")}
                  </td>
                  <td>
                    {!addon.enabled
                      ? t("status.addonStateOff")
                      : addon.active
                        ? t("status.addonStateOk")
                        : t("status.addonStatePaused", {
                            reason: addon.pauseReason,
                          })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {status.open ? (
        <div className="simpletab-section">
          <h3 className="simpletab-subtitle">{t("status.ballotsTitle")}</h3>
          {currentRound === undefined ? (
            <div className="simpletab-hint">{t("status.ballotsNoRound")}</div>
          ) : (
            <>
              <div className="simpletab-count-summary">
                {t("status.ballotsRoundSummary", {
                  roundName: currentRound.name,
                  confirmed: confirmedCount,
                  entered: enteredCount,
                  expected: roomBallotRows.length,
                })}
              </div>
              {deadlineText !== null ? (
                <div className="simpletab-hint" style={{ marginTop: "4px" }}>
                  {deadlineText}
                </div>
              ) : null}
              {roomBallotRows.length === 0 ? (
                <div className="simpletab-hint" style={{ marginTop: "8px" }}>
                  {t("status.ballotsNoDebates", {
                    roundName: currentRound.name,
                  })}
                </div>
              ) : (
                <div className="simpletab-table-wrap">
                  <table className="simpletab-table">
                    <thead>
                      <tr>
                        <th>{t("status.ballotsColRoom")}</th>
                        <th>{t("status.ballotsColStatus")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {roomBallotRows.map((row) => (
                        <tr key={row.id}>
                          <td>{row.roomLabel}</td>
                          <td>
                            <span
                              className={`simpletab-badge ${
                                row.roomStatus === "confirmed"
                                  ? "simpletab-badge-add"
                                  : row.roomStatus === "entered"
                                    ? "simpletab-badge-match"
                                    : "simpletab-badge-conflict"
                              }`}
                            >
                              {row.roomStatus === "confirmed"
                                ? t("status.ballotStatusConfirmed")
                                : row.roomStatus === "entered"
                                  ? t("status.ballotStatusEntered")
                                  : t("status.ballotStatusMissing")}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      ) : null}

      {error !== null ? (
        <div className="simpletab-status-error" role="alert">
          {t("status.hostError", { message: error })}
        </div>
      ) : null}
    </div>
  );
};
