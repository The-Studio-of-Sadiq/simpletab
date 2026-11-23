import { describe, expect, it } from "vitest";
import { createSeededRng } from "@/lib/draw/rng";
import {
  FIXED_TIME,
  makeAdjudicators,
  makeRound,
  makeTeams,
  makeTournament,
  makeVenues,
  simulateBallot,
} from "@/test/tournamentFixtures";
import type { BreakCategory } from "@/types";
import {
  applyOp,
  createTournamentState,
  defaultRegistry,
  type OpRequest,
  type TournamentState,
} from "../index";
import {
  deepFreeze,
  expectOpRoundTrip,
  expectWrittenVersionBumps,
  makeInstitutions,
  TAB_ASSISTANT_ACTOR,
  TAB_DIRECTOR_ACTOR,
} from "../test-helpers";

function makeBreakTournamentState(): TournamentState {
  const tournamentId = "t-break";
  const tournament = makeTournament("australs", { ballotMode: "consensus" }, tournamentId);
  const institutions = makeInstitutions(tournamentId, 8);
  const teams = makeTeams(4, {
    tournamentId,
    institutionCount: 4,
    speakersPerTeam: 3,
  });
  const adjudicators = makeAdjudicators(4, {
    tournamentId,
    institutionCount: 4,
    rng: createSeededRng(21),
  });
  const venues = makeVenues(2, tournamentId);
  const prelim1 = makeRound(tournamentId, 1, {
    drawStatus: "released",
    completed: true,
    resultsReleased: true,
  });
  const elim1 = makeRound(tournamentId, 2, {
    name: "Grand Final",
    abbreviation: "GF",
    stage: "elimination",
    drawType: "elimination",
    drawStatus: "none",
  });

  // Create prelim debates with distinct results so team-1 & team-2 rank 1st & 2nd unambiguously
  const d1 = {
    id: "d-p1-1",
    tournamentId,
    roundId: prelim1.id,
    roundSeq: 1,
    venueId: venues[0]!.id,
    venueName: venues[0]!.name,
    bracket: 0,
    roomRank: 1,
    importance: 1,
    resultStatus: "confirmed" as const,
    sidesConfirmed: true,
    flags: [],
    teams: {
      AFF: { teamId: teams[0]!.id, teamName: teams[0]!.name, side: "AFF" as const },
      NEG: { teamId: teams[2]!.id, teamName: teams[2]!.name, side: "NEG" as const },
    } as TournamentState["debates"][number]["teams"],
    adjudicators: {
      chairId: adjudicators[0]!.id,
      chairName: adjudicators[0]!.name,
      panellistIds: [],
      panellistNames: [],
      traineeIds: [],
      traineeNames: [],
    },
  };
  const d2 = {
    id: "d-p1-2",
    tournamentId,
    roundId: prelim1.id,
    roundSeq: 1,
    venueId: venues[1]!.id,
    venueName: venues[1]!.name,
    bracket: 0,
    roomRank: 2,
    importance: 1,
    resultStatus: "confirmed" as const,
    sidesConfirmed: true,
    flags: [],
    teams: {
      AFF: { teamId: teams[1]!.id, teamName: teams[1]!.name, side: "AFF" as const },
      NEG: { teamId: teams[3]!.id, teamName: teams[3]!.name, side: "NEG" as const },
    } as TournamentState["debates"][number]["teams"],
    adjudicators: {
      chairId: adjudicators[1]!.id,
      chairName: adjudicators[1]!.name,
      panellistIds: [],
      panellistNames: [],
      traineeIds: [],
      traineeNames: [],
    },
  };

  const b1 = simulateBallot(d1, teams, tournament, createSeededRng(100), {
    id: "b-p1-1",
    confirmed: true,
  });
  const b2 = simulateBallot(d2, teams, tournament, createSeededRng(101), {
    id: "b-p1-2",
    confirmed: true,
  });
  // Force AFF (team-1 and team-2) to win clearly
  b1.teamScores.AFF = { ...b1.teamScores.AFF, points: 1, win: true, rank: 1, totalSpeakerScore: 230, margin: 10 };
  b1.teamScores.NEG = { ...b1.teamScores.NEG, points: 0, win: false, rank: 2, totalSpeakerScore: 220, margin: -10 };
  b2.teamScores.AFF = { ...b2.teamScores.AFF, points: 1, win: true, rank: 1, totalSpeakerScore: 228, margin: 8 };
  b2.teamScores.NEG = { ...b2.teamScores.NEG, points: 0, win: false, rank: 2, totalSpeakerScore: 220, margin: -8 };

  return createTournamentState(tournament, {
    institutions,
    teams,
    adjudicators,
    venues,
    rounds: [prelim1, elim1],
    debates: [d1, d2],
    ballots: [b1, b2],
  });
}

describe("ops breaks & elimination", () => {
  it("saves break categories, overrides teams, computes/clears break, and advances elimination", () => {
    const registry = defaultRegistry();
    const state0 = makeBreakTournamentState();
    const openCat: BreakCategory = {
      id: "bc-open",
      tournamentId: state0.tournament.id,
      name: "Open",
      slug: "open",
      seq: 1,
      breakSize: 2,
      reserveSize: 1,
      isGeneral: true,
      priority: 1,
      qualificationRule: "standard",
    };

    const forbidden = applyOp(
      deepFreeze(state0),
      { type: "break.categories_save", payload: { categories: [openCat] } },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");

    const state1 = expectOpRoundTrip(
      state0,
      { type: "break.categories_save", payload: { categories: [openCat] } },
      TAB_DIRECTOR_ACTOR,
    );
    expect(state1.breakCategories).toHaveLength(1);

    const state2 = expectOpRoundTrip(
      state1,
      {
        type: "break.team_override",
        payload: { categoryId: "bc-open", teamId: "team-4", override: "withdrawn" },
      },
      TAB_DIRECTOR_ACTOR,
    );
    expect(state2.breakCategories[0]?.teamOverrides?.["team-4"]).toBe("withdrawn");

    // Undo team_override restored clean state; compute break on state1
    const computed = applyOp(
      deepFreeze(state1),
      {
        type: "break.compute",
        payload: { categoryId: "bc-open", generatedAt: FIXED_TIME },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(computed.ok).toBe(true);
    if (!computed.ok) return;
    expect(computed.state.breakCategories[0]?.generatedBreak?.breakingTeamIds).toEqual([
      "team-1",
      "team-2",
    ]);
    expect(computed.state.teams.filter((t) => t.breakStatus === "breaking").map((t) => t.id)).toEqual([
      "team-1",
      "team-2",
    ]);
    expect(computed.inverse?.type).toBe("break.clear");
    expectWrittenVersionBumps(state1, computed);

    // Inverse clears break cleanly
    const cleared = applyOp(
      deepFreeze(computed.state),
      computed.inverse!,
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.state.breakCategories[0]?.generatedBreak).toBeUndefined();
    expect(cleared.state.teams.every((t) => t.breakStatus === undefined)).toBe(true);
    expect(cleared.inverse).toBeNull();
    expectWrittenVersionBumps(computed.state, cleared);

    // Re-compute, draw Grand Final, enter confirmed ballot, and advance elimination
    const recomputed = applyOp(
      deepFreeze(cleared.state),
      {
        type: "break.compute",
        payload: { categoryId: "bc-open", generatedAt: FIXED_TIME },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(recomputed.ok).toBe(true);
    if (!recomputed.ok) return;

    const drawn = applyOp(
      deepFreeze(recomputed.state),
      {
        type: "draw.generate",
        payload: { roundId: "round-t-break-2", seed: 7 },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(drawn.ok).toBe(true);
    if (!drawn.ok) return;

    const gfDebate = drawn.state.debates.find(
      (d) => d.roundId === "round-t-break-2",
    )!;
    const gfBallot = simulateBallot(
      gfDebate,
      drawn.state.teams,
      drawn.state.tournament,
      createSeededRng(202),
      { id: "b-gf-1", confirmed: true },
    );
    const enteredGf = applyOp(
      deepFreeze(drawn.state),
      { type: "ballot.enter", payload: { ballot: gfBallot } },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(enteredGf.ok).toBe(true);
    if (!enteredGf.ok) return;

    // Cannot clear break once elimination round has a draw
    const clearBlocked = applyOp(
      deepFreeze(enteredGf.state),
      { type: "break.clear", payload: { categoryId: "bc-open" } },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(clearBlocked.ok).toBe(false);
    if (!clearBlocked.ok) expect(clearBlocked.code).toBe("INVALID");

    const advanced = applyOp(
      deepFreeze(enteredGf.state),
      {
        type: "elimination.advance",
        payload: { roundId: "round-t-break-2" },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    const gfRound = advanced.state.rounds.find(
      (r) => r.id === "round-t-break-2",
    );
    expect(gfRound?.eliminationAdvanced).toBe(true);
    expect(gfRound?.completed).toBe(true);
    expect(advanced.inverse).toBeNull();
    expectWrittenVersionBumps(enteredGf.state, advanced);

    // Advancing a second time is rejected
    const advanceAgain = applyOp(
      deepFreeze(advanced.state),
      {
        type: "elimination.advance",
        payload: { roundId: "round-t-break-2" },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(advanceAgain.ok).toBe(false);
    if (!advanceAgain.ok) expect(advanceAgain.code).toBe("INVALID");
  });

  it("rejects break.compute when there are too few eligible teams or unoverridden incomplete prelims", () => {
    const registry = defaultRegistry();
    const state = makeBreakTournamentState();
    const tooLarge: BreakCategory = {
      id: "bc-big",
      tournamentId: state.tournament.id,
      name: "Big",
      slug: "big",
      seq: 1,
      breakSize: 8,
      reserveSize: 0,
      isGeneral: true,
      priority: 1,
    };
    const saved = applyOp(
      deepFreeze(state),
      { type: "break.categories_save", payload: { categories: [tooLarge] } },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const failedCompute = applyOp(
      deepFreeze(saved.state),
      { type: "break.compute", payload: { categoryId: "bc-big" } },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(failedCompute.ok).toBe(false);
    if (!failedCompute.ok) expect(failedCompute.code).toBe("INVALID");
  });

  it("validates and checks permissions for every break operation", () => {
    const registry = defaultRegistry();
    const state = makeBreakTournamentState();
    const category: BreakCategory = {
      id: "bc-contract",
      tournamentId: state.tournament.id,
      name: "Contract",
      slug: "contract",
      seq: 1,
      breakSize: 2,
      reserveSize: 0,
      isGeneral: true,
      priority: 1,
    };
    const saved = applyOp(
      deepFreeze(state),
      { type: "break.categories_save", payload: { categories: [category] } },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const validRequests: OpRequest<unknown>[] = [
      { type: "break.categories_save", payload: { categories: [category] } },
      {
        type: "break.team_override",
        payload: { categoryId: category.id, teamId: "team-1", override: "withdrawn" },
      },
      { type: "break.compute", payload: { categoryId: category.id } },
      { type: "break.clear", payload: { categoryId: category.id } },
      { type: "elimination.advance", payload: { roundId: "round-t-break-2" } },
    ];
    for (const request of validRequests) {
      const forbidden = applyOp(
        deepFreeze(saved.state),
        request,
        TAB_ASSISTANT_ACTOR,
        registry,
      );
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");
    }

    const invalidRequests: OpRequest<unknown>[] = [
      {
        type: "break.categories_save",
        payload: { categories: [{ ...category, id: "" }] },
      },
      {
        type: "break.team_override",
        payload: { categoryId: category.id, teamId: "missing", override: "withdrawn" },
      },
      { type: "break.compute", payload: { categoryId: "missing" } },
      { type: "break.clear", payload: { categoryId: "missing" } },
      { type: "elimination.advance", payload: { roundId: "missing" } },
    ];
    for (const request of invalidRequests) {
      const invalid = applyOp(
        deepFreeze(saved.state),
        request,
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) expect(invalid.code).toBe("INVALID");
    }
  });
});
