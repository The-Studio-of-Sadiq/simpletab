import { describe, expect, it } from "vitest";
import { FIXED_TIME } from "@/test/tournamentFixtures";
import type { FeedbackSubmission } from "@/types";
import { applyOp, defaultRegistry } from "../index";
import {
  deepFreeze,
  DISPLAY_ACTOR,
  EQUITY_ACTOR,
  expectOpRoundTrip,
  expectWrittenVersionBumps,
  makeFixtureDebateAndBallot,
  SERVICE_ACTOR,
  TAB_ASSISTANT_ACTOR,
  TAB_DIRECTOR_ACTOR,
} from "../test-helpers";

function makeSampleFeedback(
  overrides: Partial<FeedbackSubmission> = {},
): FeedbackSubmission {
  return {
    id: "fb-1",
    tournamentId: "t-2team",
    roundId: "round-t-2team-1",
    debateId: "debate-1",
    targetType: "adjudicator",
    targetAdjudicatorId: "adj-1",
    targetAdjudicatorName: "Adjudicator 01",
    sourceType: "team",
    sourceId: "team-1",
    sourceName: "Team 01",
    score: 4,
    comments: "Clear feedback",
    confirmed: true,
    timestamp: FIXED_TIME,
    ...overrides,
  };
}

describe("ops feedback", () => {
  it("supports feedback.enter, supersedes earlier confirmed feedback, and inverts to ignored", () => {
    const registry = defaultRegistry();
    const { state } = makeFixtureDebateAndBallot();
    const fb1 = makeSampleFeedback({ id: "fb-1", score: 4 });

    const forbidden = applyOp(
      deepFreeze(state),
      { type: "feedback.enter", payload: { feedback: fb1 } },
      EQUITY_ACTOR,
      registry,
    );
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");

    const first = applyOp(
      deepFreeze(state),
      { type: "feedback.enter", payload: { feedback: fb1 } },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.state.feedback).toHaveLength(1);
    expect(first.inverse?.type).toBe("feedback.review");
    expectWrittenVersionBumps(state, first);

    // Second confirmed submission from same source/target supersedes first
    const fb2 = makeSampleFeedback({ id: "fb-2", score: 5 });
    const second = applyOp(
      deepFreeze(first.state),
      { type: "feedback.enter", payload: { feedback: fb2 } },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.state.feedback[0]?.confirmed).toBe(false);
    expect(second.state.feedback[1]?.confirmed).toBe(true);
    expectWrittenVersionBumps(first.state, second);

    // Inverse marks fb-2 ignored & unconfirmed
    const undone = applyOp(
      deepFreeze(second.state),
      second.inverse!,
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.state.feedback[1]?.ignored).toBe(true);
    expect(undone.state.feedback[1]?.confirmed).toBe(false);
    expectWrittenVersionBumps(second.state, undone);
  });

  it("rejects invalid feedback target or out-of-range score", () => {
    const registry = defaultRegistry();
    const { state } = makeFixtureDebateAndBallot();

    const badAdj = applyOp(
      deepFreeze(state),
      {
        type: "feedback.enter",
        payload: {
          feedback: makeSampleFeedback({ targetAdjudicatorId: "adj-unknown" }),
        },
      },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(badAdj.ok).toBe(false);
    if (!badAdj.ok) expect(badAdj.code).toBe("INVALID");

    const badScore = applyOp(
      deepFreeze(state),
      {
        type: "feedback.enter",
        payload: {
          feedback: makeSampleFeedback({ score: 99 }),
        },
      },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(badScore.ok).toBe(false);
    if (!badScore.ok) expect(badScore.code).toBe("INVALID");
  });

  it("handles feedback.receive_online (service-only, deadline check) and feedback.review round-trip", () => {
    const registry = defaultRegistry();
    const { state } = makeFixtureDebateAndBallot();
    const fbOnline = makeSampleFeedback({ id: "fb-online-1", score: 3 });

    const forbiddenHuman = applyOp(
      deepFreeze(state),
      { type: "feedback.receive_online", payload: { feedback: fbOnline } },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(forbiddenHuman.ok).toBe(false);
    if (!forbiddenHuman.ok) expect(forbiddenHuman.code).toBe("FORBIDDEN");

    const deadlineState = {
      ...state,
      rounds: state.rounds.map((r) => ({
        ...r,
        simpletab: {
          feedbackDeadline: "2026-10-01T10:00:00.000Z",
          timeZone: "UTC",
        },
      })),
      runtime: {
        portalEnforcing: true,
        now: "2026-10-01T10:05:00.000Z",
      },
    };
    const lateFeedback = applyOp(
      deepFreeze(deadlineState),
      {
        type: "feedback.receive_online",
        payload: {
          feedback: fbOnline,
          receivedAt: "2026-10-01T10:01:00.000Z",
        },
      },
      SERVICE_ACTOR,
      registry,
    );
    expect(lateFeedback.ok).toBe(false);
    if (!lateFeedback.ok) expect(lateFeedback.code).toBe("INVALID");

    const received = applyOp(
      deepFreeze(state),
      { type: "feedback.receive_online", payload: { feedback: fbOnline } },
      SERVICE_ACTOR,
      registry,
    );
    expect(received.ok).toBe(true);
    if (!received.ok) return;
    expect(received.state.feedback[0]?.id).toBe("fb-online-1");
    expect(received.inverse?.type).toBe("feedback.review");
    expectWrittenVersionBumps(state, received);

    const receivedUndo = applyOp(
      deepFreeze(received.state),
      received.inverse!,
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(receivedUndo.ok).toBe(true);
    if (!receivedUndo.ok) return;
    expect(receivedUndo.state.feedback[0]?.ignored).toBe(true);
    expect(receivedUndo.state.feedback[0]?.confirmed).toBe(false);
    expectWrittenVersionBumps(received.state, receivedUndo);

    const assistantReview = applyOp(
      deepFreeze(received.state),
      {
        type: "feedback.review",
        payload: { feedbackId: "fb-online-1", ignored: true },
      },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(assistantReview.ok).toBe(false);
    if (!assistantReview.ok) expect(assistantReview.code).toBe("FORBIDDEN");

    const displayReview = applyOp(
      deepFreeze(received.state),
      {
        type: "feedback.review",
        payload: { feedbackId: "fb-online-1", ignored: true },
      },
      DISPLAY_ACTOR,
      registry,
    );
    expect(displayReview.ok).toBe(false);
    if (!displayReview.ok) expect(displayReview.code).toBe("FORBIDDEN");

    const invalidReview = applyOp(
      deepFreeze(received.state),
      {
        type: "feedback.review",
        payload: { feedbackId: "fb-online-1" },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(invalidReview.ok).toBe(false);
    if (!invalidReview.ok) expect(invalidReview.code).toBe("INVALID");

    const afterReview = expectOpRoundTrip(
      received.state,
      {
        type: "feedback.review",
        payload: { feedbackId: "fb-online-1", ignored: true, confirmed: false },
      },
      TAB_DIRECTOR_ACTOR,
    );
    expect(afterReview.feedback[0]?.ignored).toBe(true);
    expect(afterReview.feedback[0]?.confirmed).toBe(false);
  });
});
