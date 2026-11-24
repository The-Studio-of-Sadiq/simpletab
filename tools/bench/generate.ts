import { makeAdjudicators, makeTeams, makeTournament, makeVenues, simulateBallot } from "@/test/tournamentFixtures";
import { createSeededRng } from "@/lib/draw/rng";
import { buildRounds } from "@/lib/setup/presets";
import { applyOp, createTournamentState, defaultRegistry, type TournamentState } from "@/ops";
import { TAB_DIRECTOR_ACTOR } from "@/ops/test-helpers";
import type { Institution } from "@/types";

export type BenchSize = "wudc" | "xl";

export interface GeneratedBenchTournament {
  state: TournamentState;
  teamCount: number;
  adjudicatorCount: number;
  institutionCount: number;
  venueCount: number;
}

/** Prelim rounds in a benchmark tournament: five played rounds, then a sixth to draw. */
export const BENCH_PRELIM_ROUNDS = 6;

export function generateBenchTournament(size: BenchSize, seed = 20261124, prefillRounds = 5): GeneratedBenchTournament {
  const tournamentId = `bench-${size}`;
  const teamCount = size === "wudc" ? 400 : 1000;
  const adjudicatorCount = size === "wudc" ? 500 : 1250;
  const venueCount = size === "wudc" ? 100 : 250;
  const institutionCount = size === "wudc" ? 150 : 250;
  const tournament = makeTournament("bp", { teamsInDebate: 4, substantiveSpeakers: 2, replyScoresEnabled: false }, tournamentId);
  const teams = makeTeams(teamCount, { tournamentId, institutionCount, speakersPerTeam: 2, prefix: "bench-team" });
  const institutions: Institution[] = Array.from({ length: institutionCount }, (_, index) => ({
    id: `inst-${index + 1}`,
    tournamentId,
    name: `Institution ${index + 1}`,
    code: `I${String(index + 1).padStart(3, "0")}`,
  }));
  const rng = createSeededRng(seed);
  const adjudicators = makeAdjudicators(adjudicatorCount, {
    tournamentId,
    institutionCount,
    rng,
    traineeEvery: 10,
  }).map((adjudicator) => {
    if (adjudicator.institutionId !== undefined) {
      return {
        ...adjudicator,
        conflicts: [teams[(Number(adjudicator.id.split("-")[1]) - 1) % teamCount]!.id],
      };
    }
    return adjudicator;
  });
  const venues = makeVenues(venueCount, tournamentId);
  // CrabbyTab's own round builder: six preliminary rounds plus the elimination rounds a BP break of
  // 8 needs (the break refuses to run without them). IDs are shortened to round-<seq>.
  const rounds = buildRounds({
    tournamentId,
    prelimRounds: BENCH_PRELIM_ROUNDS,
    maxBreakSize: 8,
    teamsInDebate: 4,
    drawRule: "power_paired",
  }).map((round) => ({ ...round, id: `round-${round.seq}`, createdAt: "2026-11-24T00:00:00.000Z" }));
  const breakCategory = {
    id: "bc-open",
    tournamentId,
    name: "Open",
    slug: "open",
    seq: 1,
    priority: 1,
    breakSize: 8,
    reserveSize: 0,
    isGeneral: true,
  };
  let state = createTournamentState(tournament, {
    institutions,
    teams,
    adjudicators,
    venues,
    rounds,
    breakCategories: [breakCategory],
  });
  const registry = defaultRegistry();
  for (let roundIndex = 0; roundIndex < prefillRounds; roundIndex += 1) {
    const round = rounds[roundIndex]!;
    const drawn = applyOp(state, { type: "draw.generate", payload: { roundId: round.id, seed: seed + roundIndex } }, TAB_DIRECTOR_ACTOR, registry);
    if (!drawn.ok) throw new Error(`Could not prefill draw ${round.id}: ${drawn.errors.join("; ")}`);
    state = drawn.state;
    const allocated = applyOp(state, { type: "allocation.auto", payload: { roundId: round.id, panelSize: 3 } }, TAB_DIRECTOR_ACTOR, registry);
    if (!allocated.ok) throw new Error(`Could not prefill allocation ${round.id}: ${allocated.errors.join("; ")}`);
    state = allocated.state;
    for (const debate of state.debates.filter((item) => item.roundId === round.id)) {
      if (debate.byeTeamId) continue;
      const ballot = simulateBallot(debate, state.teams, tournament, rng, { confirmed: true });
      const entered = applyOp(state, { type: "ballot.enter", payload: { ballot } }, TAB_DIRECTOR_ACTOR, registry);
      if (!entered.ok) throw new Error(`Could not prefill ballot ${debate.id}: ${entered.errors.join("; ")}`);
      state = entered.state;
    }
    const completed = applyOp(state, { type: "round.set_completion", payload: { roundId: round.id, completed: true } }, TAB_DIRECTOR_ACTOR, registry);
    if (!completed.ok) throw new Error(`Could not complete ${round.id}: ${completed.errors.join("; ")}`);
    state = completed.state;
  }
  return { state, teamCount, adjudicatorCount, institutionCount, venueCount };
}
