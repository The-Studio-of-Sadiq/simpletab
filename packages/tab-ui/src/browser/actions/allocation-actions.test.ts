import type {
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import { describe, expect, it } from "vitest";
import type { TournamentStoreSnapshot } from "../store/tournament-store";
import {
  ALLOCATION_ACTIONS,
  assignManualAction,
  autoAllocateAction,
  autofillPreformedAction,
  restoreAllocationAction,
  savePreformedAction,
  swapRoomsAction,
} from "./allocation-actions";
import { fakeStore, scriptedPrompts, testContext } from "./test-context";

const SUBMIT = {
  ok: true,
  seq: 1,
  writes: [],
  committedPayload: null,
} as unknown as SubmitResult;

const PANEL = {
  id: "p1",
  importance: 5,
  chairId: "a1",
  panellistIds: [],
  traineeIds: [],
};

function allocationState(patch: Partial<ProjectedState> = {}): ProjectedState {
  return {
    seq: 1,
    roleId: "host_owner",
    permissions: ["allocation.edit"],
    versions: { "round:r2": 2, "debate:d1": 5, "debate:d2": 6 },
    tournament: { id: "t-1", preferences: {} },
    rounds: [
      {
        id: "r2",
        seq: 2,
        name: "Round 2",
        preformedPanels: [PANEL],
      },
    ],
    adjudicators: [
      { id: "a1", name: "Judge One", baseScore: 8 },
      { id: "a2", name: "Judge Two", baseScore: 7 },
    ],
    debates: [
      { id: "d1", roundId: "r2", venueName: "Room 1", roomRank: 1, adjudicators: {} },
      { id: "d2", roundId: "r2", venueName: "Room 2", roomRank: 2, adjudicators: {} },
    ],
    teams: [],
    venues: [],
    motions: [],
    ballots: [],
    feedback: [],
    institutions: [],
    breakCategories: [],
    ...patch,
  } as unknown as ProjectedState;
}

function can(
  action: { isEnabled?: (snapshot: TournamentStoreSnapshot) => boolean },
  state: ProjectedState | null,
  open = true,
): boolean {
  const snapshot = fakeStore(state, SUBMIT, { status: { open } }).store.getSnapshot();
  return action.isEnabled?.(snapshot) ?? false;
}

describe("allocation actions", () => {
  it("offers allocation actions only with a tournament, an open host, permission and rounds", () => {
    const state = allocationState();
    for (const action of ALLOCATION_ACTIONS) {
      expect(can(action, state)).toBe(true);
      expect(can(action, null)).toBe(false);
      expect(can(action, state, false)).toBe(false);
      expect(can(action, allocationState({ permissions: [] }))).toBe(false);
      expect(can(action, allocationState({ rounds: [] }))).toBe(false);
    }
    expect(can(swapRoomsAction, allocationState({ debates: [state.debates[0]] }))).toBe(false);
  });

  it("prompts for each action and cancels when the first answer is missing", async () => {
    const { store } = fakeStore(allocationState(), SUBMIT);
    for (const action of ALLOCATION_ACTIONS) {
      expect(
        await action.prompt(testContext(store, scriptedPrompts([undefined]))),
      ).toBeUndefined();
    }

    expect(
      await autoAllocateAction.prompt(testContext(store, scriptedPrompts(["r2", "3"]))),
    ).toEqual({ roundId: "r2", panelSize: 3 });
    expect(
      await assignManualAction.prompt(
        testContext(store, scriptedPrompts(["d1", "a1", "", ""])),
      ),
    ).toEqual({ debateId: "d1", chairId: "a1", panellistIds: [], traineeIds: [] });
    // Panellists are picked one at a time until "Done"; the list runs out after the last one.
    expect(
      await assignManualAction.prompt(
        testContext(store, scriptedPrompts(["d1", "", "a1", "a2", ""])),
      ),
    ).toEqual({ debateId: "d1", panellistIds: ["a1", "a2"], traineeIds: [] });
    expect(
      await assignManualAction.prompt(
        testContext(store, scriptedPrompts(["d1", "", "a1", undefined])),
      ),
    ).toBeUndefined();
    expect(
      await swapRoomsAction.prompt(testContext(store, scriptedPrompts(["d1", "d2", false]))),
    ).toEqual({ debateIdA: "d1", debateIdB: "d2" });
    expect(
      await swapRoomsAction.prompt(
        testContext(store, scriptedPrompts(["d1", "d2", true, "a2", "chair"])),
      ),
    ).toEqual({
      debateIdA: "d1",
      debateIdB: "d2",
      moves: [{ adjudicatorId: "a2", fromDebateId: "d1", toDebateId: "d2", toRole: "chair" }],
    });
    expect(
      await savePreformedAction.prompt(
        testContext(store, scriptedPrompts(["r2", "p1", "edit", "a2", "a1", "7"])),
      ),
    ).toEqual({
      roundId: "r2",
      panels: [{ id: "p1", importance: 7, chairId: "a2", panellistIds: ["a1"], traineeIds: [] }],
    });
    expect(
      await savePreformedAction.prompt(testContext(store, scriptedPrompts(["r2", "p1", "remove"]))),
    ).toEqual({ roundId: "r2", panels: [] });
    const added = await savePreformedAction.prompt(
      testContext(store, scriptedPrompts(["r2", "", "", "a1", "", "3"])),
    );
    expect(added?.panels).toHaveLength(2);
    expect(added?.panels[1]).toMatchObject({ importance: 3, panellistIds: ["a1"], traineeIds: [] });
    expect(added?.panels[1]).not.toHaveProperty("chairId");
    expect(added?.panels[1]?.id).toMatch(/^panel-\d+-2$/);
    expect(
      await savePreformedAction.prompt(
        testContext(store, scriptedPrompts(["r2", "p1", "edit", "a2", "a1", "11"])),
      ),
    ).toBeUndefined();
    expect(
      await autofillPreformedAction.prompt(testContext(store, scriptedPrompts(["r2"]))),
    ).toEqual({ roundId: "r2", panels: [PANEL] });
    expect(
      await restoreAllocationAction.prompt(testContext(store, scriptedPrompts(["9", false]))),
    ).toBeUndefined();
    expect(
      await restoreAllocationAction.prompt(testContext(store, scriptedPrompts(["9", true]))),
    ).toEqual({ seq: 9 });
  });

  it("submits the same allocation ops the page submitted", async () => {
    const state = allocationState();
    const { store, calls } = fakeStore(state, SUBMIT);
    const ctx = testContext(store, scriptedPrompts([]));

    expect(await autoAllocateAction.run(ctx, { roundId: "r2", panelSize: 3 })).toEqual(SUBMIT);
    expect(await assignManualAction.run(ctx, {
      debateId: "d1",
      chairId: "a1",
      panellistIds: [],
      traineeIds: [],
    })).toEqual(SUBMIT);
    expect(await swapRoomsAction.run(ctx, { debateIdA: "d1", debateIdB: "d2" })).toEqual(SUBMIT);
    expect(await savePreformedAction.run(ctx, { roundId: "r2", panels: [PANEL] })).toEqual(SUBMIT);
    expect(await autofillPreformedAction.run(ctx, { roundId: "r2", panels: [PANEL] })).toEqual(SUBMIT);
    expect(await restoreAllocationAction.run(ctx, { seq: 9 })).toEqual(SUBMIT);

    expect(calls.submitted).toEqual([
      { type: "allocation.auto", payload: { roundId: "r2", panelSize: 3 } },
      {
        type: "allocation.assign_manual",
        expectedVersions: { "debate:d1": 5 },
        payload: { debateId: "d1", chairId: "a1", panellistIds: [], traineeIds: [] },
      },
      {
        type: "allocation.swap_rooms",
        expectedVersions: { "debate:d1": 5, "debate:d2": 6 },
        payload: { debateIdA: "d1", debateIdB: "d2" },
      },
      {
        type: "allocation.preformed_save",
        expectedVersions: { "round:r2": 2 },
        payload: { roundId: "r2", panels: [PANEL] },
      },
      {
        type: "allocation.preformed_autofill",
        payload: { roundId: "r2", panels: [PANEL] },
      },
    ]);
    expect(calls.undoneSeqs).toEqual([9]);
  });
});
