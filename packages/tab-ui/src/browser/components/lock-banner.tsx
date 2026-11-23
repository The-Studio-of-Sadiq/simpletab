import type { Round } from "@simpletab/core/types";
import type {
  HostCancelLongResult,
  HostLockInfo,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import { t } from "../i18n";

export interface LockBannerProps {
  locks: readonly HostLockInfo[];
  rounds: readonly Round[];
  isHostOwner: boolean;
  onCancelLock?: (lockId: string) => Promise<HostCancelLongResult | void>;
}

function formatLockLabel(
  lock: HostLockInfo,
  rounds: readonly Round[],
): string {
  const roundName =
    lock.roundId !== undefined
      ? rounds.find((round) => round.id === lock.roundId)?.name
      : undefined;

  switch (lock.opType) {
    case "draw.generate":
      return roundName
        ? t("lock.generatingRound", { round: roundName })
        : t("lock.generatingFallback");
    case "allocation.auto":
      return roundName
        ? t("lock.allocatingRound", { round: roundName })
        : t("lock.allocatingFallback");
    case "allocation.preformed_autofill":
      return roundName
        ? t("lock.autofillingRound", { round: roundName })
        : t("lock.autofillingFallback");
    default:
      return t("lock.generic", {
        opType: lock.opType,
        actorRef: lock.actorRef,
      });
  }
}

export const LockBanner: React.FC<LockBannerProps> = ({
  locks,
  rounds,
  isHostOwner,
  onCancelLock,
}) => {
  const [cancellingId, setCancellingId] = React.useState<string | null>(null);
  const [cancelError, setCancelError] = React.useState<string | null>(null);

  if (locks.length === 0) {
    return null;
  }

  const handleCancel = async (lockId: string): Promise<void> => {
    if (onCancelLock === undefined) {
      return;
    }
    setCancelError(null);
    setCancellingId(lockId);
    try {
      const result = await onCancelLock(lockId);
      if (result && !result.ok) {
        setCancelError(
          t("common.errorWithCode", {
            code: result.code,
            message: result.errors.join("; "),
          }),
        );
      }
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : String(error));
    } finally {
      setCancellingId((prev) => (prev === lockId ? null : prev));
    }
  };

  return (
    <div className="simpletab-lock-banner" role="status" aria-live="polite">
      <ul className="simpletab-lock-list">
        {locks.map((lock) => (
          <li key={lock.lockId} className="simpletab-lock-item">
            <span className="simpletab-lock-text">
              {formatLockLabel(lock, rounds)}
            </span>
            {isHostOwner && onCancelLock !== undefined ? (
              <button
                type="button"
                className="theia-button secondary"
                disabled={cancellingId === lock.lockId}
                onClick={() => {
                  void handleCancel(lock.lockId);
                }}
              >
                {cancellingId === lock.lockId
                  ? t("lock.cancelling")
                  : t("lock.cancel")}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="simpletab-hint">{t("lock.disjointHint")}</div>
      {cancelError !== null ? (
        <div className="simpletab-field-error" role="alert">
          {cancelError}
        </div>
      ) : null}
    </div>
  );
};
