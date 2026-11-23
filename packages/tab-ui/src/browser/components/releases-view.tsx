import {
  MOTIONS_STATUSES,
  motionsStatusOf,
} from "@simpletab/core/features/tournament/application/motionRelease";
import {
  drawStageOf,
  isDrawPubliclyReleased,
  isDrawReleasedToTeams,
} from "@simpletab/core/lib/draw/drawStatus";
import { getPublicSiteSettings } from "@simpletab/core/lib/publicFeatures";
import { getPublicRelease } from "@simpletab/core/lib/publicRelease";
import { recordKey, type OpRequest, type OpRound } from "@simpletab/core/ops";
import type { ReleaseGateName } from "@simpletab/core/ops/releases";
import type { MotionsStatus } from "@simpletab/core/types";
import type {
  HostCancelLongResult,
  HostStatus,
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import { t } from "../i18n";
import { withFreshVersions } from "../lib/op-versions";
import { stateHasPermission } from "../lib/permissions";
import { InlineOpError, type InlineOpErrorData } from "./inline-op-error";
import { LockBanner } from "./lock-banner";

export interface ReleasesViewProps {
  state: ProjectedState | null;
  status: HostStatus;
  onSubmitOp: (request: OpRequest) => Promise<SubmitResult>;
  onCancelLock?: (lockId: string) => Promise<HostCancelLongResult | void>;
  onOpenSetup?: () => void;
  nowIso?: string;
}

interface TournamentGateSpec {
  gate: ReleaseGateName;
  labelKey: string;
  isReleased: (state: ProjectedState) => boolean;
}

const TAB_GATES: readonly TournamentGateSpec[] = [
  {
    gate: "tab_team",
    labelKey: "releases.gateTabTeam",
    isReleased: (s) => getPublicRelease(s.tournament.preferences).teamTab,
  },
  {
    gate: "tab_speaker",
    labelKey: "releases.gateTabSpeaker",
    isReleased: (s) => getPublicRelease(s.tournament.preferences).speakerTab,
  },
  {
    gate: "tab_replies",
    labelKey: "releases.gateTabReplies",
    isReleased: (s) => s.tournament.preferences.releaseRepliesTab === true,
  },
  {
    gate: "tab_speaker_categories",
    labelKey: "releases.gateTabSpeakerCategories",
    isReleased: (s) =>
      getPublicRelease(s.tournament.preferences).speakerCategoryTabs,
  },
  {
    gate: "tab_adjudicator",
    labelKey: "releases.gateTabAdjudicator",
    isReleased: (s) => getPublicSiteSettings(s.tournament.preferences).adjudicatorTab,
  },
  {
    gate: "tab_break_categories",
    labelKey: "releases.gateTabBreakCategories",
    isReleased: (s) =>
      getPublicSiteSettings(s.tournament.preferences).breakCategoryTabs,
  },
  {
    gate: "tab_motions",
    labelKey: "releases.gateTabMotions",
    isReleased: (s) => getPublicSiteSettings(s.tournament.preferences).motionTab,
  },
];

const LIST_GATES: readonly TournamentGateSpec[] = [
  {
    gate: "public_participants",
    labelKey: "releases.gatePublicParticipants",
    isReleased: (s) => getPublicRelease(s.tournament.preferences).participants,
  },
  {
    gate: "public_institutions",
    labelKey: "releases.gatePublicInstitutions",
    isReleased: (s) => getPublicRelease(s.tournament.preferences).institutions,
  },
  {
    gate: "public_adjudicator_core",
    labelKey: "releases.gatePublicAdjudicatorCore",
    isReleased: (s) => getPublicRelease(s.tournament.preferences).adjudicatorCore,
  },
  {
    gate: "public_breaking_adjudicators",
    labelKey: "releases.gatePublicBreakingAdjudicators",
    isReleased: (s) =>
      getPublicRelease(s.tournament.preferences).breakingAdjudicators,
  },
];

const BALLOT_GATES: readonly TournamentGateSpec[] = [
  {
    gate: "public_ballots",
    labelKey: "releases.gatePublicBallots",
    isReleased: (s) => getPublicSiteSettings(s.tournament.preferences).ballots,
  },
  {
    gate: "public_private_ballots",
    labelKey: "releases.gatePublicPrivateBallots",
    isReleased: (s) =>
      getPublicSiteSettings(s.tournament.preferences).privateBallots,
  },
];

const OTHER_PAGE_GATES: readonly TournamentGateSpec[] = [
  {
    gate: "public_record_pages",
    labelKey: "releases.gatePublicRecordPages",
    isReleased: (s) => getPublicSiteSettings(s.tournament.preferences).recordPages,
  },
  {
    gate: "public_side_allocations",
    labelKey: "releases.gatePublicSideAllocations",
    isReleased: (s) =>
      getPublicSiteSettings(s.tournament.preferences).sideAllocations,
  },
  {
    gate: "public_bracket",
    labelKey: "releases.gatePublicBracket",
    isReleased: (s) => getPublicSiteSettings(s.tournament.preferences).bracket,
  },
  {
    gate: "public_diversity",
    labelKey: "releases.gatePublicDiversity",
    isReleased: (s) => getPublicSiteSettings(s.tournament.preferences).diversity,
  },
  {
    gate: "public_veto_statistics",
    labelKey: "releases.gatePublicVetoStatistics",
    isReleased: (s) => s.tournament.preferences.publicVetoStatistics === true,
  },
  {
    gate: "public_feedback_progress",
    labelKey: "releases.gatePublicFeedbackProgress",
    isReleased: (s) =>
      getPublicSiteSettings(s.tournament.preferences).feedbackProgress,
  },
];

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

export const ReleasesView: React.FC<ReleasesViewProps> = ({
  state,
  status,
  onSubmitOp,
  onCancelLock,
  onOpenSetup,
  nowIso,
}) => {
  const baseId = React.useId();
  const [opError, setOpError] = React.useState<InlineOpErrorData | null>(null);
  const [opSuccess, setOpSuccess] = React.useState<string | null>(null);
  const [lastRequest, setLastRequest] = React.useState<OpRequest | null>(null);
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
          {onOpenSetup !== undefined ? (
            <button type="button" className="theia-button" onClick={onOpenSetup}>
              {t("common.openSetupButton")}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const isHostOwner = state.roleId === "host_owner";
  const canManageReleases = stateHasPermission(state, "releases.manage");
  const canReleaseDraw = stateHasPermission(state, "draw.release");
  const canManageMotions = stateHasPermission(state, "motions.manage");
  const canManageRounds = stateHasPermission(state, "rounds.manage");

  const runOp = async (request: OpRequest, successText: string): Promise<boolean> => {
    setOpError(null);
    setOpSuccess(null);
    setLastRequest(request);
    const res = await onSubmitOp(request);
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
    gate: ReleaseGateName,
    released: boolean,
    label: string,
    categoryId?: string,
  ): Promise<void> => {
    const tournamentKey = recordKey("tournament", state.tournament.id);
    const request: OpRequest = {
      type: "release.set_gate",
      expectedVersions: {
        [tournamentKey]: state.versions[tournamentKey] ?? 0,
        ...(categoryId !== undefined
          ? {
              [recordKey("breakCategory", categoryId)]:
                state.versions[recordKey("breakCategory", categoryId)] ?? 0,
            }
          : {}),
      },
      payload: {
        gate,
        released,
        ...(categoryId !== undefined ? { categoryId } : {}),
      },
    };
    await runOp(request, t("releases.gateUpdated", { gate: label }));
  };

  const handleConfirmTabBundle = async (): Promise<void> => {
    const tournamentKey = recordKey("tournament", state.tournament.id);
    const versions: Record<string, number> = {
      [tournamentKey]: state.versions[tournamentKey] ?? 0,
    };
    for (const cat of state.breakCategories) {
      const catKey = recordKey("breakCategory", cat.id);
      versions[catKey] = state.versions[catKey] ?? 0;
    }
    const ok = await runOp(
      {
        type: "release.tab_bundle",
        expectedVersions: versions,
        payload: {
          breakCategoryIds: state.breakCategories.map((cat) => cat.id),
        },
      },
      t("releases.bundleSuccess"),
    );
    if (ok) {
      setBundleDialogOpen(false);
    }
  };

  const handleRoundDrawAction = async (
    round: OpRound,
    opType: "draw.release_teams" | "draw.release" | "draw.unrelease",
  ): Promise<void> => {
    const roundKey = recordKey("round", round.id);
    await runOp(
      {
        type: opType,
        expectedVersions: { [roundKey]: state.versions[roundKey] ?? 0 },
        payload: { roundId: round.id },
      },
      t("releases.gateUpdated", { gate: `${round.name} (${opType})` }),
    );
  };

  const handleRoundMotionsStatus = async (
    round: OpRound,
    nextStatus: MotionsStatus,
  ): Promise<void> => {
    const roundKey = recordKey("round", round.id);
    await runOp(
      {
        type: "motion.set_round_status",
        expectedVersions: { [roundKey]: state.versions[roundKey] ?? 0 },
        payload: {
          roundId: round.id,
          status: nextStatus,
          now: nowIso ?? new Date().toISOString(),
        },
      },
      t("releases.gateUpdated", { gate: `${round.name} (${nextStatus})` }),
    );
  };

  const handleRoundFlagToggle = async (
    round: OpRound,
    field: "resultsReleased" | "teamSpeaksReleased" | "adjudicatorsRevealed",
    nextValue: boolean,
  ): Promise<void> => {
    const roundKey = recordKey("round", round.id);
    const updatedRound: OpRound = {
      ...round,
      [field]: nextValue,
    };
    await runOp(
      {
        type: "round.update",
        expectedVersions: { [roundKey]: state.versions[roundKey] ?? 0 },
        payload: { round: updatedRound },
      },
      t("releases.gateUpdated", { gate: `${round.name} (${field})` }),
    );
  };

  const renderTournamentGateGroup = (
    title: string,
    specs: readonly TournamentGateSpec[],
    extraRows?: React.ReactNode,
  ): React.ReactNode => (
    <section className="simpletab-section">
      <h2 className="simpletab-subtitle">{title}</h2>
      <div className="simpletab-gate-list">
        {specs.map((spec) => {
          const released = spec.isReleased(state);
          const label = t(spec.labelKey);
          return (
            <div key={spec.gate} className="simpletab-gate-row">
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
                disabled={!canManageReleases}
                aria-label={`${released ? t("releases.actionUnrelease") : t("releases.actionRelease")} ${label}`}
                onClick={() => {
                  void handleToggleTournamentGate(spec.gate, !released, label);
                }}
              >
                {released ? t("releases.actionUnrelease") : t("releases.actionRelease")}
              </button>
            </div>
          );
        })}
        {extraRows}
      </div>
    </section>
  );

  const activeRounds = state.rounds
    .filter((round) => round.cancelled !== true)
    .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  const publicRelease = getPublicRelease(state.tournament.preferences);
  const sortedBreakCategories = [...state.breakCategories].sort(
    (left, right) => left.seq - right.seq || left.name.localeCompare(right.name),
  );

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
        onCancelLock={onCancelLock}
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
            lastRequest !== null
              ? () => {
                  void runOp(
                    withFreshVersions(lastRequest, state.versions),
                    t("releases.bundleSuccess"),
                  );
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
                      disabled={!canReleaseDraw || drawStage === "none"}
                      aria-label={`${round.name} ${t("releases.gateDrawTeams")}`}
                      onClick={() => {
                        void handleRoundDrawAction(
                          round,
                          teamsReleased ? "draw.unrelease" : "draw.release_teams",
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
                      disabled={!canReleaseDraw || drawStage === "none"}
                      aria-label={`${round.name} ${t("releases.gateDrawPublic")}`}
                      onClick={() => {
                        void handleRoundDrawAction(
                          round,
                          drawPublic ? "draw.unrelease" : "draw.release",
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
                          disabled={!canManageMotions}
                          aria-pressed={motionsStatus === statusOption}
                          onClick={() => {
                            void handleRoundMotionsStatus(round, statusOption);
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
                      disabled={!canManageRounds}
                      aria-label={`${round.name} ${t("releases.gateResults")}`}
                      onClick={() => {
                        void handleRoundFlagToggle(
                          round,
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
                      disabled={!canManageRounds}
                      aria-label={`${round.name} ${t("releases.gateSpeaks")}`}
                      onClick={() => {
                        void handleRoundFlagToggle(
                          round,
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
                      disabled={!canManageRounds}
                      aria-label={`${round.name} ${t("releases.gateAdjudicators")}`}
                      onClick={() => {
                        void handleRoundFlagToggle(
                          round,
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

      {renderTournamentGateGroup(t("releases.tabsSectionTitle"), TAB_GATES)}

      {renderTournamentGateGroup(
        t("releases.resultsBreakSectionTitle"),
        [
          {
            gate: "results_all_rounds",
            labelKey: "releases.gateResultsAllRounds",
            isReleased: (s) => getPublicRelease(s.tournament.preferences).allResults,
          },
        ],
        sortedBreakCategories.map((cat) => {
          const released = publicRelease.breakCategoryIds.has(cat.id);
          const label = t("releases.gateBreakCategory", { name: cat.name });
          return (
            <div key={cat.id} className="simpletab-gate-row">
              <span>{label}</span>
              <span
                className={`simpletab-badge ${
                  released ? "simpletab-badge-add" : ""
                }`}
              >
                {released
                  ? t("releases.stateReleased")
                  : t("releases.stateUnreleased")}
              </span>
              <button
                type="button"
                className={released ? "theia-button secondary" : "theia-button"}
                disabled={!canManageReleases}
                aria-label={`${released ? t("releases.actionUnrelease") : t("releases.actionRelease")} ${label}`}
                onClick={() => {
                  void handleToggleTournamentGate(
                    "break_category_published",
                    !released,
                    label,
                    cat.id,
                  );
                }}
              >
                {released
                  ? t("releases.actionUnrelease")
                  : t("releases.actionRelease")}
              </button>
            </div>
          );
        }),
      )}

      {renderTournamentGateGroup(t("releases.listsSectionTitle"), LIST_GATES)}
      {renderTournamentGateGroup(t("releases.ballotsSectionTitle"), BALLOT_GATES)}
      {renderTournamentGateGroup(
        t("releases.otherPagesSectionTitle"),
        OTHER_PAGE_GATES,
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
                onClick={() => {
                  void handleConfirmTabBundle();
                }}
              >
                {t("releases.bundleConfirm")}
              </button>
              <button
                type="button"
                className="theia-button secondary"
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
