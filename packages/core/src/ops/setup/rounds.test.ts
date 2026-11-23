import { describe, expect, it } from "vitest";
import { FIXED_TIME, makeRound, makeTournament } from "@/test/tournamentFixtures";
import {
  applyOp,
  createTournamentState,
  defaultRegistry,
  recordKey,
} from "../index";
import {
  deepFreeze,
  expectOpRoundTrip,
  expectStaleConflictAndForcedSuccess,
  makeFixtureDebateAndBallot,
  TAB_ASSISTANT_ACTOR,
  TAB_DIRECTOR_ACTOR,
} from "../test-helpers";

describe("setup round ops", () => {
  const registry = defaultRegistry();

  describe("round.create / update / delete", () => {
    it("creates and updates rounds with inverse round-trips, and deletes with null inverse", () => {
      const state = createTournamentState(makeTournament("bp"));
      const round = makeRound("t-bp", 1);

      const afterCreate = expectOpRoundTrip(state, {
        type: "round.create",
        payload: { round },
      });
      expect(afterCreate.rounds).toEqual([round]);

      const afterUpdate = expectOpRoundTrip(afterCreate, {
        type: "round.update",
        payload: { round: { ...round, name: "Preliminary 1", weight: 2 } },
      });
      expect(afterUpdate.rounds[0]!.name).toBe("Preliminary 1");

      const deleted = applyOp(
        deepFreeze(afterUpdate),
        { type: "round.delete", payload: { roundId: round.id } },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(deleted.ok).toBe(true);
      if (!deleted.ok) return;
      expect(deleted.inverse).toBeNull();
      expect(deleted.state.rounds).toEqual([]);
    });

    it("rejects mismatched stage/drawType and deleting an eliminationAdvanced round", () => {
      const state = createTournamentState(makeTournament("bp"), {
        rounds: [
          makeRound("t-bp", 1, {
            stage: "elimination",
            drawType: "elimination",
            eliminationAdvanced: true,
          }),
        ],
      });

      const badCreate = applyOp(
        deepFreeze(state),
        {
          type: "round.create",
          payload: {
            round: makeRound("t-bp", 2, {
              stage: "preliminary",
              drawType: "elimination",
            }),
          },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(badCreate.ok).toBe(false);
      if (!badCreate.ok) expect(badCreate.code).toBe("INVALID");

      const badUpdate = applyOp(
        deepFreeze(state),
        {
          type: "round.update",
          payload: {
            round: { ...state.rounds[0]!, drawType: "random" },
          },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(badUpdate.ok).toBe(false);
      if (!badUpdate.ok) expect(badUpdate.code).toBe("INVALID");

      const badDelete = applyOp(
        deepFreeze(state),
        {
          type: "round.delete",
          payload: { roundId: state.rounds[0]!.id },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(badDelete.ok).toBe(false);
      if (!badDelete.ok) expect(badDelete.code).toBe("INVALID");
    });

    it("enforces permissions and version conflicts for round CRUD", () => {
      const r1 = makeRound("t-bp", 1);
      const r2 = makeRound("t-bp", 2);
      const state = createTournamentState(makeTournament("bp"), { rounds: [r1] });

      const forbidden = applyOp(
        deepFreeze(state),
        { type: "round.create", payload: { round: r2 } },
        TAB_ASSISTANT_ACTOR,
        registry,
      );
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");

      expectStaleConflictAndForcedSuccess(
        state,
        { type: "round.create", payload: { round: r2 } },
        recordKey("round", r2.id),
      );
      expectStaleConflictAndForcedSuccess(
        state,
        { type: "round.update", payload: { round: { ...r1, name: "R1 Renamed" } } },
        recordKey("round", r1.id),
      );
      expectStaleConflictAndForcedSuccess(
        state,
        { type: "round.delete", payload: { roundId: r1.id } },
        recordKey("round", r1.id),
      );
    });
  });

  describe("round.set_prelim_count", () => {
    it("increases and decreases preliminary round count and restores via inverse", () => {
      const state = createTournamentState(makeTournament("bp"), {
        rounds: [makeRound("t-bp", 1)],
      });

      const afterIncrease = expectOpRoundTrip(state, {
        type: "round.set_prelim_count",
        payload: { count: 3, createdAt: FIXED_TIME },
      });
      expect(afterIncrease.rounds).toHaveLength(3);

      const afterDecrease = expectOpRoundTrip(afterIncrease, {
        type: "round.set_prelim_count",
        payload: { count: 1 },
      });
      expect(afterDecrease.rounds.filter((r) => !r.cancelled)).toHaveLength(1);
    });

    it("rejects cancelling a preliminary round that already has ballots", () => {
      const { state } = makeFixtureDebateAndBallot();
      const res = applyOp(
        deepFreeze(state),
        { type: "round.set_prelim_count", payload: { count: 0 } },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("INVALID");
    });

    it("enforces permissions and version conflicts for round.set_prelim_count", () => {
      const state = createTournamentState(makeTournament("bp"), {
        rounds: [makeRound("t-bp", 1)],
      });
      const forbidden = applyOp(
        deepFreeze(state),
        { type: "round.set_prelim_count", payload: { count: 2 } },
        TAB_ASSISTANT_ACTOR,
        registry,
      );
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");

      expectStaleConflictAndForcedSuccess(
        state,
        { type: "round.set_prelim_count", payload: { count: 2 } },
        recordKey("round", "round-t-bp-1"),
      );
    });
  });

  describe("round.set_completion and round.cancel", () => {
    it("completes a round with confirmed ballots and cancels an empty round, with inverse round-trips", () => {
      const { state } = makeFixtureDebateAndBallot();
      const afterComplete = expectOpRoundTrip(state, {
        type: "round.set_completion",
        payload: { roundId: state.rounds[0]!.id, completed: true },
      });
      expect(afterComplete.rounds[0]!.completed).toBe(true);

      const emptyRoundState = createTournamentState(makeTournament("bp"), {
        rounds: [makeRound("t-bp", 1)],
      });
      const afterCancel = expectOpRoundTrip(emptyRoundState, {
        type: "round.cancel",
        payload: { roundId: "round-t-bp-1", cancelled: true },
      });
      expect(afterCancel.rounds[0]!.cancelled).toBe(true);
    });

    it("rejects completing a round with no draw and cancelling a round with ballots", () => {
      const noDrawState = createTournamentState(makeTournament("bp"), {
        rounds: [makeRound("t-bp", 1)],
      });
      const completeRes = applyOp(
        deepFreeze(noDrawState),
        {
          type: "round.set_completion",
          payload: { roundId: "round-t-bp-1", completed: true },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(completeRes.ok).toBe(false);
      if (!completeRes.ok) expect(completeRes.code).toBe("INVALID");

      const { state: ballotState } = makeFixtureDebateAndBallot();
      const cancelRes = applyOp(
        deepFreeze(ballotState),
        {
          type: "round.cancel",
          payload: { roundId: ballotState.rounds[0]!.id, cancelled: true },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(cancelRes.ok).toBe(false);
      if (!cancelRes.ok) expect(cancelRes.code).toBe("INVALID");
    });

    it("enforces permissions and version conflicts for set_completion and cancel", () => {
      const { state } = makeFixtureDebateAndBallot();
      const roundId = state.rounds[0]!.id;

      const forbiddenComplete = applyOp(
        deepFreeze(state),
        { type: "round.set_completion", payload: { roundId, completed: true } },
        TAB_ASSISTANT_ACTOR,
        registry,
      );
      expect(forbiddenComplete.ok).toBe(false);
      if (!forbiddenComplete.ok) expect(forbiddenComplete.code).toBe("FORBIDDEN");

      expectStaleConflictAndForcedSuccess(
        state,
        { type: "round.set_completion", payload: { roundId, completed: true } },
        recordKey("round", roundId),
      );

      const emptyState = createTournamentState(makeTournament("bp"), {
        rounds: [makeRound("t-bp", 1)],
      });
      expectStaleConflictAndForcedSuccess(
        emptyState,
        { type: "round.cancel", payload: { roundId: "round-t-bp-1", cancelled: true } },
        recordKey("round", "round-t-bp-1"),
      );
    });
  });

  describe("round.set_ballot_deadline", () => {
    it("sets and clears ballot/feedback deadlines with IANA timeZone and restores via inverse", () => {
      const state = createTournamentState(makeTournament("bp"), {
        rounds: [makeRound("t-bp", 1)],
      });

      const afterSet = expectOpRoundTrip(state, {
        type: "round.set_ballot_deadline",
        payload: {
          roundId: "round-t-bp-1",
          ballotDeadline: "2026-10-01T14:00:00+06:00",
          feedbackDeadline: "2026-10-01T14:30:00Z",
          timeZone: "Asia/Dhaka",
        },
      });
      expect(afterSet.rounds[0]!.simpletab).toEqual({
        ballotDeadline: "2026-10-01T08:00:00.000Z",
        feedbackDeadline: "2026-10-01T14:30:00.000Z",
        timeZone: "Asia/Dhaka",
      });

      const afterClear = expectOpRoundTrip(afterSet, {
        type: "round.set_ballot_deadline",
        payload: {
          roundId: "round-t-bp-1",
          ballotDeadline: null,
          feedbackDeadline: null,
          timeZone: "Asia/Dhaka",
        },
      });
      expect(afterClear.rounds[0]!.simpletab).toEqual({
        ballotDeadline: null,
        feedbackDeadline: null,
        timeZone: "Asia/Dhaka",
      });
    });

    it("rejects invalid ISO instants (including Feb 30) and invalid IANA time zones", () => {
      const state = deepFreeze(
        createTournamentState(makeTournament("bp"), {
          rounds: [makeRound("t-bp", 1)],
        }),
      );

      const badDate = applyOp(
        state,
        {
          type: "round.set_ballot_deadline",
          payload: {
            roundId: "round-t-bp-1",
            ballotDeadline: "2026-02-30T12:00:00Z",
            timeZone: "Asia/Dhaka",
          },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(badDate.ok).toBe(false);
      if (!badDate.ok) expect(badDate.code).toBe("INVALID");

      const badZone = applyOp(
        state,
        {
          type: "round.set_ballot_deadline",
          payload: {
            roundId: "round-t-bp-1",
            ballotDeadline: "2026-10-01T14:00:00Z",
            timeZone: "Mars/Olympus",
          },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(badZone.ok).toBe(false);
      if (!badZone.ok) expect(badZone.code).toBe("INVALID");
    });

    it("enforces permissions and version conflicts for round.set_ballot_deadline", () => {
      const state = createTournamentState(makeTournament("bp"), {
        rounds: [makeRound("t-bp", 1)],
      });
      const forbidden = applyOp(
        deepFreeze(state),
        {
          type: "round.set_ballot_deadline",
          payload: {
            roundId: "round-t-bp-1",
            ballotDeadline: "2026-10-01T14:00:00Z",
            timeZone: "UTC",
          },
        },
        TAB_ASSISTANT_ACTOR,
        registry,
      );
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");

      expectStaleConflictAndForcedSuccess(
        state,
        {
          type: "round.set_ballot_deadline",
          payload: {
            roundId: "round-t-bp-1",
            ballotDeadline: "2026-10-01T14:00:00Z",
            timeZone: "UTC",
          },
        },
        recordKey("round", "round-t-bp-1"),
      );
    });
  });
});
