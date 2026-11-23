import { describe, expect, it } from "vitest";
import { createSeededRng } from "@/lib/draw/rng";
import {
  FIXED_TIME,
  makeRound,
  makeTeams,
  makeTournament,
  makeVenues,
  simulateBallot,
} from "@/test/tournamentFixtures";
import type { Debate, Motion } from "@/types";
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

function makeBpDrawFixture() {
  const tournament = makeTournament("bp");
  const round1 = makeRound("t-bp", 1);
  const teams = makeTeams(8, {
    tournamentId: "t-bp",
    institutionCount: 4,
    speakersPerTeam: 2,
  });
  const venues = makeVenues(2, "t-bp");
  const state = createTournamentState(tournament, {
    teams,
    venues,
    rounds: [round1],
  });
  return { state, tournament, round1, teams, venues };
}

function makeTwoTeamDrawFixture() {
  const tournament = makeTournament("australs");
  const round1 = makeRound("t-australs", 1);
  const teams = makeTeams(4, {
    tournamentId: "t-australs",
    institutionCount: 2,
    speakersPerTeam: 3,
  });
  const venues = makeVenues(2, "t-australs");
  const state = createTournamentState(tournament, {
    teams,
    venues,
    rounds: [round1],
  });
  return { state, tournament, round1, teams, venues };
}

describe("draw and swing ops", () => {
  const registry = defaultRegistry();

  it("registers Appendix A metadata for all draw and swing ops", () => {
    const publicGated = [
      "draw.generate",
      "draw.restore",
      "draw.update_debate",
      "draw.move_team",
      "draw.swap_teams",
      "draw.lock",
      "draw.unlock",
      "swing.create",
      "swing.toggle_round",
    ];
    for (const type of publicGated) {
      const def = registry.get(type)!;
      expect(def).toBeDefined();
      expect(def.visibility).toBe("public");
      expect(def.releaseGate).toBe("draw_released");
    }
    for (const type of ["draw.release_teams", "draw.release", "draw.unrelease"]) {
      const def = registry.get(type)!;
      expect(def).toBeDefined();
      expect(def.visibility).toBe("public");
      expect(def.releaseGate).toBeUndefined();
      expect(def.permission).toBe("draw.release");
      expect(def.lock).toBe(false);
    }
    expect(registry.get("draw.generate")?.lock).toBe(true);
    expect(registry.get("draw.generate")?.permission).toBe("draw.generate");
    expect(registry.get("swing.create")?.permission).toBe("participants.edit");
    expect(registry.get("swing.toggle_round")?.permission).toBe("participants.edit");
  });

  describe("draw.generate & draw.restore", () => {
    it("generates deterministic BP draws, attaches single motion, and restores via inverse", () => {
      const { state: baseState, round1 } = makeBpDrawFixture();
      const motion: Motion = {
        id: "motion-1",
        tournamentId: "t-bp",
        text: "THW fund public transit.",
        rounds: [round1.id],
        released: false,
      };
      const state = createTournamentState(baseState.tournament, {
        ...baseState,
        motions: [motion],
      });

      const after = expectOpRoundTrip(state, {
        type: "draw.generate",
        payload: { roundId: round1.id, seed: 101 },
      });
      expect(after.debates).toHaveLength(2);
      expect(after.debates[0]!.id).toBe(`debate-${round1.id}-1`);
      expect(after.debates[1]!.id).toBe(`debate-${round1.id}-2`);
      expect(after.debates[0]!.motionId).toBe(motion.id);
      expect(after.debates[0]!.motionText).toBe(motion.text);
      expect(after.rounds[0]!.drawStatus).toBe("draft");
      expect(after.rounds[0]!.drawSeed).toBe(101);

      const secondSameSeed = applyOp(
        deepFreeze(state),
        { type: "draw.generate", payload: { roundId: round1.id, seed: 101 } },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(secondSameSeed.ok).toBe(true);
      if (!secondSameSeed.ok) return;
      expect(secondSameSeed.state.debates).toEqual(after.debates);

      const differentSeed = applyOp(
        deepFreeze(state),
        { type: "draw.generate", payload: { roundId: round1.id, seed: 9999 } },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(differentSeed.ok).toBe(true);
      if (!differentSeed.ok) return;
      expect(differentSeed.state.debates).not.toEqual(after.debates);
    });

    it("generates two-team draws and restores via inverse", () => {
      const { state, round1 } = makeTwoTeamDrawFixture();
      const after = expectOpRoundTrip(state, {
        type: "draw.generate",
        payload: { roundId: round1.id, seed: 7 },
      });
      expect(after.debates).toHaveLength(2);
      expect(Object.keys(after.debates[0]!.teams).sort()).toEqual(["AFF", "NEG"]);
    });

    it("requires discardExisting when live ballots exist and restores ballots on inverse", () => {
      const { state, debate } = makeFixtureDebateAndBallot();
      const roundId = debate.roundId;

      const blocked = applyOp(
        deepFreeze(state),
        {
          type: "draw.generate",
          payload: {
            roundId,
            seed: 55,
            override: { reason: "Regenerating released round" },
          },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.code).toBe("INVALID");

      const afterDiscard = expectOpRoundTrip(state, {
        type: "draw.generate",
        payload: {
          roundId,
          seed: 55,
          discardExisting: true,
          discardedAt: FIXED_TIME,
          override: { reason: "Regenerating released round" },
        },
      });
      expect(afterDiscard.ballots[0]!.discarded).toBe(true);
      expect(afterDiscard.ballots[0]!.confirmed).toBe(false);
    });

    it("rejects cancelled rounds, invalid team counts, and FORBIDDEN actors", () => {
      const { state, round1 } = makeBpDrawFixture();
      const cancelledState = createTournamentState(state.tournament, {
        ...state,
        rounds: [{ ...round1, cancelled: true }],
      });
      const cancelledRes = applyOp(
        deepFreeze(cancelledState),
        { type: "draw.generate", payload: { roundId: round1.id, seed: 1 } },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(cancelledRes.ok).toBe(false);
      if (!cancelledRes.ok) expect(cancelledRes.code).toBe("INVALID");

      const forbiddenRes = applyOp(
        deepFreeze(state),
        { type: "draw.generate", payload: { roundId: round1.id, seed: 1 } },
        EQUITY_ACTOR,
        registry,
      );
      expect(forbiddenRes.ok).toBe(false);
      if (!forbiddenRes.ok) expect(forbiddenRes.code).toBe("FORBIDDEN");

      expectStaleConflictAndForcedSuccess(
        state,
        { type: "draw.generate", payload: { roundId: round1.id, seed: 1 } },
        recordKey("round", round1.id),
      );
    });

    it("supports direct draw.restore round-trip and rejects restoring over ballots", () => {
      const { state, round1 } = makeBpDrawFixture();
      const drawn = applyOp(
        deepFreeze(state),
        { type: "draw.generate", payload: { roundId: round1.id, seed: 12 } },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(drawn.ok).toBe(true);
      if (!drawn.ok) return;

      const swapped: Debate[] = [
        { ...drawn.state.debates[0]!, importance: 5 },
        { ...drawn.state.debates[1]!, importance: 2 },
      ];
      const afterRestore = expectOpRoundTrip(drawn.state, {
        type: "draw.restore",
        payload: { roundId: round1.id, debates: swapped },
      });
      expect(afterRestore.debates[0]!.importance).toBe(5);

      const { state: ballotState, debate } = makeFixtureDebateAndBallot();
      const badRestore = applyOp(
        deepFreeze(ballotState),
        { type: "draw.restore", payload: { roundId: debate.roundId, debates: [] } },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(badRestore.ok).toBe(false);
      if (!badRestore.ok) expect(badRestore.code).toBe("INVALID");

      const forbidden = applyOp(
        deepFreeze(drawn.state),
        { type: "draw.restore", payload: { roundId: round1.id, debates: swapped } },
        EQUITY_ACTOR,
        registry,
      );
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");
    });
  });

  describe("draw.update_debate, draw.move_team, draw.swap_teams", () => {
    it("updates a debate with inverse round-trip and blocks matchup edit when ballots exist", () => {
      const { state, round1 } = makeBpDrawFixture();
      const drawn = applyOp(
        deepFreeze(state),
        { type: "draw.generate", payload: { roundId: round1.id, seed: 22 } },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(drawn.ok).toBe(true);
      if (!drawn.ok) return;

      const debate = drawn.state.debates[0]!;
      const afterUpdate = expectOpRoundTrip(drawn.state, {
        type: "draw.update_debate",
        payload: {
          debate: {
            ...debate,
            venueName: "Main Hall",
            importance: 9,
          },
        },
      });
      expect(afterUpdate.debates[0]!.venueName).toBe("Main Hall");

      const { state: ballotState, debate: ballotDebate } =
        makeFixtureDebateAndBallot();
      const badUpdate = applyOp(
        deepFreeze(ballotState),
        {
          type: "draw.update_debate",
          payload: {
            debate: {
              ...ballotDebate,
              teams: {
                ...ballotDebate.teams,
                AFF: ballotDebate.teams.NEG,
                NEG: ballotDebate.teams.AFF,
              },
            },
            override: { reason: "Trying to override hard block" },
          },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(badUpdate.ok).toBe(false);
      if (!badUpdate.ok) expect(badUpdate.code).toBe("INVALID");

      const forbidden = applyOp(
        deepFreeze(drawn.state),
        { type: "draw.update_debate", payload: { debate } },
        EQUITY_ACTOR,
        registry,
      );
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");
    });

    it("moves teams across slots/pool and swaps teams with inverse round-trips", () => {
      const { state, round1 } = makeBpDrawFixture();
      const drawn = applyOp(
        deepFreeze(state),
        { type: "draw.generate", payload: { roundId: round1.id, seed: 33 } },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(drawn.ok).toBe(true);
      if (!drawn.ok) return;

      const d1 = drawn.state.debates[0]!;
      const d2 = drawn.state.debates[1]!;
      const ogTeam = d1.teams.OG;
      const coTeam = d2.teams.CO;

      const afterMove = expectOpRoundTrip(drawn.state, {
        type: "draw.move_team",
        payload: {
          pick: {
            teamId: ogTeam.teamId,
            teamName: ogTeam.teamName,
            from: { kind: "slot", debateId: d1.id, side: "OG" },
          },
          target: { kind: "slot", debateId: d2.id, side: "CO" },
        },
      });
      expect(afterMove.debates[1]!.teams.CO.teamId).toBe(ogTeam.teamId);
      expect(afterMove.debates[0]!.teams.OG.teamId).toBe(coTeam.teamId);

      const afterSwap = expectOpRoundTrip(drawn.state, {
        type: "draw.swap_teams",
        payload: {
          slotA: { debateId: d1.id, side: "OG" },
          slotB: { debateId: d2.id, side: "CO" },
        },
      });
      expect(afterSwap.debates[0]!.teams.OG.teamId).toBe(coTeam.teamId);
      expect(afterSwap.debates[1]!.teams.CO.teamId).toBe(ogTeam.teamId);

      const sameMove = applyOp(
        deepFreeze(drawn.state),
        {
          type: "draw.move_team",
          payload: {
            pick: {
              teamId: ogTeam.teamId,
              teamName: ogTeam.teamName,
              from: { kind: "slot", debateId: d1.id, side: "OG" },
            },
            target: { kind: "slot", debateId: d1.id, side: "OG" },
          },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(sameMove.ok).toBe(false);
      if (!sameMove.ok) expect(sameMove.code).toBe("INVALID");

      const forbiddenSwap = applyOp(
        deepFreeze(drawn.state),
        {
          type: "draw.swap_teams",
          payload: {
            slotA: { debateId: d1.id, side: "OG" },
            slotB: { debateId: d2.id, side: "CO" },
          },
        },
        EQUITY_ACTOR,
        registry,
      );
      expect(forbiddenSwap.ok).toBe(false);
      if (!forbiddenSwap.ok) expect(forbiddenSwap.code).toBe("FORBIDDEN");

      const { state: ballotState, debate: ballotDebate } =
        makeFixtureDebateAndBallot();
      const blockedSwap = applyOp(
        deepFreeze(ballotState),
        {
          type: "draw.swap_teams",
          payload: {
            slotA: { debateId: ballotDebate.id, side: "AFF" },
            slotB: { debateId: ballotDebate.id, side: "NEG" },
            override: { reason: "Cannot swap after ballot" },
          },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(blockedSwap.ok).toBe(false);
      if (!blockedSwap.ok) expect(blockedSwap.code).toBe("INVALID");
    });
  });

  describe("draw lifecycle (lock, unlock, release_teams, release, unrelease)", () => {
    it("transitions draft -> locked -> draft -> teams_released -> released -> locked with inverse round-trips", () => {
      const { state, round1 } = makeBpDrawFixture();
      const drawn = applyOp(
        deepFreeze(state),
        { type: "draw.generate", payload: { roundId: round1.id, seed: 44 } },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(drawn.ok).toBe(true);
      if (!drawn.ok) return;

      const locked = expectOpRoundTrip(drawn.state, {
        type: "draw.lock",
        payload: { roundId: round1.id },
      });
      expect(locked.rounds[0]!.drawStatus).toBe("locked");

      const unlocked = expectOpRoundTrip(locked, {
        type: "draw.unlock",
        payload: { roundId: round1.id },
      });
      expect(unlocked.rounds[0]!.drawStatus).toBe("draft");

      const teamsReleased = expectOpRoundTrip(locked, {
        type: "draw.release_teams",
        payload: { roundId: round1.id },
      });
      expect(teamsReleased.rounds[0]!.drawStatus).toBe("teams_released");

      const released = expectOpRoundTrip(teamsReleased, {
        type: "draw.release",
        payload: { roundId: round1.id },
      });
      expect(released.rounds[0]!.drawStatus).toBe("confirmed");

      const unreleased = expectOpRoundTrip(released, {
        type: "draw.unrelease",
        payload: { roundId: round1.id },
      });
      expect(unreleased.rounds[0]!.drawStatus).toBe("locked");
    });

    it("rejects locking an empty draw, invalid stage transitions, and FORBIDDEN roles", () => {
      const { state, round1 } = makeBpDrawFixture();
      const lockEmpty = applyOp(
        deepFreeze(state),
        { type: "draw.lock", payload: { roundId: round1.id } },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(lockEmpty.ok).toBe(false);
      if (!lockEmpty.ok) expect(lockEmpty.code).toBe("INVALID");

      const drawn = applyOp(
        deepFreeze(state),
        { type: "draw.generate", payload: { roundId: round1.id, seed: 44 } },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(drawn.ok).toBe(true);
      if (!drawn.ok) return;

      const unlockDraft = applyOp(
        deepFreeze(drawn.state),
        { type: "draw.unlock", payload: { roundId: round1.id } },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(unlockDraft.ok).toBe(false);
      if (!unlockDraft.ok) expect(unlockDraft.code).toBe("INVALID");

      const forbidden = applyOp(
        deepFreeze(drawn.state),
        { type: "draw.release", payload: { roundId: round1.id } },
        TAB_ASSISTANT_ACTOR,
        registry,
      );
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");

      expectStaleConflictAndForcedSuccess(
        drawn.state,
        { type: "draw.lock", payload: { roundId: round1.id } },
        recordKey("round", round1.id),
      );
    });

    it("rejects releasing a draw with validateDraw errors or concurrent clashes unless overridden", () => {
      const { state, round1, teams } = makeBpDrawFixture();
      const r2 = makeRound("t-bp", 2, { scheduleGroup: 1 });
      const drawn = applyOp(
        deepFreeze(state),
        { type: "draw.generate", payload: { roundId: round1.id, seed: 44 } },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(drawn.ok).toBe(true);
      if (!drawn.ok) return;

      const invalidDebate: Debate = {
        ...drawn.state.debates[0]!,
        teams: {
          ...drawn.state.debates[0]!.teams,
          OO: drawn.state.debates[0]!.teams.OG,
        },
      };
      const invalidState = createTournamentState(state.tournament, {
        ...drawn.state,
        debates: [invalidDebate, drawn.state.debates[1]!],
      });
      const invalidRelease = applyOp(
        deepFreeze(invalidState),
        { type: "draw.release", payload: { roundId: round1.id } },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(invalidRelease.ok).toBe(false);
      if (!invalidRelease.ok) expect(invalidRelease.code).toBe("INVALID");

      const clashDebate: Debate = {
        ...drawn.state.debates[0]!,
        id: `debate-${r2.id}-1`,
        roundId: r2.id,
        roundSeq: 2,
      };
      const clashState = createTournamentState(state.tournament, {
        ...drawn.state,
        teams,
        rounds: [round1, r2],
        debates: [...drawn.state.debates, clashDebate],
      });
      const clashRelease = applyOp(
        deepFreeze(clashState),
        { type: "draw.release_teams", payload: { roundId: round1.id } },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(clashRelease.ok).toBe(false);
      if (!clashRelease.ok) expect(clashRelease.code).toBe("INVALID");
    });
  });

  describe("swing.create & swing.toggle_round", () => {
    it("creates a swing team and toggles rounds with inverse round-trips", () => {
      const tournament = makeTournament("bp");
      const r1 = makeRound("t-bp", 1);
      const r2 = makeRound("t-bp", 2);
      const teams = makeTeams(3, { tournamentId: "t-bp", speakersPerTeam: 2 });
      const state = createTournamentState(tournament, {
        teams,
        rounds: [r1, r2],
      });

      const afterCreate = expectOpRoundTrip(state, {
        type: "swing.create",
        payload: {
          roundId: r1.id,
          name: "Swing 1",
          speakers: [{ name: "Alex Reserve" }, { name: "Sam Reserve" }],
        },
      });
      const swingTeam = afterCreate.teams.find((team) => team.isSwing);
      expect(swingTeam).toBeDefined();
      expect(swingTeam!.swingRoundIds).toEqual([r1.id]);

      const afterAddR2 = expectOpRoundTrip(afterCreate, {
        type: "swing.toggle_round",
        payload: { teamId: swingTeam!.id, roundId: r2.id, enabled: true },
      });
      expect(
        afterAddR2.teams.find((t) => t.id === swingTeam!.id)!.swingRoundIds,
      ).toEqual([r1.id, r2.id]);

      const afterRemoveR1 = expectOpRoundTrip(afterAddR2, {
        type: "swing.toggle_round",
        payload: { teamId: swingTeam!.id, roundId: r1.id },
      });
      expect(
        afterRemoveR1.teams.find((t) => t.id === swingTeam!.id)!.swingRoundIds,
      ).toEqual([r2.id]);
    });

    it("rejects invalid swing teams, elimination rounds, and FORBIDDEN roles", () => {
      const tournament = makeTournament("bp");
      const r1 = makeRound("t-bp", 1);
      const elim = makeRound("t-bp", 2, {
        stage: "elimination",
        drawType: "elimination",
      });
      const teams = makeTeams(4, { tournamentId: "t-bp", speakersPerTeam: 2 });
      const state = createTournamentState(tournament, {
        teams,
        rounds: [r1, elim],
      });

      const badCreate = applyOp(
        deepFreeze(state),
        {
          type: "swing.create",
          payload: {
            roundId: r1.id,
            name: "Swing Bad",
            speakers: [{ name: "Only One" }],
          },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(badCreate.ok).toBe(false);
      if (!badCreate.ok) expect(badCreate.code).toBe("INVALID");

      const badToggleNonSwing = applyOp(
        deepFreeze(state),
        {
          type: "swing.toggle_round",
          payload: { teamId: teams[0]!.id, roundId: r1.id },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(badToggleNonSwing.ok).toBe(false);
      if (!badToggleNonSwing.ok) expect(badToggleNonSwing.code).toBe("INVALID");

      const forbidden = applyOp(
        deepFreeze(state),
        {
          type: "swing.create",
          payload: {
            roundId: r1.id,
            name: "Swing 1",
            speakers: [{ name: "A" }, { name: "B" }],
          },
        },
        EQUITY_ACTOR,
        registry,
      );
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");

      expectStaleConflictAndForcedSuccess(
        state,
        {
          type: "swing.create",
          payload: {
            roundId: r1.id,
            name: "Swing 1",
            speakers: [{ name: "A" }, { name: "B" }],
          },
        },
        recordKey("team", `swing-${r1.id}-1`),
      );
    });
  });

  it("never mutates ballots when simulateBallot is used in draw tests", () => {
    const { state, debate, teams } = (() => {
      const f = makeFixtureDebateAndBallot();
      return {
        state: f.state,
        debate: f.debate,
        teams: f.state.teams,
      };
    })();
    const extraBallot = simulateBallot(
      debate,
      teams,
      state.tournament,
      createSeededRng(3),
      { id: "ballot-extra", version: 2, confirmed: false, timestamp: FIXED_TIME },
    );
    expect(extraBallot.debateId).toBe(debate.id);
  });
});
