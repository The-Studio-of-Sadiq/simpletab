import type { PublicChainItem } from "@simpletab/core/changelog";
import { roundResults } from "@simpletab/core/features/tournament/application/draws";
import {
  roundFieldSize,
  swingTeamsNeeded,
} from "@simpletab/core/features/tournament/application/swingTeams";
import { tournamentSides } from "@simpletab/core/lib/debateSides";
import type { PickedTeam, TeamLocation } from "@simpletab/core/lib/draw/drawEditing";
import {
  drawStageActions,
  drawStageOf,
  type DrawStage,
  type DrawStageAction,
} from "@simpletab/core/lib/draw/drawStatus";
import { getEligibleTeamsForRound } from "@simpletab/core/lib/draw/generator";
import { validateDraw } from "@simpletab/core/lib/draw/validateDraw";
import { isAvailableForRound } from "@simpletab/core/lib/roundAvailability";
import { sideLabel } from "@simpletab/core/lib/sideNames";
import type { Debate, DebateSide, Team } from "@simpletab/core/types";
import type {
  HostStatus,
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import type { ActionRunner, SimpleTabAction } from "../actions/action";
import {
  createSwingAction,
  drawStageActionFor,
  generateDrawAction,
  moveTeamAction,
  randomSeedInt,
  restoreDrawAction,
  swapTeamsAction,
  toggleSwingRoundAction,
  updateDebateAction,
} from "../actions/draw-actions";
import { openSetupAction } from "../actions/releases-actions";
import { t } from "../i18n";
import { InlineOpError, type InlineOpErrorData } from "./inline-op-error";
import { LockBanner } from "./lock-banner";
import { getDefaultRoundId, RoundPicker } from "./round-picker";

export interface DrawViewProps {
  state: ProjectedState | null;
  status: HostStatus;
  selectedRoundId?: string;
  onSelectRound?: (roundId: string) => void;
  /** Runs the same commands as the palette; no op building happens here. */
  run: ActionRunner;
  onGetChangelog?: () => Promise<PublicChainItem[]>;
  lastGenerateSeq?: number;
}

interface RoomErrorEntry {
  error: InlineOpErrorData;
  retry: (runner: ActionRunner) => Promise<SubmitResult>;
}

function stageText(stage: DrawStage): string {
  switch (stage) {
    case "none":
      return t("draw.stageNone");
    case "draft":
      return t("draw.stageDraft");
    case "locked":
      return t("draw.stageLocked");
    case "teams_released":
      return t("draw.stageTeamsReleased");
    case "released":
      return t("draw.stageReleased");
  }
}

function stageActionLabel(action: DrawStageAction): string {
  switch (action) {
    case "lock":
      return t("draw.actionLock");
    case "unlock":
      return t("draw.actionUnlock");
    case "release_teams":
      return t("draw.actionReleaseTeams");
    case "release":
      return t("draw.actionRelease");
    case "unrelease":
      return t("draw.actionUnrelease");
  }
}

function roomTitle(
  debate: Pick<Debate, "byeTeamId" | "venueName" | "roomRank"> | undefined,
): string {
  if (debate === undefined) {
    return t("draw.emptySlot");
  }
  if (debate.byeTeamId) {
    return t("draw.byeBadge");
  }
  return debate.venueName || t("draw.roomFallback", { rank: debate.roomRank });
}

function summarizeRoom(
  debate: Debate,
  sides: readonly DebateSide[],
  state: ProjectedState,
): string {
  const room = roomTitle(debate);
  const parts = sides.map((side) => {
    const label = sideLabel(
      side,
      state.tournament.preferences,
      state.tournament.format === "bp" ? "abbr" : "full",
    );
    const slot = debate.teams[side];
    const teamText = slot?.teamName || t("draw.emptySlot");
    return `${label}: ${teamText}`;
  });
  return t("draw.currentRoomSummary", { room, teams: parts.join(", ") });
}

function defaultSpeakerInputs(count: number): string[] {
  return Array.from({ length: Math.max(1, count) }, () => "");
}

export const DrawView: React.FC<DrawViewProps> = ({
  state,
  status,
  selectedRoundId: controlledRoundId,
  onSelectRound,
  run,
  onGetChangelog,
  lastGenerateSeq,
}) => {
  const baseId = React.useId();
  const [uncontrolledRoundId, setUncontrolledRoundId] = React.useState("");
  const [seedInput, setSeedInput] = React.useState(() =>
    String(randomSeedInt()),
  );
  const [discardExisting, setDiscardExisting] = React.useState(false);
  const [generating, setGenerating] = React.useState(false);
  const [bannerSuccess, setBannerSuccess] = React.useState<string | null>(null);
  const [bannerError, setBannerError] = React.useState<InlineOpErrorData | null>(
    null,
  );
  const [pickedTeam, setPickedTeam] = React.useState<PickedTeam | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = React.useState("");
  const [roomErrors, setRoomErrors] = React.useState<
    Record<string, RoomErrorEntry>
  >({});
  const [localGenSeqByRound, setLocalGenSeqByRound] = React.useState<
    Record<string, number>
  >({});

  // Swing team form state
  const [swingName, setSwingName] = React.useState("");
  const [swingSpeakers, setSwingSpeakers] = React.useState<string[]>(() =>
    defaultSpeakerInputs(state?.tournament.preferences.substantiveSpeakers ?? 2),
  );
  const [swingMessage, setSwingMessage] = React.useState<string | null>(null);
  const [swingError, setSwingError] = React.useState<InlineOpErrorData | null>(
    null,
  );

  React.useEffect(() => {
    if (state === null) {
      return;
    }
    const candidate = controlledRoundId ?? uncontrolledRoundId;
    const exists = state.rounds.some((round) => round.id === candidate);
    if (!exists) {
      const nextDefault = getDefaultRoundId(state);
      if (controlledRoundId === undefined) {
        setUncontrolledRoundId(nextDefault);
      } else if (onSelectRound !== undefined && nextDefault.length > 0) {
        onSelectRound(nextDefault);
      }
    }
  }, [state, controlledRoundId, uncontrolledRoundId, onSelectRound]);

  React.useEffect(() => {
    if (state === null) {
      return;
    }
    setSwingSpeakers(
      defaultSpeakerInputs(state.tournament.preferences.substantiveSpeakers),
    );
  }, [state?.tournament.id, state?.tournament.preferences.substantiveSpeakers]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setPickedTeam(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const effectiveRoundId = React.useMemo(() => {
    if (state === null) {
      return "";
    }
    if (
      controlledRoundId !== undefined &&
      state.rounds.some((round) => round.id === controlledRoundId)
    ) {
      return controlledRoundId;
    }
    if (state.rounds.some((round) => round.id === uncontrolledRoundId)) {
      return uncontrolledRoundId;
    }
    return getDefaultRoundId(state);
  }, [state, controlledRoundId, uncontrolledRoundId]);

  const selectedRound = React.useMemo(
    () => state?.rounds.find((round) => round.id === effectiveRoundId),
    [state?.rounds, effectiveRoundId],
  );

  React.useEffect(() => {
    if (selectedRound === undefined) {
      return;
    }
    setSeedInput(
      selectedRound.drawSeed !== undefined
        ? String(selectedRound.drawSeed)
        : String(randomSeedInt()),
    );
    setPickedTeam(null);
    setRoomErrors({});
    setBannerError(null);
    setBannerSuccess(null);
  }, [selectedRound?.id]);

  const roundDebates = React.useMemo(() => {
    if (state === null || selectedRound === undefined) {
      return [];
    }
    return state.debates
      .filter((debate) => debate.roundId === selectedRound.id)
      .sort(
        (left, right) =>
          left.roomRank - right.roomRank || left.id.localeCompare(right.id),
      );
  }, [state, selectedRound]);

  const existingRoundResults = React.useMemo(
    () =>
      state === null || selectedRound === undefined
        ? []
        : roundResults(selectedRound.id, state.debates, state.ballots),
    [state, selectedRound],
  );

  const expiryHours = state?.tournament.preferences.checkInExpiresAfterHours;

  const eligibleAvailableTeams = React.useMemo(() => {
    if (state === null || selectedRound === undefined) {
      return [];
    }
    return getEligibleTeamsForRound(state.teams, selectedRound).filter((team) =>
      isAvailableForRound(team, selectedRound, expiryHours),
    );
  }, [state, selectedRound, expiryHours]);

  const placedTeamIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const debate of roundDebates) {
      if (debate.byeTeamId) {
        ids.add(debate.byeTeamId);
      }
      for (const slot of Object.values(debate.teams)) {
        if (slot?.teamId) {
          ids.add(slot.teamId);
        }
      }
    }
    return ids;
  }, [roundDebates]);

  const fieldInfo = React.useMemo(() => {
    if (state === null || selectedRound === undefined) {
      return null;
    }
    return roundFieldSize(state.tournament, selectedRound, state.teams);
  }, [state, selectedRound]);

  const drawIssues = React.useMemo(() => {
    if (
      state === null ||
      selectedRound === undefined ||
      roundDebates.length === 0
    ) {
      return [];
    }
    return validateDraw({
      tournament: state.tournament,
      round: selectedRound,
      debates: state.debates,
      rounds: state.rounds,
      teams: state.teams,
      adjudicators: state.adjudicators,
      venues: state.venues,
      ballots: state.ballots,
      institutions: state.institutions,
    });
  }, [state, selectedRound, roundDebates.length]);

  if (state === null) {
    return (
      <div className="simpletab-page">
        <div className="simpletab-header">
          <h1 className="simpletab-title">{t("draw.title")}</h1>
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
  const sides = tournamentSides(state.tournament);
  const unassignedTeams = eligibleAvailableTeams.filter(
    (team) => !placedTeamIds.has(team.id),
  );
  const neededSwing =
    fieldInfo !== null ? swingTeamsNeeded(fieldInfo) : 0;

  const handleSelectRound = (roundId: string): void => {
    if (controlledRoundId === undefined) {
      setUncontrolledRoundId(roundId);
    }
    onSelectRound?.(roundId);
  };

  const handleGenerate = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (selectedRound === undefined) {
      return;
    }
    setBannerError(null);
    setBannerSuccess(null);

    const parsedSeed = Number(seedInput.trim());
    if (!Number.isInteger(parsedSeed)) {
      setBannerError({
        code: "INVALID",
        errors: [t("draw.seedInvalid")],
      });
      return;
    }

    setGenerating(true);
    try {
      const result = await run(generateDrawAction, {
        roundId: selectedRound.id,
        seed: parsedSeed,
        ...(discardExisting ? { discardExisting: true } : {}),
      });
      if (!result.ok) {
        setBannerError({
          code: result.code,
          errors: result.errors,
          current: result.current,
          lockId: result.lockId,
        } as InlineOpErrorData);
        return;
      }
      setLocalGenSeqByRound((prev) => ({
        ...prev,
        [selectedRound.id]: result.seq,
      }));
      setDiscardExisting(false);
      setRoomErrors({});
      setBannerSuccess(
        t("draw.generatedSuccess", {
          round: selectedRound.name,
          seed: parsedSeed,
        }),
      );
    } finally {
      setGenerating(false);
    }
  };

  const handleRestorePrevious = async (): Promise<void> => {
    if (selectedRound === undefined) {
      return;
    }
    setBannerError(null);
    setBannerSuccess(null);

    let seq: number | undefined =
      lastGenerateSeq ?? localGenSeqByRound[selectedRound.id];
    if (seq === undefined && onGetChangelog !== undefined) {
      const items = await onGetChangelog();
      const latestGenerate = [...items]
        .reverse()
        .find((item) => item.entry.opType === "draw.generate");
      seq = latestGenerate?.entry.seq;
    }

    if (seq === undefined) {
      setBannerError({
        code: "CANNOT_UNDO",
        errors: [t("draw.restoreUnavailable")],
      });
      return;
    }

    const result = await run(restoreDrawAction, { seq });
    if (!result.ok) {
      setBannerError({
        code: result.code,
        errors: result.errors,
        current: result.current,
        blockingSeqs: result.blockingSeqs,
      });
      return;
    }
    setBannerSuccess(t("draw.restoredSuccess"));
  };

  const handleStageAction = async (action: DrawStageAction): Promise<void> => {
    if (selectedRound === undefined) {
      return;
    }
    setBannerError(null);
    setBannerSuccess(null);
    const result = await run(drawStageActionFor(action), {
      roundId: selectedRound.id,
    });
    if (!result.ok) {
      setBannerError({
        code: result.code,
        errors: result.errors,
        current: result.current,
      });
      return;
    }
    setBannerSuccess(t("draw.stageUpdated"));
  };

  const submitRoomOpResult = async <A,>(
    runner: ActionRunner,
    action: SimpleTabAction<A, SubmitResult>,
    args: A,
    affectedDebateIds: string[],
    announcement?: string,
  ): Promise<SubmitResult> => {
    setRoomErrors((prev) => {
      const next = { ...prev };
      for (const id of affectedDebateIds) {
        delete next[id];
      }
      return next;
    });

    const result = await runner(action, args);
    if (!result.ok) {
      const targetId = affectedDebateIds[0];
      if (targetId !== undefined) {
        const debate = state.debates.find((d) => d.id === targetId);
        setRoomErrors((prev) => ({
          ...prev,
          [targetId]: {
            error: {
              code: result.code,
              errors: result.errors,
              current: result.current,
              currentSummary: debate
                ? summarizeRoom(debate, sides, state)
                : undefined,
            },
            retry: (currentRun) =>
              submitRoomOpResult(currentRun, action, args, affectedDebateIds),
          },
        }));
      } else {
        setBannerError({
          code: result.code,
          errors: result.errors,
          current: result.current,
        });
      }
      return result;
    }
    if (announcement) {
      setLiveAnnouncement(announcement);
    }
    return result;
  };

  const submitRoomOp = async <A,>(
    runner: ActionRunner,
    action: SimpleTabAction<A, SubmitResult>,
    args: A,
    affectedDebateIds: string[],
    announcement?: string,
  ): Promise<boolean> =>
    (
      await submitRoomOpResult(
        runner,
        action,
        args,
        affectedDebateIds,
        announcement,
      )
    ).ok;

  const executeTeamMove = async (
    pick: PickedTeam,
    target: TeamLocation,
  ): Promise<void> => {
    const affectedDebateIds: string[] = [];

    if (pick.from.kind === "slot") {
      affectedDebateIds.push(pick.from.debateId);
    }

    if (
      target.kind === "slot" &&
      !affectedDebateIds.includes(target.debateId)
    ) {
      affectedDebateIds.push(target.debateId);
    }

    const ok = await submitRoomOp(
      run,
      moveTeamAction,
      { pick, target },
      affectedDebateIds,
      `${pick.teamName} moved`,
    );
    if (ok) {
      setPickedTeam(null);
    }
  };

  const handleSlotButtonClick = (
    debate: Debate,
    side: DebateSide,
    occupantId: string,
    occupantName: string,
  ): void => {
    if (pickedTeam === null) {
      if (!occupantId) {
        return;
      }
      setPickedTeam({
        teamId: occupantId,
        teamName: occupantName,
        from: { kind: "slot", debateId: debate.id, side },
      });
      return;
    }

    if (
      pickedTeam.from.kind === "slot" &&
      pickedTeam.from.debateId === debate.id &&
      pickedTeam.from.side === side
    ) {
      setPickedTeam(null);
      return;
    }

    void executeTeamMove(pickedTeam, {
      kind: "slot",
      debateId: debate.id,
      side,
    });
  };

  const handleSwapSides = (debate: Debate): void => {
    if (sides.length !== 2) {
      return;
    }
    const [sideA, sideB] = sides;
    void submitRoomOp(run, swapTeamsAction, {
      slotA: { debateId: debate.id, side: sideA },
      slotB: { debateId: debate.id, side: sideB },
    }, [debate.id]);
  };

  const handleVenueChange = (debate: Debate, venueId: string): void => {
    void submitRoomOp(
      run,
      updateDebateAction,
      { debateId: debate.id, venueId },
      [debate.id],
    );
  };

  const handleCreateSwing = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (selectedRound === undefined) {
      return;
    }
    setSwingError(null);
    setSwingMessage(null);
    const result = await run(createSwingAction, {
      roundId: selectedRound.id,
      name: swingName.trim(),
      speakers: swingSpeakers
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    });
    if (!result.ok) {
      setSwingError({
        code: result.code,
        errors: result.errors,
        current: result.current,
      });
      return;
    }
    setSwingMessage(t("draw.swingCreated", { name: swingName.trim() }));
    setSwingName("");
    setSwingSpeakers(
      defaultSpeakerInputs(state.tournament.preferences.substantiveSpeakers),
    );
  };

  const handleToggleSwingRound = async (
    team: Team,
    enabled: boolean,
  ): Promise<void> => {
    if (selectedRound === undefined) {
      return;
    }
    setSwingError(null);
    setSwingMessage(null);
    const result = await run(toggleSwingRoundAction, {
      teamId: team.id,
      roundId: selectedRound.id,
      enabled,
    });
    if (!result.ok) {
      setSwingError({
        code: result.code,
        errors: result.errors,
        current: result.current,
      });
    }
  };

  const drawStage =
    selectedRound !== undefined ? drawStageOf(selectedRound) : "none";
  const stageActions = drawStageActions(drawStage);
  const swingTeams = state.teams.filter((team) => team.isSwing === true);
  const issueErrors = drawIssues.filter((issue) => issue.severity === "error");
  const issueWarnings = drawIssues.filter(
    (issue) => issue.severity === "warning",
  );

  const renderSideHeader = (side: DebateSide): string =>
    sideLabel(
      side,
      state.tournament.preferences,
      state.tournament.format === "bp" ? "abbr" : "full",
    );

  return (
    <div className="simpletab-page">
      <div className="simpletab-header">
        <h1 className="simpletab-title">{t("draw.title")}</h1>
        <RoundPicker
          rounds={state.rounds}
          selectedRoundId={effectiveRoundId}
          onSelectRound={handleSelectRound}
        />
      </div>

      <LockBanner
        locks={status.locks}
        rounds={state.rounds}
        isHostOwner={isHostOwner}
        run={run}
      />

      <div className="simpletab-sr-only" aria-live="polite">
        {liveAnnouncement}
      </div>

      {selectedRound === undefined ? (
        <div className="simpletab-alert" role="status">
          {t("draw.noRounds")}
        </div>
      ) : (
        <>
          <section
            className="simpletab-section"
            aria-labelledby={`${baseId}-gen-h`}
          >
            <div className="simpletab-toolbar">
              <div>
                <h2 id={`${baseId}-gen-h`} className="simpletab-subtitle">
                  {t("draw.generateSectionTitle")}
                </h2>
                <div className="simpletab-hint">
                  {t("draw.formatSummary", {
                    format: state.tournament.format.toUpperCase(),
                    drawType: selectedRound.drawType,
                    available: eligibleAvailableTeams.length,
                  })}
                </div>
                {fieldInfo !== null && neededSwing > 0 ? (
                  <div className="simpletab-hint">
                    {t("draw.swingNeededHint", {
                      excess: fieldInfo.excess,
                      teamsPerDebate: fieldInfo.teamsPerDebate,
                      needed: neededSwing,
                    })}
                  </div>
                ) : null}
              </div>

              <div className="simpletab-stage-bar">
                <span className="simpletab-hint">{t("draw.stageLabel")}:</span>
                <span className="simpletab-badge simpletab-badge-match">
                  {stageText(drawStage)}
                </span>
              </div>
            </div>

            {bannerSuccess !== null ? (
              <div
                className="simpletab-alert simpletab-alert-success"
                role="status"
              >
                {bannerSuccess}
              </div>
            ) : null}
            {bannerError !== null ? (
              <InlineOpError
                error={bannerError}
                onDismiss={() => setBannerError(null)}
              />
            ) : null}

            <form
              className="simpletab-form"
              onSubmit={(e) => {
                void handleGenerate(e);
              }}
            >
              <div className="simpletab-input-row">
                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-seed`}>{t("draw.seedLabel")}</label>
                  <div className="simpletab-input-row">
                    <input
                      id={`${baseId}-seed`}
                      type="number"
                      step={1}
                      value={seedInput}
                      onChange={(e) => setSeedInput(e.target.value)}
                    />
                    <button
                      type="button"
                      className="theia-button secondary"
                      data-view-only
                      onClick={() => setSeedInput(String(randomSeedInt()))}
                    >
                      {t("draw.randomizeSeed")}
                    </button>
                  </div>
                </div>
              </div>

              {existingRoundResults.length > 0 ? (
                <div className="simpletab-checkbox-item">
                  <input
                    id={`${baseId}-discard-ballots`}
                    type="checkbox"
                    checked={discardExisting}
                    onChange={(e) => setDiscardExisting(e.target.checked)}
                  />
                  <label htmlFor={`${baseId}-discard-ballots`}>
                    {t("draw.discardExistingLabel", {
                      count: existingRoundResults.length,
                    })}
                  </label>
                </div>
              ) : null}

              <div className="simpletab-actions">
                <button
                  type="submit"
                  className="theia-button"
                  data-action={generateDrawAction.id}
                  disabled={generating}
                >
                  {generating
                    ? t("draw.generatingButton")
                    : t("draw.generateButton")}
                </button>
                <button
                  type="button"
                  className="theia-button secondary"
                  data-action={restoreDrawAction.id}
                  onClick={() => {
                    void handleRestorePrevious();
                  }}
                >
                  {t("draw.restoreButton")}
                </button>
                {stageActions.map((action) => (
                  <button
                    key={action}
                    type="button"
                    className="theia-button secondary"
                    data-action={drawStageActionFor(action).id}
                    onClick={() => {
                      void handleStageAction(action);
                    }}
                  >
                    {stageActionLabel(action)}
                  </button>
                ))}
              </div>
            </form>
          </section>

          {drawIssues.length > 0 ? (
            <section className="simpletab-section">
              <h2 className="simpletab-subtitle">
                {t("draw.issuesTitle", {
                  errors: issueErrors.length,
                  warnings: issueWarnings.length,
                })}
              </h2>
              <ul className="simpletab-issue-list">
                {drawIssues.map((issue, idx) => (
                  <li key={`${issue.code}-${idx}`}>
                    <span
                      className={`simpletab-badge ${
                        issue.severity === "error"
                          ? "simpletab-badge-error"
                          : "simpletab-badge-conflict"
                      }`}
                    >
                      {issue.severity === "error"
                        ? t("draw.issueErrorBadge")
                        : t("draw.issueWarningBadge")}
                    </span>
                    <span>{issue.message}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {pickedTeam !== null ? (
            <div
              className="simpletab-alert simpletab-alert-warning"
              role="status"
            >
              <div className="simpletab-toolbar">
                <span>
                  {t("draw.pickedBanner", {
                    team: pickedTeam.teamName,
                    from:
                      pickedTeam.from.kind === "pool"
                        ? t("draw.emptySlot")
                        : roomTitle(
                            roundDebates.find(
                              (d) =>
                                pickedTeam.from.kind === "slot" &&
                                d.id === pickedTeam.from.debateId,
                            ),
                          ),
                  })}
                </span>
                <div className="simpletab-actions">
                  {pickedTeam.from.kind === "slot" ? (
                    <button
                      type="button"
                      className="theia-button secondary"
                      data-action={moveTeamAction.id}
                      onClick={() => {
                        void executeTeamMove(pickedTeam, { kind: "pool" });
                      }}
                    >
                      {t("draw.returnToPool", { team: pickedTeam.teamName })}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="theia-button secondary"
                    data-view-only
                    onClick={() => setPickedTeam(null)}
                  >
                    {t("draw.cancelPick")}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <section
            className="simpletab-section"
            aria-labelledby={`${baseId}-table-h`}
          >
            <h2 id={`${baseId}-table-h`} className="simpletab-subtitle">
              {t("draw.tableSectionTitle")}
            </h2>

            {roundDebates.length === 0 ? (
              <p className="simpletab-empty">
                {t("draw.emptyDraw", { round: selectedRound.name })}
              </p>
            ) : (
              <div className="simpletab-table-wrap">
                <table className="simpletab-table">
                  <caption>
                    {t("draw.tableCaption", { round: selectedRound.name })}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("draw.colRoom")}</th>
                      <th scope="col">{t("draw.colMeta")}</th>
                      {sides.map((side) => (
                        <th
                          key={side}
                          scope="col"
                          title={sideLabel(
                            side,
                            state.tournament.preferences,
                            "full",
                          )}
                        >
                          {renderSideHeader(side)}
                        </th>
                      ))}
                      <th scope="col">{t("draw.colActions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roundDebates.map((debate) => {
                      const roomLabelText = roomTitle(debate);
                      const roomError = roomErrors[debate.id];
                      return (
                        <React.Fragment key={debate.id}>
                          <tr>
                            <td>
                              {debate.byeTeamId ? (
                                <span className="simpletab-badge">
                                  {t("draw.byeBadge")}
                                </span>
                              ) : (
                                <div className="simpletab-field">
                                  <select
                                    aria-label={t("draw.venueSelectLabel", {
                                      room: roomLabelText,
                                    })}
                                    value={debate.venueId ?? ""}
                                    onChange={(e) =>
                                      handleVenueChange(debate, e.target.value)
                                    }
                                  >
                                    <option value="">
                                      {t("draw.noVenueOption")}
                                    </option>
                                    {state.venues.map((venue) => (
                                      <option key={venue.id} value={venue.id}>
                                        {venue.name}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              )}
                            </td>
                            <td>
                              <div>
                                {t("draw.bracketLabel", {
                                  bracket: debate.bracket,
                                })}
                              </div>
                              {debate.flags.map((flag) => (
                                <span key={flag} className="simpletab-badge">
                                  {flag}
                                </span>
                              ))}
                            </td>
                            {sides.map((side) => {
                              const slot = debate.teams[side];
                              const teamId = slot?.teamId ?? "";
                              const teamName = slot?.teamName ?? "";
                              const isSelected =
                                pickedTeam?.from.kind === "slot" &&
                                pickedTeam.from.debateId === debate.id &&
                                pickedTeam.from.side === side;
                              const canMoveToSlot =
                                pickedTeam !== null && !isSelected;

                              const slotAria =
                                pickedTeam === null
                                  ? teamId
                                    ? t("draw.pickSlotAria", {
                                        team: teamName,
                                        room: roomLabelText,
                                        side: renderSideHeader(side),
                                      })
                                    : t("draw.emptySlot")
                                  : teamId
                                    ? t("draw.placeInSlotAria", {
                                        picked: pickedTeam.teamName,
                                        room: roomLabelText,
                                        side: renderSideHeader(side),
                                        occupant: teamName,
                                      })
                                    : t("draw.placeInEmptySlotAria", {
                                        picked: pickedTeam.teamName,
                                        room: roomLabelText,
                                        side: renderSideHeader(side),
                                      });

                              return (
                                <td key={side}>
                                  {debate.byeTeamId && !teamId ? (
                                    <span className="simpletab-hint">
                                      {t("common.none")}
                                    </span>
                                  ) : (
                                    <div className="simpletab-slot-cell">
                                      <button
                                        type="button"
                                        draggable={teamId.length > 0}
                                        data-action={
                                          canMoveToSlot ? moveTeamAction.id : undefined
                                        }
                                        data-view-only={
                                          canMoveToSlot ? undefined : true
                                        }
                                        className={`simpletab-slot-btn${
                                          isSelected
                                            ? " simpletab-slot-selected"
                                            : ""
                                        }${
                                          pickedTeam !== null && !isSelected
                                            ? " simpletab-slot-target"
                                            : ""
                                        }`}
                                        aria-pressed={isSelected}
                                        aria-label={slotAria}
                                        disabled={
                                          pickedTeam === null &&
                                          teamId.length === 0
                                        }
                                        onClick={() =>
                                          handleSlotButtonClick(
                                            debate,
                                            side,
                                            teamId,
                                            teamName,
                                          )
                                        }
                                        onDragStart={() => {
                                          if (!teamId) {
                                            return;
                                          }
                                          setPickedTeam({
                                            teamId,
                                            teamName,
                                            from: {
                                              kind: "slot",
                                              debateId: debate.id,
                                              side,
                                            },
                                          });
                                        }}
                                        onDragOver={(e) => {
                                          e.preventDefault();
                                        }}
                                        onDrop={(e) => {
                                          e.preventDefault();
                                          if (pickedTeam !== null) {
                                            void executeTeamMove(pickedTeam, {
                                              kind: "slot",
                                              debateId: debate.id,
                                              side,
                                            });
                                          }
                                        }}
                                      >
                                        {teamId ? teamName : t("draw.emptySlot")}
                                      </button>
                                      {slot?.pulledUp ? (
                                        <span className="simpletab-badge">
                                          {t("draw.pullupBadge")}
                                        </span>
                                      ) : null}
                                    </div>
                                  )}
                                </td>
                              );
                            })}
                            <td>
                              {!debate.byeTeamId && sides.length === 2 ? (
                                <button
                                  type="button"
                                  className="theia-button secondary"
                                  data-action={swapTeamsAction.id}
                                  aria-label={t("draw.swapSidesAria", {
                                    room: roomLabelText,
                                  })}
                                  onClick={() => handleSwapSides(debate)}
                                >
                                  {t("draw.swapSidesButton")}
                                </button>
                              ) : null}
                            </td>
                          </tr>
                          {roomError !== undefined ? (
                            <tr>
                              <td colSpan={sides.length + 3}>
                                <InlineOpError
                                  error={{
                                    ...roomError.error,
                                    currentSummary: summarizeRoom(
                                      debate,
                                      sides,
                                      state,
                                    ),
                                  }}
                                  onRetry={() => {
                                    void roomError.retry(run);
                                  }}
                                  onDismiss={() => {
                                    setRoomErrors((prev) => {
                                      const next = { ...prev };
                                      delete next[debate.id];
                                      return next;
                                    });
                                  }}
                                />
                              </td>
                            </tr>
                          ) : null}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div
              className="simpletab-pool-box"
              onDragOver={(e) => {
                if (pickedTeam?.from.kind === "slot") {
                  e.preventDefault();
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (pickedTeam?.from.kind === "slot") {
                  void executeTeamMove(pickedTeam, { kind: "pool" });
                }
              }}
            >
              <h3 className="simpletab-subtitle">
                {t("draw.unassignedTitle", { count: unassignedTeams.length })}
              </h3>
              {unassignedTeams.length === 0 ? (
                <p className="simpletab-hint">{t("draw.unassignedNone")}</p>
              ) : (
                <div className="simpletab-actions">
                  {unassignedTeams.map((team) => {
                    const selected =
                      pickedTeam?.from.kind === "pool" &&
                      pickedTeam.teamId === team.id;
                    return (
                      <button
                        key={team.id}
                        type="button"
                        draggable
                        data-view-only
                        className={`simpletab-slot-btn${
                          selected ? " simpletab-slot-selected" : ""
                        }`}
                        aria-pressed={selected}
                        aria-label={t("draw.pickPoolAria", { team: team.name })}
                        onClick={() => {
                          if (selected) {
                            setPickedTeam(null);
                          } else {
                            setPickedTeam({
                              teamId: team.id,
                              teamName: team.name,
                              from: { kind: "pool" },
                            });
                          }
                        }}
                        onDragStart={() =>
                          setPickedTeam({
                            teamId: team.id,
                            teamName: team.name,
                            from: { kind: "pool" },
                          })
                        }
                      >
                        {team.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <section
            className="simpletab-section"
            aria-labelledby={`${baseId}-swing-h`}
          >
            <h2 id={`${baseId}-swing-h`} className="simpletab-subtitle">
              {t("draw.swingSectionTitle")}
            </h2>
            {swingMessage !== null ? (
              <div
                className="simpletab-alert simpletab-alert-success"
                role="status"
              >
                {swingMessage}
              </div>
            ) : null}
            {swingError !== null ? (
              <InlineOpError
                error={swingError}
                onDismiss={() => setSwingError(null)}
              />
            ) : null}

            {selectedRound.stage !== "preliminary" ? (
              <p className="simpletab-hint">{t("draw.swingPrelimOnly")}</p>
            ) : (
              <form
                className="simpletab-form"
                onSubmit={(e) => {
                  void handleCreateSwing(e);
                }}
              >
                <div className="simpletab-form-grid">
                  <div className="simpletab-field">
                    <label htmlFor={`${baseId}-swing-name`}>
                      {t("draw.swingNameLabel")}
                    </label>
                    <input
                      id={`${baseId}-swing-name`}
                      type="text"
                      required
                      value={swingName}
                      onChange={(e) => setSwingName(e.target.value)}
                    />
                  </div>
                  {swingSpeakers.map((spkName, idx) => (
                    <div key={idx} className="simpletab-field">
                      <label htmlFor={`${baseId}-swing-spk-${idx}`}>
                        {t("draw.swingSpeakerLabel", { index: idx + 1 })}
                      </label>
                      <input
                        id={`${baseId}-swing-spk-${idx}`}
                        type="text"
                        required
                        value={spkName}
                        onChange={(e) => {
                          const value = e.target.value;
                          setSwingSpeakers((prev) =>
                            prev.map((item, i) => (i === idx ? value : item)),
                          );
                        }}
                      />
                    </div>
                  ))}
                </div>
                <div className="simpletab-actions">
                  <button
                    type="submit"
                    className="theia-button"
                    data-action={createSwingAction.id}
                  >
                    {t("draw.swingCreateButton")}
                  </button>
                </div>
              </form>
            )}

            {swingTeams.length > 0 ? (
              <div className="simpletab-swing-list">
                <h3 className="simpletab-subtitle">
                  {t("draw.swingListTitle")}
                </h3>
                <ul className="simpletab-lock-list">
                  {swingTeams.map((team) => {
                    const included = Boolean(
                      team.swingRoundIds?.includes(selectedRound.id),
                    );
                    return (
                      <li key={team.id} className="simpletab-lock-item">
                        <span>
                          {team.name} —{" "}
                          {included
                            ? t("draw.swingEnabledInRound", {
                                round: selectedRound.name,
                              })
                            : t("draw.swingDisabledInRound", {
                                round: selectedRound.name,
                              })}
                        </span>
                        {selectedRound.stage === "preliminary" ? (
                          <button
                            type="button"
                            className="theia-button secondary"
                            data-action={toggleSwingRoundAction.id}
                            onClick={() => {
                              void handleToggleSwingRound(team, !included);
                            }}
                          >
                            {included
                              ? t("draw.swingExcludeButton")
                              : t("draw.swingIncludeButton")}
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
};
