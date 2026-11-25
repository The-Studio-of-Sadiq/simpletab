import {
  blankEntry,
  entryFromBallot,
  nextBallotVersion,
  resolveCheckState,
} from "@simpletab/core/features/tournament/application/ballotEntry";
import {
  roundIntakeRows,
  summarizeIntake,
  usesPerAdjudicatorSheets,
  type DebateIntakeStatus,
} from "@simpletab/core/features/tournament/application/ballotIntake";
import {
  debateBallotRules,
  diffBallots,
  rulesSides,
  type BallotDifference,
  type BallotEntry,
  type BallotResult,
} from "@simpletab/core/lib/ballots/result";
import { isTwoTeamFormat } from "@simpletab/core/lib/debateSides";
import { sideLabel } from "@simpletab/core/lib/sideNames";
import {
  recordKey,
  type LateSubmissionRecord,
  type OpBallotSubmission,
  type OpRequest,
  type RecordKey,
} from "@simpletab/core/ops";
import type { Debate, DebateSide, Speaker } from "@simpletab/core/types";
import type {
  HostCancelLongResult,
  HostStatus,
  ProjectedState,
  QrReceiveResult,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import { t } from "../i18n";
import {
  defaultTournamentTimeZone,
  formatDeadlineDateTime,
  formatDeadlineTime,
  isDeadlinePassed,
} from "../lib/deadline";
import { stateHasPermission } from "../lib/permissions";
import { qrFailureMessage, splitQrCodes } from "../lib/qr-messages";
import { BallotForm } from "./ballot-form";
import { InlineOpError, type InlineOpErrorData } from "./inline-op-error";
import { LockBanner } from "./lock-banner";
import { getDefaultRoundId, RoundPicker } from "./round-picker";

export interface ResultsViewProps {
  state: ProjectedState | null;
  status: HostStatus;
  selectedRoundId?: string;
  onSelectRound?: (roundId: string) => void;
  onSubmitOp: (request: OpRequest) => Promise<SubmitResult>;
  /** Sends a pasted or scanned QR ballot to the host, which checks it with its link secrets. */
  onReceiveQrBallot?: (codes: string[]) => Promise<QrReceiveResult>;
  onCancelLock?: (lockId: string) => Promise<HostCancelLongResult | void>;
  onOpenSetup?: () => void;
  currentActorId?: string;
  nowIso?: string;
}

interface ItemErrorEntry {
  error: InlineOpErrorData;
  retryRequest: OpRequest;
}

function withFreshVersions(
  request: OpRequest,
  versions: Record<RecordKey, number>,
): OpRequest {
  if (request.expectedVersions === undefined) {
    return request;
  }
  const next: Record<RecordKey, number> = {};
  for (const key of Object.keys(request.expectedVersions) as RecordKey[]) {
    next[key] = versions[key] ?? 0;
  }
  return {
    ...request,
    expectedVersions: next,
  };
}

function createBallotId(debateId: string, version: number): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return `ballot-${debateId}-v${version}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  }
  return `ballot-${debateId}-v${version}-${Date.now()}`;
}

function statusBadgeText(statusValue: DebateIntakeStatus): string {
  switch (statusValue) {
    case "missing":
      return t("results.statusMissing");
    case "partial":
      return t("results.statusPartial");
    case "received":
      return t("results.statusReceived");
    case "entered":
      return t("results.statusEntered");
    case "awaiting_check":
      return t("results.statusAwaitingCheck");
    case "disputed":
      return t("results.statusDisputed");
    case "confirmed":
      return t("results.statusConfirmed");
  }
}

function statusBadgeClass(statusValue: DebateIntakeStatus): string {
  switch (statusValue) {
    case "confirmed":
      return "simpletab-badge-add";
    case "disputed":
      return "simpletab-badge-error";
    case "awaiting_check":
    case "partial":
      return "simpletab-badge-conflict";
    case "entered":
    case "received":
      return "simpletab-badge-match";
    default:
      return "";
  }
}

function roomTitle(debate: Debate | undefined): string {
  if (debate === undefined) {
    return t("results.unknownRoom");
  }
  return debate.venueName || t("draw.roomFallback", { rank: debate.roomRank });
}

function summarizeBallotScores(
  ballot: OpBallotSubmission,
  state: ProjectedState,
): string {
  const twoTeam = isTwoTeamFormat(state.tournament.format);
  const prefs = state.tournament.preferences;
  return Object.entries(ballot.teamScores ?? {})
    .filter(([, entry]) => Boolean(entry))
    .map(([side, entry]) => {
      const label = sideLabel(
        side as DebateSide,
        prefs,
        twoTeam ? "full" : "abbr",
      );
      if (state.tournament.format === "bp") {
        return `${label}: #${entry.rank ?? "?"} (${entry.totalSpeakerScore})`;
      }
      return `${label}: ${entry.win ? t("results.winShort") : t("results.lossShort")} (${entry.totalSpeakerScore})`;
    })
    .join(" · ");
}

export const ResultsView: React.FC<ResultsViewProps> = ({
  state,
  status,
  selectedRoundId: controlledRoundId,
  onSelectRound,
  onSubmitOp,
  onReceiveQrBallot,
  onCancelLock,
  onOpenSetup,
  currentActorId,
  nowIso,
}) => {
  const baseId = React.useId();
  const [uncontrolledRoundId, setUncontrolledRoundId] = React.useState("");
  const [selectedDebateId, setSelectedDebateId] = React.useState("");
  const [submittingBallot, setSubmittingBallot] = React.useState(false);
  const [formError, setFormError] = React.useState<InlineOpErrorData | null>(
    null,
  );
  const [formSuccess, setFormSuccess] = React.useState<string | null>(null);
  const [blindMismatchByDebate, setBlindMismatchByDebate] = React.useState<
    Record<string, BallotDifference[]>
  >({});
  const [ballotActionErrors, setBallotActionErrors] = React.useState<
    Record<string, ItemErrorEntry>
  >({});
  const [lateErrors, setLateErrors] = React.useState<
    Record<string, ItemErrorEntry>
  >({});
  const [lateSuccess, setLateSuccess] = React.useState<string | null>(null);

  // QR / Text import box
  const [qrInput, setQrInput] = React.useState("");
  const [qrMessage, setQrMessage] = React.useState<string | null>(null);
  const [qrError, setQrError] = React.useState<InlineOpErrorData | null>(null);

  // Paper intake scan box
  const [intakeCode, setIntakeCode] = React.useState("");
  const [intakeMessage, setIntakeMessage] = React.useState<string | null>(null);
  const [intakeError, setIntakeError] = React.useState<InlineOpErrorData | null>(
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

  React.useEffect(() => {
    if (roundDebates.length === 0) {
      setSelectedDebateId("");
      return;
    }
    if (!roundDebates.some((d) => d.id === selectedDebateId)) {
      setSelectedDebateId(roundDebates[0].id);
    }
  }, [roundDebates, selectedDebateId]);

  const selectedDebate = React.useMemo(
    () => roundDebates.find((d) => d.id === selectedDebateId),
    [roundDebates, selectedDebateId],
  );

  if (state === null) {
    return (
      <div className="simpletab-page">
        <div className="simpletab-header">
          <h1 className="simpletab-title">{t("results.title")}</h1>
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
  const prefs = state.tournament.preferences;
  const doubleEntry = prefs.ballotDoubleEntry === true;
  const checkMode = prefs.ballotCheckMode ?? "review";
  const canEnterLate = stateHasPermission(state, "results.enter_late");
  const canConfirmOthers = stateHasPermission(state, "results.confirm_others");
  const canIntake = stateHasPermission(state, "ballots.intake");
  const twoTeam = isTwoTeamFormat(state.tournament.format);

  const handleSelectRound = (roundId: string): void => {
    setFormError(null);
    setFormSuccess(null);
    setBallotActionErrors({});
    setLateErrors({});
    setLateSuccess(null);
    setQrMessage(null);
    setQrError(null);
    setIntakeMessage(null);
    setIntakeError(null);
    if (controlledRoundId === undefined) {
      setUncontrolledRoundId(roundId);
    }
    onSelectRound?.(roundId);
  };

  const baseRules = debateBallotRules(
    state.tournament,
    selectedRound,
    undefined,
    state.rounds,
  );
  const perAdjudicator = usesPerAdjudicatorSheets(selectedRound, baseRules);

  const intakeRows =
    selectedRound !== undefined
      ? roundIntakeRows({
          roundId: selectedRound.id,
          debates: state.debates,
          adjudicators: state.adjudicators,
          intake: state.ballotIntake ?? [],
          ballots: state.ballots,
          perAdjudicator,
          doubleEntry,
          format: state.tournament.format,
        })
      : [];
  const intakeSummary = summarizeIntake(intakeRows);

  const deadline = selectedRound?.simpletab?.ballotDeadline ?? null;
  const timeZone =
    selectedRound !== undefined
      ? defaultTournamentTimeZone(state, selectedRound)
      : "UTC";
  const nowMs = nowIso ? Date.parse(nowIso) : Date.now();
  const deadlinePassed = isDeadlinePassed(deadline, nowMs);

  const lateItems: LateSubmissionRecord[] =
    canEnterLate && selectedRound !== undefined
      ? (state.lateSubmissions ?? []).filter(
          (item) => item.roundId === selectedRound.id,
        )
      : [];

  const checkState =
    selectedDebate !== undefined
      ? resolveCheckState({
          ballots: state.ballots,
          debateId: selectedDebate.id,
          userId: currentActorId,
          doubleEntry,
          checkMode,
        })
      : ({ kind: "single" } as const);

  const debateBallots =
    selectedDebate !== undefined
      ? state.ballots
          .filter((b) => b.debateId === selectedDebate.id)
          .sort((a, b) => (b.version || 0) - (a.version || 0))
      : [];

  const activeBlindMismatch: BallotDifference[] = (() => {
    if (selectedDebate === undefined) {
      return [];
    }
    const localDiffs = blindMismatchByDebate[selectedDebate.id];
    if (localDiffs && localDiffs.length > 0) {
      return localDiffs;
    }
    if (doubleEntry && checkMode === "blind") {
      const pending = debateBallots.filter((b) => !b.confirmed && !b.discarded);
      if (pending.length >= 2) {
        return diffBallots(pending[1], pending[0], state.tournament.format);
      }
    }
    return [];
  })();

  const hideFirstEntryInView = checkState.kind === "blind-check";

  const initialFormEntry = (() => {
    if (selectedDebate === undefined || selectedRound === undefined) {
      return undefined;
    }
    if (checkState.kind === "blind-check") {
      return undefined;
    }
    const targetBallot =
      checkState.kind === "review"
        ? checkState.pending
        : debateBallots.find((b) => !b.discarded);
    if (targetBallot === undefined) {
      return undefined;
    }
    const rules = debateBallotRules(
      state.tournament,
      selectedRound,
      selectedDebate,
      state.rounds,
    );
    const teamById = new Map(state.teams.map((tm) => [tm.id, tm]));
    const rosters: Partial<Record<DebateSide, Speaker[]>> = {};
    for (const [side, slot] of Object.entries(selectedDebate.teams)) {
      if (slot?.teamId) {
        rosters[side as DebateSide] = teamById.get(slot.teamId)?.speakers ?? [];
      }
    }
    const blank = blankEntry(
      selectedDebate,
      rosters,
      state.adjudicators,
      rules,
    );
    return entryFromBallot(targetBallot, blank, rules);
  })();

  const handleSubmitEntry = async (
    entry: BallotEntry,
    result: BallotResult,
    confirmNow: boolean,
  ): Promise<void> => {
    if (selectedRound === undefined || selectedDebate === undefined) {
      return;
    }
    setFormError(null);
    setFormSuccess(null);
    setSubmittingBallot(true);

    try {
      const version = nextBallotVersion(state.ballots, selectedDebate.id);
      const timestamp = nowIso ?? new Date().toISOString();
      const motion = entry.motionId
        ? state.motions.find((m) => m.id === entry.motionId)
        : undefined;
      const vetoes = Object.fromEntries(
        Object.entries(entry.vetoes ?? {}).filter(
          ([, motionId]) => typeof motionId === "string" && motionId.length > 0,
        ),
      ) as Partial<Record<DebateSide, string>>;

      const baseBallot: OpBallotSubmission = {
        id: createBallotId(selectedDebate.id, version),
        tournamentId: state.tournament.id,
        roundId: selectedRound.id,
        debateId: selectedDebate.id,
        version,
        confirmed: false,
        discarded: false,
        submitterType: "tabroom",
        ...(currentActorId ? { submitterId: currentActorId } : {}),
        ...(entry.motionId ? { motionId: entry.motionId } : {}),
        ...(motion?.text ? { motionText: motion.text } : {}),
        speakerScores: result.speakerScores,
        teamScores: result.teamScores,
        ...(result.sheets ? { sheets: result.sheets } : {}),
        ...(Object.keys(vetoes).length > 0 ? { vetoes } : {}),
        ...(entry.forfeitSide ? { forfeitSide: entry.forfeitSide } : {}),
        ...(result.noSpeakerScores ? { noSpeakerScores: true } : {}),
        ...(result.selfSplit ? { selfSplit: true } : {}),
        ...(selectedDebate.adjudicators.chairId
          ? { chairId: selectedDebate.adjudicators.chairId }
          : {}),
        timestamp,
        ...(deadlinePassed ? { late: true } : {}),
      };

      let finalBallot: OpBallotSubmission = baseBallot;
      let blindMatched = false;

      if (checkState.kind === "blind-check") {
        const diffs = diffBallots(
          checkState.pending,
          baseBallot,
          state.tournament.format,
        );
        if (diffs.length === 0) {
          blindMatched = true;
          finalBallot = {
            ...baseBallot,
            confirmed: true,
            checksVersion: checkState.pending.version,
            confirmedBy: currentActorId ?? "tabroom",
            confirmedTimestamp: timestamp,
          };
          setBlindMismatchByDebate((prev) => {
            const next = { ...prev };
            delete next[selectedDebate.id];
            return next;
          });
        } else {
          setBlindMismatchByDebate((prev) => ({
            ...prev,
            [selectedDebate.id]: diffs,
          }));
          finalBallot = {
            ...baseBallot,
            confirmed: false,
            checksVersion: checkState.pending.version,
          };
        }
      } else if (confirmNow && checkState.kind === "single") {
        finalBallot = {
          ...baseBallot,
          confirmed: true,
          confirmedBy: currentActorId ?? "tabroom",
          confirmedTimestamp: timestamp,
        };
      }

      const debateKey = recordKey("debate", selectedDebate.id);
      const submitRes = await onSubmitOp({
        type: "ballot.enter",
        expectedVersions: {
          [debateKey]: state.versions[debateKey] ?? 0,
        },
        payload: {
          ballot: finalBallot,
        },
      });

      if (!submitRes.ok) {
        setFormError({
          code: submitRes.code,
          errors: submitRes.errors,
          current: submitRes.current,
        });
        return;
      }

      if (checkState.kind === "blind-check") {
        setFormSuccess(
          blindMatched
            ? t("results.blindMatchConfirmed")
            : t("results.blindMismatchSaved"),
        );
      } else {
        setFormSuccess(
          finalBallot.confirmed
            ? t("results.savedAndConfirmed")
            : t("results.savedDraft"),
        );
      }
    } finally {
      setSubmittingBallot(false);
    }
  };

  const submitBallotAction = async (
    ballot: OpBallotSubmission,
    opType: "ballot.confirm" | "ballot.discard",
    overrideRequest?: OpRequest,
  ): Promise<void> => {
    setBallotActionErrors((prev) => {
      if (!(ballot.id in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[ballot.id];
      return next;
    });
    const ballotKey = recordKey("ballot", ballot.id);
    const debateKey = recordKey("debate", ballot.debateId);
    const request: OpRequest = overrideRequest ?? {
      type: opType,
      expectedVersions: {
        [ballotKey]: state.versions[ballotKey] ?? 0,
        [debateKey]: state.versions[debateKey] ?? 0,
      },
      payload:
        opType === "ballot.confirm"
          ? {
              ballotId: ballot.id,
              confirmedAt: nowIso ?? new Date().toISOString(),
            }
          : {
              ballotId: ballot.id,
              discardedAt: nowIso ?? new Date().toISOString(),
            },
    };
    const res = await onSubmitOp(request);
    if (!res.ok) {
      setBallotActionErrors((prev) => ({
        ...prev,
        [ballot.id]: {
          error: {
            code: res.code,
            errors: res.errors,
            current: res.current,
          },
          retryRequest: request,
        },
      }));
    }
  };

  const submitAcceptLate = async (
    item: LateSubmissionRecord,
    overrideRequest?: OpRequest,
  ): Promise<void> => {
    setLateErrors((prev) => {
      if (!(item.id in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
    setLateSuccess(null);

    const nextVersion = nextBallotVersion(state.ballots, item.debateId);
    const debateKey = recordKey("debate", item.debateId);
    const acceptedBallot: OpBallotSubmission = {
      ...item.ballot,
      id: createBallotId(item.debateId, nextVersion),
      version: nextVersion,
      confirmed: false,
      discarded: false,
      late: true,
      ...(currentActorId ? { enteredBy: currentActorId } : {}),
      timestamp: nowIso ?? new Date().toISOString(),
    };

    const request: OpRequest = overrideRequest ?? {
      type: "ballot.enter",
      expectedVersions: {
        [debateKey]: state.versions[debateKey] ?? 0,
      },
      payload: {
        ballot: acceptedBallot,
      },
    };
    const res = await onSubmitOp(request);
    if (!res.ok) {
      setLateErrors((prev) => ({
        ...prev,
        [item.id]: {
          error: {
            code: res.code,
            errors: res.errors,
            current: res.current,
          },
          retryRequest: request,
        },
      }));
      return;
    }
    const debate = state.debates.find((d) => d.id === item.debateId);
    setLateSuccess(
      t("results.lateAcceptedSuccess", { room: roomTitle(debate) }),
    );
  };

  const handleQrImport = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setQrMessage(null);
    setQrError(null);
    const codes = splitQrCodes(qrInput);
    if (codes.length === 0) {
      setQrError({ code: "INVALID", errors: [t("results.qrEmptyError")] });
      return;
    }
    if (onReceiveQrBallot === undefined) {
      setQrError({ code: "INVALID", errors: [t("results.qrDecodeFailed")] });
      return;
    }
    const res = await onReceiveQrBallot(codes);
    if (!res.ok) {
      setQrError({ code: "INVALID", errors: [qrFailureMessage(res)] });
      return;
    }
    setQrInput("");
    setQrMessage(t("results.qrImportedSuccess"));
  };

  const handleIntakeSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (selectedRound === undefined) {
      return;
    }
    setIntakeMessage(null);
    setIntakeError(null);
    const trimmed = intakeCode.trim();
    if (trimmed.length === 0) {
      setIntakeError({
        code: "INVALID",
        errors: [t("results.intakeEmptyError")],
      });
      return;
    }
    const res = await onSubmitOp({
      type: "ballot.intake_record",
      payload: {
        sheetCode: trimmed,
        roundId: selectedRound.id,
        receivedAt: nowIso ?? new Date().toISOString(),
      },
    });
    if (!res.ok) {
      setIntakeError({
        code: res.code,
        errors: res.errors,
        current: res.current,
      });
      return;
    }
    setIntakeCode("");
    setIntakeMessage(t("results.intakeSuccess", { code: trimmed }));
  };

  return (
    <div className="simpletab-page">
      <div className="simpletab-header">
        <h1 className="simpletab-title">{t("results.title")}</h1>
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
        onCancelLock={onCancelLock}
      />

      {selectedRound === undefined ? (
        <div className="simpletab-alert" role="status">
          {t("results.noRounds")}
        </div>
      ) : (
        <>
          {deadline !== null ? (
            <div
              className={`simpletab-alert ${
                deadlinePassed ? "simpletab-alert-warning" : ""
              }`}
              role="status"
            >
              <div className="simpletab-stage-bar">
                <strong>
                  {t("results.deadlineBanner", {
                    time: formatDeadlineTime(deadline, timeZone),
                    timeZone,
                  })}
                </strong>
                {deadlinePassed ? (
                  <span className="simpletab-badge simpletab-badge-conflict">
                    {t("results.deadlinePassedBadge")}
                  </span>
                ) : null}
              </div>
              {deadlinePassed ? (
                <div className="simpletab-hint">
                  {t("results.deadlinePassedHint")}
                </div>
              ) : null}
            </div>
          ) : null}

          <section
            className="simpletab-section"
            aria-labelledby={`${baseId}-board-h`}
          >
            <div className="simpletab-toolbar">
              <h2 id={`${baseId}-board-h`} className="simpletab-subtitle">
                {t("results.boardTitle", { round: selectedRound.name })}
              </h2>
              <div className="simpletab-status-counts" role="status">
                <span className="simpletab-badge">
                  {t("results.countMissing", {
                    count: intakeSummary.counts.missing,
                  })}
                </span>
                {intakeSummary.counts.partial > 0 ? (
                  <span className="simpletab-badge simpletab-badge-conflict">
                    {t("results.countPartial", {
                      count: intakeSummary.counts.partial,
                    })}
                  </span>
                ) : null}
                {intakeSummary.counts.received > 0 ? (
                  <span className="simpletab-badge simpletab-badge-match">
                    {t("results.countReceived", {
                      count: intakeSummary.counts.received,
                    })}
                  </span>
                ) : null}
                <span className="simpletab-badge simpletab-badge-match">
                  {t("results.countEntered", {
                    count: intakeSummary.counts.entered,
                  })}
                </span>
                <span className="simpletab-badge simpletab-badge-conflict">
                  {t("results.countAwaitingCheck", {
                    count: intakeSummary.counts.awaiting_check,
                  })}
                </span>
                <span className="simpletab-badge simpletab-badge-error">
                  {t("results.countDisputed", {
                    count: intakeSummary.counts.disputed,
                  })}
                </span>
                <span className="simpletab-badge simpletab-badge-add">
                  {t("results.countConfirmed", {
                    count: intakeSummary.counts.confirmed,
                  })}
                </span>
              </div>
            </div>

            {intakeRows.length === 0 ? (
              <p className="simpletab-empty">{t("results.noDebates")}</p>
            ) : (
              <div className="simpletab-table-wrap">
                <table className="simpletab-table">
                  <caption>
                    {t("results.boardCaption", { round: selectedRound.name })}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("results.colRoom")}</th>
                      <th scope="col">{t("results.colTeams")}</th>
                      <th scope="col">{t("results.colPanel")}</th>
                      <th scope="col">{t("results.colStatus")}</th>
                      <th scope="col">{t("results.colSummary")}</th>
                      <th scope="col">{t("results.colAction")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {intakeRows.map((row) => {
                      const debate = state.debates.find(
                        (d) => d.id === row.debateId,
                      );
                      if (debate === undefined) {
                        return null;
                      }
                      const ballotsForRoom = state.ballots.filter(
                        (b) => b.debateId === debate.id && !b.discarded,
                      );
                      const confirmedBallot = ballotsForRoom.find(
                        (b) => b.confirmed,
                      );
                      const latestLive = [...ballotsForRoom].sort(
                        (a, b) => (b.version || 0) - (a.version || 0),
                      )[0];
                      const hasLate = ballotsForRoom.some((b) => b.late === true);
                      const blindHidden =
                        doubleEntry &&
                        checkMode === "blind" &&
                        row.status === "awaiting_check";

                      const teamText = Object.entries(debate.teams)
                        .filter(([, slot]) => Boolean(slot?.teamId))
                        .map(([side, slot]) => {
                          const sLabel = sideLabel(
                            side as DebateSide,
                            prefs,
                            twoTeam ? "full" : "abbr",
                          );
                          return `${sLabel}: ${slot.teamName}`;
                        })
                        .join(" · ");

                      const panelText =
                        debate.adjudicators.chairName ??
                        (debate.adjudicators.panellistNames.length > 0
                          ? debate.adjudicators.panellistNames.join(", ")
                          : t("common.none"));

                      const summaryText = blindHidden
                        ? t("results.blindSummaryHidden")
                        : confirmedBallot
                          ? summarizeBallotScores(confirmedBallot, state)
                          : latestLive
                            ? summarizeBallotScores(latestLive, state)
                            : row.disputeReason ?? t("common.none");

                      const isSelected = debate.id === selectedDebate?.id;

                      return (
                        <tr
                          key={debate.id}
                          className={isSelected ? "simpletab-row-selected" : undefined}
                        >
                          <td>{roomTitle(debate)}</td>
                          <td>{teamText}</td>
                          <td>{panelText}</td>
                          <td>
                            <span
                              className={`simpletab-badge ${statusBadgeClass(row.status)}`}
                            >
                              {statusBadgeText(row.status)}
                            </span>
                            {hasLate ? (
                              <span className="simpletab-badge simpletab-badge-conflict">
                                {t("results.lateBadge")}
                              </span>
                            ) : null}
                          </td>
                          <td>{summaryText}</td>
                          <td>
                            <button
                              type="button"
                              className={
                                isSelected
                                  ? "theia-button"
                                  : "theia-button secondary"
                              }
                              onClick={() => {
                                setSelectedDebateId(debate.id);
                                setFormError(null);
                                setFormSuccess(null);
                              }}
                            >
                              {row.status === "missing" ||
                              row.status === "received" ||
                              row.status === "partial"
                                ? t("results.enterBallotButton")
                                : blindHidden
                                  ? t("results.blindCheckButton")
                                  : t("results.openBallotButton")}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {selectedDebate !== undefined ? (
            <section
              className="simpletab-section"
              aria-labelledby={`${baseId}-entry-h`}
            >
              <div className="simpletab-toolbar">
                <h2 id={`${baseId}-entry-h`} className="simpletab-subtitle">
                  {t("results.debateEntryTitle", {
                    room: roomTitle(selectedDebate),
                  })}
                </h2>
                <span className="simpletab-hint">
                  {doubleEntry
                    ? t("results.doubleEntryModeLabel", { mode: checkMode })
                    : t("results.singleEntryModeLabel")}
                </span>
              </div>

              {checkState.kind === "blind-check" ? (
                <div className="simpletab-alert" role="status">
                  {t("results.blindCheckNotice")}
                </div>
              ) : null}

              {checkState.kind === "awaiting-other" ? (
                <div className="simpletab-alert simpletab-alert-warning" role="status">
                  {t("results.awaitingOtherNotice")}
                </div>
              ) : null}

              {activeBlindMismatch.length > 0 ? (
                <div className="simpletab-alert simpletab-alert-error" role="alert">
                  <strong>{t("results.blindMismatchHeading")}</strong>
                  <ul className="simpletab-issue-list">
                    {activeBlindMismatch.map((diff, idx) => (
                      <li key={idx}>
                        {t("results.mismatchLine", {
                          field: diff.field,
                          first: diff.first,
                          second: diff.second,
                        })}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {!hideFirstEntryInView && debateBallots.length > 0 ? (
                <div className="simpletab-ballot-versions">
                  <h3 className="simpletab-subtitle">
                    {t("results.versionsTitle")}
                  </h3>
                  <div className="simpletab-table-wrap">
                    <table className="simpletab-table">
                      <caption>{t("results.versionsCaption")}</caption>
                      <thead>
                        <tr>
                          <th scope="col">{t("results.colVersion")}</th>
                          <th scope="col">{t("results.colStatus")}</th>
                          <th scope="col">{t("results.colSummary")}</th>
                          <th scope="col">{t("results.colAction")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {debateBallots.map((ballot) => {
                          const errEntry = ballotActionErrors[ballot.id];
                          const statusText = ballot.discarded
                            ? t("results.versionDiscarded")
                            : ballot.confirmed
                              ? t("results.versionConfirmed")
                              : t("results.versionDraft");
                          const badgeClass = ballot.discarded
                            ? "simpletab-badge-error"
                            : ballot.confirmed
                              ? "simpletab-badge-add"
                              : "simpletab-badge-conflict";
                          return (
                            <tr key={ballot.id}>
                              <td>{`v${ballot.version}`}</td>
                              <td>
                                <span className={`simpletab-badge ${badgeClass}`}>
                                  {statusText}
                                </span>
                                {ballot.late === true ? (
                                  <span className="simpletab-badge simpletab-badge-conflict">
                                    {t("results.lateBadge")}
                                  </span>
                                ) : null}
                                {ballot.enteredBy ? (
                                  <div className="simpletab-hint">
                                    {t("results.enteredByLabel", {
                                      actor: ballot.enteredBy,
                                    })}
                                  </div>
                                ) : null}
                              </td>
                              <td>
                                <div>{summarizeBallotScores(ballot, state)}</div>
                                {errEntry !== undefined ? (
                                  <InlineOpError
                                    error={errEntry.error}
                                    onRetry={() => {
                                      void submitBallotAction(
                                        ballot,
                                        errEntry.retryRequest
                                          .type as "ballot.confirm" | "ballot.discard",
                                        withFreshVersions(
                                          errEntry.retryRequest,
                                          state.versions,
                                        ),
                                      );
                                    }}
                                    onDismiss={() => {
                                      setBallotActionErrors((prev) => {
                                        const next = { ...prev };
                                        delete next[ballot.id];
                                        return next;
                                      });
                                    }}
                                  />
                                ) : null}
                              </td>
                              <td>
                                {!ballot.discarded ? (
                                  <div className="simpletab-actions">
                                    {!ballot.confirmed && canConfirmOthers ? (
                                      <button
                                        type="button"
                                        className="theia-button"
                                        onClick={() => {
                                          void submitBallotAction(
                                            ballot,
                                            "ballot.confirm",
                                          );
                                        }}
                                      >
                                        {t("results.confirmButton")}
                                      </button>
                                    ) : null}
                                    {canConfirmOthers ? (
                                      <button
                                        type="button"
                                        className="theia-button secondary"
                                        onClick={() => {
                                          void submitBallotAction(
                                            ballot,
                                            "ballot.discard",
                                          );
                                        }}
                                      >
                                        {t("results.discardButton")}
                                      </button>
                                    ) : null}
                                  </div>
                                ) : null}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              {formSuccess !== null ? (
                <div className="simpletab-alert simpletab-alert-success" role="status">
                  {formSuccess}
                </div>
              ) : null}

              <BallotForm
                key={`${selectedDebate.id}-${checkState.kind}`}
                state={state}
                round={selectedRound}
                debate={selectedDebate}
                initialEntry={initialFormEntry}
                checkState={checkState}
                submitting={submittingBallot}
                submitError={formError}
                onDismissError={() => setFormError(null)}
                onSubmitEntry={handleSubmitEntry}
              />
            </section>
          ) : null}

          {canEnterLate ? (
            <section
              className="simpletab-section"
              aria-labelledby={`${baseId}-late-h`}
            >
              <h2 id={`${baseId}-late-h`} className="simpletab-subtitle">
                {t("results.lateSubmissionsTitle", {
                  count: lateItems.length,
                })}
              </h2>
              {lateSuccess !== null ? (
                <div className="simpletab-alert simpletab-alert-success" role="status">
                  {lateSuccess}
                </div>
              ) : null}
              {lateItems.length === 0 ? (
                <p className="simpletab-empty">{t("results.lateSubmissionsEmpty")}</p>
              ) : (
                <div className="simpletab-table-wrap">
                  <table className="simpletab-table">
                    <caption>{t("results.lateSubmissionsCaption")}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t("results.colRoom")}</th>
                        <th scope="col">{t("results.colSubmitter")}</th>
                        <th scope="col">{t("results.colReceivedAt")}</th>
                        <th scope="col">{t("results.colSummary")}</th>
                        <th scope="col">{t("results.colAction")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lateItems.map((item) => {
                        const debate = state.debates.find(
                          (d) => d.id === item.debateId,
                        );
                        const errEntry = lateErrors[item.id];
                        return (
                          <tr key={item.id}>
                            <td>{roomTitle(debate)}</td>
                            <td>
                              {item.ballot.submitterName ||
                                item.ballot.submitterId ||
                                t("common.none")}
                            </td>
                            <td>
                              <div>
                                {formatDeadlineDateTime(item.receivedAt, timeZone)}
                              </div>
                              <div className="simpletab-hint">
                                {t("results.lateDeadlineRef", {
                                  deadline: formatDeadlineDateTime(
                                    item.deadline,
                                    timeZone,
                                  ),
                                })}
                              </div>
                            </td>
                            <td>
                              <div>{summarizeBallotScores(item.ballot, state)}</div>
                              {errEntry !== undefined ? (
                                <InlineOpError
                                  error={errEntry.error}
                                  onRetry={() => {
                                    void submitAcceptLate(
                                      item,
                                      withFreshVersions(
                                        errEntry.retryRequest,
                                        state.versions,
                                      ),
                                    );
                                  }}
                                  onDismiss={() => {
                                    setLateErrors((prev) => {
                                      const next = { ...prev };
                                      delete next[item.id];
                                      return next;
                                    });
                                  }}
                                />
                              ) : null}
                            </td>
                            <td>
                              <button
                                type="button"
                                className="theia-button"
                                onClick={() => {
                                  void submitAcceptLate(item);
                                }}
                              >
                                {t("results.acceptLateButton")}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : null}

          <div className="simpletab-form-grid">
            <section
              className="simpletab-section"
              aria-labelledby={`${baseId}-qr-h`}
            >
              <h2 id={`${baseId}-qr-h`} className="simpletab-subtitle">
                {t("results.qrSectionTitle")}
              </h2>
              <form
                className="simpletab-form"
                onSubmit={(e) => void handleQrImport(e)}
              >
                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-qr-text`}>
                    {t("results.qrInputLabel")}
                  </label>
                  <textarea
                    id={`${baseId}-qr-text`}
                    rows={3}
                    placeholder={t("results.qrInputPlaceholder")}
                    value={qrInput}
                    onChange={(e) => setQrInput(e.target.value)}
                  />
                </div>
                {qrMessage !== null ? (
                  <div
                    className="simpletab-alert simpletab-alert-success"
                    role="status"
                  >
                    {qrMessage}
                  </div>
                ) : null}
                {qrError !== null ? (
                  <InlineOpError
                    error={qrError}
                    onDismiss={() => setQrError(null)}
                  />
                ) : null}
                <div className="simpletab-actions">
                  <button type="submit" className="theia-button secondary">
                    {t("results.qrImportButton")}
                  </button>
                </div>
              </form>
            </section>

            {canIntake ? (
              <section
                className="simpletab-section"
                aria-labelledby={`${baseId}-intake-h`}
              >
                <h2 id={`${baseId}-intake-h`} className="simpletab-subtitle">
                  {t("results.intakeSectionTitle")}
                </h2>
                <form
                  className="simpletab-form"
                  onSubmit={(e) => void handleIntakeSubmit(e)}
                >
                  <div className="simpletab-field">
                    <label htmlFor={`${baseId}-intake-code`}>
                      {t("results.intakeInputLabel")}
                    </label>
                    <input
                      id={`${baseId}-intake-code`}
                      type="text"
                      placeholder={t("results.intakePlaceholder")}
                      value={intakeCode}
                      onChange={(e) => setIntakeCode(e.target.value)}
                    />
                  </div>
                  {intakeMessage !== null ? (
                    <div
                      className="simpletab-alert simpletab-alert-success"
                      role="status"
                    >
                      {intakeMessage}
                    </div>
                  ) : null}
                  {intakeError !== null ? (
                    <InlineOpError
                      error={intakeError}
                      onDismiss={() => setIntakeError(null)}
                    />
                  ) : null}
                  <div className="simpletab-actions">
                    <button type="submit" className="theia-button secondary">
                      {t("results.intakeButton")}
                    </button>
                  </div>
                </form>
              </section>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
};
