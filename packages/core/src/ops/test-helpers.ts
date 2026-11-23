import { BUILT_IN_ROLES, customRole } from "@/permissions";
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
import type { Debate, Institution } from "@/types";
import {
  applyOp,
  createTournamentState,
  defaultRegistry,
  type Actor,
  type ApplySuccess,
  type OpRequest,
  type RecordKey,
  type TournamentState,
} from "./index";

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      const child = (value as Record<string, unknown>)[key];
      deepFreeze(child);
    }
  }
  return value;
}

export function stripVersions(
  state: TournamentState,
): Omit<TournamentState, "versions"> {
  const { versions: _versions, ...rest } = state;
  return rest;
}

export const HOST_OWNER_ACTOR: Actor = {
  ref: "host-owner-1",
  type: "human",
  role: BUILT_IN_ROLES.host_owner,
  isHostOwner: true,
};

export const TAB_DIRECTOR_ACTOR: Actor = {
  ref: "td-1",
  type: "human",
  role: BUILT_IN_ROLES.tab_director,
  isHostOwner: false,
};

export const TAB_ASSISTANT_ACTOR: Actor = {
  ref: "ta-1",
  type: "human",
  role: BUILT_IN_ROLES.tab_assistant,
  isHostOwner: false,
};

export const EQUITY_ACTOR: Actor = {
  ref: "equity-1",
  type: "human",
  role: BUILT_IN_ROLES.equity,
  isHostOwner: false,
};

export const ADJ_CORE_ACTOR: Actor = {
  ref: "adjcore-1",
  type: "human",
  role: BUILT_IN_ROLES.adjudication_core,
  isHostOwner: false,
};

export const DISPLAY_ACTOR: Actor = {
  ref: "display-1",
  type: "human",
  role: BUILT_IN_ROLES.display,
  isHostOwner: false,
};

export const AI_ACTOR: Actor = {
  ref: "ai-cli-1",
  type: "ai",
  role: BUILT_IN_ROLES.ai,
  isHostOwner: false,
};

export const PROPOSALS_ONLY_HUMAN_ACTOR: Actor = {
  ref: "human-proposals-only",
  type: "human",
  role: customRole("custom_ai_like", "Proposals Only", ["settings.edit", "rounds.manage"], {
    proposalsOnly: true,
  }),
  isHostOwner: false,
};

export const SERVICE_ACTOR: Actor = {
  ref: "simpletab-ballots",
  type: "service",
  role: BUILT_IN_ROLES.display,
  isHostOwner: false,
};

export function makeInstitutions(tournamentId: string, count = 2): Institution[] {
  return Array.from({ length: count }, (_, idx) => ({
    id: `inst-${idx + 1}`,
    tournamentId,
    name: `Institution ${idx + 1}`,
    code: `I${idx + 1}`,
  }));
}

export function makeFixtureDebateAndBallot(
  tournamentId = "t-2team",
): { state: TournamentState; debate: Debate } {
  const tournament = makeTournament("australs", {}, tournamentId);
  const institutions = makeInstitutions(tournamentId, 2);
  const teams = makeTeams(2, {
    tournamentId,
    institutionCount: 2,
    speakersPerTeam: 3,
  });
  const adjudicators = makeAdjudicators(3, {
    tournamentId,
    institutionCount: 2,
    rng: createSeededRng(42),
  });
  const venues = makeVenues(2, tournamentId);
  const round1 = makeRound(tournamentId, 1, { drawStatus: "released" });
  const debate: Debate = {
    id: "debate-1",
    tournamentId,
    roundId: round1.id,
    roundSeq: 1,
    venueId: venues[0]!.id,
    venueName: venues[0]!.name,
    bracket: 0,
    roomRank: 1,
    importance: 1,
    resultStatus: "confirmed",
    sidesConfirmed: true,
    flags: [],
    teams: {
      AFF: {
        teamId: teams[0]!.id,
        teamName: teams[0]!.name,
        side: "AFF",
      },
      NEG: {
        teamId: teams[1]!.id,
        teamName: teams[1]!.name,
        side: "NEG",
      },
    } as Debate["teams"],
    adjudicators: {
      chairId: adjudicators[0]!.id,
      chairName: adjudicators[0]!.name,
      panellistIds: [adjudicators[1]!.id],
      panellistNames: [adjudicators[1]!.name],
      traineeIds: [adjudicators[2]!.id],
      traineeNames: [adjudicators[2]!.name],
    },
  };
  const ballot = simulateBallot(
    debate,
    teams,
    tournament,
    createSeededRng(7),
    {
      confirmed: true,
      submitterId: adjudicators[0]!.id,
      timestamp: FIXED_TIME,
    },
  );
  const state = createTournamentState(tournament, {
    institutions,
    teams,
    adjudicators,
    venues,
    rounds: [round1],
    debates: [debate],
    ballots: [ballot],
  });
  return { state, debate };
}

export function expectOpRoundTrip<P>(
  initialState: TournamentState,
  request: OpRequest<P>,
  actor: Actor = TAB_DIRECTOR_ACTOR,
): TournamentState {
  const registry = defaultRegistry();
  const originalState = structuredClone(initialState);
  const frozenBefore = deepFreeze(initialState);
  const applied = applyOp(frozenBefore, request, actor, registry);
  expect(applied.ok).toBe(true);
  if (!applied.ok) {
    throw new Error(`Expected op ${request.type} to succeed: ${applied.errors.join("; ")}`);
  }
  expect(stripVersions(frozenBefore)).toEqual(stripVersions(originalState));
  expect(frozenBefore.versions).toEqual(originalState.versions);
  expectWrittenVersionBumps(frozenBefore, applied);
  expect(applied.inverse).not.toBeNull();
  const frozenAfter = deepFreeze(applied.state);
  const undone = applyOp(frozenAfter, applied.inverse!, actor, registry);
  expect(undone.ok).toBe(true);
  if (!undone.ok) {
    throw new Error(`Expected inverse of ${request.type} to succeed: ${undone.errors.join("; ")}`);
  }
  expect(stripVersions(undone.state)).toEqual(stripVersions(frozenBefore));
  return applied.state;
}

export function expectWrittenVersionBumps<P>(
  initialState: TournamentState,
  applied: ApplySuccess<P>,
): void {
  for (const key of applied.writes) {
    expect(applied.state.versions[key]).toBe(
      (initialState.versions[key] ?? 0) + 1,
    );
  }
}

export function expectStaleConflictAndForcedSuccess<P>(
  state: TournamentState,
  request: OpRequest<P>,
  conflictKey: RecordKey,
  actor: Actor = TAB_DIRECTOR_ACTOR,
  forcedActor: Actor = HOST_OWNER_ACTOR,
): void {
  const registry = defaultRegistry();
  const currentVersion = state.versions[conflictKey] ?? 0;
  const staleVersion = currentVersion + 99;
  const frozen = deepFreeze(state);

  const conflicted = applyOp(
    frozen,
    {
      ...request,
      expectedVersions: { [conflictKey]: staleVersion },
    },
    actor,
    registry,
  );
  expect(conflicted.ok).toBe(false);
  if (!conflicted.ok) {
    expect(conflicted.code).toBe("VERSION_CONFLICT");
    expect(conflicted.current?.[conflictKey]).toBe(currentVersion);
  }

  const forcedNonOwner = applyOp(
    frozen,
    {
      ...request,
      expectedVersions: { [conflictKey]: staleVersion },
      forced: true,
    },
    actor,
    registry,
  );
  expect(forcedNonOwner.ok).toBe(false);
  if (!forcedNonOwner.ok) {
    expect(forcedNonOwner.code).toBe("VERSION_CONFLICT");
  }

  const forcedOwner = applyOp(
    frozen,
    {
      ...request,
      expectedVersions: { [conflictKey]: staleVersion },
      forced: true,
    },
    forcedActor,
    registry,
  );
  expect(forcedOwner.ok).toBe(true);
}
