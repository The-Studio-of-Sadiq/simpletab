import { motionsStatusOf } from "@simpletab/core/features/tournament/application/motionRelease";
import { tournamentSides } from "@simpletab/core/lib/debateSides";
import { isDrawPubliclyReleased } from "@simpletab/core/lib/draw/drawStatus";
import {
  hasInfoSlide,
  resolveInfoSlideMedia,
} from "@simpletab/core/lib/motions/infoSlideMedia";
import { sideLabel } from "@simpletab/core/lib/sideNames";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import { project } from "@simpletab/core/projection";
import type { Debate, Motion } from "@simpletab/core/types";
import type { ProjectedState } from "@simpletab/host/lib/common/host-protocol";
import {
  computeRemainingSeconds,
  formatCountdown,
  type ProjectorControlState,
} from "@simpletab/host/lib/common/projector-protocol";
import * as React from "@theia/core/shared/react";
import { t } from "../i18n";
import { getDefaultRoundId } from "./round-picker";

export interface ProjectorViewProps {
  displayState: ProjectedState | null;
  control: ProjectorControlState;
  nowMs?: number;
  onToggleFullscreen?: () => void;
}

function ensureDisplayProjection(
  state: ProjectedState | null,
): ProjectedState | null {
  if (state === null) {
    return null;
  }
  if (state.roleId === BUILT_IN_ROLES.display.id) {
    return state;
  }
  const projected = project(state, BUILT_IN_ROLES.display);
  return {
    ...projected,
    tournament: projected.tournament as ProjectedState["tournament"],
    rounds: projected.rounds as ProjectedState["rounds"],
    ballots: projected.ballots as ProjectedState["ballots"],
    seq: state.seq,
    roleId: BUILT_IN_ROLES.display.id,
    permissions: [],
    versions: {},
  };
}

function renderPanelNames(
  debate: Debate,
  adjudicatorNames: ReadonlyMap<string, string>,
): string | null {
  const names: string[] = [];
  const adj = debate.adjudicators;
  if (adj.chairId) {
    const name = adj.chairName ?? adjudicatorNames.get(adj.chairId) ?? adj.chairId;
    names.push(t("projector.chairTag", { name }));
  }
  (adj.panellistIds ?? []).forEach((id, idx) => {
    const name = adj.panellistNames?.[idx] ?? adjudicatorNames.get(id) ?? id;
    names.push(name);
  });
  (adj.traineeIds ?? []).forEach((id, idx) => {
    const name = adj.traineeNames?.[idx] ?? adjudicatorNames.get(id) ?? id;
    names.push(t("projector.traineeTag", { name }));
  });
  return names.length > 0 ? names.join(", ") : null;
}

function renderMotionInfoSlide(motion: Motion): React.ReactNode {
  const media = resolveInfoSlideMedia(motion.infoSlideMedia);
  return (
    <div className="simpletab-projector-infoslide">
      <div className="simpletab-projector-section-label">
        {t("projector.infoSlideHeading")}
      </div>
      {motion.infoSlide && motion.infoSlide.trim().length > 0 ? (
        <p className="simpletab-projector-infoslide-text">{motion.infoSlide}</p>
      ) : null}
      {media !== null ? (
        <div className="simpletab-projector-media">
          {media.type === "image" ? (
            <img
              src={media.src}
              alt={media.alt}
              className="simpletab-projector-media-img"
            />
          ) : media.type === "youtube" ? (
            <iframe
              src={media.src}
              title={media.title || t("projector.infoSlideHeading")}
              className="simpletab-projector-media-frame"
              allowFullScreen
            />
          ) : (
            <video
              src={media.src}
              controls
              className="simpletab-projector-media-video"
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

export const ProjectorView: React.FC<ProjectorViewProps> = ({
  displayState,
  control,
  nowMs,
  onToggleFullscreen,
}) => {
  const safeState = React.useMemo(
    () => ensureDisplayProjection(displayState),
    [displayState],
  );

  const [tickNowMs, setTickNowMs] = React.useState<number>(() => Date.now());
  const [drawPageIndex, setDrawPageIndex] = React.useState(0);

  React.useEffect(() => {
    if (!control.countdown.running || nowMs !== undefined) {
      return;
    }
    setTickNowMs(Date.now());
    const id = setInterval(() => {
      setTickNowMs(Date.now());
    }, 250);
    return () => clearInterval(id);
  }, [control.countdown.running, control.countdown.updatedAtMs, nowMs]);

  const effectiveNowMs = nowMs ?? tickNowMs;
  const remainingSeconds = computeRemainingSeconds(
    control.countdown,
    effectiveNowMs,
  );
  const timerStateText =
    remainingSeconds === 0
      ? t("projector.timerFinished")
      : control.countdown.running
        ? t("projector.timerRunning")
        : t("projector.timerPaused");

  const activeRound = React.useMemo(() => {
    if (safeState === null) {
      return undefined;
    }
    const candidateId = control.roundId ?? getDefaultRoundId(safeState);
    return (
      safeState.rounds.find((r) => r.id === candidateId) ?? safeState.rounds[0]
    );
  }, [safeState, control.roundId]);

  const roundMotions = React.useMemo(() => {
    if (safeState === null || activeRound === undefined) {
      return [];
    }
    return safeState.motions.filter((motion) =>
      (motion.rounds ?? []).includes(activeRound.id),
    );
  }, [safeState, activeRound]);

  const drawReleased = Boolean(
    activeRound &&
      !activeRound.cancelled &&
      isDrawPubliclyReleased(activeRound),
  );

  const roundDebates = React.useMemo(() => {
    if (safeState === null || activeRound === undefined || !drawReleased) {
      return [];
    }
    return safeState.debates
      .filter((d) => d.roundId === activeRound.id)
      .sort((a, b) => a.roomRank - b.roomRank || a.id.localeCompare(b.id));
  }, [safeState, activeRound, drawReleased]);

  const roomsPerPage = Math.max(1, control.roomsPerPage);
  const totalPages = Math.max(1, Math.ceil(roundDebates.length / roomsPerPage));
  const safePageIndex = drawPageIndex % totalPages;

  React.useEffect(() => {
    setDrawPageIndex(0);
  }, [activeRound?.id, roundDebates.length, roomsPerPage]);

  React.useEffect(() => {
    if (totalPages <= 1) {
      return;
    }
    const intervalMs = Math.max(2, control.pageIntervalSeconds) * 1000;
    const id = setInterval(() => {
      setDrawPageIndex((prev) => (prev + 1) % totalPages);
    }, intervalMs);
    return () => clearInterval(id);
  }, [totalPages, control.pageIntervalSeconds]);

  const teamNames = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const team of safeState?.teams ?? []) {
      map.set(team.id, team.name);
    }
    return map;
  }, [safeState?.teams]);

  const adjudicatorNames = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const adj of safeState?.adjudicators ?? []) {
      map.set(adj.id, adj.name);
    }
    return map;
  }, [safeState?.adjudicators]);

  if (safeState === null) {
    return (
      <div className="simpletab-projector-root">
        <header className="simpletab-projector-topbar">
          <div className="simpletab-projector-title">SimpleTab</div>
          {onToggleFullscreen !== undefined ? (
            <button
              type="button"
              className="simpletab-projector-btn"
              data-view-only
              onClick={onToggleFullscreen}
            >
              {t("projector.toggleFullscreen")}
            </button>
          ) : null}
        </header>
        <div className="simpletab-projector-empty">
          {t("projector.noTournament")}
        </div>
      </div>
    );
  }

  const sides = tournamentSides(safeState.tournament);
  const motionStatus = motionsStatusOf(activeRound);
  const visibleDebates = roundDebates.slice(
    safePageIndex * roomsPerPage,
    (safePageIndex + 1) * roomsPerPage,
  );

  const showMotionSection =
    control.mode === "auto" || control.mode === "motion";
  const showDrawSection = control.mode === "auto" || control.mode === "draw";
  const showTimerProminent = control.mode === "countdown";

  return (
    <div className="simpletab-projector-root">
      <header className="simpletab-projector-topbar">
        <div>
          <div className="simpletab-projector-title">
            {safeState.tournament.name}
          </div>
          <div className="simpletab-projector-round">
            {activeRound ? activeRound.name : t("projector.noRound")}
          </div>
        </div>

        <div className="simpletab-projector-timer-compact" aria-live="polite">
          <span className="simpletab-projector-timer-digits">
            {formatCountdown(remainingSeconds)}
          </span>
          <span className="simpletab-projector-timer-state">
            {timerStateText}
          </span>
          {onToggleFullscreen !== undefined ? (
            <button
              type="button"
              className="simpletab-projector-btn"
              data-view-only
              onClick={onToggleFullscreen}
            >
              {t("projector.toggleFullscreen")}
            </button>
          ) : null}
        </div>
      </header>

      {showTimerProminent ? (
        <section className="simpletab-projector-panel simpletab-projector-timer-hero">
          <div className="simpletab-projector-timer-digits-hero">
            {formatCountdown(remainingSeconds)}
          </div>
          <div className="simpletab-projector-timer-state">
            {timerStateText}
          </div>
        </section>
      ) : null}

      {showMotionSection ? (
        <section className="simpletab-projector-panel">
          <h2 className="simpletab-projector-heading">
            {t("projector.motionHeading")}
          </h2>

          {motionStatus === "not_released" ? (
            <div className="simpletab-projector-muted">
              {t("projector.motionNotReleased")}
            </div>
          ) : motionStatus === "info_slides_released" ? (
            <div className="simpletab-projector-motions-list">
              {roundMotions
                .filter((motion) => hasInfoSlide(motion))
                .map((motion) => (
                  <div key={motion.id} className="simpletab-projector-motion-card">
                    {renderMotionInfoSlide(motion)}
                  </div>
                ))}
              <div className="simpletab-projector-muted">
                {t("projector.motionTextPending")}
              </div>
            </div>
          ) : roundMotions.length === 0 ? (
            <div className="simpletab-projector-muted">
              {t("projector.motionNotReleased")}
            </div>
          ) : (
            <div className="simpletab-projector-motions-list">
              {roundMotions.map((motion, index) => (
                <div key={motion.id} className="simpletab-projector-motion-card">
                  {roundMotions.length > 1 ? (
                    <div className="simpletab-projector-section-label">
                      {t("projector.motionChoiceLabel", { index: index + 1 })}
                    </div>
                  ) : null}
                  {hasInfoSlide(motion) ? renderMotionInfoSlide(motion) : null}
                  {motion.text.trim().length > 0 ? (
                    <p className="simpletab-projector-motion-text">
                      {motion.text}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {showDrawSection ? (
        <section className="simpletab-projector-panel">
          <div className="simpletab-projector-draw-header">
            <h2 className="simpletab-projector-heading">
              {t("projector.drawHeading")}
            </h2>
            {drawReleased && roundDebates.length > 0 ? (
              <div className="simpletab-projector-page-badge">
                {t("projector.drawPageIndicator", {
                  page: safePageIndex + 1,
                  total: totalPages,
                })}
              </div>
            ) : null}
          </div>

          {!drawReleased || roundDebates.length === 0 ? (
            <div className="simpletab-projector-muted">
              {t("projector.drawNotReleased")}
            </div>
          ) : (
            <div className="simpletab-projector-draw-grid">
              {visibleDebates.map((debate) => {
                const roomName =
                  debate.venueName ||
                  t("draw.roomFallback", { rank: debate.roomRank });
                const panelText = renderPanelNames(debate, adjudicatorNames);
                return (
                  <article
                    key={debate.id}
                    className="simpletab-projector-room-card"
                  >
                    <h3 className="simpletab-projector-room-title">
                      {roomName}
                    </h3>
                    {debate.byeTeamId ? (
                      <div className="simpletab-projector-room-bye">
                        {t("projector.byeRoom")}:{" "}
                        {teamNames.get(debate.byeTeamId) ?? debate.byeTeamId}
                      </div>
                    ) : (
                      <dl className="simpletab-projector-teams">
                        {sides.map((side) => {
                          const slot = debate.teams[side];
                          const label = sideLabel(
                            side,
                            safeState.tournament.preferences,
                            "abbr",
                          );
                          const teamName = slot
                            ? teamNames.get(slot.teamId) ??
                              slot.teamName ??
                              slot.teamId
                            : t("common.none");
                          return (
                            <div
                              key={side}
                              className="simpletab-projector-team-row"
                            >
                              <dt>{label}</dt>
                              <dd>{teamName}</dd>
                            </div>
                          );
                        })}
                      </dl>
                    )}
                    {panelText !== null ? (
                      <div className="simpletab-projector-panel-row">
                        {t("projector.panelLabel", { panel: panelText })}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
};
