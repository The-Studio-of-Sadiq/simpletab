import type { ProjectedState } from "@simpletab/host/lib/common/host-protocol";
import {
  computeRemainingSeconds,
  formatCountdown,
  type ProjectorControlPatch,
  type ProjectorControlState,
  type ProjectorMode,
} from "@simpletab/host/lib/common/projector-protocol";
import * as React from "@theia/core/shared/react";
import type { ActionRunner } from "../actions/action";
import {
  closeProjectorAction,
  openProjectorAction,
  pauseProjectorCountdownAction,
  resetProjectorCountdownAction,
  startProjectorCountdownAction,
  toggleProjectorFullscreenAction,
  updateProjectorControlAction,
} from "../actions/projector-actions";
import { t } from "../i18n";
import { RoundPicker } from "./round-picker";

export interface ProjectorControlViewProps {
  state: ProjectedState | null;
  available: boolean;
  control: ProjectorControlState;
  nowMs?: number;
  /** Every button runs the same command the palette offers. */
  run: ActionRunner;
}

export const ProjectorControlView: React.FC<ProjectorControlViewProps> = ({
  state,
  available,
  control,
  nowMs,
  run,
}) => {
  const baseId = React.useId();
  const [durationMinutes, setDurationMinutes] = React.useState(() =>
    String(Math.max(1, Math.round(control.countdown.durationSeconds / 60))),
  );
  const [tickNowMs, setTickNowMs] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!control.countdown.running || nowMs !== undefined) {
      return;
    }
    setTickNowMs(Date.now());
    const id = setInterval(() => setTickNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, [control.countdown.running, control.countdown.updatedAtMs, nowMs]);

  const effectiveNowMs = nowMs ?? tickNowMs;
  const remainingSeconds = computeRemainingSeconds(
    control.countdown,
    effectiveNowMs,
  );

  const parsedMinutes = Number(durationMinutes);
  const configuredSeconds =
    Number.isFinite(parsedMinutes) && parsedMinutes > 0
      ? Math.round(parsedMinutes * 60)
      : undefined;

  const timerLabel =
    remainingSeconds === 0
      ? t("projector.timerFinished")
      : control.countdown.running
        ? t("projector.timerRunning")
        : t("projector.timerPaused");

  return (
    <div className="simpletab-page">
      <div className="simpletab-header">
        <h2 className="simpletab-title">{t("projector.controlTitle")}</h2>
        <span className="simpletab-badge">
          {control.open
            ? t("projector.windowStatusOpen")
            : t("projector.windowStatusClosed")}
        </span>
      </div>

      {!available ? (
        <div className="simpletab-alert simpletab-alert-warning" role="alert">
          {t("projector.unavailable")}
        </div>
      ) : null}

      <section className="simpletab-section">
        <div className="simpletab-actions">
          <button
            type="button"
            className="theia-button"
            data-action={openProjectorAction.id}
            disabled={!available}
            onClick={() => {
              void run(openProjectorAction, {});
            }}
          >
            {t("projector.openWindow")}
          </button>
          <button
            type="button"
            className="theia-button secondary"
            data-action={closeProjectorAction.id}
            disabled={!available || !control.open}
            onClick={() => {
              void run(closeProjectorAction, {});
            }}
          >
            {t("projector.closeWindow")}
          </button>
          <button
            type="button"
            className="theia-button secondary"
            data-action={toggleProjectorFullscreenAction.id}
            disabled={!available || !control.open}
            onClick={() => {
              void run(toggleProjectorFullscreenAction, {});
            }}
          >
            {t("projector.toggleFullscreen")}
          </button>
        </div>

        <div className="simpletab-form" style={{ marginTop: "14px" }}>
          <div className="simpletab-form-grid">
            <div className="simpletab-field">
              <RoundPicker
                id={`${baseId}-round`}
                label={t("projector.roundLabel")}
                rounds={state?.rounds ?? []}
                selectedRoundId={control.roundId ?? ""}
                onSelectRound={(roundId) => {
                  void run(updateProjectorControlAction, { patch: { roundId } });
                }}
              />
            </div>

            <div className="simpletab-field">
              <label htmlFor={`${baseId}-mode`}>
                {t("projector.modeLabel")}
              </label>
              <select
                id={`${baseId}-mode`}
                value={control.mode}
                disabled={!available}
                onChange={(e) => {
                  void run(updateProjectorControlAction, {
                    patch: { mode: e.target.value as ProjectorMode },
                  });
                }}
              >
                <option value="auto">{t("projector.modeAuto")}</option>
                <option value="motion">{t("projector.modeMotion")}</option>
                <option value="draw">{t("projector.modeDraw")}</option>
                <option value="countdown">
                  {t("projector.modeCountdown")}
                </option>
              </select>
            </div>

            <div className="simpletab-field">
              <label htmlFor={`${baseId}-interval`}>
                {t("projector.pageIntervalLabel")}
              </label>
              <input
                id={`${baseId}-interval`}
                type="number"
                min={2}
                max={120}
                value={control.pageIntervalSeconds}
                disabled={!available}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  if (Number.isFinite(val) && val >= 2) {
                    void run(updateProjectorControlAction, {
                      patch: { pageIntervalSeconds: val },
                    });
                  }
                }}
              />
            </div>

            <div className="simpletab-field">
              <label htmlFor={`${baseId}-rooms`}>
                {t("projector.roomsPerPageLabel")}
              </label>
              <input
                id={`${baseId}-rooms`}
                type="number"
                min={1}
                max={32}
                value={control.roomsPerPage}
                disabled={!available}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  if (Number.isFinite(val) && val >= 1) {
                    void run(updateProjectorControlAction, {
                      patch: { roomsPerPage: val },
                    });
                  }
                }}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="simpletab-section">
        <h3 className="simpletab-subtitle">{t("projector.countdownSection")}</h3>
        <div className="simpletab-actions" style={{ marginBottom: "10px" }}>
          <strong style={{ fontSize: "1.5em", fontFamily: "monospace" }}>
            {formatCountdown(remainingSeconds)}
          </strong>
          <span className="simpletab-badge">{timerLabel}</span>
        </div>

        <div className="simpletab-form-grid">
          <div className="simpletab-field">
            <label htmlFor={`${baseId}-minutes`}>
              {t("projector.durationMinutesLabel")}
            </label>
            <input
              id={`${baseId}-minutes`}
              type="number"
              min={1}
              max={180}
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(e.target.value)}
            />
          </div>
        </div>

        <div className="simpletab-actions" style={{ marginTop: "12px" }}>
          <button
            type="button"
            className="theia-button"
            data-action={startProjectorCountdownAction.id}
            disabled={!available}
            onClick={() => {
              void run(startProjectorCountdownAction, {
                durationSeconds: control.countdown.running
                  ? undefined
                  : remainingSeconds > 0
                    ? undefined
                    : configuredSeconds,
              });
            }}
          >
            {t("projector.startTimer")}
          </button>
          <button
            type="button"
            className="theia-button secondary"
            data-action={pauseProjectorCountdownAction.id}
            disabled={!available || !control.countdown.running}
            onClick={() => {
              void run(pauseProjectorCountdownAction, {});
            }}
          >
            {t("projector.pauseTimer")}
          </button>
          <button
            type="button"
            className="theia-button secondary"
            data-action={resetProjectorCountdownAction.id}
            disabled={!available}
            onClick={() => {
              void run(resetProjectorCountdownAction, {
                durationSeconds: configuredSeconds,
              });
            }}
          >
            {t("projector.resetTimer")}
          </button>
        </div>
      </section>
    </div>
  );
};
