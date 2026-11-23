import { describe, expect, it } from "vitest";
import { makeRound, makeTeams, makeTournament, makeVenues } from "@/test/tournamentFixtures";
import {
  applyOp,
  createTournamentState,
  defaultRegistry,
  recordKey,
} from "../index";
import {
  deepFreeze,
  DISPLAY_ACTOR,
  EQUITY_ACTOR,
  expectOpRoundTrip,
  expectStaleConflictAndForcedSuccess,
  makeFixtureDebateAndBallot,
  SERVICE_ACTOR,
  TAB_ASSISTANT_ACTOR,
  TAB_DIRECTOR_ACTOR,
} from "../test-helpers";

describe("setup venue and checkin ops", () => {
  const registry = defaultRegistry();

  describe("venue.create / update / delete", () => {
    it("creates, updates, and deletes venues with inverse round-trips", () => {
      const state = createTournamentState(makeTournament("bp"));
      const [venue] = makeVenues(1, "t-bp");

      const afterCreate = expectOpRoundTrip(state, {
        type: "venue.create",
        payload: { venue: venue! },
      });
      expect(afterCreate.venues).toEqual([venue]);

      const afterUpdate = expectOpRoundTrip(afterCreate, {
        type: "venue.update",
        payload: { venue: { ...venue!, name: "Main Hall", priority: 10 } },
      });
      expect(afterUpdate.venues[0]!.name).toBe("Main Hall");

      const afterDelete = expectOpRoundTrip(afterUpdate, {
        type: "venue.delete",
        payload: { venueId: venue!.id },
      });
      expect(afterDelete.venues).toEqual([]);
    });

    it("rejects deleting a venue used in a debate", () => {
      const { state } = makeFixtureDebateAndBallot();
      const res = applyOp(
        deepFreeze(state),
        { type: "venue.delete", payload: { venueId: "venue-1" } },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("INVALID");
        expect(res.errors[0]).toContain("cannot be deleted");
      }
    });

    it("enforces permissions and version conflicts for venue ops", () => {
      const [v1, v2] = makeVenues(2, "t-bp");
      const state = createTournamentState(makeTournament("bp"), { venues: [v1!] });

      const forbidden = applyOp(
        deepFreeze(state),
        { type: "venue.create", payload: { venue: v2! } },
        TAB_ASSISTANT_ACTOR,
        registry,
      );
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");

      expectStaleConflictAndForcedSuccess(
        state,
        { type: "venue.create", payload: { venue: v2! } },
        recordKey("venue", v2!.id),
      );
      expectStaleConflictAndForcedSuccess(
        state,
        { type: "venue.update", payload: { venue: { ...v1!, name: "Updated Room" } } },
        recordKey("venue", v1!.id),
      );
      expectStaleConflictAndForcedSuccess(
        state,
        { type: "venue.delete", payload: { venueId: v1!.id } },
        recordKey("venue", v1!.id),
      );
    });
  });

  describe("checkin.set_participant / checkin.set_venue / checkin.self_checkin", () => {
    it("sets participant and venue check-in and restores exact state via inverse", () => {
      const tournament = makeTournament("bp", { allowSelfCheckIn: true });
      const round = makeRound(tournament.id, 1);
      const teams = makeTeams(1, { tournamentId: tournament.id, speakersPerTeam: 2 });
      const venues = makeVenues(1, tournament.id);
      const state = createTournamentState(tournament, {
        rounds: [round],
        teams,
        venues,
      });

      const afterParticipant = expectOpRoundTrip(
        state,
        {
          type: "checkin.set_participant",
          payload: {
            entityType: "team",
            entityId: teams[0]!.id,
            roundId: round.id,
            available: false,
          },
        },
        TAB_ASSISTANT_ACTOR,
      );
      expect(afterParticipant.teams[0]!.roundAvailability?.[round.id]).toBe(false);

      const afterVenue = expectOpRoundTrip(
        afterParticipant,
        {
          type: "checkin.set_venue",
          payload: { venueId: venues[0]!.id, checkedIn: true },
        },
        TAB_ASSISTANT_ACTOR,
      );
      expect(afterVenue.venues[0]!.checkedIn).toBe(true);

      const afterSelf = expectOpRoundTrip(
        afterVenue,
        {
          type: "checkin.self_checkin",
          payload: {
            entityType: "team",
            entityId: teams[0]!.id,
            roundId: round.id,
            available: true,
          },
        },
        SERVICE_ACTOR,
      );
      expect(afterSelf.teams[0]!.roundAvailability?.[round.id]).toBe(true);
    });

    it("rejects self check-in when disabled or for non-current round", () => {
      const tournament = makeTournament("bp", { allowSelfCheckIn: false });
      const r1 = makeRound(tournament.id, 1);
      const r2 = makeRound(tournament.id, 2);
      const teams = makeTeams(1, { tournamentId: tournament.id, speakersPerTeam: 2 });
      const disabledState = deepFreeze(
        createTournamentState(tournament, { rounds: [r1, r2], teams }),
      );

      const disabledRes = applyOp(
        disabledState,
        {
          type: "checkin.self_checkin",
          payload: {
            entityType: "team",
            entityId: teams[0]!.id,
            roundId: r1.id,
            available: true,
          },
        },
        SERVICE_ACTOR,
        registry,
      );
      expect(disabledRes.ok).toBe(false);
      if (!disabledRes.ok) expect(disabledRes.code).toBe("INVALID");

      const enabledState = deepFreeze(
        createTournamentState(makeTournament("bp", { allowSelfCheckIn: true }), {
          rounds: [r1, r2],
          teams,
        }),
      );
      const wrongRoundRes = applyOp(
        enabledState,
        {
          type: "checkin.self_checkin",
          payload: {
            entityType: "team",
            entityId: teams[0]!.id,
            roundId: r2.id,
            available: true,
          },
        },
        SERVICE_ACTOR,
        registry,
      );
      expect(wrongRoundRes.ok).toBe(false);
      if (!wrongRoundRes.ok) expect(wrongRoundRes.code).toBe("INVALID");
    });

    it("rejects non-service actor on checkin.self_checkin and unauthorized actors on checkins", () => {
      const tournament = makeTournament("bp", { allowSelfCheckIn: true });
      const r1 = makeRound(tournament.id, 1);
      const teams = makeTeams(1, { tournamentId: tournament.id, speakersPerTeam: 2 });
      const venues = makeVenues(1, tournament.id);
      const state = createTournamentState(tournament, {
        rounds: [r1],
        teams,
        venues,
      });

      const humanSelfCheckin = applyOp(
        deepFreeze(state),
        {
          type: "checkin.self_checkin",
          payload: {
            entityType: "team",
            entityId: teams[0]!.id,
            roundId: r1.id,
            available: true,
          },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(humanSelfCheckin.ok).toBe(false);
      if (!humanSelfCheckin.ok) expect(humanSelfCheckin.code).toBe("FORBIDDEN");

      const forbiddenVenue = applyOp(
        deepFreeze(state),
        {
          type: "checkin.set_venue",
          payload: { venueId: venues[0]!.id, checkedIn: true },
        },
        EQUITY_ACTOR,
        registry,
      );
      expect(forbiddenVenue.ok).toBe(false);
      if (!forbiddenVenue.ok) expect(forbiddenVenue.code).toBe("FORBIDDEN");

      const forbiddenParticipant = applyOp(
        deepFreeze(state),
        {
          type: "checkin.set_participant",
          payload: {
            entityType: "team",
            entityId: teams[0]!.id,
            roundId: r1.id,
            available: false,
          },
        },
        DISPLAY_ACTOR,
        registry,
      );
      expect(forbiddenParticipant.ok).toBe(false);
      if (!forbiddenParticipant.ok) expect(forbiddenParticipant.code).toBe("FORBIDDEN");

      expectStaleConflictAndForcedSuccess(
        state,
        {
          type: "checkin.set_participant",
          payload: {
            entityType: "team",
            entityId: teams[0]!.id,
            roundId: r1.id,
            available: false,
          },
        },
        recordKey("team", teams[0]!.id),
        TAB_ASSISTANT_ACTOR,
      );
      expectStaleConflictAndForcedSuccess(
        state,
        {
          type: "checkin.set_venue",
          payload: { venueId: venues[0]!.id, checkedIn: true },
        },
        recordKey("venue", venues[0]!.id),
        TAB_ASSISTANT_ACTOR,
      );
      expectStaleConflictAndForcedSuccess(
        state,
        {
          type: "checkin.self_checkin",
          payload: {
            entityType: "team",
            entityId: teams[0]!.id,
            roundId: r1.id,
            available: true,
          },
        },
        recordKey("team", teams[0]!.id),
        SERVICE_ACTOR,
        { ...SERVICE_ACTOR, isHostOwner: true },
      );
    });
  });
});
