import { describe, expect, it } from "vitest";
import { customRole } from "@/permissions";
import { FIXED_TIME, makeTeams, makeTournament } from "@/test/tournamentFixtures";
import {
  applyOp,
  createTournamentState,
  defaultRegistry,
  recordKey,
  type OpRequest,
} from "../index";
import {
  ADJ_CORE_ACTOR,
  deepFreeze,
  DISPLAY_ACTOR,
  EQUITY_ACTOR,
  expectOpRoundTrip,
  expectStaleConflictAndForcedSuccess,
  makeFixtureDebateAndBallot,
  makeInstitutions,
  TAB_ASSISTANT_ACTOR,
  TAB_DIRECTOR_ACTOR,
} from "../test-helpers";

describe("setup participant and conflict ops", () => {
  const registry = defaultRegistry();

  describe("institution.create / update / delete", () => {
    it("creates, updates, deletes institutions with inverse round-trips", () => {
      const state = createTournamentState(makeTournament("bp"));
      const inst = {
        id: "inst-1",
        tournamentId: "t-bp",
        name: "Dhaka University",
        code: "DU",
      };

      const afterCreate = expectOpRoundTrip(state, {
        type: "institution.create",
        payload: { institution: inst },
      });
      expect(afterCreate.institutions).toEqual([inst]);

      const afterUpdate = expectOpRoundTrip(afterCreate, {
        type: "institution.update",
        payload: { institution: { ...inst, name: "DU Debating", code: "DUDS" } },
      });
      expect(afterUpdate.institutions[0]!.code).toBe("DUDS");

      const afterDelete = expectOpRoundTrip(afterUpdate, {
        type: "institution.delete",
        payload: { institutionId: inst.id },
      });
      expect(afterDelete.institutions).toEqual([]);
    });

    it("rejects deleting an institution referenced by teams or adjudicators", () => {
      const { state } = makeFixtureDebateAndBallot();
      const res = applyOp(
        deepFreeze(state),
        {
          type: "institution.delete",
          payload: { institutionId: "inst-1" },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("INVALID");
        expect(res.errors[0]).toContain("cannot be deleted");
      }
    });

    it("enforces permissions and version conflicts for institution ops", () => {
      const state = createTournamentState(makeTournament("bp"), {
        institutions: makeInstitutions("t-bp", 1),
      });
      const inst = { id: "inst-2", tournamentId: "t-bp", name: "Uni B", code: "UB" };

      const requests: OpRequest<unknown>[] = [
        { type: "institution.create", payload: { institution: inst } },
        { type: "institution.update", payload: { institution: { ...state.institutions[0]!, name: "X" } } },
        { type: "institution.delete", payload: { institutionId: "inst-1" } },
      ];
      for (const req of requests) {
        const forbidden = applyOp(deepFreeze(state), req, DISPLAY_ACTOR, registry);
        expect(forbidden.ok).toBe(false);
        if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");
      }

      expectStaleConflictAndForcedSuccess(
        state,
        { type: "institution.create", payload: { institution: inst } },
        recordKey("institution", "inst-2"),
      );
      expectStaleConflictAndForcedSuccess(
        state,
        { type: "institution.update", payload: { institution: { ...state.institutions[0]!, name: "Updated" } } },
        recordKey("institution", "inst-1"),
      );
      expectStaleConflictAndForcedSuccess(
        state,
        { type: "institution.delete", payload: { institutionId: "inst-1" } },
        recordKey("institution", "inst-1"),
      );
    });
  });

  describe("team.create / update / delete", () => {
    it("creates, strips real-name codeNames, updates, deletes with inverse round-trips", () => {
      const state = createTournamentState(makeTournament("bp"));
      const [team1] = makeTeams(1, { tournamentId: "t-bp", speakersPerTeam: 2 });
      const withRealCodeName = { ...team1!, codeName: team1!.name };

      const afterCreate = expectOpRoundTrip(state, {
        type: "team.create",
        payload: { team: withRealCodeName },
      });
      expect(afterCreate.teams[0]!.codeName).toBeUndefined();

      const afterUpdate = expectOpRoundTrip(afterCreate, {
        type: "team.update",
        payload: { team: { ...afterCreate.teams[0]!, name: "Renamed Team", codeName: "Fox" } },
      });
      expect(afterUpdate.teams[0]!.name).toBe("Renamed Team");
      expect(afterUpdate.teams[0]!.codeName).toBe("Fox");

      const afterDelete = expectOpRoundTrip(afterUpdate, {
        type: "team.delete",
        payload: { teamId: team1!.id },
      });
      expect(afterDelete.teams).toEqual([]);
    });

    it("rejects removing a speaker with ballots and deleting a team with ballots", () => {
      const { state } = makeFixtureDebateAndBallot();
      const team = state.teams[0]!;

      const removeSpeakerRes = applyOp(
        deepFreeze(state),
        {
          type: "team.update",
          payload: {
            team: { ...team, speakers: team.speakers.slice(1) },
          },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(removeSpeakerRes.ok).toBe(false);
      if (!removeSpeakerRes.ok) expect(removeSpeakerRes.code).toBe("INVALID");

      const deleteTeamRes = applyOp(
        deepFreeze(state),
        {
          type: "team.delete",
          payload: { teamId: team.id },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(deleteTeamRes.ok).toBe(false);
      if (!deleteTeamRes.ok) expect(deleteTeamRes.code).toBe("INVALID");
    });

    it("enforces permissions and version conflicts for team ops", () => {
      const [team1, team2] = makeTeams(2, { tournamentId: "t-bp", speakersPerTeam: 2 });
      const state = createTournamentState(makeTournament("bp"), { teams: [team1!] });

      const forbidden = applyOp(
        deepFreeze(state),
        { type: "team.create", payload: { team: team2! } },
        EQUITY_ACTOR,
        registry,
      );
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");

      expectStaleConflictAndForcedSuccess(
        state,
        { type: "team.create", payload: { team: team2! } },
        recordKey("team", team2!.id),
      );
      expectStaleConflictAndForcedSuccess(
        state,
        { type: "team.update", payload: { team: { ...team1!, name: "New" } } },
        recordKey("team", team1!.id),
      );
      expectStaleConflictAndForcedSuccess(
        state,
        { type: "team.delete", payload: { teamId: team1!.id } },
        recordKey("team", team1!.id),
      );
    });
  });

  describe("adjudicator.create / update / delete / update_scores", () => {
    it("creates, updates, updates scores with history, and deletes with inverse round-trips", () => {
      const state = createTournamentState(makeTournament("bp"));
      const adj = {
        id: "adj-1",
        tournamentId: "t-bp",
        name: "Judge One",
        baseScore: 5,
        trainee: false,
        independent: true,
        conflicts: [],
      };

      const afterCreate = expectOpRoundTrip(state, {
        type: "adjudicator.create",
        payload: { adjudicator: adj },
      });
      const afterUpdate = expectOpRoundTrip(afterCreate, {
        type: "adjudicator.update",
        payload: { adjudicator: { ...adj, name: "Judge One Updated" } },
      });
      expect(afterUpdate.adjudicators[0]!.name).toBe("Judge One Updated");

      const afterScores = expectOpRoundTrip(
        afterUpdate,
        {
          type: "adjudicator.update_scores",
          payload: {
            adjudicatorId: adj.id,
            baseScore: 7.5,
            testScore: 8,
            breaking: true,
            reason: "Mock debate calibration",
            timestamp: FIXED_TIME,
          },
        },
        ADJ_CORE_ACTOR,
      );
      expect(afterScores.adjudicators[0]!.baseScore).toBe(7.5);
      expect(afterScores.adjudicators[0]!.scoreHistory?.length).toBe(2);

      const afterDelete = expectOpRoundTrip(afterScores, {
        type: "adjudicator.delete",
        payload: { adjudicatorId: adj.id },
      });
      expect(afterDelete.adjudicators).toEqual([]);
    });

    it("rejects deleting an adjudicator referenced by debates/ballots and enforces mayEditAdjudicatorScores", () => {
      const { state } = makeFixtureDebateAndBallot();

      const deleteRes = applyOp(
        deepFreeze(state),
        { type: "adjudicator.delete", payload: { adjudicatorId: "adj-1" } },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(deleteRes.ok).toBe(false);
      if (!deleteRes.ok) expect(deleteRes.code).toBe("INVALID");

      const blindScoresEditor = {
        ref: "blind-score-editor",
        type: "human" as const,
        role: customRole("custom_blind_scores", "Blind Score Editor", ["adjudicators.scores_edit"]),
        isHostOwner: false,
      };
      const forbiddenScores = applyOp(
        deepFreeze(state),
        {
          type: "adjudicator.update_scores",
          payload: { adjudicatorId: "adj-1", baseScore: 8 },
        },
        blindScoresEditor,
        registry,
      );
      expect(forbiddenScores.ok).toBe(false);
      if (!forbiddenScores.ok) expect(forbiddenScores.code).toBe("FORBIDDEN");

      const invalidScore = applyOp(
        deepFreeze(state),
        {
          type: "adjudicator.update_scores",
          payload: { adjudicatorId: "adj-1", baseScore: Number.NaN },
        },
        ADJ_CORE_ACTOR,
        registry,
      );
      expect(invalidScore.ok).toBe(false);
      if (!invalidScore.ok) expect(invalidScore.code).toBe("INVALID");
    });

    it("checks version conflicts and forced host-owner override on adjudicator ops", () => {
      const { state } = makeFixtureDebateAndBallot();
      const newAdj = {
        id: "adj-new",
        tournamentId: state.tournament.id,
        name: "Judge New",
        baseScore: 6,
        trainee: false,
        independent: true,
        conflicts: [],
      };
      const baseWithoutUsage = createTournamentState(state.tournament, {
        adjudicators: [state.adjudicators[0]!],
      });

      expectStaleConflictAndForcedSuccess(
        baseWithoutUsage,
        { type: "adjudicator.create", payload: { adjudicator: newAdj } },
        recordKey("adjudicator", newAdj.id),
      );
      expectStaleConflictAndForcedSuccess(
        baseWithoutUsage,
        { type: "adjudicator.update", payload: { adjudicator: { ...baseWithoutUsage.adjudicators[0]!, name: "Changed" } } },
        recordKey("adjudicator", "adj-1"),
      );
      expectStaleConflictAndForcedSuccess(
        baseWithoutUsage,
        { type: "adjudicator.update_scores", payload: { adjudicatorId: "adj-1", baseScore: 9 } },
        recordKey("adjudicator", "adj-1"),
        ADJ_CORE_ACTOR,
      );
      expectStaleConflictAndForcedSuccess(
        baseWithoutUsage,
        { type: "adjudicator.delete", payload: { adjudicatorId: "adj-1" } },
        recordKey("adjudicator", "adj-1"),
      );
    });
  });

  describe("conflict.update_adjudicator and conflict.set_team_institutions", () => {
    it("updates adjudicator conflicts (including removing reciprocal conflicts) and restores via inverse", () => {
      const { state } = makeFixtureDebateAndBallot();
      const withReciprocal = createTournamentState(state.tournament, {
        ...state,
        adjudicators: state.adjudicators.map((adj) =>
          adj.id === "adj-2"
            ? { ...adj, conflicts: [{ adjudicatorId: "adj-1", type: "personal" as const }] }
            : adj,
        ),
      });

      const afterSet = expectOpRoundTrip(
        withReciprocal,
        {
          type: "conflict.update_adjudicator",
          payload: {
            adjudicatorId: "adj-1",
            teamIds: ["team-1"],
            adjudicatorIds: ["adj-2"],
            institutionIds: ["inst-1"],
          },
        },
        EQUITY_ACTOR,
      );
      expect(afterSet.adjudicators[0]!.conflicts.some((c) => c.teamId === "team-1")).toBe(true);

      const afterClear = expectOpRoundTrip(
        afterSet,
        {
          type: "conflict.update_adjudicator",
          payload: {
            adjudicatorId: "adj-1",
            teamIds: [],
            adjudicatorIds: [],
            institutionIds: [],
          },
        },
        EQUITY_ACTOR,
      );
      expect(afterClear.adjudicators[1]!.conflicts).toEqual([]);
    });

    it("sets team institution conflicts and restores via inverse", () => {
      const { state } = makeFixtureDebateAndBallot();
      const updated = expectOpRoundTrip(
        state,
        {
          type: "conflict.set_team_institutions",
          payload: {
            teamId: "team-1",
            institutionIds: ["inst-1", "inst-2", "inst-1"],
          },
        },
        EQUITY_ACTOR,
      );
      expect(updated.teams[0]!.institutionConflictIds).toEqual(["inst-1", "inst-2"]);
    });

    it("rejects missing entities, unauthorized actors, and stale versions on conflict ops", () => {
      const { state } = makeFixtureDebateAndBallot();
      const frozen = deepFreeze(state);

      const badAdj = applyOp(
        frozen,
        {
          type: "conflict.update_adjudicator",
          payload: { adjudicatorId: "missing", teamIds: [], adjudicatorIds: [], institutionIds: [] },
        },
        EQUITY_ACTOR,
        registry,
      );
      expect(badAdj.ok).toBe(false);
      if (!badAdj.ok) expect(badAdj.code).toBe("INVALID");

      const badTeam = applyOp(
        frozen,
        {
          type: "conflict.set_team_institutions",
          payload: { teamId: "missing", institutionIds: ["inst-1"] },
        },
        EQUITY_ACTOR,
        registry,
      );
      expect(badTeam.ok).toBe(false);
      if (!badTeam.ok) expect(badTeam.code).toBe("INVALID");

      const forbiddenAdj = applyOp(
        frozen,
        {
          type: "conflict.update_adjudicator",
          payload: { adjudicatorId: "adj-1", teamIds: [], adjudicatorIds: [], institutionIds: [] },
        },
        TAB_ASSISTANT_ACTOR,
        registry,
      );
      expect(forbiddenAdj.ok).toBe(false);
      if (!forbiddenAdj.ok) expect(forbiddenAdj.code).toBe("FORBIDDEN");

      expectStaleConflictAndForcedSuccess(
        state,
        {
          type: "conflict.update_adjudicator",
          payload: { adjudicatorId: "adj-1", teamIds: ["team-1"], adjudicatorIds: [], institutionIds: [] },
        },
        recordKey("adjudicator", "adj-1"),
        EQUITY_ACTOR,
      );
      expectStaleConflictAndForcedSuccess(
        state,
        {
          type: "conflict.set_team_institutions",
          payload: { teamId: "team-1", institutionIds: ["inst-2"] },
        },
        recordKey("team", "team-1"),
        EQUITY_ACTOR,
      );
    });
  });
});
