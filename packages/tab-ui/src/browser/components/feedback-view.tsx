import { adminFeedbackLinkError } from "@simpletab/core/features/tournament/application/feedback";
import { feedbackPathsForRound, describeFeedbackPaths } from "@simpletab/core/lib/feedback/paths";
import { roundFeedbackProgress } from "@simpletab/core/lib/feedback/progress";
import {
  integerScaleChoices,
  isFeedbackEnabledForRound,
  numericBoundsText,
  questionsForFeedbackSource,
  validateFeedbackAnswers,
} from "@simpletab/core/lib/feedback/questions";
import {
  defaultFeedbackScore,
  feedbackScoreStep,
  validateFeedbackScore,
} from "@simpletab/core/lib/scoring/validator";
import type {
  Debate,
  FeedbackAnswer,
  FeedbackQuestion,
  FeedbackSubmission,
} from "@simpletab/core/types";
import type {
  HostStatus,
  ProjectedState,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import type { ActionRunner } from "../actions/action";
import {
  enterFeedbackAction,
  FEEDBACK_REVIEW_PATCHES,
  reviewFeedbackAction,
  type ReviewFeedbackPatch,
} from "../actions/feedback-actions";
import { openSetupAction } from "../actions/releases-actions";
import { t } from "../i18n";
import { stateHasPermission } from "../lib/permissions";
import { InlineOpError, type InlineOpErrorData } from "./inline-op-error";
import { LockBanner } from "./lock-banner";
import { getDefaultRoundId, RoundPicker } from "./round-picker";

export interface FeedbackViewProps {
  state: ProjectedState | null;
  status: HostStatus;
  selectedRoundId?: string;
  onSelectRound?: (roundId: string) => void;
  /** Feedback actions are the only way this page changes tournament data. */
  run: ActionRunner;
  nowIso?: string;
}

interface RowErrorEntry {
  error: InlineOpErrorData;
  retry: () => void;
}

function createFeedbackId(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return `fb-${globalThis.crypto.randomUUID()}`;
  }
  return `fb-${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
}

function roomTitle(debate: Debate | undefined): string {
  if (debate === undefined) {
    return t("feedback.unknownRoom");
  }
  return debate.venueName || t("draw.roomFallback", { rank: debate.roomRank });
}

function debateAdjudicatorIds(debate: Debate): string[] {
  const panel = debate.adjudicators;
  return [
    ...(panel.chairId ? [panel.chairId] : []),
    ...panel.panellistIds,
    ...panel.traineeIds,
  ];
}

export const FeedbackView: React.FC<FeedbackViewProps> = ({
  state,
  status,
  selectedRoundId: controlledRoundId,
  onSelectRound,
  run,
  nowIso,
}) => {
  const baseId = React.useId();
  const [uncontrolledRoundId, setUncontrolledRoundId] = React.useState("");

  // Entry form state
  const [selectedDebateId, setSelectedDebateId] = React.useState("");
  const [sourceType, setSourceType] = React.useState<"team" | "adjudicator">(
    "team",
  );
  const [sourceId, setSourceId] = React.useState("");
  const [targetType, setTargetType] = React.useState<"adjudicator" | "team">(
    "adjudicator",
  );
  const [targetId, setTargetId] = React.useState("");
  const [scoreInput, setScoreInput] = React.useState(() =>
    String(defaultFeedbackScore(state?.tournament.preferences)),
  );
  const [agreeValue, setAgreeValue] = React.useState<"" | "yes" | "no">("");
  const [comments, setComments] = React.useState("");
  const [answers, setAnswers] = React.useState<Record<string, FeedbackAnswer>>(
    {},
  );
  const [confirmOnEnter, setConfirmOnEnter] = React.useState(true);
  const [entryError, setEntryError] = React.useState<InlineOpErrorData | null>(
    null,
  );
  const [entrySuccess, setEntrySuccess] = React.useState<string | null>(null);

  // Review table errors
  const [reviewErrors, setReviewErrors] = React.useState<
    Record<string, RowErrorEntry>
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

  React.useEffect(() => {
    if (state === null) {
      return;
    }
    setScoreInput(String(defaultFeedbackScore(state.tournament.preferences)));
    setAnswers({});
  }, [state?.tournament.id, selectedRound?.id]);

  React.useEffect(() => {
    if (selectedDebate === undefined) {
      setSourceId("");
      setTargetId("");
      return;
    }
    const teamSources = Object.values(selectedDebate.teams)
      .map((slot) => slot?.teamId)
      .filter((id): id is string => Boolean(id));
    const adjList = debateAdjudicatorIds(selectedDebate);

    const validSources = sourceType === "team" ? teamSources : adjList;
    if (!validSources.includes(sourceId)) {
      setSourceId(validSources[0] ?? "");
    }

    const validTargets =
      targetType === "team"
        ? teamSources.filter((id) => !(sourceType === "team" && id === sourceId))
        : adjList.filter(
            (id) => !(sourceType === "adjudicator" && id === sourceId),
          );
    if (!validTargets.includes(targetId)) {
      setTargetId(validTargets[0] ?? "");
    }
  }, [selectedDebate, sourceType, sourceId, targetType, targetId]);

  if (state === null) {
    return (
      <div className="simpletab-page">
        <div className="simpletab-header">
          <h1 className="simpletab-title">{t("feedback.title")}</h1>
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

  if (!stateHasPermission(state, "feedback.view")) {
    return (
      <div className="simpletab-page">
        <div className="simpletab-header">
          <h1 className="simpletab-title">{t("feedback.title")}</h1>
        </div>
        <div className="simpletab-alert simpletab-alert-error" role="alert">
          {t("feedback.noPermission")}
        </div>
      </div>
    );
  }

  const isHostOwner = state.roleId === "host_owner";
  const prefs = state.tournament.preferences;
  const teamById = new Map(state.teams.map((item) => [item.id, item]));
  const adjById = new Map(state.adjudicators.map((item) => [item.id, item]));
  const debateById = new Map(roundDebates.map((item) => [item.id, item]));

  const handleSelectRound = (roundId: string): void => {
    setEntryError(null);
    setEntrySuccess(null);
    setReviewErrors({});
    if (controlledRoundId === undefined) {
      setUncontrolledRoundId(roundId);
    }
    onSelectRound?.(roundId);
  };

  const paths = feedbackPathsForRound(prefs, selectedRound);
  const progress =
    selectedRound !== undefined
      ? roundFeedbackProgress(
          selectedRound,
          state.debates,
          state.feedback,
          paths,
          prefs.feedbackInEliminationRounds ?? true,
        )
      : null;

  const roundSubmissions =
    selectedRound !== undefined
      ? state.feedback
          .filter((item) => item.roundId === selectedRound.id)
          .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))
      : [];

  const questions = questionsForFeedbackSource(sourceType, prefs);
  const minFeedbackScore = prefs.feedbackMinScore ?? 1;
  const maxFeedbackScore = prefs.feedbackMaxScore ?? 10;
  const scoreStep = feedbackScoreStep(prefs);

  const sourceOptions: Array<{ id: string; label: string }> =
    selectedDebate === undefined
      ? []
      : sourceType === "team"
        ? Object.values(selectedDebate.teams)
            .filter((slot) => Boolean(slot?.teamId))
            .map((slot) => ({
              id: slot.teamId,
              label: slot.teamName || teamById.get(slot.teamId)?.name || slot.teamId,
            }))
        : debateAdjudicatorIds(selectedDebate).map((id) => ({
            id,
            label: adjById.get(id)?.name ?? id,
          }));

  const targetOptions: Array<{ id: string; label: string }> =
    selectedDebate === undefined
      ? []
      : targetType === "team"
        ? Object.values(selectedDebate.teams)
            .filter(
              (slot) =>
                Boolean(slot?.teamId) &&
                !(sourceType === "team" && slot.teamId === sourceId),
            )
            .map((slot) => ({
              id: slot.teamId,
              label: slot.teamName || teamById.get(slot.teamId)?.name || slot.teamId,
            }))
        : debateAdjudicatorIds(selectedDebate)
            .filter((id) => !(sourceType === "adjudicator" && id === sourceId))
            .map((id) => ({
              id,
              label: adjById.get(id)?.name ?? id,
            }));

  const renderQuestionControl = (question: FeedbackQuestion): React.ReactNode => {
    const qId = `${baseId}-q-${question.id}`;
    const value = answers[question.id];
    const bounds = numericBoundsText(question);
    const labelSuffix = `${question.required ? " *" : ""}${bounds ? ` (${bounds})` : ""}`;

    if (question.type === "textarea") {
      return (
        <div key={question.id} className="simpletab-field">
          <label htmlFor={qId}>{`${question.label}${labelSuffix}`}</label>
          <textarea
            id={qId}
            rows={2}
            value={typeof value === "string" ? value : ""}
            onChange={(e) =>
              setAnswers((prev) => ({ ...prev, [question.id]: e.target.value }))
            }
          />
        </div>
      );
    }

    if (
      question.type === "scale" ||
      question.type === "integer" ||
      question.type === "float"
    ) {
      return (
        <div key={question.id} className="simpletab-field">
          <label htmlFor={qId}>{`${question.label}${labelSuffix}`}</label>
          <input
            id={qId}
            type="number"
            min={question.min}
            max={question.max}
            step={question.type === "integer" ? 1 : "any"}
            value={typeof value === "number" && Number.isFinite(value) ? String(value) : ""}
            onChange={(e) => {
              const raw = e.target.value;
              setAnswers((prev) => ({
                ...prev,
                [question.id]: raw === "" ? null : Number(raw),
              }));
            }}
          />
        </div>
      );
    }

    if (question.type === "integer_scale") {
      const choices = integerScaleChoices(question);
      return (
        <div key={question.id} className="simpletab-field">
          <label htmlFor={qId}>{`${question.label}${labelSuffix}`}</label>
          <select
            id={qId}
            value={typeof value === "number" ? String(value) : ""}
            onChange={(e) => {
              const raw = e.target.value;
              setAnswers((prev) => ({
                ...prev,
                [question.id]: raw === "" ? null : Number(raw),
              }));
            }}
          >
            <option value="">{t("feedback.selectOption")}</option>
            {choices.map((choice) => (
              <option key={choice} value={String(choice)}>
                {String(choice)}
              </option>
            ))}
          </select>
        </div>
      );
    }

    if (question.type === "yes_no") {
      return (
        <div key={question.id} className="simpletab-field">
          <label htmlFor={qId}>{`${question.label}${labelSuffix}`}</label>
          <select
            id={qId}
            value={
              value === true ? "true" : value === false ? "false" : ""
            }
            onChange={(e) => {
              const raw = e.target.value;
              setAnswers((prev) => ({
                ...prev,
                [question.id]:
                  raw === "true" ? true : raw === "false" ? false : null,
              }));
            }}
          >
            <option value="">{t("feedback.selectOption")}</option>
            <option value="true">{t("common.yes")}</option>
            <option value="false">{t("common.no")}</option>
          </select>
        </div>
      );
    }

    if (question.type === "checkbox") {
      return (
        <label key={question.id} className="simpletab-checkbox-item">
          <input
            id={qId}
            type="checkbox"
            checked={value === true}
            onChange={(e) =>
              setAnswers((prev) => ({
                ...prev,
                [question.id]: e.target.checked,
              }))
            }
          />
          <span>{`${question.label}${labelSuffix}`}</span>
        </label>
      );
    }

    if (question.type === "select_one") {
      return (
        <div key={question.id} className="simpletab-field">
          <label htmlFor={qId}>{`${question.label}${labelSuffix}`}</label>
          <select
            id={qId}
            value={typeof value === "string" ? value : ""}
            onChange={(e) =>
              setAnswers((prev) => ({
                ...prev,
                [question.id]: e.target.value || null,
              }))
            }
          >
            <option value="">{t("feedback.selectOption")}</option>
            {(question.options ?? []).map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
      );
    }

    if (question.type === "select_many") {
      const selectedList = Array.isArray(value) ? value : [];
      return (
        <fieldset key={question.id} className="simpletab-fieldset">
          <legend>{`${question.label}${labelSuffix}`}</legend>
          <div className="simpletab-checkbox-row">
            {(question.options ?? []).map((opt) => {
              const checked = selectedList.includes(opt);
              return (
                <label key={opt} className="simpletab-checkbox-item">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...selectedList, opt]
                        : selectedList.filter((item) => item !== opt);
                      setAnswers((prev) => ({ ...prev, [question.id]: next }));
                    }}
                  />
                  <span>{opt}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      );
    }

    return (
      <div key={question.id} className="simpletab-field">
        <label htmlFor={qId}>{`${question.label}${labelSuffix}`}</label>
        <input
          id={qId}
          type="text"
          value={typeof value === "string" ? value : ""}
          onChange={(e) =>
            setAnswers((prev) => ({ ...prev, [question.id]: e.target.value }))
          }
        />
      </div>
    );
  };

  const handleEnterFeedback = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (selectedRound === undefined || selectedDebate === undefined) {
      return;
    }
    setEntryError(null);
    setEntrySuccess(null);

    const parsedScore = Number(scoreInput.trim());
    const scoreCheck = validateFeedbackScore(parsedScore, prefs);
    if (!scoreCheck.valid) {
      setEntryError({
        code: "INVALID",
        errors: [scoreCheck.error ?? t("feedback.invalidScore")],
      });
      return;
    }

    const answerError = validateFeedbackAnswers(questions, answers);
    if (answerError !== null) {
      setEntryError({
        code: "INVALID",
        errors: [answerError],
      });
      return;
    }

    const sourceLabel =
      sourceOptions.find((item) => item.id === sourceId)?.label ?? sourceId;
    const targetLabel =
      targetOptions.find((item) => item.id === targetId)?.label ?? targetId;

    const feedback: FeedbackSubmission = {
      id: createFeedbackId(),
      tournamentId: state.tournament.id,
      roundId: selectedRound.id,
      debateId: selectedDebate.id,
      targetType,
      ...(targetType === "adjudicator"
        ? {
            targetAdjudicatorId: targetId,
            targetAdjudicatorName: targetLabel,
          }
        : {
            targetTeamId: targetId,
            targetTeamName: targetLabel,
          }),
      sourceType,
      sourceId,
      sourceName: sourceLabel,
      score: parsedScore,
      ...(agreeValue === "yes"
        ? { agreeWithDecision: true }
        : agreeValue === "no"
          ? { agreeWithDecision: false }
          : {}),
      ...(comments.trim().length > 0 ? { comments: comments.trim() } : {}),
      ...(questions.length > 0 ? { answers } : {}),
      confirmed: confirmOnEnter,
      timestamp: nowIso ?? new Date().toISOString(),
    };

    if (targetType === "adjudicator") {
      const linkErr = adminFeedbackLinkError(feedback, state.debates);
      if (linkErr !== null) {
        setEntryError({
          code: "INVALID",
          errors: [linkErr],
        });
        return;
      }
    }

    const result = await run(enterFeedbackAction, { feedback });
    if (!result.ok) {
      setEntryError({
        code: result.code,
        errors: result.errors,
        current: result.current,
      });
      return;
    }
    setComments("");
    setAnswers({});
    setAgreeValue("");
    setEntrySuccess(
      t("feedback.enteredSuccess", {
        source: sourceLabel,
        target: targetLabel,
      }),
    );
  };

  const submitReview = async (
    item: FeedbackSubmission,
    patch: ReviewFeedbackPatch,
  ): Promise<void> => {
    setReviewErrors((prev) => {
      if (!(item.id in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
    const result = await run(reviewFeedbackAction, { feedbackId: item.id, patch });
    if (!result.ok) {
      setReviewErrors((prev) => ({
        ...prev,
        [item.id]: {
          error: {
            code: result.code,
            errors: result.errors,
            current: result.current,
          },
          retry: () => {
            void submitReview(item, patch);
          },
        },
      }));
    }
  };

  return (
    <div className="simpletab-page">
      <div className="simpletab-header">
        <h1 className="simpletab-title">{t("feedback.title")}</h1>
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
          {t("feedback.noRounds")}
        </div>
      ) : (
        <>
          <section
            className="simpletab-section"
            aria-labelledby={`${baseId}-progress-h`}
          >
            <div className="simpletab-toolbar">
              <div>
                <h2 id={`${baseId}-progress-h`} className="simpletab-subtitle">
                  {t("feedback.progressSectionTitle")}
                </h2>
                <div className="simpletab-hint">
                  {t("feedback.pathsSummary", {
                    paths: describeFeedbackPaths(paths),
                  })}
                </div>
              </div>
              {progress !== null ? (
                <div className="simpletab-count-summary" role="status">
                  {progress.enabled
                    ? t("feedback.progressCounts", {
                        submitted: progress.submitted,
                        expected: progress.expected,
                      })
                    : t("feedback.disabledForRound")}
                </div>
              ) : null}
            </div>

            {progress !== null && progress.enabled ? (
              progress.outstanding.length === 0 ? (
                <div className="simpletab-alert simpletab-alert-success" role="status">
                  {progress.expected > 0
                    ? t("feedback.allSubmitted")
                    : t("feedback.noneExpected")}
                </div>
              ) : (
                <div className="simpletab-table-wrap">
                  <table className="simpletab-table">
                    <caption>{t("feedback.outstandingCaption")}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t("feedback.colRoom")}</th>
                        <th scope="col">{t("feedback.colSource")}</th>
                        <th scope="col">{t("feedback.colOwedTargets")}</th>
                        <th scope="col">{t("feedback.colActions")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {progress.outstanding.map((item) => {
                        const debate = debateById.get(item.debateId);
                        const sourceLabel =
                          item.sourceType === "team"
                            ? (teamById.get(item.sourceId)?.name ?? item.sourceId)
                            : (adjById.get(item.sourceId)?.name ?? item.sourceId);
                        const owedText = item.owed
                          .map(
                            (target) =>
                              adjById.get(target.targetAdjudicatorId)?.name ??
                              target.targetAdjudicatorId,
                          )
                          .join(", ");
                        return (
                          <tr
                            key={`${item.debateId}-${item.sourceType}-${item.sourceId}`}
                          >
                            <td>{roomTitle(debate)}</td>
                            <td>{sourceLabel}</td>
                            <td>{owedText}</td>
                            <td>
                              <button
                                type="button"
                                className="theia-button secondary"
                                data-view-only
                                onClick={() => {
                                  setSelectedDebateId(item.debateId);
                                  setSourceType(item.sourceType);
                                  setSourceId(item.sourceId);
                                  setTargetType("adjudicator");
                                  if (item.owed[0]) {
                                    setTargetId(item.owed[0].targetAdjudicatorId);
                                  }
                                }}
                              >
                                {t("feedback.fillForSourceButton")}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )
            ) : null}
          </section>

          <section
            className="simpletab-section"
            aria-labelledby={`${baseId}-enter-h`}
          >
            <h2 id={`${baseId}-enter-h`} className="simpletab-subtitle">
              {t("feedback.enterSectionTitle")}
            </h2>

            {roundDebates.length === 0 ? (
              <p className="simpletab-empty">{t("feedback.noDebatesInRound")}</p>
            ) : (
              <form
                className="simpletab-form"
                onSubmit={(e) => void handleEnterFeedback(e)}
              >
                <div className="simpletab-form-grid">
                  <div className="simpletab-field">
                    <label htmlFor={`${baseId}-debate`}>
                      {t("feedback.debateLabel")}
                    </label>
                    <select
                      id={`${baseId}-debate`}
                      value={selectedDebateId}
                      onChange={(e) => setSelectedDebateId(e.target.value)}
                    >
                      {roundDebates.map((debate) => (
                        <option key={debate.id} value={debate.id}>
                          {roomTitle(debate)}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="simpletab-field">
                    <label htmlFor={`${baseId}-source-type`}>
                      {t("feedback.sourceTypeLabel")}
                    </label>
                    <select
                      id={`${baseId}-source-type`}
                      value={sourceType}
                      onChange={(e) =>
                        setSourceType(e.target.value as "team" | "adjudicator")
                      }
                    >
                      <option value="team">{t("feedback.sourceTypeTeam")}</option>
                      <option value="adjudicator">
                        {t("feedback.sourceTypeAdjudicator")}
                      </option>
                    </select>
                  </div>

                  <div className="simpletab-field">
                    <label htmlFor={`${baseId}-source-id`}>
                      {t("feedback.sourceLabel")}
                    </label>
                    <select
                      id={`${baseId}-source-id`}
                      value={sourceId}
                      onChange={(e) => setSourceId(e.target.value)}
                    >
                      {sourceOptions.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {paths.onTeams ? (
                    <div className="simpletab-field">
                      <label htmlFor={`${baseId}-target-type`}>
                        {t("feedback.targetTypeLabel")}
                      </label>
                      <select
                        id={`${baseId}-target-type`}
                        value={targetType}
                        onChange={(e) =>
                          setTargetType(e.target.value as "adjudicator" | "team")
                        }
                      >
                        <option value="adjudicator">
                          {t("feedback.targetTypeAdjudicator")}
                        </option>
                        <option value="team">
                          {t("feedback.targetTypeTeam")}
                        </option>
                      </select>
                    </div>
                  ) : null}

                  <div className="simpletab-field">
                    <label htmlFor={`${baseId}-target-id`}>
                      {t("feedback.targetLabel")}
                    </label>
                    <select
                      id={`${baseId}-target-id`}
                      value={targetId}
                      onChange={(e) => setTargetId(e.target.value)}
                    >
                      {targetOptions.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="simpletab-field">
                    <label htmlFor={`${baseId}-score`}>
                      {t("feedback.scoreLabel", {
                        min: minFeedbackScore,
                        max: maxFeedbackScore,
                      })}
                    </label>
                    <input
                      id={`${baseId}-score`}
                      type="number"
                      min={minFeedbackScore}
                      max={maxFeedbackScore}
                      step={scoreStep}
                      value={scoreInput}
                      onChange={(e) => setScoreInput(e.target.value)}
                    />
                  </div>

                  <div className="simpletab-field">
                    <label htmlFor={`${baseId}-agree`}>
                      {t("feedback.agreeLabel")}
                    </label>
                    <select
                      id={`${baseId}-agree`}
                      value={agreeValue}
                      onChange={(e) =>
                        setAgreeValue(e.target.value as "" | "yes" | "no")
                      }
                    >
                      <option value="">{t("feedback.agreeUnspecified")}</option>
                      <option value="yes">{t("common.yes")}</option>
                      <option value="no">{t("common.no")}</option>
                    </select>
                  </div>
                </div>

                {questions.length > 0 ? (
                  <div className="simpletab-fieldset">
                    <div className="simpletab-count-summary">
                      {t("feedback.questionsHeading")}
                    </div>
                    {questions.map(renderQuestionControl)}
                  </div>
                ) : null}

                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-comments`}>
                    {t("feedback.commentsLabel")}
                  </label>
                  <textarea
                    id={`${baseId}-comments`}
                    rows={2}
                    value={comments}
                    onChange={(e) => setComments(e.target.value)}
                  />
                </div>

                <label className="simpletab-checkbox-item">
                  <input
                    type="checkbox"
                    checked={confirmOnEnter}
                    onChange={(e) => setConfirmOnEnter(e.target.checked)}
                  />
                  <span>{t("feedback.confirmOnEnterLabel")}</span>
                </label>

                {selectedDebate &&
                !isFeedbackEnabledForRound(
                  selectedDebate,
                  selectedRound,
                  prefs.feedbackInEliminationRounds ?? true,
                ) ? (
                  <div className="simpletab-alert simpletab-alert-warning" role="status">
                    {t("feedback.roundDebateDisabledHint")}
                  </div>
                ) : null}

                {entrySuccess !== null ? (
                  <div className="simpletab-alert simpletab-alert-success" role="status">
                    {entrySuccess}
                  </div>
                ) : null}
                {entryError !== null ? (
                  <InlineOpError
                    error={entryError}
                    onDismiss={() => setEntryError(null)}
                  />
                ) : null}

                <div className="simpletab-actions">
                  <button
                    type="submit"
                    className="theia-button"
                    data-action={enterFeedbackAction.id}
                    disabled={!sourceId || !targetId}
                  >
                    {t("feedback.submitButton")}
                  </button>
                </div>
              </form>
            )}
          </section>

          <section
            className="simpletab-section"
            aria-labelledby={`${baseId}-review-h`}
          >
            <h2 id={`${baseId}-review-h`} className="simpletab-subtitle">
              {t("feedback.reviewSectionTitle", {
                count: roundSubmissions.length,
              })}
            </h2>

            {roundSubmissions.length === 0 ? (
              <p className="simpletab-empty">{t("feedback.emptySubmissions")}</p>
            ) : (
              <div className="simpletab-table-wrap">
                <table className="simpletab-table">
                  <caption>
                    {t("feedback.reviewCaption", { round: selectedRound.name })}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("feedback.colRoom")}</th>
                      <th scope="col">{t("feedback.colSource")}</th>
                      <th scope="col">{t("feedback.colTarget")}</th>
                      <th scope="col">{t("feedback.colScore")}</th>
                      <th scope="col">{t("feedback.colDetails")}</th>
                      <th scope="col">{t("feedback.colStatus")}</th>
                      <th scope="col">{t("feedback.colActions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roundSubmissions.map((item) => {
                      const debate = state.debates.find(
                        (d) => d.id === item.debateId,
                      );
                      const targetName =
                        item.targetType === "team"
                          ? (item.targetTeamName ??
                            teamById.get(item.targetTeamId ?? "")?.name ??
                            item.targetTeamId ??
                            "")
                          : (item.targetAdjudicatorName ??
                            adjById.get(item.targetAdjudicatorId ?? "")?.name ??
                            item.targetAdjudicatorId ??
                            "");
                      const errEntry = reviewErrors[item.id];
                      const statusBadgeClass = item.ignored
                        ? "simpletab-badge-error"
                        : item.confirmed
                          ? "simpletab-badge-add"
                          : "simpletab-badge-conflict";
                      const statusText = item.ignored
                        ? t("feedback.statusIgnored")
                        : item.confirmed
                          ? t("feedback.statusConfirmed")
                          : t("feedback.statusPending");
                      const answerEntries = Object.entries(item.answers ?? {});

                      return (
                        <tr key={item.id}>
                          <td>{roomTitle(debate)}</td>
                          <td>
                            <div>{item.sourceName}</div>
                            <div className="simpletab-hint">
                              {item.sourceType === "team"
                                ? t("feedback.sourceTypeTeam")
                                : t("feedback.sourceTypeAdjudicator")}
                            </div>
                          </td>
                          <td>{targetName}</td>
                          <td>{item.score}</td>
                          <td>
                            {item.comments ? <div>{item.comments}</div> : null}
                            {answerEntries.length > 0 ? (
                              <div className="simpletab-hint">
                                {answerEntries
                                  .map(
                                    ([k, v]) =>
                                      `${k}: ${Array.isArray(v) ? v.join(", ") : String(v ?? "")}`,
                                  )
                                  .join("; ")}
                              </div>
                            ) : null}
                            {errEntry !== undefined ? (
                              <InlineOpError
                                error={errEntry.error}
                                onRetry={errEntry.retry}
                                onDismiss={() => {
                                  setReviewErrors((prev) => {
                                    const next = { ...prev };
                                    delete next[item.id];
                                    return next;
                                  });
                                }}
                              />
                            ) : null}
                          </td>
                          <td>
                            <span className={`simpletab-badge ${statusBadgeClass}`}>
                              {statusText}
                            </span>
                          </td>
                          <td>
                            <div className="simpletab-actions">
                              {!item.confirmed && !item.ignored ? (
                                <button
                                  type="button"
                                  className="theia-button"
                                  data-action={reviewFeedbackAction.id}
                                  onClick={() => {
                                    void submitReview(
                                      item,
                                      FEEDBACK_REVIEW_PATCHES.confirm,
                                    );
                                  }}
                                >
                                  {t("feedback.confirmButton")}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="theia-button secondary"
                                  data-action={reviewFeedbackAction.id}
                                  onClick={() => {
                                    void submitReview(
                                      item,
                                      FEEDBACK_REVIEW_PATCHES.unconfirm,
                                    );
                                  }}
                                >
                                  {t("feedback.unconfirmButton")}
                                </button>
                              )}
                              {!item.ignored ? (
                                <button
                                  type="button"
                                  className="theia-button secondary"
                                  data-action={reviewFeedbackAction.id}
                                  onClick={() => {
                                    void submitReview(
                                      item,
                                      FEEDBACK_REVIEW_PATCHES.ignore,
                                    );
                                  }}
                                >
                                  {t("feedback.ignoreButton")}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="theia-button secondary"
                                  data-action={reviewFeedbackAction.id}
                                  onClick={() => {
                                    void submitReview(
                                      item,
                                      FEEDBACK_REVIEW_PATCHES.restore,
                                    );
                                  }}
                                >
                                  {t("feedback.restoreButton")}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
};
