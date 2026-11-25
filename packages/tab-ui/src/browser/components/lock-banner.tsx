import type { Round } from "@simpletab/core/types";
import type { HostLockInfo } from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import type { ActionRunner } from "../actions/action";
import { cancelLockAction, lockLabel } from "../actions/releases-actions";
import { t } from "../i18n";

export interface LockBannerProps {
  locks: readonly HostLockInfo[];
  rounds: readonly Round[];
  isHostOwner: boolean;
  /** Cancelling runs the "cancel a long operation" command. */
  run: ActionRunner;
}

export const LockBanner: React.FC<LockBannerProps> = ({
  locks,
  rounds,
  isHostOwner,
  run,
}) => {
  const [cancellingId, setCancellingId] = React.useState<string | null>(null);
  const [cancelError, setCancelError] = React.useState<string | null>(null);

  if (locks.length === 0) {
    return null;
  }

  const handleCancel = async (lockId: string): Promise<void> => {
    setCancelError(null);
    setCancellingId(lockId);
    try {
      const result = await run(cancelLockAction, { lockId });
      if (!result.ok) {
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
              {lockLabel(lock, rounds)}
            </span>
            {isHostOwner ? (
              <button
                type="button"
                className="theia-button secondary"
                data-action={cancelLockAction.id}
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
