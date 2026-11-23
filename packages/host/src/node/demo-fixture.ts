import {
  createTournamentState,
  type Actor,
  type OpRequest,
  type TournamentState,
} from "@simpletab/core/ops";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import type { Round, Team, Tournament, TournamentPreferences } from "@simpletab/core/types";
import { HostEngine } from "./engine/engine";

const DEMO_TIMESTAMP = "2026-10-01T09:00:00.000Z";

function createDemoPreferences(): TournamentPreferences {
  return {
    teamsInDebate: 4,
    substantiveSpeakers: 2,
    replyScoresEnabled: false,
    minSpeakerScore: 50,
    maxSpeakerScore: 100,
    stepSpeakerScore: 1,
    minReplyScore: 30,
    maxReplyScore: 40,
    drawRule: "power_paired",
    sideAllocationRule: "balanced",
    ballotDoubleEntry: false,
    publicDraw: true,
    publicResults: true,
    publicStandings: true,
    publicMotions: true,
    feedbackEnabled: false,
    feedbackMinScore: 1,
    feedbackMaxScore: 5,
  };
}

export function createDemoInitialState(): TournamentState {
  const tournament: Tournament = {
    id: "t-bp-demo",
    name: "SimpleTab BP Demo",
    shortName: "BP Demo",
    slug: "bp-demo",
    format: "bp",
    active: true,
    ownerId: "host-owner-1",
    admins: { "host-owner-1": true },
    preferences: createDemoPreferences(),
    createdAt: DEMO_TIMESTAMP,
    updatedAt: DEMO_TIMESTAMP,
  };
  return createTournamentState(tournament);
}

function makeDemoTeam(tournamentId: string, index: number): Team {
  const id = `demo-team-${index}`;
  return {
    id,
    tournamentId,
    name: `Demo Team ${String(index).padStart(2, "0")}`,
    speakers: [
      { id: `${id}-s1`, name: `Speaker ${index}.1` },
      { id: `${id}-s2`, name: `Speaker ${index}.2` },
    ],
    breakCategories: [],
    speakerCategories: [],
    checkedIn: true,
  };
}

function makeDemoRound(tournamentId: string): Round {
  return {
    id: `round-${tournamentId}-1`,
    tournamentId,
    seq: 1,
    name: "Round 1",
    abbreviation: "R1",
    stage: "preliminary",
    drawType: "random",
    drawStatus: "none",
    feedbackWeight: 1,
    silent: false,
    motionsReleased: false,
    resultsReleased: false,
    completed: false,
    createdAt: DEMO_TIMESTAMP,
  };
}

export async function seedDemoTournament(dbPath: string): Promise<HostEngine> {
  const initialState = createDemoInitialState();
  const engine = HostEngine.open(dbPath, {
    initialState,
    clock: () => new Date(DEMO_TIMESTAMP),
  });
  const actor: Actor = {
    ref: "host-owner-1",
    type: "human",
    role: BUILT_IN_ROLES.host_owner,
    isHostOwner: true,
  };

  try {
    const requests: OpRequest[] = [
      ...[1, 2, 3, 4].map((index) => ({
        type: "team.create",
        payload: { team: makeDemoTeam(initialState.tournament.id, index) },
      })),
      {
        type: "round.create",
        payload: { round: makeDemoRound(initialState.tournament.id) },
      },
    ];

    for (const request of requests) {
      const result = await engine.submit(request, actor);
      if (!result.ok) {
        throw new Error(
          `Failed to seed demo operation ${request.type}: ${result.errors.join("; ")}`,
        );
      }
    }

    const check = await engine.runFastCheck();
    if (!check.ok) {
      throw new Error(`Demo tournament failed integrity check: ${check.reason}`);
    }
    return engine;
  } catch (error) {
    await engine.close();
    throw error;
  }
}
