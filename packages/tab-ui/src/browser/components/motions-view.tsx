import {
  MOTIONS_STATUSES,
  motionsStatusOf,
} from "@simpletab/core/features/tournament/application/motionRelease";
import { hasInfoSlide } from "@simpletab/core/lib/motions/infoSlideMedia";
import { recordKey, type OpRequest, type RecordKey } from "@simpletab/core/ops";
import type { Motion, MotionsStatus } from "@simpletab/core/types";
import type {
  HostCancelLongResult,
  HostStatus,
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import { t } from "../i18n";
import {
  COMMON_TIME_ZONES,
  defaultTournamentTimeZone,
  formatDeadlineTime,
  isDeadlinePassed,
  isValidIanaTimeZone,
  localDateTimeToUtcIso,
  utcIsoToLocalParts,
} from "../lib/deadline";
import { InlineOpError, type InlineOpErrorData } from "./inline-op-error";
import { LockBanner } from "./lock-banner";
import { getDefaultRoundId, RoundPicker } from "./round-picker";

export interface MotionsViewProps {
  state: ProjectedState | null;
  status: HostStatus;
  selectedRoundId?: string;
  onSelectRound?: (roundId: string) => void;
  onSubmitOp: (request: OpRequest) => Promise<SubmitResult>;
  onCancelLock?: (lockId: string) => Promise<HostCancelLongResult | void>;
  onOpenSetup?: () => void;
  nowIso?: string;
}

interface MotionRowErrorEntry {
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

function motionsStatusLabel(statusValue: MotionsStatus): string {
  switch (statusValue) {
    case "not_released":
      return t("motions.statusNotReleased");
    case "info_slides_released":
      return t("motions.statusInfoSlides");
    case "motions_released":
      return t("motions.statusMotionsReleased");
  }
}

function releaseButtonLabel(statusValue: MotionsStatus): string {
  switch (statusValue) {
    case "not_released":
      return t("motions.releaseNotReleased");
    case "info_slides_released":
      return t("motions.releaseInfoSlides");
    case "motions_released":
      return t("motions.releaseMotions");
  }
}

function createMotionId(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return `motion-${globalThis.crypto.randomUUID()}`;
  }
  return `motion-${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
}

export const MotionsView: React.FC<MotionsViewProps> = ({
  state,
  status,
  selectedRoundId: controlledRoundId,
  onSelectRound,
  onSubmitOp,
  onCancelLock,
  onOpenSetup,
  nowIso,
}) => {
  const baseId = React.useId();
  const [uncontrolledRoundId, setUncontrolledRoundId] = React.useState("");

  // Release status feedback
  const [releaseError, setReleaseError] =
    React.useState<InlineOpErrorData | null>(null);
  const [releaseSuccess, setReleaseSuccess] = React.useState<string | null>(
    null,
  );
  const [lastReleaseRequest, setLastReleaseRequest] =
    React.useState<OpRequest | null>(null);

  // Deadline form state
  const [deadlineDate, setDeadlineDate] = React.useState("");
  const [deadlineTime, setDeadlineTime] = React.useState("14:00");
  const [deadlineZone, setDeadlineZone] = React.useState("UTC");
  const [deadlineError, setDeadlineError] =
    React.useState<InlineOpErrorData | null>(null);
  const [deadlineSuccess, setDeadlineSuccess] = React.useState<string | null>(
    null,
  );
  const [lastDeadlineRequest, setLastDeadlineRequest] =
    React.useState<OpRequest | null>(null);

  // Motion editor state
  const [editingMotionId, setEditingMotionId] = React.useState<string | null>(
    null,
  );
  const [motionText, setMotionText] = React.useState("");
  const [motionInfoSlide, setMotionInfoSlide] = React.useState("");
  const [motionReference, setMotionReference] = React.useState("");
  const [motionFormError, setMotionFormError] =
    React.useState<InlineOpErrorData | null>(null);
  const [motionFormSuccess, setMotionFormSuccess] = React.useState<
    string | null
  >(null);
  const [rowErrors, setRowErrors] = React.useState<
    Record<string, MotionRowErrorEntry>
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
    if (state === null || selectedRound === undefined) {
      return;
    }
    const tz = defaultTournamentTimeZone(state, selectedRound);
    setDeadlineZone(tz);
    const existingDeadline = selectedRound.simpletab?.ballotDeadline;
    if (existingDeadline) {
      const local = utcIsoToLocalParts(existingDeadline, tz);
      if (local !== null) {
        setDeadlineDate(local.date);
        setDeadlineTime(local.time);
      }
    } else {
      const baseNow = nowIso ?? new Date().toISOString();
      const localToday = utcIsoToLocalParts(baseNow, tz);
      setDeadlineDate(localToday?.date ?? "");
      setDeadlineTime("14:00");
    }
    setReleaseError(null);
    setReleaseSuccess(null);
    setDeadlineError(null);
    setDeadlineSuccess(null);
    setMotionFormError(null);
    setMotionFormSuccess(null);
    setRowErrors({});
    setEditingMotionId(null);
    setMotionText("");
    setMotionInfoSlide("");
    setMotionReference("");
  }, [
    selectedRound?.id,
    selectedRound?.simpletab?.ballotDeadline,
    selectedRound?.simpletab?.timeZone,
    state?.tournament.id,
  ]);

  const roundMotions = React.useMemo(() => {
    if (state === null || selectedRound === undefined) {
      return [];
    }
    return state.motions
      .filter((motion) => (motion.rounds ?? []).includes(selectedRound.id))
      .sort((left, right) => {
        const leftSeq = left.roundSeq?.[selectedRound.id] ?? left.seq ?? 0;
        const rightSeq = right.roundSeq?.[selectedRound.id] ?? right.seq ?? 0;
        return leftSeq - rightSeq || left.id.localeCompare(right.id);
      });
  }, [state, selectedRound]);

  if (state === null) {
    return (
      <div className="simpletab-page">
        <div className="simpletab-header">
          <h1 className="simpletab-title">{t("motions.title")}</h1>
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

  const handleSelectRound = (roundId: string): void => {
    if (controlledRoundId === undefined) {
      setUncontrolledRoundId(roundId);
    }
    onSelectRound?.(roundId);
  };

  const submitReleaseStatus = async (
    nextStatus: MotionsStatus,
    overrideRequest?: OpRequest,
  ): Promise<void> => {
    if (selectedRound === undefined) {
      return;
    }
    setReleaseError(null);
    setReleaseSuccess(null);
    const roundKey = recordKey("round", selectedRound.id);
    const request: OpRequest = overrideRequest ?? {
      type: "motion.set_round_status",
      expectedVersions: {
        [roundKey]: state.versions[roundKey] ?? 0,
      },
      payload: {
        roundId: selectedRound.id,
        status: nextStatus,
        now: nowIso ?? new Date().toISOString(),
      },
    };
    setLastReleaseRequest(request);
    const result = await onSubmitOp(request);
    if (!result.ok) {
      setReleaseError({
        code: result.code,
        errors: result.errors,
        current: result.current,
      });
      return;
    }
    setReleaseSuccess(
      t("motions.releaseUpdated", {
        round: selectedRound.name,
        status: motionsStatusLabel(nextStatus),
      }),
    );
  };

  const submitDeadlineRequest = async (
    request: OpRequest,
    cleared: boolean,
    displayTime?: string,
    displayZone?: string,
  ): Promise<void> => {
    setDeadlineError(null);
    setDeadlineSuccess(null);
    setLastDeadlineRequest(request);
    const result = await onSubmitOp(request);
    if (!result.ok) {
      setDeadlineError({
        code: result.code,
        errors: result.errors,
        current: result.current,
      });
      return;
    }
    setDeadlineSuccess(
      cleared
        ? t("motions.deadlineCleared")
        : t("motions.deadlineSummary", {
            time: displayTime ?? "",
            timeZone: displayZone ?? "",
          }),
    );
  };

  const handleSaveDeadline = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (selectedRound === undefined) {
      return;
    }
    setDeadlineError(null);
    setDeadlineSuccess(null);

    const trimmedZone = deadlineZone.trim();
    if (!isValidIanaTimeZone(trimmedZone)) {
      setDeadlineError({
        code: "INVALID",
        errors: [t("motions.invalidTimeZone")],
      });
      return;
    }
    const utcIso = localDateTimeToUtcIso(
      deadlineDate,
      deadlineTime,
      trimmedZone,
    );
    if (utcIso === null) {
      setDeadlineError({
        code: "INVALID",
        errors: [t("motions.invalidDeadlineInput")],
      });
      return;
    }

    const roundKey = recordKey("round", selectedRound.id);
    const request: OpRequest = {
      type: "round.set_ballot_deadline",
      expectedVersions: {
        [roundKey]: state.versions[roundKey] ?? 0,
      },
      payload: {
        roundId: selectedRound.id,
        ballotDeadline: utcIso,
        timeZone: trimmedZone,
      },
    };
    await submitDeadlineRequest(
      request,
      false,
      formatDeadlineTime(utcIso, trimmedZone),
      trimmedZone,
    );
  };

  const handleClearDeadline = async (): Promise<void> => {
    if (selectedRound === undefined) {
      return;
    }
    const roundKey = recordKey("round", selectedRound.id);
    const trimmedZone = isValidIanaTimeZone(deadlineZone.trim())
      ? deadlineZone.trim()
      : defaultTournamentTimeZone(state, selectedRound);
    const request: OpRequest = {
      type: "round.set_ballot_deadline",
      expectedVersions: {
        [roundKey]: state.versions[roundKey] ?? 0,
      },
      payload: {
        roundId: selectedRound.id,
        ballotDeadline: null,
        timeZone: trimmedZone,
      },
    };
    await submitDeadlineRequest(request, true);
  };

  const handleStartEditMotion = (motion: Motion): void => {
    setEditingMotionId(motion.id);
    setMotionText(motion.text);
    setMotionInfoSlide(motion.infoSlide ?? "");
    setMotionReference(motion.reference ?? "");
    setMotionFormError(null);
    setMotionFormSuccess(null);
  };

  const handleCancelEditMotion = (): void => {
    setEditingMotionId(null);
    setMotionText("");
    setMotionInfoSlide("");
    setMotionReference("");
    setMotionFormError(null);
  };

  const handleSaveMotion = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (selectedRound === undefined) {
      return;
    }
    setMotionFormError(null);
    setMotionFormSuccess(null);

    const trimmedText = motionText.trim();
    if (trimmedText.length === 0) {
      setMotionFormError({
        code: "INVALID",
        errors: [t("motions.motionTextRequired")],
      });
      return;
    }
    const trimmedInfo = motionInfoSlide.trim();
    const trimmedRef = motionReference.trim();

    if (editingMotionId !== null) {
      const existing = state.motions.find((m) => m.id === editingMotionId);
      if (existing === undefined) {
        setMotionFormError({
          code: "INVALID",
          errors: [t("motions.motionMissing")],
        });
        return;
      }
      const nextMotion: Motion = {
        ...existing,
        text: trimmedText,
        ...(trimmedInfo.length > 0 ? { infoSlide: trimmedInfo } : {}),
        ...(trimmedRef.length > 0 ? { reference: trimmedRef } : {}),
      };
      if (trimmedInfo.length === 0) {
        delete nextMotion.infoSlide;
      }
      if (trimmedRef.length === 0) {
        delete nextMotion.reference;
      }
      const motionKey = recordKey("motion", existing.id);
      const result = await onSubmitOp({
        type: "motion.update",
        expectedVersions: {
          [motionKey]: state.versions[motionKey] ?? 0,
        },
        payload: {
          motion: nextMotion,
        },
      });
      if (!result.ok) {
        setMotionFormError({
          code: result.code,
          errors: result.errors,
          current: result.current,
        });
        return;
      }
      setMotionFormSuccess(t("motions.motionUpdated"));
      handleCancelEditMotion();
      return;
    }

    const nextSeq =
      roundMotions.reduce(
        (max, m) => Math.max(max, m.roundSeq?.[selectedRound.id] ?? m.seq ?? 0),
        0,
      ) + 1;
    const created: Motion = {
      id: createMotionId(),
      tournamentId: state.tournament.id,
      text: trimmedText,
      ...(trimmedInfo.length > 0 ? { infoSlide: trimmedInfo } : {}),
      ...(trimmedRef.length > 0 ? { reference: trimmedRef } : {}),
      rounds: [selectedRound.id],
      seq: nextSeq,
      roundSeq: { [selectedRound.id]: nextSeq },
      released: motionsStatusOf(selectedRound) === "motions_released",
    };
    const result = await onSubmitOp({
      type: "motion.create",
      payload: {
        motion: created,
      },
    });
    if (!result.ok) {
      setMotionFormError({
        code: result.code,
        errors: result.errors,
        current: result.current,
      });
      return;
    }
    setMotionFormSuccess(t("motions.motionCreated"));
    setMotionText("");
    setMotionInfoSlide("");
    setMotionReference("");
  };

  const submitDeleteMotion = async (
    motionId: string,
    overrideRequest?: OpRequest,
  ): Promise<void> => {
    setRowErrors((prev) => {
      if (!(motionId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[motionId];
      return next;
    });
    const motionKey = recordKey("motion", motionId);
    const request: OpRequest = overrideRequest ?? {
      type: "motion.delete",
      expectedVersions: {
        [motionKey]: state.versions[motionKey] ?? 0,
      },
      payload: {
        motionId,
      },
    };
    const result = await onSubmitOp(request);
    if (!result.ok) {
      setRowErrors((prev) => ({
        ...prev,
        [motionId]: {
          error: {
            code: result.code,
            errors: result.errors,
            current: result.current,
          },
          retryRequest: request,
        },
      }));
    } else if (editingMotionId === motionId) {
      handleCancelEditMotion();
    }
  };

  const currentStatus =
    selectedRound !== undefined
      ? motionsStatusOf(selectedRound)
      : "not_released";
  const currentDeadline = selectedRound?.simpletab?.ballotDeadline ?? null;
  const currentZone =
    selectedRound !== undefined
      ? defaultTournamentTimeZone(state, selectedRound)
      : "UTC";
  const nowMs = nowIso ? Date.parse(nowIso) : Date.now();
  const deadlinePassed = isDeadlinePassed(currentDeadline, nowMs);

  return (
    <div className="simpletab-page">
      <div className="simpletab-header">
        <h1 className="simpletab-title">{t("motions.title")}</h1>
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
          {t("motions.noRounds")}
        </div>
      ) : (
        <>
          <section
            className="simpletab-section"
            aria-labelledby={`${baseId}-release-h`}
          >
            <div className="simpletab-toolbar">
              <div>
                <h2 id={`${baseId}-release-h`} className="simpletab-subtitle">
                  {t("motions.releaseSectionTitle")}
                </h2>
                <div className="simpletab-stage-bar">
                  <span className="simpletab-hint">
                    {t("motions.currentStatusLabel")}:
                  </span>
                  <span
                    className={`simpletab-badge ${
                      currentStatus === "motions_released"
                        ? "simpletab-badge-add"
                        : currentStatus === "info_slides_released"
                          ? "simpletab-badge-match"
                          : ""
                    }`}
                  >
                    {motionsStatusLabel(currentStatus)}
                  </span>
                </div>
              </div>

              <div
                className="simpletab-actions"
                role="group"
                aria-label={t("motions.releaseSectionTitle")}
              >
                {MOTIONS_STATUSES.map((statusOption) => {
                  const active = currentStatus === statusOption;
                  return (
                    <button
                      key={statusOption}
                      type="button"
                      className={
                        active ? "theia-button" : "theia-button secondary"
                      }
                      aria-pressed={active}
                      onClick={() => {
                        void submitReleaseStatus(statusOption);
                      }}
                    >
                      {releaseButtonLabel(statusOption)}
                    </button>
                  );
                })}
              </div>
            </div>

            {releaseSuccess !== null ? (
              <div className="simpletab-alert simpletab-alert-success" role="status">
                {releaseSuccess}
              </div>
            ) : null}
            {releaseError !== null ? (
              <InlineOpError
                error={releaseError}
                onRetry={
                  lastReleaseRequest !== null
                    ? () => {
                        void submitReleaseStatus(
                          currentStatus,
                          withFreshVersions(lastReleaseRequest, state.versions),
                        );
                      }
                    : undefined
                }
                onDismiss={() => setReleaseError(null)}
              />
            ) : null}
          </section>

          <section
            className="simpletab-section"
            aria-labelledby={`${baseId}-deadline-h`}
          >
            <div className="simpletab-toolbar">
              <div>
                <h2 id={`${baseId}-deadline-h`} className="simpletab-subtitle">
                  {t("motions.deadlineSectionTitle")}
                </h2>
                {currentDeadline ? (
                  <div className="simpletab-stage-bar" role="status">
                    <span className="simpletab-count-summary">
                      {t("motions.deadlineSummary", {
                        time: formatDeadlineTime(currentDeadline, currentZone),
                        timeZone: currentZone,
                      })}
                    </span>
                    {deadlinePassed ? (
                      <span className="simpletab-badge simpletab-badge-conflict">
                        {t("motions.deadlinePassedBadge")}
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <div className="simpletab-hint" role="status">
                    {t("motions.noDeadlineSet")}
                  </div>
                )}
              </div>
            </div>

            <form className="simpletab-form" onSubmit={(e) => void handleSaveDeadline(e)}>
              <div className="simpletab-form-grid">
                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-dl-date`}>
                    {t("motions.deadlineDateLabel")}
                  </label>
                  <input
                    id={`${baseId}-dl-date`}
                    type="date"
                    value={deadlineDate}
                    onChange={(e) => setDeadlineDate(e.target.value)}
                  />
                </div>
                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-dl-time`}>
                    {t("motions.deadlineTimeLabel")}
                  </label>
                  <input
                    id={`${baseId}-dl-time`}
                    type="time"
                    value={deadlineTime}
                    onChange={(e) => setDeadlineTime(e.target.value)}
                  />
                </div>
                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-dl-tz`}>
                    {t("motions.deadlineZoneLabel")}
                  </label>
                  <input
                    id={`${baseId}-dl-tz`}
                    type="text"
                    list={`${baseId}-tz-list`}
                    value={deadlineZone}
                    onChange={(e) => setDeadlineZone(e.target.value)}
                  />
                  <datalist id={`${baseId}-tz-list`}>
                    {COMMON_TIME_ZONES.map((tz) => (
                      <option key={tz} value={tz} />
                    ))}
                  </datalist>
                </div>
              </div>

              <div className="simpletab-actions">
                <button type="submit" className="theia-button">
                  {t("motions.saveDeadline")}
                </button>
                {currentDeadline !== null ? (
                  <button
                    type="button"
                    className="theia-button secondary"
                    onClick={() => {
                      void handleClearDeadline();
                    }}
                  >
                    {t("motions.clearDeadline")}
                  </button>
                ) : null}
              </div>
            </form>

            {deadlineSuccess !== null ? (
              <div className="simpletab-alert simpletab-alert-success" role="status">
                {deadlineSuccess}
              </div>
            ) : null}
            {deadlineError !== null ? (
              <InlineOpError
                error={deadlineError}
                onRetry={
                  lastDeadlineRequest !== null
                    ? () => {
                        void submitDeadlineRequest(
                          withFreshVersions(lastDeadlineRequest, state.versions),
                          false,
                        );
                      }
                    : undefined
                }
                onDismiss={() => setDeadlineError(null)}
              />
            ) : null}
          </section>

          <section
            className="simpletab-section"
            aria-labelledby={`${baseId}-list-h`}
          >
            <h2 id={`${baseId}-list-h`} className="simpletab-subtitle">
              {t("motions.roundMotionsTitle", {
                round: selectedRound.name,
                count: roundMotions.length,
              })}
            </h2>

            {roundMotions.length === 0 ? (
              <p className="simpletab-empty">{t("motions.emptyMotions")}</p>
            ) : (
              <div className="simpletab-table-wrap">
                <table className="simpletab-table">
                  <caption>
                    {t("motions.tableCaption", { round: selectedRound.name })}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("motions.colMotion")}</th>
                      <th scope="col">{t("motions.colInfoSlide")}</th>
                      <th scope="col">{t("motions.colStatus")}</th>
                      <th scope="col">{t("motions.colActions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roundMotions.map((motion) => {
                      const errEntry = rowErrors[motion.id];
                      return (
                        <tr key={motion.id}>
                          <td>
                            <div>{motion.text}</div>
                            {motion.reference ? (
                              <div className="simpletab-hint">
                                {t("motions.referenceSummary", {
                                  reference: motion.reference,
                                })}
                              </div>
                            ) : null}
                            {errEntry !== undefined ? (
                              <InlineOpError
                                error={errEntry.error}
                                onRetry={() => {
                                  void submitDeleteMotion(
                                    motion.id,
                                    withFreshVersions(
                                      errEntry.retryRequest,
                                      state.versions,
                                    ),
                                  );
                                }}
                                onDismiss={() => {
                                  setRowErrors((prev) => {
                                    const next = { ...prev };
                                    delete next[motion.id];
                                    return next;
                                  });
                                }}
                              />
                            ) : null}
                          </td>
                          <td>
                            {hasInfoSlide(motion) ? (
                              <div>{motion.infoSlide}</div>
                            ) : (
                              <span className="simpletab-hint">
                                {t("common.none")}
                              </span>
                            )}
                          </td>
                          <td>
                            <span
                              className={`simpletab-badge ${
                                motion.released ? "simpletab-badge-add" : ""
                              }`}
                            >
                              {motion.released
                                ? t("motions.badgeReleased")
                                : t("motions.badgeHidden")}
                            </span>
                          </td>
                          <td>
                            <div className="simpletab-actions">
                              <button
                                type="button"
                                className="theia-button secondary"
                                onClick={() => handleStartEditMotion(motion)}
                              >
                                {t("common.edit")}
                              </button>
                              <button
                                type="button"
                                className="theia-button secondary"
                                onClick={() => {
                                  void submitDeleteMotion(motion.id);
                                }}
                              >
                                {t("common.delete")}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <form
              className="simpletab-form simpletab-manual-editor"
              onSubmit={(e) => void handleSaveMotion(e)}
            >
              <h3 className="simpletab-subtitle">
                {editingMotionId !== null
                  ? t("motions.editFormTitle")
                  : t("motions.addFormTitle")}
              </h3>
              <div className="simpletab-field">
                <label htmlFor={`${baseId}-motion-text`}>
                  {t("motions.motionTextLabel")}
                </label>
                <textarea
                  id={`${baseId}-motion-text`}
                  rows={3}
                  value={motionText}
                  onChange={(e) => setMotionText(e.target.value)}
                />
              </div>
              <div className="simpletab-field">
                <label htmlFor={`${baseId}-motion-info`}>
                  {t("motions.infoSlideLabel")}
                </label>
                <textarea
                  id={`${baseId}-motion-info`}
                  rows={3}
                  value={motionInfoSlide}
                  onChange={(e) => setMotionInfoSlide(e.target.value)}
                />
              </div>
              <div className="simpletab-field">
                <label htmlFor={`${baseId}-motion-ref`}>
                  {t("motions.referenceLabel")}
                </label>
                <input
                  id={`${baseId}-motion-ref`}
                  type="text"
                  value={motionReference}
                  onChange={(e) => setMotionReference(e.target.value)}
                />
              </div>

              {motionFormSuccess !== null ? (
                <div className="simpletab-alert simpletab-alert-success" role="status">
                  {motionFormSuccess}
                </div>
              ) : null}
              {motionFormError !== null ? (
                <InlineOpError
                  error={motionFormError}
                  onDismiss={() => setMotionFormError(null)}
                />
              ) : null}

              <div className="simpletab-actions">
                <button type="submit" className="theia-button">
                  {editingMotionId !== null
                    ? t("motions.saveMotionButton")
                    : t("motions.addMotionButton")}
                </button>
                {editingMotionId !== null ? (
                  <button
                    type="button"
                    className="theia-button secondary"
                    onClick={handleCancelEditMotion}
                  >
                    {t("common.cancel")}
                  </button>
                ) : null}
              </div>
            </form>
          </section>
        </>
      )}
    </div>
  );
};
