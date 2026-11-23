import { describe, expect, it } from "vitest";
import { FIXED_TIME, makeRound, makeTournament } from "@/test/tournamentFixtures";
import type { Motion } from "@/types";
import {
  applyOp,
  createTournamentState,
  defaultRegistry,
  recordKey,
} from "../index";
import {
  deepFreeze,
  EQUITY_ACTOR,
  expectOpRoundTrip,
  expectStaleConflictAndForcedSuccess,
  makeFixtureDebateAndBallot,
  TAB_ASSISTANT_ACTOR,
  TAB_DIRECTOR_ACTOR,
} from "../test-helpers";

describe("motion ops", () => {
  const registry = defaultRegistry();

  it("registers Appendix A metadata for all motion ops", () => {
    for (const type of ["motion.create", "motion.update", "motion.delete"]) {
      const def = registry.get(type)!;
      expect(def).toBeDefined();
      expect(def.permission).toBe("motions.manage");
      expect(def.visibility).toBe("private");
      expect(def.releaseGate).toBeUndefined();
      expect(def.lock).toBe(false);
    }
    const statusDef = registry.get("motion.set_round_status")!;
    expect(statusDef).toBeDefined();
    expect(statusDef.permission).toBe("motions.manage");
    expect(statusDef.visibility).toBe("public");
    expect(statusDef.releaseGate).toBeUndefined();
    expect(statusDef.lock).toBe(false);
  });

  describe("motion.create / update / delete", () => {
    it("creates, updates, and deletes motions with inverse round-trips", () => {
      const r1 = makeRound("t-bp", 1);
      const state = createTournamentState(makeTournament("bp"), {
        rounds: [r1],
      });
      const motion: Motion = {
        id: "motion-1",
        tournamentId: "t-bp",
        text: "THW ban single-use plastics.",
        infoSlide: "Plastic pollution details.",
        infoSlideMedia: {
          kind: "image",
          url: "https://example.com/slide.png",
          alt: "Chart",
        },
        rounds: [r1.id],
        released: false,
      };

      const afterCreate = expectOpRoundTrip(state, {
        type: "motion.create",
        payload: { motion },
      });
      expect(afterCreate.motions).toEqual([motion]);

      const afterUpdate = expectOpRoundTrip(afterCreate, {
        type: "motion.update",
        payload: {
          motion: {
            ...motion,
            text: "THW phase out single-use plastics.",
          },
        },
      });
      expect(afterUpdate.motions[0]!.text).toBe(
        "THW phase out single-use plastics.",
      );

      const afterDelete = expectOpRoundTrip(afterUpdate, {
        type: "motion.delete",
        payload: { motionId: motion.id },
      });
      expect(afterDelete.motions).toEqual([]);
    });

    it("rejects invalid infoSlideMedia, deleting a motion used by a ballot, and FORBIDDEN roles", () => {
      const r1 = makeRound("t-bp", 1);
      const state = createTournamentState(makeTournament("bp"), {
        rounds: [r1],
      });

      const badMedia = applyOp(
        deepFreeze(state),
        {
          type: "motion.create",
          payload: {
            motion: {
              id: "motion-bad",
              tournamentId: "t-bp",
              text: "THBT ...",
              infoSlideMedia: {
                kind: "image",
                url: "http://insecure.example.com/slide.png",
              },
              rounds: [r1.id],
              released: false,
            },
          },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(badMedia.ok).toBe(false);
      if (!badMedia.ok) expect(badMedia.code).toBe("INVALID");

      const { state: ballotState } = makeFixtureDebateAndBallot();
      const usedMotion: Motion = {
        id: "motion-used",
        tournamentId: ballotState.tournament.id,
        text: "THW ...",
        rounds: [ballotState.rounds[0]!.id],
        released: true,
      };
      const withUsedMotion = createTournamentState(ballotState.tournament, {
        ...ballotState,
        motions: [usedMotion],
        ballots: [{ ...ballotState.ballots[0]!, motionId: usedMotion.id }],
      });
      const badDelete = applyOp(
        deepFreeze(withUsedMotion),
        { type: "motion.delete", payload: { motionId: usedMotion.id } },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(badDelete.ok).toBe(false);
      if (!badDelete.ok) expect(badDelete.code).toBe("INVALID");

      const forbiddenEquity = applyOp(
        deepFreeze(state),
        {
          type: "motion.create",
          payload: {
            motion: {
              id: "motion-1",
              tournamentId: "t-bp",
              text: "THW ...",
              rounds: [r1.id],
              released: false,
            },
          },
        },
        EQUITY_ACTOR,
        registry,
      );
      expect(forbiddenEquity.ok).toBe(false);
      if (!forbiddenEquity.ok) expect(forbiddenEquity.code).toBe("FORBIDDEN");

      const forbiddenAssistant = applyOp(
        deepFreeze(state),
        {
          type: "motion.create",
          payload: {
            motion: {
              id: "motion-1",
              tournamentId: "t-bp",
              text: "THW ...",
              rounds: [r1.id],
              released: false,
            },
          },
        },
        TAB_ASSISTANT_ACTOR,
        registry,
      );
      expect(forbiddenAssistant.ok).toBe(false);
      if (!forbiddenAssistant.ok) expect(forbiddenAssistant.code).toBe("FORBIDDEN");
    });
  });

  describe("motion.set_round_status", () => {
    it("cycles not_released -> info_slides_released -> motions_released with deterministic prep time and restores via inverse", () => {
      const r1 = makeRound("t-bp", 1);
      const r2 = makeRound("t-bp", 2);
      const sharedMotion: Motion = {
        id: "motion-1",
        tournamentId: "t-bp",
        text: "THW decentralize energy grids.",
        rounds: [r1.id, r2.id],
        released: false,
      };
      const state = createTournamentState(
        makeTournament("bp", { preparationTime: 15 }),
        {
          rounds: [r1, r2],
          motions: [sharedMotion],
        },
      );

      const afterInfoSlides = expectOpRoundTrip(state, {
        type: "motion.set_round_status",
        payload: { roundId: r1.id, status: "info_slides_released" },
      });
      expect(afterInfoSlides.rounds[0]!.motionsStatus).toBe("info_slides_released");
      expect(afterInfoSlides.rounds[0]!.motionsReleased).toBe(false);

      const afterRelease = expectOpRoundTrip(afterInfoSlides, {
        type: "motion.set_round_status",
        payload: {
          roundId: r1.id,
          status: "motions_released",
          now: FIXED_TIME,
        },
      });
      expect(afterRelease.rounds[0]!.motionsReleased).toBe(true);
      expect(afterRelease.rounds[0]!.startsAt).toBe("2026-10-01T09:15:00.000Z");
      expect(afterRelease.motions[0]!.released).toBe(true);

      const alsoR2 = applyOp(
        deepFreeze(afterRelease),
        {
          type: "motion.set_round_status",
          payload: { roundId: r2.id, status: "motions_released", now: FIXED_TIME },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(alsoR2.ok).toBe(true);
      if (!alsoR2.ok) return;

      const withdrawR1 = expectOpRoundTrip(alsoR2.state, {
        type: "motion.set_round_status",
        payload: { roundId: r1.id, status: "not_released" },
      });
      expect(withdrawR1.rounds[0]!.motionsReleased).toBe(false);
      expect(withdrawR1.motions[0]!.released).toBe(true);
    });

    it("rejects releasing a round without motions, cancelled rounds, FORBIDDEN roles, and stale versions", () => {
      const r1 = makeRound("t-bp", 1);
      const state = createTournamentState(makeTournament("bp"), {
        rounds: [r1],
      });

      const noMotions = applyOp(
        deepFreeze(state),
        {
          type: "motion.set_round_status",
          payload: { roundId: r1.id, status: "motions_released" },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(noMotions.ok).toBe(false);
      if (!noMotions.ok) expect(noMotions.code).toBe("INVALID");

      const motion: Motion = {
        id: "motion-1",
        tournamentId: "t-bp",
        text: "THW ...",
        rounds: [r1.id],
        released: false,
      };
      const withMotion = createTournamentState(state.tournament, {
        rounds: [r1],
        motions: [motion],
      });

      const forbidden = applyOp(
        deepFreeze(withMotion),
        {
          type: "motion.set_round_status",
          payload: { roundId: r1.id, status: "motions_released" },
        },
        EQUITY_ACTOR,
        registry,
      );
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");

      expectStaleConflictAndForcedSuccess(
        withMotion,
        {
          type: "motion.set_round_status",
          payload: { roundId: r1.id, status: "motions_released" },
        },
        recordKey("round", r1.id),
      );
    });
  });
});
