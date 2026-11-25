import type { PublicChainItem } from "@simpletab/core/changelog";
import {
  emptyPreformedPanel,
  validatePreformedPanels,
} from "@simpletab/core/features/tournament/application/preformedPanels";
import {
  buildPastAdjTeams,
  calculateAdjDebateConflict,
} from "@simpletab/core/lib/draw/allocator";
import { earlierDebates } from "@simpletab/core/lib/draw/validateDraw";
import { isAvailableForRound } from "@simpletab/core/lib/roundAvailability";
import type { AdjudicatorPanelRole } from "@simpletab/core/ops/allocation";
import type {
  Adjudicator,
  Debate,
  PreformedPanel,
  Team,
} from "@simpletab/core/types";
import type {
  HostStatus,
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import type { ActionRunner, SimpleTabAction } from "../actions/action";
import {
  assignManualAction,
  autoAllocateAction,
  autofillPreformedAction,
  restoreAllocationAction,
  savePreformedAction,
  swapRoomsAction,
} from "../actions/allocation-actions";
import { openSetupAction } from "../actions/releases-actions";
import { t } from "../i18n";
import { InlineOpError, type InlineOpErrorData } from "./inline-op-error";
import { LockBanner } from "./lock-banner";
import { getDefaultRoundId, RoundPicker } from "./round-picker";

export type AllocationTabId = "panels" | "preformed";

const TAB_ORDER: readonly AllocationTabId[] = ["panels", "preformed"];

export interface AllocationViewProps {
  state: ProjectedState | null;
  status: HostStatus;
  selectedRoundId?: string;
  onSelectRound?: (roundId: string) => void;
  /** Runs the same commands as the palette; no op building happens here. */
  run: ActionRunner;
  onGetChangelog?: () => Promise<PublicChainItem[]>;
  lastAutoSeq?: number;
}

interface RoomErrorEntry {
  error: InlineOpErrorData;
  retry: (runner: ActionRunner) => Promise<SubmitResult>;
}

interface MovingAdjudicator {
  adjudicatorId: string;
  adjudicatorName: string;
  fromDebateId: string;
}

interface ManualPanelDraft {
  chairId: string;
  panellistIds: string[];
  traineeIds: string[];
}

function roomTitle(debate: Debate): string {
  return debate.venueName || t("draw.roomFallback", { rank: debate.roomRank });
}

function summarizePanel(debate: Debate): string {
  const chair = debate.adjudicators.chairName ?? t("allocation.noChair");
  const panellists =
    debate.adjudicators.panellistNames.length > 0
      ? debate.adjudicators.panellistNames.join(", ")
      : t("allocation.noPanellists");
  const trainees =
    debate.adjudicators.traineeNames.length > 0
      ? debate.adjudicators.traineeNames.join(", ")
      : t("allocation.noTrainees");
  return t("allocation.currentPanelSummary", {
    room: roomTitle(debate),
    summary: `Chair: ${chair}; Panellists: ${panellists}; Trainees: ${trainees}`,
  });
}

export const AllocationView: React.FC<AllocationViewProps> = ({
  state,
  status,
  selectedRoundId: controlledRoundId,
  onSelectRound,
  run,
  onGetChangelog,
  lastAutoSeq,
}) => {
  const baseId = React.useId();
  const [activeTab, setActiveTab] = React.useState<AllocationTabId>("panels");
  const [uncontrolledRoundId, setUncontrolledRoundId] = React.useState("");
  const [panelSizeInput, setPanelSizeInput] = React.useState("3");
  const [allocating, setAllocating] = React.useState(false);
  const [bannerSuccess, setBannerSuccess] = React.useState<string | null>(null);
  const [bannerError, setBannerError] = React.useState<InlineOpErrorData | null>(
    null,
  );
  const [allocWarnings, setAllocWarnings] = React.useState<string[]>([]);
  const [swapSourceDebateId, setSwapSourceDebateId] = React.useState<
    string | null
  >(null);
  const [movingAdj, setMovingAdj] = React.useState<MovingAdjudicator | null>(
    null,
  );
  const [editingDebateId, setEditingDebateId] = React.useState<string | null>(
    null,
  );
  const [manualDraft, setManualDraft] = React.useState<ManualPanelDraft>({
    chairId: "",
    panellistIds: [],
    traineeIds: [],
  });
  const [roomErrors, setRoomErrors] = React.useState<
    Record<string, RoomErrorEntry>
  >({});
  const [localAutoSeqByRound, setLocalAutoSeqByRound] = React.useState<
    Record<string, number>
  >({});

  // Unallocated pool assignment controls
  const [poolTargets, setPoolTargets] = React.useState<
    Record<string, { debateId: string; role: AdjudicatorPanelRole }>
  >({});

  // Preformed panels tab draft
  const [preformedDraft, setPreformedDraft] = React.useState<PreformedPanel[]>(
    [],
  );
  const [preformedMessage, setPreformedMessage] = React.useState<string | null>(
    null,
  );
  const [preformedError, setPreformedError] =
    React.useState<InlineOpErrorData | null>(null);

  const tabRefs = React.useRef<
    Partial<Record<AllocationTabId, HTMLButtonElement | null>>
  >({});

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
    setPreformedDraft(
      (selectedRound?.preformedPanels ?? []).map((panel) => ({
        ...panel,
        panellistIds: [...panel.panellistIds],
        traineeIds: [...panel.traineeIds],
      })),
    );
    setPreformedError(null);
    setPreformedMessage(null);
    setSwapSourceDebateId(null);
    setMovingAdj(null);
    setEditingDebateId(null);
    setRoomErrors({});
  }, [selectedRound?.id, state?.seq]);

  const skipAdjCheckins =
    state?.tournament.preferences.skipAdjCheckins === true;
  const expiryHours = state?.tournament.preferences.checkInExpiresAfterHours;

  const adjById = React.useMemo(
    () => new Map((state?.adjudicators ?? []).map((adj) => [adj.id, adj])),
    [state?.adjudicators],
  );
  const teamById = React.useMemo(
    () => new Map((state?.teams ?? []).map((team) => [team.id, team])),
    [state?.teams],
  );

  const roundDebates = React.useMemo(() => {
    if (state === null || selectedRound === undefined) {
      return [];
    }
    return state.debates
      .filter((debate) => debate.roundId === selectedRound.id && !debate.byeTeamId)
      .sort(
        (left, right) =>
          left.roomRank - right.roomRank || left.id.localeCompare(right.id),
      );
  }, [state, selectedRound]);

  const pastAdjTeams = React.useMemo(() => {
    if (state === null || selectedRound === undefined) {
      return new Map<string, Set<string>>();
    }
    const past = earlierDebates({
      round: selectedRound,
      debates: state.debates,
      rounds: state.rounds,
      ballots: state.ballots,
    });
    return buildPastAdjTeams(past);
  }, [state, selectedRound]);

  const adjUsageCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const debate of roundDebates) {
      const ids = [
        ...(debate.adjudicators.chairId ? [debate.adjudicators.chairId] : []),
        ...debate.adjudicators.panellistIds,
        ...debate.adjudicators.traineeIds,
      ];
      for (const id of ids) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return counts;
  }, [roundDebates]);

  const unallocatedAdjudicators = React.useMemo(() => {
    if (state === null || selectedRound === undefined) {
      return [];
    }
    return state.adjudicators.filter((adj) => {
      if ((adjUsageCounts.get(adj.id) ?? 0) > 0) {
        return false;
      }
      if (skipAdjCheckins) {
        return true;
      }
      return isAvailableForRound(adj, selectedRound, expiryHours);
    });
  }, [
    state,
    adjUsageCounts,
    skipAdjCheckins,
    selectedRound,
    expiryHours,
  ]);

  if (state === null) {
    return (
      <div className="simpletab-page">
        <div className="simpletab-header">
          <h1 className="simpletab-title">{t("allocation.title")}</h1>
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

  const handleSelectRound = (roundId: string): void => {
    setBannerError(null);
    setBannerSuccess(null);
    setAllocWarnings([]);
    if (controlledRoundId === undefined) {
      setUncontrolledRoundId(roundId);
    }
    onSelectRound?.(roundId);
  };

  const selectTab = (tab: AllocationTabId): void => {
    setActiveTab(tab);
  };

  const handleTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    tab: AllocationTabId,
  ): void => {
    const idx = TAB_ORDER.indexOf(tab);
    let nextIdx = idx;
    if (event.key === "ArrowRight") {
      nextIdx = (idx + 1) % TAB_ORDER.length;
    } else if (event.key === "ArrowLeft") {
      nextIdx = (idx - 1 + TAB_ORDER.length) % TAB_ORDER.length;
    } else if (event.key === "Home") {
      nextIdx = 0;
    } else if (event.key === "End") {
      nextIdx = TAB_ORDER.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const nextTab = TAB_ORDER[nextIdx];
    selectTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  const submitRoomOpResult = async <A,>(
    runner: ActionRunner,
    action: SimpleTabAction<A, SubmitResult>,
    args: A,
    affectedDebateIds: string[],
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
      const primaryId = affectedDebateIds[0];
      if (primaryId !== undefined) {
        const debate = state.debates.find((d) => d.id === primaryId);
        setRoomErrors((prev) => ({
          ...prev,
          [primaryId]: {
            error: {
              code: result.code,
              errors: result.errors,
              current: result.current,
              currentSummary: debate ? summarizePanel(debate) : undefined,
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
    return result;
  };

  const submitRoomOp = async <A,>(
    runner: ActionRunner,
    action: SimpleTabAction<A, SubmitResult>,
    args: A,
    affectedDebateIds: string[],
  ): Promise<boolean> =>
    (await submitRoomOpResult(runner, action, args, affectedDebateIds)).ok;

  const handleAutoAllocate = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (selectedRound === undefined) {
      return;
    }
    setBannerError(null);
    setBannerSuccess(null);
    setAllocWarnings([]);

    const panelSize = Number(panelSizeInput.trim());
    if (!Number.isInteger(panelSize) || panelSize < 1) {
      setBannerError({
        code: "INVALID",
        errors: [t("allocation.panelSizeInvalid")],
      });
      return;
    }

    setAllocating(true);
    try {
      const result = await run(autoAllocateAction, {
        roundId: selectedRound.id,
        panelSize,
      });
      if (!result.ok) {
        setBannerError({
          code: result.code,
          errors: result.errors,
          current: result.current,
        });
        return;
      }
      setLocalAutoSeqByRound((prev) => ({
        ...prev,
        [selectedRound.id]: result.seq,
      }));
      const committed = result.committedPayload as
        | { warnings?: string[] }
        | undefined;
      if (Array.isArray(committed?.warnings)) {
        setAllocWarnings(committed.warnings);
      }
      setBannerSuccess(
        t("allocation.autoAllocatedSuccess", { round: selectedRound.name }),
      );
    } finally {
      setAllocating(false);
    }
  };

  const handleRestoreAllocation = async (): Promise<void> => {
    if (selectedRound === undefined) {
      return;
    }
    setBannerError(null);
    setBannerSuccess(null);

    let seq: number | undefined =
      lastAutoSeq ?? localAutoSeqByRound[selectedRound.id];
    if (seq === undefined && onGetChangelog !== undefined) {
      const items = await onGetChangelog();
      const latestAuto = [...items]
        .reverse()
        .find((item) => item.entry.opType === "allocation.auto");
      seq = latestAuto?.entry.seq;
    }
    if (seq === undefined) {
      setBannerError({
        code: "CANNOT_UNDO",
        errors: [t("allocation.restoreUnavailable")],
      });
      return;
    }

    const result = await run(restoreAllocationAction, { seq });
    if (!result.ok) {
      setBannerError({
        code: result.code,
        errors: result.errors,
        current: result.current,
        blockingSeqs: result.blockingSeqs,
      });
      return;
    }
    setBannerSuccess(t("allocation.restoredSuccess"));
  };

  const handleSwapPanels = async (
    debateIdA: string,
    debateIdB: string,
  ): Promise<void> => {
    const ok = await submitRoomOp(
      run,
      swapRoomsAction,
      { debateIdA, debateIdB },
      [debateIdA, debateIdB],
    );
    if (ok) {
      setSwapSourceDebateId(null);
    }
  };

  const handleMoveAdjToRoom = async (
    move: MovingAdjudicator,
    toDebateId: string,
    toRole: AdjudicatorPanelRole,
  ): Promise<void> => {
    const ok = await submitRoomOp(
      run,
      swapRoomsAction,
      {
        debateIdA: move.fromDebateId,
        debateIdB: toDebateId,
        moves: [
          {
            adjudicatorId: move.adjudicatorId,
            fromDebateId: move.fromDebateId,
            toDebateId,
            toRole,
          },
        ],
      },
      [move.fromDebateId, toDebateId],
    );
    if (ok) {
      setMovingAdj(null);
    }
  };

  const openManualEditor = (debate: Debate): void => {
    setEditingDebateId(debate.id);
    setManualDraft({
      chairId: debate.adjudicators.chairId ?? "",
      panellistIds: [...debate.adjudicators.panellistIds],
      traineeIds: [...debate.adjudicators.traineeIds],
    });
  };

  const handleSaveManual = async (debateId: string): Promise<void> => {
    const ok = await submitRoomOp(
      run,
      assignManualAction,
      {
        debateId,
        ...(manualDraft.chairId ? { chairId: manualDraft.chairId } : {}),
        panellistIds: manualDraft.panellistIds,
        traineeIds: manualDraft.traineeIds,
      },
      [debateId],
    );
    if (ok) {
      setEditingDebateId(null);
    }
  };

  const handleAssignFromPool = async (adjId: string): Promise<void> => {
    const target = poolTargets[adjId] ?? {
      debateId: roundDebates[0]?.id ?? "",
      role: "panellist" as AdjudicatorPanelRole,
    };
    const debate = roundDebates.find((d) => d.id === target.debateId);
    if (debate === undefined) {
      return;
    }
    const current = debate.adjudicators;
    let chairId = current.chairId;
    const panellistIds = current.panellistIds.filter((id) => id !== adjId);
    const traineeIds = current.traineeIds.filter((id) => id !== adjId);

    if (target.role === "chair") {
      if (chairId && chairId !== adjId) {
        panellistIds.push(chairId);
      }
      chairId = adjId;
    } else if (target.role === "panellist") {
      panellistIds.push(adjId);
    } else {
      traineeIds.push(adjId);
    }

    await submitRoomOp(
      run,
      assignManualAction,
      {
        debateId: debate.id,
        ...(chairId ? { chairId } : {}),
        panellistIds,
        traineeIds,
      },
      [debate.id],
    );
  };

  const handleSavePreformed = async (): Promise<void> => {
    if (selectedRound === undefined) {
      return;
    }
    setPreformedError(null);
    setPreformedMessage(null);
    const result = await run(savePreformedAction, {
      roundId: selectedRound.id,
      panels: preformedDraft,
    });
    if (!result.ok) {
      setPreformedError({
        code: result.code,
        errors: result.errors,
        current: result.current,
      });
      return;
    }
    setPreformedMessage(
      t("allocation.preformedSaved", { round: selectedRound.name }),
    );
  };

  const handleAutofillPreformed = async (): Promise<void> => {
    if (selectedRound === undefined) {
      return;
    }
    setPreformedError(null);
    setPreformedMessage(null);
    const result = await run(autofillPreformedAction, {
      roundId: selectedRound.id,
      panels: preformedDraft,
    });
    if (!result.ok) {
      setPreformedError({
        code: result.code,
        errors: result.errors,
        current: result.current,
      });
      return;
    }
    const committed = result.committedPayload as
      | { warnings?: string[] }
      | undefined;
    if (Array.isArray(committed?.warnings)) {
      setAllocWarnings(committed.warnings);
    }
    setPreformedMessage(
      t("allocation.preformedAutofilled", { round: selectedRound.name }),
    );
  };

  const renderAdjudicatorBadges = (
    adjId: string,
    adjName: string,
    debate: Debate,
    debateTeams: Team[],
    otherPanelAdjs: Adjudicator[],
  ): React.ReactNode => {
    const adj = adjById.get(adjId);
    const conflict =
      adj !== undefined
        ? calculateAdjDebateConflict(
            adj,
            debateTeams,
            pastAdjTeams,
            undefined,
            otherPanelAdjs,
          )
        : null;
    const isHardConflict =
      conflict !== null &&
      (conflict.hasInstitutionalClash ||
        conflict.hasPersonalClash ||
        conflict.hasAdjudicatorClash);
    const isHistoryOnly =
      conflict !== null && !isHardConflict && conflict.hasHistoryClash;
    const isDuplicate = (adjUsageCounts.get(adjId) ?? 0) > 1;
    const isUnavailable =
      adj !== undefined &&
      !skipAdjCheckins &&
      selectedRound !== undefined &&
      !isAvailableForRound(adj, selectedRound, expiryHours);

    return (
      <div className="simpletab-adj-chip">
        <div className="simpletab-adj-main">
          <strong>{adj?.name ?? adjName}</strong>
          {adj !== undefined ? (
            <span className="simpletab-hint">
              {" "}
              ({t("allocation.baseScoreLabel", { score: adj.baseScore })}
              {adj.institutionName ? ` · ${adj.institutionName}` : ""})
            </span>
          ) : null}
          {roundDebates.length > 1 ? (
            <button
              type="button"
              className="theia-button secondary simpletab-compact-btn"
              data-view-only
              onClick={() => {
                if (
                  movingAdj?.adjudicatorId === adjId &&
                  movingAdj.fromDebateId === debate.id
                ) {
                  setMovingAdj(null);
                } else {
                  setMovingAdj({
                    adjudicatorId: adjId,
                    adjudicatorName: adj?.name ?? adjName,
                    fromDebateId: debate.id,
                  });
                }
              }}
            >
              {t("allocation.moveAdjButton")}
            </button>
          ) : null}
        </div>

        {isHardConflict && conflict !== null ? (
          <div className="simpletab-conflict-warning" role="status">
            <span className="simpletab-badge simpletab-badge-error">
              {t("allocation.conflictLabel")}
            </span>
            <span>{conflict.reasons.join("; ")}</span>
          </div>
        ) : null}

        {isHistoryOnly && conflict !== null ? (
          <div className="simpletab-history-warning" role="status">
            <span className="simpletab-badge simpletab-badge-conflict">
              {t("allocation.historyLabel")}
            </span>
            <span>{conflict.reasons.join("; ")}</span>
          </div>
        ) : null}

        {isDuplicate ? (
          <div className="simpletab-conflict-warning" role="status">
            <span className="simpletab-badge simpletab-badge-error">
              {t("allocation.duplicateLabel")}
            </span>
          </div>
        ) : null}

        {isUnavailable ? (
          <div className="simpletab-conflict-warning" role="status">
            <span className="simpletab-badge simpletab-badge-error">
              {t("allocation.unavailableLabel")}
            </span>
          </div>
        ) : null}
      </div>
    );
  };

  const preformedValidationErrors = validatePreformedPanels(
    preformedDraft,
    state.adjudicators,
  );
  const swapSourceDebate =
    swapSourceDebateId !== null
      ? roundDebates.find((d) => d.id === swapSourceDebateId)
      : undefined;
  const moveSourceDebate =
    movingAdj !== null
      ? roundDebates.find((d) => d.id === movingAdj.fromDebateId)
      : undefined;

  return (
    <div className="simpletab-page">
      <div className="simpletab-header">
        <h1 className="simpletab-title">{t("allocation.title")}</h1>
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

      {selectedRound === undefined ? (
        <div className="simpletab-alert" role="status">
          {t("allocation.noRounds")}
        </div>
      ) : (
        <>
          <div
            className="simpletab-tabs"
            role="tablist"
            aria-label={t("allocation.title")}
          >
            {TAB_ORDER.map((tab) => {
              const selected = activeTab === tab;
              const label =
                tab === "panels"
                  ? t("allocation.tabPanels", { count: roundDebates.length })
                  : t("allocation.tabPreformed", {
                      count: selectedRound.preformedPanels?.length ?? 0,
                    });
              return (
                <button
                  key={tab}
                  ref={(el) => {
                    tabRefs.current[tab] = el;
                  }}
                  id={`${baseId}-tab-${tab}`}
                  type="button"
                  data-view-only
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`${baseId}-panel-${tab}`}
                  tabIndex={selected ? 0 : -1}
                  className="simpletab-tab"
                  onClick={() => selectTab(tab)}
                  onKeyDown={(e) => handleTabKeyDown(e, tab)}
                >
                  {label}
                </button>
              );
            })}
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

          {allocWarnings.length > 0 ? (
            <div
              className="simpletab-alert simpletab-alert-warning"
              role="status"
            >
              <strong>{t("allocation.warningsTitle")}</strong>
              <ul className="simpletab-issue-list">
                {allocWarnings.map((warning, idx) => (
                  <li key={idx}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {activeTab === "panels" ? (
            <div
              id={`${baseId}-panel-panels`}
              role="tabpanel"
              aria-labelledby={`${baseId}-tab-panels`}
            >
              <section className="simpletab-section">
                <form
                  className="simpletab-toolbar"
                  onSubmit={(e) => {
                    void handleAutoAllocate(e);
                  }}
                >
                  <div className="simpletab-input-row">
                    <div className="simpletab-field">
                      <label htmlFor={`${baseId}-panel-size`}>
                        {t("allocation.panelSizeLabel")}
                      </label>
                      <input
                        id={`${baseId}-panel-size`}
                        type="number"
                        min={1}
                        step={1}
                        value={panelSizeInput}
                        onChange={(e) => setPanelSizeInput(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="simpletab-actions">
                    <button
                      type="submit"
                      className="theia-button"
                      data-action={autoAllocateAction.id}
                      disabled={allocating}
                    >
                      {allocating
                        ? t("allocation.autoAllocating")
                        : t("allocation.autoAllocateButton")}
                    </button>
                    <button
                      type="button"
                      className="theia-button secondary"
                      data-action={restoreAllocationAction.id}
                      onClick={() => {
                        void handleRestoreAllocation();
                      }}
                    >
                      {t("allocation.restoreButton")}
                    </button>
                  </div>
                </form>
              </section>

              {swapSourceDebate !== undefined ? (
                <div
                  className="simpletab-alert simpletab-alert-warning"
                  role="status"
                >
                  <div className="simpletab-toolbar">
                    <span>
                      {t("allocation.swapModeBanner", {
                        room: roomTitle(swapSourceDebate),
                      })}
                    </span>
                    <button
                      type="button"
                      className="theia-button secondary"
                      data-view-only
                      onClick={() => setSwapSourceDebateId(null)}
                    >
                      {t("allocation.cancelSwap")}
                    </button>
                  </div>
                </div>
              ) : null}

              {movingAdj !== null && moveSourceDebate !== undefined ? (
                <div
                  className="simpletab-alert simpletab-alert-warning"
                  role="status"
                >
                  <div className="simpletab-toolbar">
                    <span>
                      {t("allocation.moveAdjBanner", {
                        adjudicator: movingAdj.adjudicatorName,
                        room: roomTitle(moveSourceDebate),
                      })}
                    </span>
                    <button
                      type="button"
                      className="theia-button secondary"
                      data-view-only
                      onClick={() => setMovingAdj(null)}
                    >
                      {t("allocation.cancelMove")}
                    </button>
                  </div>
                </div>
              ) : null}

              {roundDebates.length === 0 ? (
                <p className="simpletab-empty">
                  {t("allocation.emptyDebates", { round: selectedRound.name })}
                </p>
              ) : (
                <div className="simpletab-panel-list">
                  {roundDebates.map((debate) => {
                    const roomName = roomTitle(debate);
                    const debateTeams = Object.values(debate.teams)
                      .map((slot) =>
                        slot?.teamId ? teamById.get(slot.teamId) : undefined,
                      )
                      .filter((tm): tm is Team => tm !== undefined);
                    const panelAdjIds = [
                      ...(debate.adjudicators.chairId
                        ? [debate.adjudicators.chairId]
                        : []),
                      ...debate.adjudicators.panellistIds,
                      ...debate.adjudicators.traineeIds,
                    ];
                    const panelAdjs = panelAdjIds
                      .map((id) => adjById.get(id))
                      .filter((adj): adj is Adjudicator => adj !== undefined);
                    const othersFor = (selfId: string): Adjudicator[] =>
                      panelAdjs.filter((adj) => adj.id !== selfId);

                    const isEditing = editingDebateId === debate.id;
                    const roomError = roomErrors[debate.id];

                    return (
                      <section key={debate.id} className="simpletab-section">
                        <div className="simpletab-toolbar">
                          <div>
                            <h2 className="simpletab-subtitle">{roomName}</h2>
                            <div className="simpletab-hint">
                              {t("draw.bracketLabel", {
                                bracket: debate.bracket,
                              })}{" "}
                              ·{" "}
                              {debateTeams.map((tm) => tm.name).join(" vs ")}
                            </div>
                          </div>

                          <div className="simpletab-actions">
                            {swapSourceDebate === undefined ? (
                              roundDebates.length > 1 ? (
                                <button
                                  type="button"
                                  className="theia-button secondary"
                                  data-view-only
                                  onClick={() =>
                                    setSwapSourceDebateId(debate.id)
                                  }
                                >
                                  {t("allocation.swapRoomButton")}
                                </button>
                              ) : null
                            ) : swapSourceDebate.id === debate.id ? (
                              <button
                                type="button"
                                className="theia-button secondary"
                                data-view-only
                                onClick={() => setSwapSourceDebateId(null)}
                              >
                                {t("allocation.cancelSwap")}
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="theia-button"
                                data-action={swapRoomsAction.id}
                                onClick={() => {
                                  void handleSwapPanels(
                                    swapSourceDebate.id,
                                    debate.id,
                                  );
                                }}
                              >
                                {t("allocation.swapWithButton", {
                                  room: roomTitle(swapSourceDebate),
                                })}
                              </button>
                            )}

                            <button
                              type="button"
                              className="theia-button secondary"
                              data-view-only
                              onClick={() =>
                                isEditing
                                  ? setEditingDebateId(null)
                                  : openManualEditor(debate)
                              }
                            >
                              {isEditing
                                ? t("allocation.closeEditButton")
                                : t("allocation.editManualButton")}
                            </button>
                          </div>
                        </div>

                        {movingAdj !== null &&
                        movingAdj.fromDebateId !== debate.id ? (
                          <div className="simpletab-actions">
                            <button
                              type="button"
                              className="theia-button secondary"
                              data-action={swapRoomsAction.id}
                              onClick={() => {
                                void handleMoveAdjToRoom(
                                  movingAdj,
                                  debate.id,
                                  "chair",
                                );
                              }}
                            >
                              {t("allocation.moveHereChair", {
                                room: roomName,
                              })}
                            </button>
                            <button
                              type="button"
                              className="theia-button secondary"
                              data-action={swapRoomsAction.id}
                              onClick={() => {
                                void handleMoveAdjToRoom(
                                  movingAdj,
                                  debate.id,
                                  "panellist",
                                );
                              }}
                            >
                              {t("allocation.moveHerePanellist", {
                                room: roomName,
                              })}
                            </button>
                            <button
                              type="button"
                              className="theia-button secondary"
                              data-action={swapRoomsAction.id}
                              onClick={() => {
                                void handleMoveAdjToRoom(
                                  movingAdj,
                                  debate.id,
                                  "trainee",
                                );
                              }}
                            >
                              {t("allocation.moveHereTrainee", {
                                room: roomName,
                              })}
                            </button>
                          </div>
                        ) : null}

                        <div className="simpletab-panel-roles">
                          <div>
                            <strong>{t("allocation.chairLabel")}:</strong>{" "}
                            {debate.adjudicators.chairId ? (
                              renderAdjudicatorBadges(
                                debate.adjudicators.chairId,
                                debate.adjudicators.chairName ??
                                  debate.adjudicators.chairId,
                                debate,
                                debateTeams,
                                othersFor(debate.adjudicators.chairId),
                              )
                            ) : (
                              <span className="simpletab-hint">
                                {t("allocation.noChair")}
                              </span>
                            )}
                          </div>

                          <div>
                            <strong>{t("allocation.panellistsLabel")}:</strong>{" "}
                            {debate.adjudicators.panellistIds.length === 0 ? (
                              <span className="simpletab-hint">
                                {t("allocation.noPanellists")}
                              </span>
                            ) : (
                              debate.adjudicators.panellistIds.map(
                                (id, idx) => (
                                  <React.Fragment key={id}>
                                    {renderAdjudicatorBadges(
                                      id,
                                      debate.adjudicators.panellistNames[idx] ??
                                        id,
                                      debate,
                                      debateTeams,
                                      othersFor(id),
                                    )}
                                  </React.Fragment>
                                ),
                              )
                            )}
                          </div>

                          <div>
                            <strong>{t("allocation.traineesLabel")}:</strong>{" "}
                            {debate.adjudicators.traineeIds.length === 0 ? (
                              <span className="simpletab-hint">
                                {t("allocation.noTrainees")}
                              </span>
                            ) : (
                              debate.adjudicators.traineeIds.map((id, idx) => (
                                <React.Fragment key={id}>
                                  {renderAdjudicatorBadges(
                                    id,
                                    debate.adjudicators.traineeNames[idx] ?? id,
                                    debate,
                                    debateTeams,
                                    othersFor(id),
                                  )}
                                </React.Fragment>
                              ))
                            )}
                          </div>
                        </div>

                        {isEditing ? (
                          <div className="simpletab-manual-editor">
                            <div className="simpletab-field">
                              <label htmlFor={`${baseId}-chair-${debate.id}`}>
                                {t("allocation.selectChairLabel", {
                                  room: roomName,
                                })}
                              </label>
                              <select
                                id={`${baseId}-chair-${debate.id}`}
                                value={manualDraft.chairId}
                                onChange={(e) => {
                                  const nextChair = e.target.value;
                                  setManualDraft((prev) => ({
                                    ...prev,
                                    chairId: nextChair,
                                    panellistIds: prev.panellistIds.filter(
                                      (id) => id !== nextChair,
                                    ),
                                    traineeIds: prev.traineeIds.filter(
                                      (id) => id !== nextChair,
                                    ),
                                  }));
                                }}
                              >
                                <option value="">
                                  {t("allocation.noChair")}
                                </option>
                                {state.adjudicators
                                  .filter((adj) => !adj.trainee)
                                  .map((adj) => (
                                    <option key={adj.id} value={adj.id}>
                                      {`${adj.name} (${adj.baseScore})`}
                                    </option>
                                  ))}
                              </select>
                            </div>

                            <div className="simpletab-field">
                              <label htmlFor={`${baseId}-add-pan-${debate.id}`}>
                                {t("allocation.addPanellistLabel", {
                                  room: roomName,
                                })}
                              </label>
                              <select
                                id={`${baseId}-add-pan-${debate.id}`}
                                value=""
                                onChange={(e) => {
                                  const adjId = e.target.value;
                                  if (!adjId) {
                                    return;
                                  }
                                  setManualDraft((prev) => ({
                                    ...prev,
                                    chairId:
                                      prev.chairId === adjId ? "" : prev.chairId,
                                    panellistIds: prev.panellistIds.includes(
                                      adjId,
                                    )
                                      ? prev.panellistIds
                                      : [...prev.panellistIds, adjId],
                                    traineeIds: prev.traineeIds.filter(
                                      (id) => id !== adjId,
                                    ),
                                  }));
                                }}
                              >
                                <option value="">
                                  {t("allocation.selectAdjudicatorPlaceholder")}
                                </option>
                                {state.adjudicators
                                  .filter(
                                    (adj) =>
                                      !adj.trainee &&
                                      adj.id !== manualDraft.chairId &&
                                      !manualDraft.panellistIds.includes(
                                        adj.id,
                                      ),
                                  )
                                  .map((adj) => (
                                    <option key={adj.id} value={adj.id}>
                                      {`${adj.name} (${adj.baseScore})`}
                                    </option>
                                  ))}
                              </select>
                              <div className="simpletab-actions">
                                {manualDraft.panellistIds.map((id) => {
                                  const name = adjById.get(id)?.name ?? id;
                                  return (
                                    <button
                                      key={id}
                                      type="button"
                                      className="theia-button secondary"
                                      data-view-only
                                      aria-label={t(
                                        "allocation.removeMemberAria",
                                        { name, room: roomName },
                                      )}
                                      onClick={() =>
                                        setManualDraft((prev) => ({
                                          ...prev,
                                          panellistIds:
                                            prev.panellistIds.filter(
                                              (x) => x !== id,
                                            ),
                                        }))
                                      }
                                    >
                                      {`${name} ×`}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>

                            <div className="simpletab-field">
                              <label htmlFor={`${baseId}-add-tr-${debate.id}`}>
                                {t("allocation.addTraineeLabel", {
                                  room: roomName,
                                })}
                              </label>
                              <select
                                id={`${baseId}-add-tr-${debate.id}`}
                                value=""
                                onChange={(e) => {
                                  const adjId = e.target.value;
                                  if (!adjId) {
                                    return;
                                  }
                                  setManualDraft((prev) => ({
                                    ...prev,
                                    chairId:
                                      prev.chairId === adjId ? "" : prev.chairId,
                                    panellistIds: prev.panellistIds.filter(
                                      (id) => id !== adjId,
                                    ),
                                    traineeIds: prev.traineeIds.includes(adjId)
                                      ? prev.traineeIds
                                      : [...prev.traineeIds, adjId],
                                  }));
                                }}
                              >
                                <option value="">
                                  {t("allocation.selectAdjudicatorPlaceholder")}
                                </option>
                                {state.adjudicators
                                  .filter(
                                    (adj) =>
                                      adj.id !== manualDraft.chairId &&
                                      !manualDraft.traineeIds.includes(adj.id),
                                  )
                                  .map((adj) => (
                                    <option key={adj.id} value={adj.id}>
                                      {`${adj.name} (${adj.baseScore})`}
                                    </option>
                                  ))}
                              </select>
                              <div className="simpletab-actions">
                                {manualDraft.traineeIds.map((id) => {
                                  const name = adjById.get(id)?.name ?? id;
                                  return (
                                    <button
                                      key={id}
                                      type="button"
                                      className="theia-button secondary"
                                      data-view-only
                                      aria-label={t(
                                        "allocation.removeMemberAria",
                                        { name, room: roomName },
                                      )}
                                      onClick={() =>
                                        setManualDraft((prev) => ({
                                          ...prev,
                                          traineeIds: prev.traineeIds.filter(
                                            (x) => x !== id,
                                          ),
                                        }))
                                      }
                                    >
                                      {`${name} ×`}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>

                            <div className="simpletab-actions">
                              <button
                                type="button"
                                className="theia-button"
                                data-action={assignManualAction.id}
                                onClick={() => {
                                  void handleSaveManual(debate.id);
                                }}
                              >
                                {t("allocation.saveManualButton")}
                              </button>
                            </div>
                          </div>
                        ) : null}

                        {roomError !== undefined ? (
                          <InlineOpError
                            error={{
                              ...roomError.error,
                              currentSummary: summarizePanel(debate),
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
                        ) : null}
                      </section>
                    );
                  })}
                </div>
              )}

              <section className="simpletab-section">
                <h2 className="simpletab-subtitle">
                  {t("allocation.poolTitle", {
                    count: unallocatedAdjudicators.length,
                  })}
                </h2>
                {unallocatedAdjudicators.length === 0 ? (
                  <p className="simpletab-hint">{t("allocation.poolEmpty")}</p>
                ) : (
                  <div className="simpletab-table-wrap">
                    <table className="simpletab-table">
                      <thead>
                        <tr>
                          <th scope="col">{t("checkin.colName")}</th>
                          <th scope="col">{t("checkin.colDetails")}</th>
                          {roundDebates.length > 0 ? (
                            <th scope="col">{t("checkin.colAction")}</th>
                          ) : null}
                        </tr>
                      </thead>
                      <tbody>
                        {unallocatedAdjudicators.map((adj) => {
                          const target = poolTargets[adj.id] ?? {
                            debateId: roundDebates[0]?.id ?? "",
                            role: (adj.trainee
                              ? "trainee"
                              : "panellist") as AdjudicatorPanelRole,
                          };
                          return (
                            <tr key={adj.id}>
                              <td>{adj.name}</td>
                              <td>
                                {t("allocation.baseScoreLabel", {
                                  score: adj.baseScore,
                                })}
                                {adj.trainee
                                  ? ` · ${t("checkin.traineeBadge")}`
                                  : ""}
                                {adj.institutionName
                                  ? ` · ${adj.institutionName}`
                                  : ""}
                              </td>
                              {roundDebates.length > 0 ? (
                                <td>
                                  <div className="simpletab-actions">
                                    <select
                                      aria-label={`${t("allocation.poolAssignRoom")} for ${adj.name}`}
                                      value={target.debateId}
                                      onChange={(e) =>
                                        setPoolTargets((prev) => ({
                                          ...prev,
                                          [adj.id]: {
                                            ...target,
                                            debateId: e.target.value,
                                          },
                                        }))
                                      }
                                    >
                                      {roundDebates.map((d) => (
                                        <option key={d.id} value={d.id}>
                                          {roomTitle(d)}
                                        </option>
                                      ))}
                                    </select>
                                    <select
                                      aria-label={`${t("allocation.poolAssignRole")} for ${adj.name}`}
                                      value={target.role}
                                      onChange={(e) =>
                                        setPoolTargets((prev) => ({
                                          ...prev,
                                          [adj.id]: {
                                            ...target,
                                            role: e.target
                                              .value as AdjudicatorPanelRole,
                                          },
                                        }))
                                      }
                                    >
                                      <option value="chair">
                                        {t("allocation.roleChair")}
                                      </option>
                                      <option value="panellist">
                                        {t("allocation.rolePanellist")}
                                      </option>
                                      <option value="trainee">
                                        {t("allocation.roleTrainee")}
                                      </option>
                                    </select>
                                    <button
                                      type="button"
                                      className="theia-button secondary"
                                      data-action={assignManualAction.id}
                                      onClick={() => {
                                        void handleAssignFromPool(adj.id);
                                      }}
                                    >
                                      {t("allocation.poolAssignButton")}
                                    </button>
                                  </div>
                                </td>
                              ) : null}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          ) : null}

          {activeTab === "preformed" ? (
            <div
              id={`${baseId}-panel-preformed`}
              role="tabpanel"
              aria-labelledby={`${baseId}-tab-preformed`}
            >
              <section className="simpletab-section">
                <p className="simpletab-hint">
                  {t("allocation.preformedIntro", {
                    round: selectedRound.name,
                  })}
                </p>

                {preformedMessage !== null ? (
                  <div
                    className="simpletab-alert simpletab-alert-success"
                    role="status"
                  >
                    {preformedMessage}
                  </div>
                ) : null}
                {preformedError !== null ? (
                  <InlineOpError
                    error={preformedError}
                    onDismiss={() => setPreformedError(null)}
                  />
                ) : null}
                {preformedValidationErrors.length > 0 ? (
                  <div
                    className="simpletab-alert simpletab-alert-error"
                    role="alert"
                  >
                    <ul className="simpletab-issue-list">
                      {preformedValidationErrors.map((err, idx) => (
                        <li key={idx}>{err}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="simpletab-actions">
                  <button
                    type="button"
                    className="theia-button secondary"
                    data-view-only
                    onClick={() =>
                      setPreformedDraft((prev) => [
                        ...prev,
                        emptyPreformedPanel(
                          `panel-${Date.now()}-${prev.length + 1}`,
                          0,
                        ),
                      ])
                    }
                  >
                    {t("allocation.preformedAdd")}
                  </button>
                  <button
                    type="button"
                    className="theia-button"
                    data-action={savePreformedAction.id}
                    onClick={() => {
                      void handleSavePreformed();
                    }}
                  >
                    {t("allocation.preformedSave")}
                  </button>
                  <button
                    type="button"
                    className="theia-button secondary"
                    data-action={autofillPreformedAction.id}
                    onClick={() => {
                      void handleAutofillPreformed();
                    }}
                  >
                    {t("allocation.preformedAutofill")}
                  </button>
                </div>
              </section>

              {preformedDraft.length === 0 ? (
                <p className="simpletab-empty">
                  {t("allocation.preformedEmpty", {
                    round: selectedRound.name,
                  })}
                </p>
              ) : (
                <div className="simpletab-panel-list">
                  {preformedDraft.map((panel, index) => (
                    <section key={panel.id} className="simpletab-section">
                      <div className="simpletab-toolbar">
                        <h2 className="simpletab-subtitle">
                          {t("allocation.preformedPanelTitle", {
                            index: index + 1,
                          })}
                        </h2>
                        <button
                          type="button"
                          className="theia-button secondary"
                          data-view-only
                          onClick={() =>
                            setPreformedDraft((prev) =>
                              prev.filter((p) => p.id !== panel.id),
                            )
                          }
                        >
                          {t("allocation.preformedRemove")}
                        </button>
                      </div>

                      <div className="simpletab-form-grid">
                        <div className="simpletab-field">
                          <label htmlFor={`${baseId}-pf-imp-${panel.id}`}>
                            {t("allocation.preformedImportanceLabel")}
                          </label>
                          <input
                            id={`${baseId}-pf-imp-${panel.id}`}
                            type="number"
                            min={0}
                            max={10}
                            value={panel.importance}
                            onChange={(e) => {
                              const value = Number(e.target.value);
                              setPreformedDraft((prev) =>
                                prev.map((item) =>
                                  item.id === panel.id
                                    ? {
                                        ...item,
                                        importance: Number.isFinite(value)
                                          ? value
                                          : 0,
                                      }
                                    : item,
                                ),
                              );
                            }}
                          />
                        </div>

                        <div className="simpletab-field">
                          <label htmlFor={`${baseId}-pf-chair-${panel.id}`}>
                            {t("allocation.chairLabel")}
                          </label>
                          <select
                            id={`${baseId}-pf-chair-${panel.id}`}
                            value={panel.chairId ?? ""}
                            onChange={(e) => {
                              const chairId = e.target.value || undefined;
                              setPreformedDraft((prev) =>
                                prev.map((item) =>
                                  item.id === panel.id
                                    ? {
                                        ...item,
                                        chairId,
                                        panellistIds: item.panellistIds.filter(
                                          (id) => id !== chairId,
                                        ),
                                        traineeIds: item.traineeIds.filter(
                                          (id) => id !== chairId,
                                        ),
                                      }
                                    : item,
                                ),
                              );
                            }}
                          >
                            <option value="">{t("allocation.noChair")}</option>
                            {state.adjudicators
                              .filter((adj) => !adj.trainee)
                              .map((adj) => (
                                <option key={adj.id} value={adj.id}>
                                  {`${adj.name} (${adj.baseScore})`}
                                </option>
                              ))}
                          </select>
                        </div>

                        <div className="simpletab-field">
                          <label htmlFor={`${baseId}-pf-pan-${panel.id}`}>
                            {t("allocation.panellistsLabel")}
                          </label>
                          <select
                            id={`${baseId}-pf-pan-${panel.id}`}
                            value=""
                            onChange={(e) => {
                              const adjId = e.target.value;
                              if (!adjId) {
                                return;
                              }
                              setPreformedDraft((prev) =>
                                prev.map((item) =>
                                  item.id === panel.id
                                    ? {
                                        ...item,
                                        panellistIds:
                                          item.panellistIds.includes(adjId)
                                            ? item.panellistIds
                                            : [...item.panellistIds, adjId],
                                      }
                                    : item,
                                ),
                              );
                            }}
                          >
                            <option value="">
                              {t("allocation.selectAdjudicatorPlaceholder")}
                            </option>
                            {state.adjudicators
                              .filter(
                                (adj) =>
                                  !adj.trainee &&
                                  adj.id !== panel.chairId &&
                                  !panel.panellistIds.includes(adj.id),
                              )
                              .map((adj) => (
                                <option key={adj.id} value={adj.id}>
                                  {`${adj.name} (${adj.baseScore})`}
                                </option>
                              ))}
                          </select>
                          <div className="simpletab-actions">
                            {panel.panellistIds.map((id) => (
                              <button
                                key={id}
                                type="button"
                                className="theia-button secondary"
                                data-view-only
                                onClick={() =>
                                  setPreformedDraft((prev) =>
                                    prev.map((item) =>
                                      item.id === panel.id
                                        ? {
                                            ...item,
                                            panellistIds:
                                              item.panellistIds.filter(
                                                (x) => x !== id,
                                              ),
                                          }
                                        : item,
                                    ),
                                  )
                                }
                              >
                                {`${adjById.get(id)?.name ?? id} ×`}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="simpletab-field">
                          <label htmlFor={`${baseId}-pf-tr-${panel.id}`}>
                            {t("allocation.traineesLabel")}
                          </label>
                          <select
                            id={`${baseId}-pf-tr-${panel.id}`}
                            value=""
                            onChange={(e) => {
                              const adjId = e.target.value;
                              if (!adjId) {
                                return;
                              }
                              setPreformedDraft((prev) =>
                                prev.map((item) =>
                                  item.id === panel.id
                                    ? {
                                        ...item,
                                        traineeIds: item.traineeIds.includes(
                                          adjId,
                                        )
                                          ? item.traineeIds
                                          : [...item.traineeIds, adjId],
                                      }
                                    : item,
                                ),
                              );
                            }}
                          >
                            <option value="">
                              {t("allocation.selectAdjudicatorPlaceholder")}
                            </option>
                            {state.adjudicators
                              .filter(
                                (adj) =>
                                  adj.id !== panel.chairId &&
                                  !panel.traineeIds.includes(adj.id),
                              )
                              .map((adj) => (
                                <option key={adj.id} value={adj.id}>
                                  {`${adj.name} (${adj.baseScore})`}
                                </option>
                              ))}
                          </select>
                          <div className="simpletab-actions">
                            {panel.traineeIds.map((id) => (
                              <button
                                key={id}
                                type="button"
                                className="theia-button secondary"
                                data-view-only
                                onClick={() =>
                                  setPreformedDraft((prev) =>
                                    prev.map((item) =>
                                      item.id === panel.id
                                        ? {
                                            ...item,
                                            traineeIds: item.traineeIds.filter(
                                              (x) => x !== id,
                                            ),
                                          }
                                        : item,
                                    ),
                                  )
                                }
                              >
                                {`${adjById.get(id)?.name ?? id} ×`}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
};
