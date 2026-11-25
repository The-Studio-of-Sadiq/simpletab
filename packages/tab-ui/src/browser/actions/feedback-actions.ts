import { adminFeedbackLinkError } from "@simpletab/core/features/tournament/application/feedback";
import {
  integerScaleChoices,
  questionsForFeedbackSource,
  validateFeedbackAnswers,
} from "@simpletab/core/lib/feedback/questions";
import {
  defaultFeedbackScore,
  validateFeedbackScore,
} from "@simpletab/core/lib/scoring/validator";
import { recordKey, type RecordKey } from "@simpletab/core/ops";
import type {
  Debate,
  FeedbackAnswer,
  FeedbackQuestion,
  FeedbackSubmission,
} from "@simpletab/core/types";
import type {
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import { t } from "../i18n";
import { stateHasPermission } from "../lib/permissions";
import type { TournamentStoreSnapshot } from "../store/tournament-store";
import { defineAction, type ActionContext } from "./action";

/** Widget id of the Feedback page. */
export const FEEDBACK_PAGE = "simpletab-feedback-widget";

type ParticipantType = "team" | "adjudicator";

function stateOf(ctx: ActionContext): ProjectedState {
  const state = ctx.store.getState();
  if (state === null) {
    throw new Error(t("common.noTournamentPrompt"));
  }
  return state;
}

function versionOf(state: ProjectedState, key: RecordKey): number {
  return state.versions[key] ?? 0;
}

function activeRounds(state: ProjectedState): ProjectedState["rounds"] {
  return [...state.rounds].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}

function debateLabel(state: ProjectedState, debate: Debate): string {
  return debate.venueName || t("draw.roomFallback", { rank: debate.roomRank });
}

function adjudicatorIds(debate: Debate): string[] {
  const panel = debate.adjudicators;
  return [
    ...(panel.chairId ? [panel.chairId] : []),
    ...panel.panellistIds,
    ...panel.traineeIds,
  ];
}

function participants(
  state: ProjectedState,
  debate: Debate,
  type: ParticipantType,
): Array<{ value: string; label: string }> {
  const teamById = new Map(state.teams.map((team) => [team.id, team]));
  const adjById = new Map(state.adjudicators.map((item) => [item.id, item]));
  if (type === "team") {
    return Object.values(debate.teams)
      .filter((slot) => Boolean(slot?.teamId))
      .map((slot) => ({
        value: slot.teamId,
        label: slot.teamName || teamById.get(slot.teamId)?.name || slot.teamId,
      }));
  }
  return adjudicatorIds(debate).map((id) => ({
    value: id,
    label: adjById.get(id)?.name ?? id,
  }));
}

async function pickRound(ctx: ActionContext, state: ProjectedState): Promise<string | undefined> {
  return ctx.prompts.pick(
    activeRounds(state).map((round) => ({
      label: round.name,
      description: String(round.seq),
      value: round.id,
    })),
    t("action.feedback.pickRound"),
  );
}

async function pickDebate(
  ctx: ActionContext,
  state: ProjectedState,
  roundId: string,
): Promise<string | undefined> {
  return ctx.prompts.pick(
    state.debates
      .filter((debate) => debate.roundId === roundId && !debate.byeTeamId)
      .sort((a, b) => a.roomRank - b.roomRank || a.id.localeCompare(b.id))
      .map((debate) => ({
        label: debateLabel(state, debate),
        description: debate.id,
        value: debate.id,
      })),
    t("action.feedback.pickDebate"),
  );
}

async function pickParticipantType(
  ctx: ActionContext,
  question: string,
): Promise<ParticipantType | undefined> {
  return ctx.prompts.pick(
    [
      { label: t("feedback.sourceTypeTeam"), value: "team" as const },
      { label: t("feedback.sourceTypeAdjudicator"), value: "adjudicator" as const },
    ],
    question,
  );
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

/** The checks the page runs before it submits feedback, in the same order. */
export function feedbackEntryError(
  state: ProjectedState,
  feedback: FeedbackSubmission,
): string | null {
  const prefs = state.tournament.preferences;
  const scoreCheck = validateFeedbackScore(feedback.score, prefs);
  if (!scoreCheck.valid) {
    return scoreCheck.error ?? t("feedback.invalidScore");
  }
  const questions = questionsForFeedbackSource(feedback.sourceType, prefs);
  const answerError = validateFeedbackAnswers(questions, feedback.answers ?? {});
  if (answerError !== null) {
    return answerError;
  }
  return feedback.targetType === "adjudicator"
    ? adminFeedbackLinkError(feedback, state.debates)
    : null;
}

/**
 * Asks one feedback question in the palette. Returns the answer, `null` for a skipped
 * optional question, or `undefined` when the person cancels.
 */
async function askFeedbackAnswer(
  ctx: ActionContext,
  question: FeedbackQuestion,
): Promise<FeedbackAnswer | undefined> {
  const skip = { label: t("action.feedback.skipQuestion"), value: null };
  const optional = question.required ? [] : [skip];
  switch (question.type) {
    case "yes_no":
    case "checkbox":
      return ctx.prompts.pick<FeedbackAnswer>(
        [
          { label: t("common.yes"), value: true },
          { label: t("common.no"), value: false },
          ...optional,
        ],
        question.label,
      );
    case "select_one":
    case "integer_scale": {
      const choices =
        question.type === "select_one"
          ? (question.options ?? []).map((option) => ({ label: option, value: option }))
          : integerScaleChoices(question).map((value) => ({
              label: String(value),
              value,
            }));
      return ctx.prompts.pick<FeedbackAnswer>([...choices, ...optional], question.label);
    }
    case "select_many": {
      const chosen: string[] = [];
      for (;;) {
        const remaining = (question.options ?? []).filter((option) => !chosen.includes(option));
        if (remaining.length === 0) {
          return chosen;
        }
        const next = await ctx.prompts.pick(
          [
            { label: t("action.feedback.doneChoosing"), value: "" },
            ...remaining.map((option) => ({ label: option, value: option })),
          ],
          question.label,
        );
        if (next === undefined) {
          return undefined;
        }
        if (next === "") {
          return chosen;
        }
        chosen.push(next);
      }
    }
    case "scale":
    case "integer":
    case "float": {
      const raw = await ctx.prompts.input(question.label, { optional: !question.required });
      if (raw === undefined) {
        return undefined;
      }
      return raw.trim().length === 0 ? null : Number(raw.trim());
    }
    case "text":
    case "textarea": {
      const raw = await ctx.prompts.input(question.label, { optional: !question.required });
      return raw === undefined ? undefined : raw;
    }
  }
}


export interface EnterFeedbackArgs {
  feedback: FeedbackSubmission;
}

export const enterFeedbackAction = defineAction<EnterFeedbackArgs, SubmitResult>({
  id: "simpletab.feedback.enter-feedback",
  labelKey: "action.feedback.enterFeedback",
  page: FEEDBACK_PAGE,
  isEnabled(snapshot) {
    return (
      snapshot.state !== null &&
      snapshot.status.open &&
      stateHasPermission(snapshot.state, "feedback.enter") &&
      activeRounds(snapshot.state).length > 0
    );
  },
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const roundId = await pickRound(ctx, state);
    if (roundId === undefined) {
      return undefined;
    }
    const debateId = await pickDebate(ctx, state, roundId);
    if (debateId === undefined) {
      return undefined;
    }
    const debate = state.debates.find((item) => item.id === debateId);
    if (debate === undefined) {
      return undefined;
    }
    const prefs = state.tournament.preferences;
    const sourceType = await pickParticipantType(ctx, t("action.feedback.pickSourceType"));
    if (sourceType === undefined) {
      return undefined;
    }
    const sourceChoices = participants(state, debate, sourceType).filter(
      (item) => item.value.length > 0,
    );
    const sourceId = await ctx.prompts.pick(sourceChoices, t("action.feedback.pickSource"));
    if (sourceId === undefined) {
      return undefined;
    }
    const targetType = await pickParticipantType(ctx, t("action.feedback.pickTargetType"));
    if (targetType === undefined) {
      return undefined;
    }
    const targetChoices = participants(state, debate, targetType).filter(
      (item) => item.value.length > 0 && item.value !== sourceId,
    );
    const targetId = await ctx.prompts.pick(targetChoices, t("action.feedback.pickTarget"));
    if (targetId === undefined) {
      return undefined;
    }
    const rawScore = await ctx.prompts.input(t("action.feedback.pickScore"), {
      value: String(defaultFeedbackScore(prefs)),
    });
    if (rawScore === undefined) {
      return undefined;
    }
    const score = Number(rawScore.trim());
    const agree = await ctx.prompts.pick(
      [
        { label: t("common.yes"), value: "yes" as const },
        { label: t("common.no"), value: "no" as const },
        { label: t("common.none"), value: "" as const },
      ],
      t("action.feedback.pickAgree"),
    );
    if (agree === undefined) {
      return undefined;
    }
    const questions = questionsForFeedbackSource(sourceType, prefs);
    const answers: Record<string, FeedbackAnswer> = {};
    for (const question of questions) {
      const answer = await askFeedbackAnswer(ctx, question);
      if (answer === undefined) {
        return undefined;
      }
      if (answer !== null) {
        answers[question.id] = answer;
      }
    }
    const comments = await ctx.prompts.input(t("action.feedback.commentsPrompt"), {
      optional: true,
    });
    if (comments === undefined) {
      return undefined;
    }
    const confirmNow = await ctx.prompts.pick(
      [
        { label: t("common.yes"), value: true },
        { label: t("common.no"), value: false },
      ],
      t("action.feedback.confirmOnEnter"),
    );
    if (confirmNow === undefined) {
      return undefined;
    }

    const sourceLabel =
      sourceChoices.find((item) => item.value === sourceId)?.label ?? sourceId;
    const targetLabel =
      targetChoices.find((item) => item.value === targetId)?.label ?? targetId;
    const feedback: FeedbackSubmission = {
      id: createFeedbackId(),
      tournamentId: state.tournament.id,
      roundId,
      debateId,
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
      score,
      ...(agree === "yes"
        ? { agreeWithDecision: true }
        : agree === "no"
          ? { agreeWithDecision: false }
          : {}),
      ...(comments.trim().length > 0 ? { comments: comments.trim() } : {}),
      ...(questions.length > 0 ? { answers } : {}),
      confirmed: confirmNow,
      timestamp: new Date().toISOString(),
    };
    return { feedback };
  },
  run(ctx, { feedback }) {
    const state = stateOf(ctx);
    // The page checks these before it runs the action; the palette relies on this check.
    const invalid = feedbackEntryError(state, feedback);
    if (invalid !== null) {
      return Promise.resolve({ ok: false, code: "INVALID", errors: [invalid] });
    }
    return ctx.store.submit({
      type: "feedback.enter",
      payload: { feedback },
    });
  },
});

export interface ReviewFeedbackPatch {
  confirmed?: boolean;
  ignored?: boolean;
}

export interface ReviewFeedbackArgs {
  feedbackId: string;
  patch: ReviewFeedbackPatch;
}

export const reviewFeedbackAction = defineAction<ReviewFeedbackArgs, SubmitResult>({
  id: "simpletab.feedback.review-feedback",
  labelKey: "action.feedback.reviewFeedback",
  page: FEEDBACK_PAGE,
  isEnabled(snapshot) {
    return (
      snapshot.state !== null &&
      snapshot.status.open &&
      stateHasPermission(snapshot.state, "feedback.view")
    );
  },
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null || state.feedback.length === 0) {
      return undefined;
    }
    const feedbackId = await ctx.prompts.pick(
      state.feedback.map((item) => ({
        label: `${item.sourceName} → ${String(item.targetAdjudicatorName ?? item.targetTeamName ?? "")}`,
        description: `${item.score} · ${item.timestamp}`,
        value: item.id,
      })),
      t("action.feedback.pickSubmission"),
    );
    if (feedbackId === undefined) {
      return undefined;
    }
    const patch = await ctx.prompts.pick(
      [
        { label: t("action.feedback.confirmReview"), value: { confirmed: true, ignored: false } },
        { label: t("action.feedback.unconfirmReview"), value: { confirmed: false } },
        {
          label: t("action.feedback.ignoreReview"),
          value: { ignored: true, confirmed: false },
        },
        { label: t("action.feedback.restoreReview"), value: { ignored: false } },
      ],
      t("action.feedback.pickDecision"),
    );
    return patch === undefined ? undefined : { feedbackId, patch };
  },
  run(ctx, { feedbackId, patch }) {
    const state = stateOf(ctx);
    const key = recordKey("feedback", feedbackId);
    return ctx.store.submit({
      type: "feedback.review",
      expectedVersions: { [key]: versionOf(state, key) },
      payload: { feedbackId, ...patch },
    });
  },
});

export const FEEDBACK_ACTIONS = [enterFeedbackAction, reviewFeedbackAction] as const;

/** Labels for the review decisions, shared with the page when it renders its buttons. */
export const FEEDBACK_REVIEW_PATCHES = {
  confirm: { confirmed: true, ignored: false },
  unconfirm: { confirmed: false },
  ignore: { ignored: true, confirmed: false },
  restore: { ignored: false },
} as const satisfies Readonly<Record<string, ReviewFeedbackPatch>>;
