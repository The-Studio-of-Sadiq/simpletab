import { MOTIONS_STATUSES, motionsStatusOf } from "@simpletab/core/features/tournament/application/motionRelease";
import {
  drawStageOf,
  isDrawPubliclyReleased,
  isDrawReleasedToTeams,
} from "@simpletab/core/lib/draw/drawStatus";
import type { MotionsStatus } from "@simpletab/core/types";
import type {
  HostStatus,
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import type { ActionRunner, SimpleTabAction } from "../actions/action";
import {
  openSetupAction,
  releaseTabBundleAction,
  setDrawGateAction,
  setGateAction,
  setRoundFlagAction,
  setRoundMotionsAction,
  type RoundReleaseField,
  gateGroups,
  type GateSpec,
} from "../actions/releases-actions";
import { t } from "../i18n";
import { stateHasPermission } from "../lib/permissions";
import { InlineOpError, type InlineOpErrorData } from "./inline-op-error";
import { LockBanner } from "./lock-banner";

export interface ReleasesViewProps {
  state: ProjectedState | null;
  status: HostStatus;
  /** Runs the same commands as the palette; no op building happens here. */
  run: ActionRunner;
  nowIso?: string;
}

function motionsStatusText(statusValue: MotionsStatus): string {
  switch (statusValue) {
    case "not_released":
      return t("motions.statusNotReleased");
    case "info_slides_released":
      return t("motions.statusInfoSlides");
    case "motions_released":
      return t("motions.statusMotionsReleased");
  }
}

function motionsButtonText(statusValue: MotionsStatus): string {
  switch (statusValue) {
    case "not_released":
      return t("motions.releaseNotReleased");
    case "info_slides_released":
      return t("motions.releaseInfoSlides");
    case "motions_released":
      return t("motions.releaseMotions");
  }
}

/**
 * The Releases page (design section 6): every gate is a command, so a person can use the buttons
 * here or the palette and get exactly the same op.
 */
export const ReleasesView: React.FC<ReleasesViewProps> = ({
  state,
  status,
  run,
  nowIso,
}) => {
  const baseId = React.useId();
  const [opError, setOpError] = React.useState<InlineOpErrorData | null>(null);
  const [opSuccess, setOpSuccess] = React.useState<string | null>(null);
  const [retryRun, setRetryRun] = React.useState<(() => Promise<boolean>) | null>(null);
  const [bundleDialogOpen, setBundleDialogOpen] = React.useState(false);

  React.useEffect(() => {
    if (!bundleDialogOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setBundleDialogOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bundleDialogOpen]);

  if (state === null) {
    return (
      <div className="simpletab-page">
        <div className="simpletab-header">
          <h1 className="simpletab-title">{t("releases.title")}</h1>
        </div>
        <div className="simpletab-alert">
          <p>{t("common.noTournamentPrompt")}</p>
          <button
            type="button"
            className="theia-button"
            data-action={openSetupAction.id}
            onClick={() => {
              void run(openSetupAction, {});
            }}
          >
            {t("common.openSetupButton")}
          </button>
        </div>
      </div>
    );
  }

  const isHostOwner = state.roleId === "host_owner";
  const canManageReleases = stateHasPermission(state, "releases.manage");
  const canReleaseDraw = stateHasPermission(state, "draw.release");
  const canManageMotions = stateHasPermission(state, "motions.manage");
  const canManageRounds = stateHasPermission(state, "rounds.manage");

  const runOp = async <A,>(
    action: SimpleTabAction<A, SubmitResult>,
    args: A,
    successText: string,
  ): Promise<boolean> => {
    setOpError(null);
    setOpSuccess(null);
    setRetryRun(() => () => runOp(action, args, successText));
    const res = await run(action, args);
    if (!res.ok) {
      setOpError({
        code: res.code,
        errors: res.errors,
        current: res.current,
      });
      return false;
    }
    setOpSuccess(successText);
    return true;
  };

  const handleToggleTournamentGate = async (
    spec: GateSpec,
    released: boolean,
    label: string,
  ): Promise<void> => {
    await runOp(
      setGateAction,
      {
        gate: spec.gate,
        released,
        labelKey: spec.labelKey,
        ...(spec.categoryId !== undefined ? { categoryId: spec.categoryId } : {}),
      },
      t("releases.gateUpdated", { gate: label }),
    );
  };

  const handleConfirmTabBundle = async (): Promise<void> => {
    const ok = await runOp(
      releaseTabBundleAction,
      {},
      t("releases.bundleSuccess"),
    );
    if (ok) {
      setBundleDialogOpen(false);
    }
  };

  const handleRoundDrawAction = async (
    roundId: string,
    roundName: string,
    scope: "teams" | "public",
    released: boolean,
  ): Promise<void> => {
    const opType =
      scope === "teams"
        ? released
          ? "draw.unrelease"
          : "draw.release_teams"
        : released
          ? "draw.unrelease"
          : "draw.release";
    await runOp(
      setDrawGateAction,
      { roundId, scope, released },
      t("releases.gateUpdated", { gate: `${roundName} (${opType})` }),
    );
  };

  const handleRoundMotionsStatus = async (
    roundId: string,
    roundName: string,
    nextStatus: MotionsStatus,
  ): Promise<void> => {
    await runOp(
      setRoundMotionsAction,
      {
        roundId,
        status: nextStatus,
        ...(nowIso !== undefined ? { now: nowIso } : {}),
      },
      t("releases.gateUpdated", { gate: `${roundName} (${nextStatus})` }),
    );
  };

  const handleRoundFlagToggle = async (
    roundId: string,
    roundName: string,
    field: RoundReleaseField,
    nextValue: boolean,
  ): Promise<void> => {
    await runOp(
      setRoundFlagAction,
      { roundId, field, released: nextValue },
      t("releases.gateUpdated", { gate: `${roundName} (${field})` }),
    );
  };

  const renderTournamentGateGroup = (
    title: string,
    specs: readonly GateSpec[],
  ): React.ReactNode => (
    <section className="simpletab-section">
      <h2 className="simpletab-subtitle">{title}</h2>
      <div className="simpletab-gate-list">
        {specs.map((spec) => {
          const released = spec.isReleased(state);
          const label = spec.categoryId === undefined
            ? t(spec.labelKey)
            : t(spec.labelKey, {
                name: sortedBreakCategories.find((cat) => cat.id === spec.categoryId)?.name ?? spec.categoryId,
              });
          return (
            <div key={`${spec.gate}:${spec.categoryId ?? ""}`} className="simpletab-gate-row">
              <span>{label}</span>
              <span
                className={`simpletab-badge ${
                  released ? "simpletab-badge-add" : ""
                }`}
              >
                {released ? t("releases.stateReleased") : t("releases.stateUnreleased")}
              </span>
              <button
                type="button"
                className={released ? "theia-button secondary" : "theia-button"}
                data-action={setGateAction.id}
                disabled={!canManageReleases}
                aria-label={`${released ? t("releases.actionUnrelease") : t("releases.actionRelease")} ${label}`}
                onClick={() => {
                  void handleToggleTournamentGate(spec, !released, label);
                }}
              >
                {released ? t("releases.actionUnrelease") : t("releases.actionRelease")}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );

  const activeRounds = state.rounds
    .filter((round) => round.cancelled !== true)
    .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  const sortedBreakCategories = [...state.breakCategories].sort(
    (left, right) => left.seq - right.seq || left.name.localeCompare(right.name),
  );
  const groups = gateGroups(state);

  const bundlePublicItems: string[] = [
    t("releases.gateTabTeam"),
    t("releases.gateTabSpeaker"),
    t("releases.gateTabMotions"),
    t("releases.gatePublicBallots"),
    t("releases.gateResultsAllRounds"),
    t("releases.gatePublicDiversity"),
    t("releases.bundleItemPublicResults"),
    t("releases.gatePublicBreakingAdjudicators"),
    ...sortedBreakCategories.map((cat) =>
      t("releases.gateBreakCategory", { name: cat.name }),
    ),
  ];

  const bundleOffItems: string[] = [
    t("releases.bundleOffCheckIn"),
    t("releases.bundleOffStandings"),
    t("releases.bundleOffDraw"),
    t("releases.bundleOffBreakCategories"),
  ];

  return (
    <div className="simpletab-page">
      <div className="simpletab-header">
        <h1 className="simpletab-title">{t("releases.title")}</h1>
        <button
          type="button"
          className="theia-button"
          data-view-only
          disabled={!canManageReleases}
          onClick={() => setBundleDialogOpen(true)}
        >
          {t("releases.bundleButton")}
        </button>
      </div>

      <LockBanner
        locks={status.locks}
        rounds={state.rounds}
        isHostOwner={isHostOwner}
        run={run}
      />

      <div className="simpletab-hint">{t("releases.bundleHint")}</div>

      {opSuccess !== null ? (
        <div className="simpletab-alert simpletab-alert-success" role="status">
          {opSuccess}
        </div>
      ) : null}
      {opError !== null ? (
        <InlineOpError
          error={opError}
          onRetry={
            retryRun !== null
              ? () => {
                  void retryRun();
                }
              : undefined
          }
          onDismiss={() => setOpError(null)}
        />
      ) : null}

      <section
        className="simpletab-section"
        aria-labelledby={`${baseId}-rounds-h`}
      >
        <h2 id={`${baseId}-rounds-h`} className="simpletab-subtitle">
          {t("releases.roundSectionTitle")}
        </h2>
        {activeRounds.length === 0 ? (
          <p className="simpletab-empty">{t("releases.noRounds")}</p>
        ) : (
          activeRounds.map((round) => {
            const drawStage = drawStageOf(round);
            const teamsReleased = isDrawReleasedToTeams(round);
            const drawPublic = isDrawPubliclyReleased(round);
            const motionsStatus = motionsStatusOf(round);
            const drawStateLabel =
              drawStage === "released"
                ? t("releases.stateDrawPublic")
                : drawStage === "teams_released"
                  ? t("releases.stateDrawTeams")
                  : drawStage === "locked"
                    ? t("releases.stateDrawLocked")
                    : drawStage === "draft"
                      ? t("releases.stateDrawDraft")
                      : t("releases.stateDrawNone");

            return (
              <div key={round.id} className="simpletab-section">
                <h3 className="simpletab-subtitle">{round.name}</h3>
                <div className="simpletab-gate-list">
                  <div className="simpletab-gate-row">
                    <span>{t("releases.gateDrawTeams")}</span>
                    <span
                      className={`simpletab-badge ${
                        teamsReleased ? "simpletab-badge-add" : ""
                      }`}
                    >
                      {teamsReleased ? t("releases.stateDrawTeams") : drawStateLabel}
                    </span>
                    <button
                      type="button"
                      className={
                        teamsReleased ? "theia-button secondary" : "theia-button"
                      }
                      data-action={setDrawGateAction.id}
                      disabled={!canReleaseDraw || drawStage === "none"}
                      aria-label={`${round.name} ${t("releases.gateDrawTeams")}`}
                      onClick={() => {
                        void handleRoundDrawAction(
                          round.id,
                          round.name,
                          "teams",
                          !teamsReleased,
                        );
                      }}
                    >
                      {teamsReleased
                        ? t("releases.actionUnrelease")
                        : t("releases.actionRelease")}
                    </button>
                  </div>

                  <div className="simpletab-gate-row">
                    <span>{t("releases.gateDrawPublic")}</span>
                    <span
                      className={`simpletab-badge ${
                        drawPublic ? "simpletab-badge-add" : ""
                      }`}
                    >
                      {drawPublic ? t("releases.stateDrawPublic") : drawStateLabel}
                    </span>
                    <button
                      type="button"
                      className={drawPublic ? "theia-button secondary" : "theia-button"}
                      data-action={setDrawGateAction.id}
                      disabled={!canReleaseDraw || drawStage === "none"}
                      aria-label={`${round.name} ${t("releases.gateDrawPublic")}`}
                      onClick={() => {
                        void handleRoundDrawAction(
                          round.id,
                          round.name,
                          "public",
                          !drawPublic,
                        );
                      }}
                    >
                      {drawPublic
                        ? t("releases.actionUnrelease")
                        : t("releases.actionRelease")}
                    </button>
                  </div>

                  <div className="simpletab-gate-row">
                    <span>{t("releases.gateMotions")}</span>
                    <span
                      className={`simpletab-badge ${
                        motionsStatus === "motions_released"
                          ? "simpletab-badge-add"
                          : motionsStatus === "info_slides_released"
                            ? "simpletab-badge-match"
                            : ""
                      }`}
                    >
                      {motionsStatusText(motionsStatus)}
                    </span>
                    <div className="simpletab-actions">
                      {MOTIONS_STATUSES.map((statusOption) => (
                        <button
                          key={statusOption}
                          type="button"
                          className={
                            motionsStatus === statusOption
                              ? "theia-button"
                              : "theia-button secondary"
                          }
                          data-action={setRoundMotionsAction.id}
                          disabled={!canManageMotions}
                          aria-pressed={motionsStatus === statusOption}
                          onClick={() => {
                            void handleRoundMotionsStatus(
                              round.id,
                              round.name,
                              statusOption,
                            );
                          }}
                        >
                          {motionsButtonText(statusOption)}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="simpletab-gate-row">
                    <span>{t("releases.gateResults")}</span>
                    <span
                      className={`simpletab-badge ${
                        round.resultsReleased ? "simpletab-badge-add" : ""
                      }`}
                    >
                      {round.resultsReleased
                        ? t("releases.stateReleased")
                        : t("releases.stateUnreleased")}
                    </span>
                    <button
                      type="button"
                      className={
                        round.resultsReleased
                          ? "theia-button secondary"
                          : "theia-button"
                      }
                      data-action={setRoundFlagAction.id}
                      disabled={!canManageRounds}
                      aria-label={`${round.name} ${t("releases.gateResults")}`}
                      onClick={() => {
                        void handleRoundFlagToggle(
                          round.id,
                          round.name,
                          "resultsReleased",
                          !round.resultsReleased,
                        );
                      }}
                    >
                      {round.resultsReleased
                        ? t("releases.actionUnrelease")
                        : t("releases.actionRelease")}
                    </button>
                  </div>

                  <div className="simpletab-gate-row">
                    <span>{t("releases.gateSpeaks")}</span>
                    <span
                      className={`simpletab-badge ${
                        round.teamSpeaksReleased ? "simpletab-badge-add" : ""
                      }`}
                    >
                      {round.teamSpeaksReleased
                        ? t("releases.stateReleased")
                        : t("releases.stateUnreleased")}
                    </span>
                    <button
                      type="button"
                      className={
                        round.teamSpeaksReleased
                          ? "theia-button secondary"
                          : "theia-button"
                      }
                      data-action={setRoundFlagAction.id}
                      disabled={!canManageRounds}
                      aria-label={`${round.name} ${t("releases.gateSpeaks")}`}
                      onClick={() => {
                        void handleRoundFlagToggle(
                          round.id,
                          round.name,
                          "teamSpeaksReleased",
                          !(round.teamSpeaksReleased === true),
                        );
                      }}
                    >
                      {round.teamSpeaksReleased
                        ? t("releases.actionUnrelease")
                        : t("releases.actionRelease")}
                    </button>
                  </div>

                  <div className="simpletab-gate-row">
                    <span>{t("releases.gateAdjudicators")}</span>
                    <span
                      className={`simpletab-badge ${
                        round.adjudicatorsRevealed ? "simpletab-badge-add" : ""
                      }`}
                    >
                      {round.adjudicatorsRevealed
                        ? t("releases.stateRevealed")
                        : t("releases.stateHidden")}
                    </span>
                    <button
                      type="button"
                      className={
                        round.adjudicatorsRevealed
                          ? "theia-button secondary"
                          : "theia-button"
                      }
                      data-action={setRoundFlagAction.id}
                      disabled={!canManageRounds}
                      aria-label={`${round.name} ${t("releases.gateAdjudicators")}`}
                      onClick={() => {
                        void handleRoundFlagToggle(
                          round.id,
                          round.name,
                          "adjudicatorsRevealed",
                          !(round.adjudicatorsRevealed === true),
                        );
                      }}
                    >
                      {round.adjudicatorsRevealed
                        ? t("releases.actionHide")
                        : t("releases.actionReveal")}
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </section>

      {renderTournamentGateGroup(t("releases.tabsSectionTitle"), groups[0] ?? [])}
      {renderTournamentGateGroup(
        t("releases.resultsBreakSectionTitle"),
        groups[1] ?? [],
      )}
      {renderTournamentGateGroup(t("releases.listsSectionTitle"), groups[2] ?? [])}
      {renderTournamentGateGroup(t("releases.ballotsSectionTitle"), groups[3] ?? [])}
      {renderTournamentGateGroup(
        t("releases.otherPagesSectionTitle"),
        groups[4] ?? [],
      )}

      {bundleDialogOpen ? (
        <div className="simpletab-dialog-backdrop">
          <div
            className="simpletab-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${baseId}-bundle-title`}
          >
            <h2 id={`${baseId}-bundle-title`} className="simpletab-subtitle">
              {t("releases.bundleDialogTitle")}
            </h2>
            <p>{t("releases.bundleDialogIntro")}</p>
            <ul className="simpletab-issue-list">
              {bundlePublicItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p>{t("releases.bundleDialogOffIntro")}</p>
            <ul className="simpletab-issue-list">
              {bundleOffItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <div className="simpletab-actions">
              <button
                type="button"
                className="theia-button"
                data-action={releaseTabBundleAction.id}
                onClick={() => {
                  void handleConfirmTabBundle();
                }}
              >
                {t("releases.bundleConfirm")}
              </button>
              <button
                type="button"
                className="theia-button secondary"
                data-view-only
                onClick={() => setBundleDialogOpen(false)}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
