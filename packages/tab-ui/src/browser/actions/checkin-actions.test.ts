import type {
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import { describe, expect, it } from "vitest";
import type { TournamentStoreSnapshot } from "../store/tournament-store";
import { CHECKIN_ACTIONS, setParticipantAction, setVenueAction } from "./checkin-actions";
import { fakeStore, scriptedPrompts, testContext } from "./test-context";

const SUBMIT = {
  ok: true,
  seq: 1,
  writes: [],
  committedPayload: null,
} as unknown as SubmitResult;

function checkinState(patch: Partial<ProjectedState> = {}): ProjectedState {
  return {
    seq: 1,
    roleId: "host_owner",
    permissions: ["checkins.edit"],
    versions: { "venue:v1": 3, "team:t1": 2 },
    tournament: { id: "t-1", preferences: {} },
    rounds: [{ id: "r1", seq: 1, name: "Round 1" }],
    teams: [{ id: "t1", name: "Team One" }],
    adjudicators: [{ id: "a1", name: "Judge One" }],
    venues: [{ id: "v1", name: "Room One" }],
    debates: [],
    motions: [],
    ballots: [],
    feedback: [],
    institutions: [],
    breakCategories: [],
    ...patch,
  } as unknown as ProjectedState;
}

function cancelledRound(): ProjectedState["rounds"][number] {
  return {
    id: "r1",
    seq: 1,
    name: "Round 1",
    cancelled: true,
  } as unknown as ProjectedState["rounds"][number];
}

function can(
  action: { isEnabled?: (snapshot: TournamentStoreSnapshot) => boolean },
  state: ProjectedState | null,
  open = true,
): boolean {
  const snapshot = fakeStore(state, SUBMIT, { status: { open } }).store.getSnapshot();
  return action.isEnabled?.(snapshot) ?? false;
}

describe("check-in actions", () => {
  it("offers check-in actions only with a tournament, an open host, permission and a round", () => {
    const state = checkinState();
    for (const action of CHECKIN_ACTIONS) {
      expect(can(action, state)).toBe(true);
      expect(can(action, null)).toBe(false);
      expect(can(action, state, false)).toBe(false);
      expect(can(action, checkinState({ permissions: [] }))).toBe(false);
    }
    expect(can(setParticipantAction, checkinState({ rounds: [] }))).toBe(false);
    expect(
      can(setParticipantAction, checkinState({ rounds: [cancelledRound()] })),
    ).toBe(false);
    expect(can(setVenueAction, checkinState({ rounds: [] }))).toBe(true);
  });

  it("prompts for a venue and its state, and cancels if either step is declined", async () => {
    const { store } = fakeStore(checkinState(), SUBMIT);
    const ctx = testContext(store, scriptedPrompts([undefined]));
    expect(await setVenueAction.prompt(ctx)).toBeUndefined();
    expect(
      await setVenueAction.prompt(testContext(store, scriptedPrompts(["v1", undefined]))),
    ).toBeUndefined();
    expect(
      await setVenueAction.prompt(testContext(store, scriptedPrompts(["v1", true]))),
    ).toEqual({ venueId: "v1", checkedIn: true });
  });

  it("prompts for participant, round and state, cancelling at the first step", async () => {
    const { store } = fakeStore(checkinState(), SUBMIT);
    expect(
      await setParticipantAction.prompt(testContext(store, scriptedPrompts([undefined]))),
    ).toBeUndefined();
    expect(
      await setParticipantAction.prompt(testContext(store, scriptedPrompts(["team", undefined]))),
    ).toBeUndefined();
    expect(
      await setParticipantAction.prompt(
        testContext(store, scriptedPrompts(["adjudicator", "a1", "r1", false])),
      ),
    ).toEqual({ entityType: "adjudicator", entityId: "a1", roundId: "r1", available: false });
  });

  it("submits the same checkin ops the page submitted, with fresh expected versions", async () => {
    const state = checkinState();
    const { store, calls } = fakeStore(state, SUBMIT);
    const ctx = testContext(store, scriptedPrompts([]));

    expect(await setVenueAction.run(ctx, { venueId: "v1", checkedIn: true })).toEqual(SUBMIT);
    expect(await setParticipantAction.run(ctx, {
      entityType: "team",
      entityId: "t1",
      roundId: "r1",
      available: false,
    })).toEqual(SUBMIT);
    expect(calls.submitted).toEqual([
      {
        type: "checkin.set_venue",
        expectedVersions: { "venue:v1": 3 },
        payload: { venueId: "v1", checkedIn: true },
      },
      {
        type: "checkin.set_participant",
        expectedVersions: { "team:t1": 2 },
        payload: { entityType: "team", entityId: "t1", roundId: "r1", available: false },
      },
    ]);
  });
});
