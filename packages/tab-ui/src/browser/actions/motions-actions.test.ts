import type {
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import { describe, expect, it } from "vitest";
import { t } from "../i18n";
import type { TournamentStoreSnapshot } from "../store/tournament-store";
import {
  createMotionAction,
  deleteMotionAction,
  MOTIONS_ACTIONS,
  setBallotDeadlineAction,
  updateMotionAction,
} from "./motions-actions";
import { setRoundMotionsAction } from "./releases-actions";
import { fakeStore, scriptedPrompts, testContext } from "./test-context";

const SUBMIT = {
  ok: true,
  seq: 1,
  writes: [],
  committedPayload: null,
} as unknown as SubmitResult;

type Permissions = NonNullable<ProjectedState["permissions"]>;

const MANAGE_MOTIONS: Permissions = ["motions.manage"];
const MANAGE_ROUNDS: Permissions = ["rounds.manage"];

function motionsState(patch: Partial<ProjectedState> = {}): ProjectedState {
  return {
    seq: 1,
    roleId: "host_owner",
    permissions: [...MANAGE_MOTIONS, ...MANAGE_ROUNDS],
    versions: { "round:r1": 4, "motion:m1": 3 },
    tournament: {
      id: "t-1",
      simpletab: { timeZone: "UTC" },
      preferences: {},
    },
    rounds: [
      {
        id: "r1",
        seq: 1,
        name: "Round 1",
        motionsStatus: "not_released",
      },
    ],
    teams: [],
    adjudicators: [],
    venues: [],
    debates: [],
    motions: [
      {
        id: "m1",
        tournamentId: "t-1",
        text: "Old motion",
        infoSlide: "Old info",
        reference: "Old ref",
        seq: 1,
        rounds: ["r1"],
      },
    ],
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

describe("motions actions", () => {
  it("offers motions actions only with a tournament, an open host, permission and an active round", () => {
    const state = motionsState();
    for (const action of MOTIONS_ACTIONS) {
      expect(can(action, state)).toBe(true);
      expect(can(action, null)).toBe(false);
      expect(can(action, state, false)).toBe(false);
      expect(can(action, motionsState({ permissions: [] }))).toBe(false);
      expect(can(action, motionsState({ rounds: [] }))).toBe(false);
      expect(can(action, motionsState({ rounds: [cancelledRound()] }))).toBe(false);
    }
    for (const action of MOTIONS_ACTIONS.filter((item) => item !== setBallotDeadlineAction)) {
      expect(can(action, motionsState({ permissions: MANAGE_ROUNDS }))).toBe(false);
      expect(can(action, motionsState({ permissions: MANAGE_MOTIONS }))).toBe(true);
    }
    expect(can(setBallotDeadlineAction, motionsState({ permissions: MANAGE_MOTIONS }))).toBe(false);
    expect(can(setBallotDeadlineAction, motionsState({ permissions: MANAGE_ROUNDS }))).toBe(true);
  });

  it("cancels every prompt when its first answer is missing", async () => {
    const { store } = fakeStore(motionsState(), SUBMIT);
    for (const action of MOTIONS_ACTIONS) {
      expect(
        await action.prompt(testContext(store, scriptedPrompts([undefined]))),
      ).toBeUndefined();
    }
  });

  it("prompts to set or clear a deadline", async () => {
    const { store } = fakeStore(motionsState(), SUBMIT);
    const set = scriptedPrompts(["r1", false, "2026-02-02", "12:30", "UTC"]);
    expect(await setBallotDeadlineAction.prompt(testContext(store, set))).toEqual({
      roundId: "r1",
      ballotDeadline: "2026-02-02T12:30:00.000Z",
      timeZone: "UTC",
    });
    expect(set.asked).toEqual([
      t("action.motions.pickRound"),
      t("action.motions.pickDeadlineAction"),
      t("motions.deadlineDateLabel"),
      t("motions.deadlineTimeLabel"),
      t("motions.deadlineZoneLabel"),
    ]);

    const clear = scriptedPrompts(["r1", true]);
    expect(await setBallotDeadlineAction.prompt(testContext(store, clear))).toEqual({
      roundId: "r1",
      ballotDeadline: null,
      timeZone: "UTC",
    });
    expect(
      await setBallotDeadlineAction.prompt(
        testContext(store, scriptedPrompts(["r1", false, "2026-02-02", undefined])),
      ),
    ).toBeUndefined();
    expect(
      await setBallotDeadlineAction.prompt(
        testContext(store, scriptedPrompts(["r1", false, "2026-02-02", "12:30", "Mars/Olympus"])),
      ),
    ).toBeUndefined();
  });

  it("prompts for a new motion's round, text, info slide and reference", async () => {
    const { store } = fakeStore(motionsState(), SUBMIT);
    const prompts = scriptedPrompts(["r1", "New motion", "New info", "New ref"]);
    expect(await createMotionAction.prompt(testContext(store, prompts))).toEqual({
      roundId: "r1",
      text: "New motion",
      infoSlide: "New info",
      reference: "New ref",
    });
    expect(prompts.asked).toEqual([
      t("action.motions.pickRound"),
      t("motions.motionTextLabel"),
      t("motions.infoSlideLabel"),
      t("motions.referenceLabel"),
    ]);
    expect(
      await createMotionAction.prompt(
        testContext(store, scriptedPrompts(["r1", "", "New info", "New ref"])),
      ),
    ).toBeUndefined();
  });

  it("prompts for an existing motion and its edited fields", async () => {
    const { store } = fakeStore(motionsState(), SUBMIT);
    const prompts = scriptedPrompts(["m1", "Edited motion", "Edited info", "Edited ref"]);
    expect(await updateMotionAction.prompt(testContext(store, prompts))).toEqual({
      motionId: "m1",
      text: "Edited motion",
      infoSlide: "Edited info",
      reference: "Edited ref",
    });
    expect(prompts.asked).toEqual([
      t("action.motions.pickMotion"),
      t("motions.motionTextLabel"),
      t("motions.infoSlideLabel"),
      t("motions.referenceLabel"),
    ]);
  });

  it("confirms before deleting a motion", async () => {
    const { store } = fakeStore(motionsState(), SUBMIT);
    const prompts = scriptedPrompts(["m1", true]);
    expect(await deleteMotionAction.prompt(testContext(store, prompts))).toEqual({ motionId: "m1" });
    expect(prompts.asked).toEqual([
      t("action.motions.pickMotionToDelete"),
      t("action.motions.confirmDeleteTitle"),
    ]);
    expect(
      await deleteMotionAction.prompt(
        testContext(store, scriptedPrompts(["m1", false])),
      ),
    ).toBeUndefined();
  });

  it("submits the same motion ops the page submitted", async () => {
    const state = motionsState();
    const { store, calls } = fakeStore(state, SUBMIT);
    const ctx = testContext(store, scriptedPrompts([]));

    expect(await setRoundMotionsAction.run(ctx, {
      roundId: "r1",
      status: "motions_released",
      now: "2026-01-01T00:00:00.000Z",
    })).toEqual(SUBMIT);
    expect(await setBallotDeadlineAction.run(ctx, {
      roundId: "r1",
      ballotDeadline: "2026-02-02T12:30:00.000Z",
      timeZone: "UTC",
    })).toEqual(SUBMIT);
    expect(await setBallotDeadlineAction.run(ctx, {
      roundId: "r1",
      ballotDeadline: null,
      timeZone: "UTC",
    })).toEqual(SUBMIT);
    expect(await createMotionAction.run(ctx, {
      roundId: "r1",
      text: "New motion",
      infoSlide: "New info",
      reference: "New ref",
    })).toEqual(SUBMIT);
    expect(await updateMotionAction.run(ctx, {
      motionId: "m1",
      text: "Edited motion",
      infoSlide: "Edited info",
      reference: "Edited ref",
    })).toEqual(SUBMIT);
    expect(await deleteMotionAction.run(ctx, { motionId: "m1" })).toEqual(SUBMIT);

    expect(calls.submitted).toHaveLength(6);
    expect(calls.submitted[0]).toEqual({
      type: "motion.set_round_status",
      expectedVersions: { "round:r1": 4 },
      payload: {
        roundId: "r1",
        status: "motions_released",
        now: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(calls.submitted[1]).toEqual({
      type: "round.set_ballot_deadline",
      expectedVersions: { "round:r1": 4 },
      payload: {
        roundId: "r1",
        ballotDeadline: "2026-02-02T12:30:00.000Z",
        timeZone: "UTC",
      },
    });
    expect(calls.submitted[2]).toEqual({
      type: "round.set_ballot_deadline",
      expectedVersions: { "round:r1": 4 },
      payload: { roundId: "r1", ballotDeadline: null, timeZone: "UTC" },
    });
    expect(calls.submitted[3]).toEqual({
      type: "motion.create",
      payload: {
        motion: expect.objectContaining({
          id: expect.stringMatching(/^motion-/),
          tournamentId: "t-1",
          text: "New motion",
          infoSlide: "New info",
          reference: "New ref",
          rounds: ["r1"],
          seq: 2,
          roundSeq: { r1: 2 },
        }),
      },
    });
    expect(calls.submitted[4]).toEqual({
      type: "motion.update",
      expectedVersions: { "motion:m1": 3 },
      payload: {
        motion: expect.objectContaining({
          id: "m1",
          text: "Edited motion",
          infoSlide: "Edited info",
          reference: "Edited ref",
        }),
      },
    });
    expect(calls.submitted[5]).toEqual({
      type: "motion.delete",
      expectedVersions: { "motion:m1": 3 },
      payload: { motionId: "m1" },
    });
  });
});
