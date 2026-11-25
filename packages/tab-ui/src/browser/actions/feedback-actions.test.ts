import type { ProjectedState, SubmitResult } from "@simpletab/host/lib/common/host-protocol";
import type { Debate } from "@simpletab/core/types";
import { describe, expect, it } from "vitest";
import { t } from "../i18n";
import type { TournamentStoreSnapshot } from "../store/tournament-store";
import {
  enterFeedbackAction,
  FEEDBACK_ACTIONS,
  FEEDBACK_PAGE,
  FEEDBACK_REVIEW_PATCHES,
  reviewFeedbackAction,
} from "./feedback-actions";
import { fakeStore, scriptedPrompts, testContext } from "./test-context";

const SUBMIT = {
  ok: true,
  seq: 1,
  writes: [],
  committedPayload: null,
} as unknown as SubmitResult;

function feedbackState(patch: Partial<ProjectedState> = {}): ProjectedState {
  return {
    seq: 4,
    roleId: "host_owner",
    permissions: ["feedback.enter", "feedback.view"],
    versions: {
      "feedback:fb-1": 1,
    },
    tournament: {
      id: "t-1",
      format: "bp",
      preferences: {
        teamsInDebate: 4,
        feedbackMinScore: 1,
        feedbackMaxScore: 5,
        feedbackQuestions: [],
      },
    },
    rounds: [
      {
        id: "r1",
        tournamentId: "t-1",
        seq: 1,
        name: "Round 1",
        stage: "preliminary",
        drawStatus: "released",
      },
    ],
    teams: [
      {
        id: "t1",
        tournamentId: "t-1",
        name: "Team Alpha",
        speakers: [{ id: "s1", name: "Alice" }],
        breakCategories: [],
        speakerCategories: [],
      },
      {
        id: "t2",
        tournamentId: "t-1",
        name: "Team Beta",
        speakers: [{ id: "s2", name: "Bob" }],
        breakCategories: [],
        speakerCategories: [],
      },
    ],
    adjudicators: [
      {
        id: "adj-1",
        tournamentId: "t-1",
        name: "Chair One",
        trainee: false,
      },
      {
        id: "adj-2",
        tournamentId: "t-1",
        name: "Panel Two",
        trainee: false,
      },
    ],
    debates: [
      {
        id: "d1",
        tournamentId: "t-1",
        roundId: "r1",
        roundSeq: 1,
        venueName: "Hall A",
        roomRank: 1,
        teams: {
          OG: { teamId: "t1", teamName: "Team Alpha", side: "OG" },
          OO: { teamId: "t2", teamName: "Team Beta", side: "OO" },
        } as Debate["teams"],
        adjudicators: {
          chairId: "adj-1",
          chairName: "Chair One",
          panellistIds: ["adj-2"],
          panellistNames: ["Panel Two"],
          traineeIds: [],
          traineeNames: [],
        },
      },
    ],
    ballots: [],
    feedback: [
      {
        id: "fb-1",
        tournamentId: "t-1",
        roundId: "r1",
        debateId: "d1",
        targetType: "adjudicator",
        targetAdjudicatorId: "adj-1",
        targetAdjudicatorName: "Chair One",
        sourceType: "team",
        sourceId: "t1",
        sourceName: "Team Alpha",
        score: 4,
        confirmed: false,
        timestamp: "2026-11-25T08:00:00.000Z",
      },
    ],
    breakCategories: [],
    ...patch,
  } as unknown as ProjectedState;
}

function can(
  action: { isEnabled?: (snapshot: TournamentStoreSnapshot) => boolean },
  state: ProjectedState | null,
): boolean {
  const { store } = fakeStore(state, SUBMIT);
  return action.isEnabled?.(store.getSnapshot()) ?? false;
}

describe("feedback actions", () => {
  it("registers one command per Feedback mutation, gated by an open tournament and permissions", () => {
    expect(FEEDBACK_PAGE).toBe("simpletab-feedback-widget");
    expect(FEEDBACK_ACTIONS.map((action) => action.id)).toEqual([
      "simpletab.feedback.enter-feedback",
      "simpletab.feedback.review-feedback",
    ]);
    for (const action of FEEDBACK_ACTIONS) {
      expect(action.page).toBe(FEEDBACK_PAGE);
      expect(action.labelKey).toMatch(/^action\.feedback\./);
      expect(can(action, feedbackState())).toBe(true);
      expect(can(action, null)).toBe(false);
    }
    expect(can(enterFeedbackAction, feedbackState({ rounds: [] }))).toBe(false);
    expect(
      can(enterFeedbackAction, feedbackState({ permissions: ["feedback.view"] })),
    ).toBe(false);
    expect(
      can(reviewFeedbackAction, feedbackState({ permissions: ["feedback.enter"] })),
    ).toBe(false);
  });

  it("asks round, room, source, target, score, agreement and confirmation, then enters feedback", async () => {
    const state = feedbackState();
    const { store, submitted } = fakeStore(state, SUBMIT);
    const prompts = scriptedPrompts([
      "r1",
      "d1",
      "team",
      "t1",
      "adjudicator",
      "adj-1",
      "4",
      "yes",
      "Clear and fair.",
      true,
    ]);
    const args = await enterFeedbackAction.prompt(testContext(store, prompts));
    expect(args).toBeDefined();
    expect(prompts.asked).toEqual([
      t("action.feedback.pickRound"),
      t("action.feedback.pickDebate"),
      t("action.feedback.pickSourceType"),
      t("action.feedback.pickSource"),
      t("action.feedback.pickTargetType"),
      t("action.feedback.pickTarget"),
      t("action.feedback.pickScore"),
      t("action.feedback.pickAgree"),
      t("action.feedback.commentsPrompt"),
      t("action.feedback.confirmOnEnter"),
    ]);

    const result = await enterFeedbackAction.run(testContext(store, scriptedPrompts([])), args!);
    expect(result).toBe(SUBMIT);
    expect(submitted).toHaveLength(1);
    expect(submitted[0].type).toBe("feedback.enter");
    expect(submitted[0].expectedVersions).toBeUndefined();
    const feedback = (submitted[0].payload as { feedback: Record<string, unknown> }).feedback;
    expect(feedback.id).toMatch(/^fb-/);
    expect(feedback.timestamp).toEqual(expect.any(String));
    expect(feedback).toMatchObject({
      tournamentId: "t-1",
      roundId: "r1",
      debateId: "d1",
      targetType: "adjudicator",
      targetAdjudicatorId: "adj-1",
      targetAdjudicatorName: "Chair One",
      sourceType: "team",
      sourceId: "t1",
      sourceName: "Team Alpha",
      score: 4,
      agreeWithDecision: true,
      comments: "Clear and fair.",
      confirmed: true,
    });
    expect(feedback).not.toHaveProperty("answers");
  });

  it("asks the tournament's feedback questions and reports bad input instead of cancelling", async () => {
    const base = feedbackState();
    const state = {
      ...base,
      tournament: {
        ...base.tournament,
        preferences: {
          ...base.tournament.preferences,
          feedbackQuestions: [
            { id: "q1", label: "Was the call explained?", type: "yes_no", required: true },
            { id: "q2", label: "Notes", type: "text", required: false },
          ],
        },
      },
    } as ProjectedState;
    const { store, submitted } = fakeStore(state, SUBMIT);
    const prompts = scriptedPrompts([
      "r1",
      "d1",
      "team",
      "t1",
      "adjudicator",
      "adj-1",
      "9",
      "",
      true,
      "",
      "",
      false,
    ]);
    const args = await enterFeedbackAction.prompt(testContext(store, prompts));
    expect(prompts.asked).toContain("Was the call explained?");
    expect(prompts.asked).toContain("Notes");
    expect(args?.feedback.answers).toEqual({ q1: true, q2: "" });
    expect(args?.feedback).not.toHaveProperty("agreeWithDecision");

    // Score 9 is outside 1–5: run refuses with the validator's message and submits nothing.
    const result = await enterFeedbackAction.run(testContext(store, scriptedPrompts([])), args!);
    expect(result.ok).toBe(false);
    expect(submitted).toHaveLength(0);
  });

  it("exposes the exact review patches and submits feedback.review with live versions", async () => {
    expect(FEEDBACK_REVIEW_PATCHES).toEqual({
      confirm: { confirmed: true, ignored: false },
      unconfirm: { confirmed: false },
      ignore: { ignored: true, confirmed: false },
      restore: { ignored: false },
    });

    const state = feedbackState();
    const { store, submitted } = fakeStore(state, SUBMIT);
    const ctx = testContext(store, scriptedPrompts([]));
    for (const patch of Object.values(FEEDBACK_REVIEW_PATCHES)) {
      await reviewFeedbackAction.run(ctx, { feedbackId: "fb-1", patch });
    }
    expect(submitted.map((op) => op.payload)).toEqual(
      Object.values(FEEDBACK_REVIEW_PATCHES).map((patch) => ({
        feedbackId: "fb-1",
        ...patch,
      })),
    );
    for (const op of submitted) {
      expect(op.type).toBe("feedback.review");
      expect(op.expectedVersions).toEqual({ "feedback:fb-1": 1 });
    }
  });

  it("asks for a submission and decision, using live state for review prompts", async () => {
    const state = feedbackState();
    const { store } = fakeStore(state, SUBMIT);
    const prompts = scriptedPrompts(["fb-1", FEEDBACK_REVIEW_PATCHES.confirm]);
    expect(await reviewFeedbackAction.prompt(testContext(store, prompts))).toEqual({
      feedbackId: "fb-1",
      patch: FEEDBACK_REVIEW_PATCHES.confirm,
    });
    expect(prompts.asked).toEqual([
      t("action.feedback.pickSubmission"),
      t("action.feedback.pickDecision"),
    ]);
    expect(
      await reviewFeedbackAction.prompt(
        testContext(store, scriptedPrompts([FEEDBACK_REVIEW_PATCHES.confirm])),
      ),
    ).toBeUndefined();
  });

  it("cancels prompts and invalid scores without submitting anything", async () => {
    const { store, submitted } = fakeStore(feedbackState(), SUBMIT);
    expect(
      await enterFeedbackAction.prompt(testContext(store, scriptedPrompts([undefined]))),
    ).toBeUndefined();
    expect(
      await enterFeedbackAction.prompt(
        testContext(store, scriptedPrompts(["r1", "d1", "team", "t1", "adjudicator", undefined])),
      ),
    ).toBeUndefined();
    expect(
      await enterFeedbackAction.prompt(
        testContext(store, scriptedPrompts(["r1", "d1", "team", "t1", "adjudicator", "adj-1", "6"])),
      ),
    ).toBeUndefined();
    expect(
      await reviewFeedbackAction.prompt(testContext(store, scriptedPrompts([undefined]))),
    ).toBeUndefined();
    expect(
      await reviewFeedbackAction.prompt(
        testContext(store, scriptedPrompts(["fb-1", undefined])),
      ),
    ).toBeUndefined();
    expect(submitted).toEqual([]);
  });
});
