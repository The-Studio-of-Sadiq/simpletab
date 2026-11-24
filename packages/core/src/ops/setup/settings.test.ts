import { describe, expect, it } from "vitest";
import { createSeededRng } from "@/lib/draw/rng";
import { customRole } from "@/permissions";
import { FIXED_TIME, makeTournament, simulateBallot } from "@/test/tournamentFixtures";
import {
  applyOp,
  createTournamentState,
  defaultRegistry,
  recordKey,
  type SettingsResaveBallotsPayload,
} from "../index";
import {
  deepFreeze,
  expectOpRoundTrip,
  expectStaleConflictAndForcedSuccess,
  makeFixtureDebateAndBallot,
  TAB_ASSISTANT_ACTOR,
  TAB_DIRECTOR_ACTOR,
} from "../test-helpers";

describe("setup settings and roles ops", () => {
  const registry = defaultRegistry();

  describe("settings.update", () => {
    it("updates preferences and restores exact state via inverse", () => {
      const state = createTournamentState(makeTournament("bp"));
      const updated = expectOpRoundTrip(state, {
        type: "settings.update",
        payload: {
          name: "Renamed BP Open",
          preferences: {
            welcomeMessage: "Welcome debaters",
            minSpeakerScore: 55,
            maxSpeakerScore: 95,
          },
        },
      });
      expect(updated.tournament.name).toBe("Renamed BP Open");
      expect(updated.tournament.preferences.welcomeMessage).toBe("Welcome debaters");
      expect(updated.tournament.preferences.minSpeakerScore).toBe(55);

      const withSimpletab = expectOpRoundTrip(state, {
        type: "settings.update",
        payload: {
          preferences: {},
          simpletab: { trustSignedBallots: true, timeZone: "Asia/Dhaka" },
        },
      });
      expect(withSimpletab.tournament.simpletab).toEqual({
        trustSignedBallots: true,
        timeZone: "Asia/Dhaka",
      });
    });

    it("rejects invalid preferences and locked settings when ballots exist", () => {
      const { state } = makeFixtureDebateAndBallot();
      const frozen = deepFreeze(state);

      const invalidPref = applyOp(
        frozen,
        {
          type: "settings.update",
          payload: {
            preferences: { minSpeakerScore: 90, maxSpeakerScore: 70 },
          },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(invalidPref.ok).toBe(false);
      if (!invalidPref.ok) {
        expect(invalidPref.code).toBe("INVALID");
      }

      const lockedFormat = applyOp(
        frozen,
        {
          type: "settings.update",
          payload: {
            preferences: { teamsInDebate: 4 },
            format: "bp",
          },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(lockedFormat.ok).toBe(false);
      if (!lockedFormat.ok) {
        expect(lockedFormat.code).toBe("INVALID");
      }
    });

    it("enforces permissions, version conflicts, and forced host-owner override", () => {
      const state = createTournamentState(makeTournament("bp"));
      const forbidden = applyOp(
        deepFreeze(state),
        {
          type: "settings.update",
          payload: { preferences: { welcomeMessage: "Blocked" } },
        },
        TAB_ASSISTANT_ACTOR,
        registry,
      );
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) {
        expect(forbidden.code).toBe("FORBIDDEN");
      }

      expectStaleConflictAndForcedSuccess(
        state,
        {
          type: "settings.update",
          payload: { preferences: { welcomeMessage: "Allowed" } },
        },
        recordKey("tournament", state.tournament.id),
      );
    });
  });

  describe("settings.resave_ballots", () => {
    it("recomputes stored ballot totals and debate caches under updated scoring settings", () => {
      const { state, debate } = makeFixtureDebateAndBallot();
      const ironTournament = {
        ...state.tournament,
        preferences: {
          ...state.tournament.preferences,
          teamScoreIncludesGhosts: true,
        },
      };
      const ironBallot = simulateBallot(
        debate,
        state.teams,
        ironTournament,
        createSeededRng(7),
        {
          ironPersonSide: "AFF",
          confirmed: true,
          submitterId: state.adjudicators[0]!.id,
          timestamp: FIXED_TIME,
        },
      );
      const withGhostState = createTournamentState(ironTournament, {
        ...state,
        ballots: [ironBallot],
      });

      const res = applyOp<SettingsResaveBallotsPayload>(
        deepFreeze(withGhostState),
        {
          type: "settings.resave_ballots",
          payload: {
            changedKeys: ["teamScoreIncludesGhosts"],
            preferences: { teamScoreIncludesGhosts: false },
            override: { reason: "Recalculate without ghost speech" },
          },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.inverse).toBeNull();
      expect(res.committedPayload.updatedBallotIds).toContain(ironBallot.id);
      expect(res.committedPayload.updatedDebateIds).toContain(debate.id);
      expect(res.state.ballots[0]!.teamScores.AFF.totalSpeakerScore).toBeLessThan(
        ironBallot.teamScores.AFF.totalSpeakerScore,
      );
    });

    it("rejects empty changedKeys or missing override after ballots exist", () => {
      const { state } = makeFixtureDebateAndBallot();
      const emptyKeys = applyOp(
        deepFreeze(state),
        {
          type: "settings.resave_ballots",
          payload: { changedKeys: [] },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(emptyKeys.ok).toBe(false);
      if (!emptyKeys.ok) {
        expect(emptyKeys.code).toBe("INVALID");
      }

      const missingOverride = applyOp(
        deepFreeze(state),
        {
          type: "settings.resave_ballots",
          payload: {
            changedKeys: ["teamScoreIncludesGhosts"],
            preferences: { teamScoreIncludesGhosts: true },
          },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(missingOverride.ok).toBe(false);
      if (!missingOverride.ok) {
        expect(missingOverride.code).toBe("INVALID");
      }
    });

    it("enforces permissions, version conflicts, and forced host-owner override", () => {
      const { state } = makeFixtureDebateAndBallot();
      const forbidden = applyOp(
        deepFreeze(state),
        {
          type: "settings.resave_ballots",
          payload: { changedKeys: ["teamScoreIncludesGhosts"] },
        },
        TAB_ASSISTANT_ACTOR,
        registry,
      );
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) {
        expect(forbidden.code).toBe("FORBIDDEN");
      }

      expectStaleConflictAndForcedSuccess(
        state,
        {
          type: "settings.resave_ballots",
          payload: { changedKeys: ["teamScoreIncludesGhosts"] },
        },
        recordKey("tournament", state.tournament.id),
      );
    });
  });

  describe("roles.update", () => {
    it("updates custom groups and restores previous groups via inverse", () => {
      const state = createTournamentState(makeTournament("bp"));
      const updated = expectOpRoundTrip(state, {
        type: "roles.update",
        payload: {
          customGroups: [
            {
              id: "custom_floor",
              name: "Floor Runners",
              permissions: ["checkins.edit", "draw.display"],
            },
          ],
        },
      });
      expect(updated.roles).toEqual([
        {
          id: "custom_floor",
          name: "Floor Runners",
          permissions: ["checkins.edit", "draw.display"],
        },
      ]);
    });

    it("rejects invalid custom groups via validateCustomGroups", () => {
      const state = createTournamentState(makeTournament("bp"));
      const res = applyOp(
        deepFreeze(state),
        {
          type: "roles.update",
          payload: {
            customGroups: [
              {
                id: "bad_prefix",
                name: "Invalid",
                permissions: ["conflicts.edit"],
              },
            ],
          },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("INVALID");
      }
    });

    it("enforces roles.manage permission, version conflicts, and forced override", () => {
      const state = createTournamentState(makeTournament("bp"));
      const settingsOnlyActor = {
        ref: "settings-only",
        type: "human" as const,
        role: customRole("custom_settings", "Settings Only", ["settings.edit"]),
        isHostOwner: false,
      };
      const forbidden = applyOp(
        deepFreeze(state),
        {
          type: "roles.update",
          payload: { customGroups: [] },
        },
        settingsOnlyActor,
        registry,
      );
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) {
        expect(forbidden.code).toBe("FORBIDDEN");
      }

      expectStaleConflictAndForcedSuccess(
        state,
        {
          type: "roles.update",
          payload: { customGroups: [] },
        },
        recordKey("role", "custom_groups"),
      );
    });
  });
});
