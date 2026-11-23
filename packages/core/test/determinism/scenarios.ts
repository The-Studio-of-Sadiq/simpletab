import { createSeededRng } from "@/lib/draw/rng";
import {
  FIXED_TIME,
  makeRound,
  makeTeams,
  makeTournament,
  makeVenues,
  simulateBallot,
} from "@/test/tournamentFixtures";
import type { Debate, TournamentFormat } from "@/types";
import {
  applyOp,
  createTournamentState,
  defaultRegistry,
  type TournamentState,
} from "@/ops";
import { TAB_DIRECTOR_ACTOR } from "@/ops/test-helpers";

type SupportedFormat = Extract<TournamentFormat, "bp" | "australs">;

export interface DrawScenario {
  name: string;
  generate(): Debate[];
}

interface ScenarioFixture {
  tournamentId: string;
  format: SupportedFormat;
  teamCount: number;
  preferences?: Parameters<typeof makeTournament>[1];
}

const registry = defaultRegistry();

function makeScenarioFixture(fixture: ScenarioFixture): {
  state: TournamentState;
  tournament: ReturnType<typeof makeTournament>;
  round1: ReturnType<typeof makeRound>;
  round2: ReturnType<typeof makeRound>;
  teams: ReturnType<typeof makeTeams>;
} {
  const { tournamentId, format, teamCount, preferences = {} } = fixture;
  const tournament = makeTournament(format, preferences, tournamentId);
  const round1 = makeRound(tournamentId, 1);
  const round2 = makeRound(tournamentId, 2);
  const teams = makeTeams(teamCount, {
    tournamentId,
    institutionCount: Math.min(4, Math.floor(teamCount / 2)),
    speakersPerTeam: format === "bp" ? 2 : 3,
    prefix: `${tournamentId}-team`,
  });
  const teamsPerDebate = format === "bp" ? 4 : 2;
  const venues = makeVenues(Math.ceil(teamCount / teamsPerDebate), tournamentId);
  const state = createTournamentState(tournament, {
    teams,
    venues,
    rounds: [round1, round2],
  });
  return { state, tournament, round1, round2, teams };
}

function runDraw(state: TournamentState, roundId: string, seed: number): TournamentState {
  const result = applyOp(
    state,
    { type: "draw.generate", payload: { roundId, seed } },
    TAB_DIRECTOR_ACTOR,
    registry,
  );
  if (!result.ok) {
    throw new Error(`Could not generate ${roundId}: ${result.errors.join(" ")}`);
  }
  return result.state;
}

function firstRoundScenario(
  name: string,
  format: SupportedFormat,
  teamCount: number,
  seed: number,
  preferences: ScenarioFixture["preferences"] = {},
): DrawScenario {
  return {
    name,
    generate(): Debate[] {
      const { state, round1 } = makeScenarioFixture({
        tournamentId: `determinism-${name}`,
        format,
        teamCount,
        preferences,
      });
      const drawnState = runDraw(state, round1.id, seed);
      return drawnState.debates.filter((debate) => debate.roundId === round1.id);
    },
  };
}

function powerPairedScenario(
  name: string,
  format: SupportedFormat,
  teamCount: number,
  seed: number,
): DrawScenario {
  return {
    name,
    generate(): Debate[] {
      const { state, tournament, round1, round2, teams } = makeScenarioFixture({
        tournamentId: `determinism-${name}`,
        format,
        teamCount,
      });
      const firstRoundState = runDraw(state, round1.id, 314159);
      const ballotRng = createSeededRng(271828);
      const ballots = firstRoundState.debates
        .filter((debate) => debate.roundId === round1.id && !debate.byeTeamId)
        .map((debate) => simulateBallot(debate, teams, tournament, ballotRng));
      const rounds = firstRoundState.rounds.map((round) =>
        round.id === round1.id ? { ...round, completed: true, updatedAt: FIXED_TIME } : round,
      );
      const stateWithResults = createTournamentState(tournament, {
        ...firstRoundState,
        rounds,
        ballots,
      });
      const drawnState = runDraw(stateWithResults, round2.id, seed);
      return drawnState.debates.filter((debate) => debate.roundId === round2.id);
    },
  };
}

export const scenarios: DrawScenario[] = [
  firstRoundScenario("bp-round-1-seed-101", "bp", 8, 101),
  firstRoundScenario("bp-round-1-seed-9999", "bp", 8, 9999),
  firstRoundScenario("two-team-round-1-seed-7", "australs", 8, 7),
  firstRoundScenario("two-team-round-1-seed-8128", "australs", 8, 8128),
  powerPairedScenario("bp-round-2-power-paired-seed-2026", "bp", 8, 2026),
  powerPairedScenario("bp-round-2-power-paired-seed-9001", "bp", 8, 9001),
  powerPairedScenario("two-team-round-2-power-paired-seed-505", "australs", 8, 505),
  firstRoundScenario("two-team-round-1-bye-seed-606", "australs", 5, 606, {
    byeTeamSelectionMethod: "random",
  }),
];
