import { adminFeedbackLinkError } from "@/features/tournament/application/feedback";
import {
  isFeedbackEnabledForRound,
  questionsForFeedbackSource,
  validateFeedbackAnswers,
} from "@/lib/feedback/questions";
import {
  feedbackVersionOptions,
  supersededFeedbackIds,
} from "@/lib/feedback/versions";
import type { FeedbackSubmission } from "@/types";
import {
  cloneValue,
  dedupeKeys,
  isFiniteNumber,
  isNonEmptyText,
  isValidIsoInstant,
} from "../setup/helpers";
import { recordKey, type OpDef, type TournamentState } from "../types";

export interface FeedbackEnterPayload {
  feedback: FeedbackSubmission;
  supersededIds?: string[];
}

export interface FeedbackReceiveOnlinePayload {
  feedback: FeedbackSubmission;
  receivedAt?: string;
  supersededIds?: string[];
}

export interface FeedbackReviewPayload {
  feedbackId: string;
  confirmed?: boolean;
  ignored?: boolean;
  restoreIgnored?: boolean | null;
  previousConfirmed?: boolean;
  previousIgnored?: boolean | null;
}

function validateCommonFeedback(
  state: TournamentState,
  feedback: FeedbackSubmission,
): string[] {
  if (!isNonEmptyText(feedback.id)) {
    return ["Feedback id must not be empty."];
  }
  if (state.feedback.some((item) => item.id === feedback.id)) {
    return [`Feedback ${feedback.id} already exists.`];
  }
  if (!isNonEmptyText(feedback.roundId)) {
    return ["Feedback roundId must not be empty."];
  }
  if (!isNonEmptyText(feedback.debateId)) {
    return ["Feedback debateId must not be empty."];
  }

  const round = state.rounds.find((item) => item.id === feedback.roundId);
  if (!round) {
    return [`Round ${feedback.roundId} does not exist.`];
  }
  if (round.cancelled) {
    return [`${round.name} is cancelled.`];
  }

  const debate = state.debates.find((item) => item.id === feedback.debateId);
  if (!debate || debate.roundId !== feedback.roundId) {
    return ["Choose a debate from the selected round."];
  }

  const errors: string[] = [];
  const minScore = state.tournament.preferences.feedbackMinScore ?? 1;
  const maxScore = state.tournament.preferences.feedbackMaxScore ?? 5;
  if (
    !isFiniteNumber(feedback.score) ||
    feedback.score < minScore ||
    feedback.score > maxScore
  ) {
    errors.push(`Feedback score must be between ${minScore} and ${maxScore}.`);
  }

  if (feedback.sourceType !== "team" && feedback.sourceType !== "adjudicator") {
    errors.push("Feedback sourceType must be \"team\" or \"adjudicator\".");
    return errors;
  }

  const targetType = feedback.targetType ?? "adjudicator";
  if (targetType === "adjudicator") {
    const linkError = adminFeedbackLinkError(feedback, state.debates);
    if (linkError) {
      errors.push(linkError);
    }
  } else {
    const teamInDebate = Object.values(debate.teams ?? {}).some(
      (slot) => slot?.teamId === feedback.targetTeamId,
    );
    if (!feedback.targetTeamId || !teamInDebate) {
      errors.push("The target team did not take part in that debate.");
    }
    const panel = [
      debate.adjudicators?.chairId,
      ...(debate.adjudicators?.panellistIds ?? []),
      ...(debate.adjudicators?.traineeIds ?? []),
    ];
    const sourceInDebate =
      feedback.sourceType === "team"
        ? Object.values(debate.teams ?? {}).some(
            (slot) => slot?.teamId === feedback.sourceId,
          )
        : panel.includes(feedback.sourceId);
    if (!sourceInDebate) {
      errors.push("The source did not take part in that debate.");
    }
    if (feedback.sourceType === "team" && feedback.sourceId === feedback.targetTeamId) {
      errors.push("A team cannot give feedback on itself.");
    }
  }

  const questions = questionsForFeedbackSource(
    feedback.sourceType,
    state.tournament.preferences,
  );
  const answerError = validateFeedbackAnswers(questions, feedback.answers ?? {});
  if (answerError) {
    errors.push(answerError);
  }
  return errors;
}

function applyFeedbackSubmission(
  state: TournamentState,
  feedback: FeedbackSubmission,
): { nextFeedback: FeedbackSubmission[]; supersededIds: string[] } {
  const round = state.rounds.find((item) => item.id === feedback.roundId);
  const versionOpts = feedbackVersionOptions(state.tournament.preferences, round);
  const supersededIds = supersededFeedbackIds(
    [feedback],
    state.feedback,
    versionOpts,
  );
  const supersededSet = new Set(supersededIds);
  const nextFeedback = [
    ...state.feedback.map((item) =>
      supersededSet.has(item.id)
        ? { ...cloneValue(item), confirmed: false }
        : item,
    ),
    feedback,
  ];
  return { nextFeedback, supersededIds };
}

export const feedbackEnterOp: OpDef<FeedbackEnterPayload> = {
  type: "feedback.enter",
  permission: "feedback.enter",
  category: "feedback",
  visibility: "private",
  lock: false,
  reads(state, payload) {
    return dedupeKeys([
      recordKey("round", payload.feedback.roundId),
      recordKey("debate", payload.feedback.debateId),
      recordKey("feedback", payload.feedback.id),
      ...state.feedback
        .filter((item) => item.debateId === payload.feedback.debateId)
        .map((item) => recordKey("feedback", item.id)),
    ]);
  },
  writes(state, payload) {
    const round = state.rounds.find((item) => item.id === payload.feedback.roundId);
    const superseded =
      payload.supersededIds ??
      supersededFeedbackIds(
        [payload.feedback],
        state.feedback,
        feedbackVersionOptions(state.tournament.preferences, round),
      );
    return dedupeKeys([
      recordKey("feedback", payload.feedback.id),
      ...superseded.map((id) => recordKey("feedback", id)),
    ]);
  },
  validate(state, payload) {
    return validateCommonFeedback(state, payload.feedback);
  },
  apply(state, payload) {
    const created = cloneValue(payload.feedback);
    const { nextFeedback, supersededIds } = applyFeedbackSubmission(state, created);
    return {
      state: {
        ...state,
        feedback: nextFeedback,
      },
      committedPayload: {
        feedback: cloneValue(created),
        supersededIds,
      },
    };
  },
  inverse(committedPayload) {
    return {
      type: "feedback.review",
      payload: {
        feedbackId: committedPayload.feedback.id,
        ignored: true,
        confirmed: false,
      },
    };
  },
};

export const feedbackReceiveOnlineOp: OpDef<FeedbackReceiveOnlinePayload> = {
  type: "feedback.receive_online",
  permission: "service",
  category: "feedback",
  visibility: "private",
  lock: false,
  reads(state, payload) {
    return dedupeKeys([
      recordKey("tournament", state.tournament.id),
      recordKey("round", payload.feedback.roundId),
      recordKey("debate", payload.feedback.debateId),
      recordKey("feedback", payload.feedback.id),
      ...state.feedback
        .filter((item) => item.debateId === payload.feedback.debateId)
        .map((item) => recordKey("feedback", item.id)),
    ]);
  },
  writes(state, payload) {
    const round = state.rounds.find((item) => item.id === payload.feedback.roundId);
    const superseded =
      payload.supersededIds ??
      supersededFeedbackIds(
        [payload.feedback],
        state.feedback,
        feedbackVersionOptions(state.tournament.preferences, round),
      );
    return dedupeKeys([
      recordKey("feedback", payload.feedback.id),
      ...superseded.map((id) => recordKey("feedback", id)),
    ]);
  },
  validate(state, payload) {
    const errors = validateCommonFeedback(state, payload.feedback);
    if (errors.length > 0) {
      return errors;
    }

    if (state.tournament.preferences.privateUrlFeedback === false) {
      return ["Private URL feedback is disabled for this tournament."];
    }
    const round = state.rounds.find(
      (item) => item.id === payload.feedback.roundId,
    )!;
    const debate = state.debates.find(
      (item) => item.id === payload.feedback.debateId,
    )!;
    if (
      !isFeedbackEnabledForRound(
        debate,
        round,
        state.tournament.preferences.feedbackInEliminationRounds ?? true,
      )
    ) {
      return ["Feedback is not enabled for this debate."];
    }

    if (
      payload.receivedAt !== undefined &&
      !isValidIsoInstant(payload.receivedAt)
    ) {
      return ["receivedAt must be a valid ISO 8601 instant."];
    }

    const deadline = round.simpletab?.feedbackDeadline;
    if (
      state.runtime?.portalEnforcing === true &&
      typeof deadline === "string" &&
      deadline.trim().length > 0
    ) {
      const effectiveAt = payload.receivedAt ?? state.runtime.now;
      const atMs = Date.parse(effectiveAt);
      const deadlineMs = Date.parse(deadline);
      if (Number.isFinite(atMs) && Number.isFinite(deadlineMs) && atMs >= deadlineMs) {
        return [`Feedback deadline for ${round.name} has passed.`];
      }
    }

    return [];
  },
  apply(state, payload) {
    const created = cloneValue(payload.feedback);
    const { nextFeedback, supersededIds } = applyFeedbackSubmission(state, created);
    return {
      state: {
        ...state,
        feedback: nextFeedback,
      },
      committedPayload: {
        ...cloneValue(payload),
        feedback: cloneValue(created),
        supersededIds,
      },
    };
  },
  inverse(committedPayload) {
    return {
      type: "feedback.review",
      payload: {
        feedbackId: committedPayload.feedback.id,
        ignored: true,
        confirmed: false,
      },
    };
  },
};

export const feedbackReviewOp: OpDef<FeedbackReviewPayload> = {
  type: "feedback.review",
  permission: "feedback.view",
  category: "feedback",
  visibility: "private",
  lock: false,
  reads(_state, payload) {
    return [recordKey("feedback", payload.feedbackId)];
  },
  writes(_state, payload) {
    return [recordKey("feedback", payload.feedbackId)];
  },
  validate(state, payload) {
    if (!isNonEmptyText(payload.feedbackId)) {
      return ["feedbackId must not be empty."];
    }
    const existing = state.feedback.find((item) => item.id === payload.feedbackId);
    if (!existing) {
      return [`Feedback ${payload.feedbackId} does not exist.`];
    }
    if (
      payload.confirmed === undefined &&
      payload.ignored === undefined &&
      payload.restoreIgnored === undefined
    ) {
      return ["Provide confirmed or ignored to update feedback review state."];
    }
    if (payload.confirmed !== undefined && typeof payload.confirmed !== "boolean") {
      return ["confirmed must be a boolean."];
    }
    if (payload.ignored !== undefined && typeof payload.ignored !== "boolean") {
      return ["ignored must be a boolean."];
    }
    if (
      payload.restoreIgnored !== undefined &&
      payload.restoreIgnored !== null &&
      typeof payload.restoreIgnored !== "boolean"
    ) {
      return ["restoreIgnored must be a boolean or null."];
    }
    return [];
  },
  apply(state, payload) {
    const existing = state.feedback.find(
      (item) => item.id === payload.feedbackId,
    )!;
    const previousConfirmed = existing.confirmed;
    const previousIgnored = existing.ignored ?? null;
    const updated = cloneValue(existing);

    if (payload.confirmed !== undefined) {
      updated.confirmed = payload.confirmed;
    }
    if (payload.restoreIgnored !== undefined) {
      if (payload.restoreIgnored === null) {
        delete updated.ignored;
      } else {
        updated.ignored = payload.restoreIgnored;
      }
    } else if (payload.ignored !== undefined) {
      updated.ignored = payload.ignored;
    }

    return {
      state: {
        ...state,
        feedback: state.feedback.map((item) =>
          item.id === updated.id ? updated : item,
        ),
      },
      committedPayload: {
        ...cloneValue(payload),
        previousConfirmed,
        previousIgnored,
      },
    };
  },
  inverse(committedPayload) {
    if (committedPayload.previousConfirmed === undefined) {
      return null;
    }
    return {
      type: "feedback.review",
      payload: {
        feedbackId: committedPayload.feedbackId,
        confirmed: committedPayload.previousConfirmed,
        ...(committedPayload.previousIgnored === null ||
        committedPayload.previousIgnored === undefined
          ? { restoreIgnored: null }
          : { ignored: committedPayload.previousIgnored }),
      },
    };
  },
};
