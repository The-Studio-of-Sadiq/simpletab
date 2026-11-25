import {
  roundIntakeRows,
  summarizeIntake,
  usesPerAdjudicatorSheets,
  type DebateIntakeStatus,
} from "@simpletab/core/features/tournament/application/ballotIntake";
import {
  debateBallotRules,
  diffBallots,
  type BallotDifference,
} from "@simpletab/core/lib/ballots/result";
import { isTwoTeamFormat } from "@simpletab/core/lib/debateSides";
import { sideLabel } from "@simpletab/core/lib/sideNames";
import type { LateSubmissionRecord, OpBallotSubmission } from "@simpletab/core/ops";
import type { Debate, DebateSide } from "@simpletab/core/types";
import type { HostStatus, ProjectedState } from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import type { ActionRunner } from "../actions/action";
import {
  acceptLateBallotAction,
  confirmBallotAction,
  discardBallotAction,
  importQrBallotAction,
  initialFormEntry,
  recordBallotIntakeAction,
  resolveResultsCheckState,
} from "../actions/results-actions";
import { openSetupAction } from "../actions/releases-actions";
import { t } from "../i18n";
import {
  defaultTournamentTimeZone,
  formatDeadlineDateTime,
  formatDeadlineTime,
  isDeadlinePassed,
} from "../lib/deadline";
import { stateHasPermission } from "../lib/permissions";
import { splitQrCodes } from "../lib/qr-messages";
import { BallotForm, type BallotSubmitOutcome } from "./ballot-form";
import { InlineOpError, type InlineOpErrorData } from "./inline-op-error";
import { LockBanner } from "./lock-banner";
import { getDefaultRoundId, RoundPicker } from "./round-picker";

export interface ResultsViewProps {
  state: ProjectedState | null;
  status: HostStatus;
  selectedRoundId?: string;
  onSelectRound?: (roundId: string) => void;
  /** Results actions are the only way this page changes tournament data. */
  run: ActionRunner;
  currentActorId?: string;
  nowIso?: string;
}

interface ItemErrorEntry {
  error: InlineOpErrorData;
  retry: () => void;
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
  run,
  currentActorId,
  nowIso,
}) => {
  const baseId = React.useId();
  const [uncontrolledRoundId, setUncontrolledRoundId] = React.useState("");
  const [selectedDebateId, setSelectedDebateId] = React.useState("");
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
  const prefs = state.tournament.preferences;
  const doubleEntry = prefs.ballotDoubleEntry === true;
  const checkMode = prefs.ballotCheckMode ?? "review";
  const canEnterLate = stateHasPermission(state, "results.enter_late");
  const canConfirmOthers = stateHasPermission(state, "results.confirm_others");
  const canIntake = stateHasPermission(state, "ballots.intake");
  const twoTeam = isTwoTeamFormat(state.tournament.format);

  const handleSelectRound = (roundId: string): void => {
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
      ? resolveResultsCheckState(state, selectedDebate.id, currentActorId)
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

  const initialFormEntryValue =
    selectedDebate !== undefined && selectedRound !== undefined
      ? initialFormEntry(state, selectedRound, selectedDebate, currentActorId)
      : undefined;

  const handleSubmitOutcome = (outcome: BallotSubmitOutcome): void => {
    if (selectedDebate === undefined) {
      return;
    }
    setFormSuccess(null);
    if (outcome.checkStateKind === "blind-check") {
      if (outcome.blindDiffs.length === 0) {
        setBlindMismatchByDebate((prev) => {
          const next = { ...prev };
          delete next[selectedDebate.id];
          return next;
        });
        setFormSuccess(t("results.blindMatchConfirmed"));
      } else {
        setBlindMismatchByDebate((prev) => ({
          ...prev,
          [selectedDebate.id]: [...outcome.blindDiffs],
        }));
        setFormSuccess(t("results.blindMismatchSaved"));
      }
      return;
    }
    setFormSuccess(
      outcome.confirmed ? t("results.savedAndConfirmed") : t("results.savedDraft"),
    );
  };

  const clearBallotError = (ballotId: string): void => {
    setBallotActionErrors((prev) => {
      if (!(ballotId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[ballotId];
      return next;
    });
  };

  const submitConfirm = async (ballot: OpBallotSubmission): Promise<void> => {
    clearBallotError(ballot.id);
    const res = await run(confirmBallotAction, {
      ballotId: ballot.id,
      confirmedAt: nowIso ?? new Date().toISOString(),
    });
    if (!res.ok) {
      setBallotActionErrors((prev) => ({
        ...prev,
        [ballot.id]: {
          error: {
            code: res.code,
            errors: res.errors,
            current: res.current,
          },
          retry: () => {
            void submitConfirm(ballot);
          },
        },
      }));
    }
  };

  const submitDiscard = async (ballot: OpBallotSubmission): Promise<void> => {
    clearBallotError(ballot.id);
    const res = await run(discardBallotAction, {
      ballotId: ballot.id,
      discardedAt: nowIso ?? new Date().toISOString(),
    });
    if (!res.ok) {
      setBallotActionErrors((prev) => ({
        ...prev,
        [ballot.id]: {
          error: {
            code: res.code,
            errors: res.errors,
            current: res.current,
          },
          retry: () => {
            void submitDiscard(ballot);
          },
        },
      }));
    }
  };

  const submitAcceptLate = async (item: LateSubmissionRecord): Promise<void> => {
    setLateErrors((prev) => {
      if (!(item.id in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
    setLateSuccess(null);

    const res = await run(acceptLateBallotAction, {
      lateItemId: item.id,
      now: nowIso ?? new Date().toISOString(),
      actorId: currentActorId,
    });
    if (!res.ok) {
      setLateErrors((prev) => ({
        ...prev,
        [item.id]: {
          error: {
            code: res.code,
            errors: res.errors,
            current: res.current,
          },
          retry: () => {
            void submitAcceptLate(item);
          },
        },
      }));
      return;
    }
    const debate = state.debates.find((d) => d.id === item.debateId);
    setLateSuccess(t("results.lateAcceptedSuccess", { room: roomTitle(debate) }));
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
    const res = await run(importQrBallotAction, { codes });
    if (!res.ok) {
      setQrError({ code: "INVALID", errors: res.errors });
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
    const res = await run(recordBallotIntakeAction, {
      sheetCode: trimmed,
      roundId: selectedRound.id,
      receivedAt: nowIso ?? new Date().toISOString(),
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
        run={run}
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
                              data-view-only
                              onClick={() => {
                                setSelectedDebateId(debate.id);
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
                                    onRetry={errEntry.retry}
                                    onDismiss={() => clearBallotError(ballot.id)}
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
                                        data-action={confirmBallotAction.id}
                                        onClick={() => {
                                          void submitConfirm(ballot);
                                        }}
                                      >
                                        {t("results.confirmButton")}
                                      </button>
                                    ) : null}
                                    {canConfirmOthers ? (
                                      <button
                                        type="button"
                                        className="theia-button secondary"
                                        data-action={discardBallotAction.id}
                                        onClick={() => {
                                          void submitDiscard(ballot);
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
                initialEntry={initialFormEntryValue}
                checkState={checkState}
                actorId={currentActorId}
                nowIso={nowIso}
                run={run}
                onComplete={handleSubmitOutcome}
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
                                  onRetry={errEntry.retry}
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
                                data-action={acceptLateBallotAction.id}
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
                  <button
                    type="submit"
                    className="theia-button secondary"
                    data-action={importQrBallotAction.id}
                  >
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
                    <button
                      type="submit"
                      className="theia-button secondary"
                      data-action={recordBallotIntakeAction.id}
                    >
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
