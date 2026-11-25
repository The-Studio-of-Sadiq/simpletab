import type {
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import { describe, expect, it } from "vitest";
import { t } from "../i18n";
import type { TournamentStoreSnapshot } from "../store/tournament-store";
import type { PickedTeam, TeamLocation } from "@simpletab/core/lib/draw/drawEditing";
import {
  createSwingAction,
  DRAW_ACTIONS,
  drawStageActionFor,
  generateDrawAction,
  lockDrawAction,
  moveTeamAction,
  releaseDrawAction,
  releaseDrawToTeamsAction,
  restoreDrawAction,
  swapTeamsAction,
  toggleSwingRoundAction,
  unlockDrawAction,
  unreleaseDrawAction,
  updateDebateAction,
} from "./draw-actions";
import { fakeStore, scriptedPrompts, testContext } from "./test-context";

const SUBMIT = {
  ok: true,
  seq: 1,
  writes: [],
  committedPayload: null,
} as unknown as SubmitResult;

type Permissions = NonNullable<ProjectedState["permissions"]>;

const EDIT: Permissions = ["draw.generate"];
const RELEASE: Permissions = ["draw.release"];

const SLOT_PICK: PickedTeam = {
  teamId: "t1",
  teamName: "Team One",
  from: { kind: "slot", debateId: "d1", side: "OG" },
};
const POOL_PICK: PickedTeam = {
  teamId: "s1",
  teamName: "Swing Team",
  from: { kind: "pool" },
};
const SLOT_TARGET: TeamLocation = { kind: "slot", debateId: "d2", side: "OG" };

function plainTeam(): ProjectedState["teams"][number] {
  return {
    id: "t1",
    name: "Team One",
  } as unknown as ProjectedState["teams"][number];
}

function plainRound(): ProjectedState["rounds"][number] {
  return {
    id: "r1",
    seq: 1,
    name: "Round 1",
  } as unknown as ProjectedState["rounds"][number];
}

function drawState(patch: Partial<ProjectedState> = {}): ProjectedState {
  return {
    seq: 1,
    roleId: "host_owner",
    permissions: [...EDIT, ...RELEASE],
    versions: {
      "round:r1": 4,
      "debate:d1": 5,
      "debate:d2": 6,
      "team:t1": 7,
      "team:s1": 8,
    },
    tournament: {
      id: "t-1",
      format: "bp",
      simpletab: { timeZone: "UTC" },
      preferences: {},
    },
    rounds: [
      {
        id: "r1",
        seq: 1,
        name: "Round 1",
        stage: "preliminary",
        drawStatus: "draft",
      },
    ],
    teams: [
      { id: "t1", name: "Team One" },
      { id: "t2", name: "Team Two" },
      {
        id: "s1",
        name: "Swing Team",
        isSwing: true,
        swingRoundIds: ["r1"],
      },
    ],
    venues: [{ id: "v1", name: "Room 1" }],
    debates: [
      {
        id: "d1",
        roundId: "r1",
        venueId: "v1",
        venueName: "Room 1",
        roomRank: 1,
        teams: {
          OG: { teamId: "t1", teamName: "Team One", side: "OG" },
          OO: { teamId: "t2", teamName: "Team Two", side: "OO" },
        },
      },
      {
        id: "d2",
        roundId: "r1",
        venueName: "Room 2",
        roomRank: 2,
        teams: {},
      },
    ],
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

const stageActions = [
  lockDrawAction,
  unlockDrawAction,
  releaseDrawToTeamsAction,
  releaseDrawAction,
  unreleaseDrawAction,
];

/** A draw in a stage that offers the action (the page shows only those stage buttons). */
function stagedState(
  action: (typeof stageActions)[number],
  patch: Partial<ProjectedState> = {},
): ProjectedState {
  const drawStatus =
    action === unlockDrawAction ? "locked" : action === unreleaseDrawAction ? "released" : "draft";
  const base = drawState(patch);
  return {
    ...base,
    rounds: base.rounds.map((round) => ({ ...round, drawStatus })),
  } as ProjectedState;
}

describe("draw actions", () => {
  it("offers draw editing only with a tournament, an open host, permission and an active round", () => {
    const state = drawState();
    const editingActions = DRAW_ACTIONS.filter(
      (action) => !stageActions.includes(action as (typeof stageActions)[number]),
    );
    for (const action of editingActions) {
      expect(can(action, state)).toBe(true);
      expect(can(action, null)).toBe(false);
      expect(can(action, state, false)).toBe(false);
      expect(can(action, drawState({ rounds: [] }))).toBe(false);
      expect(can(action, drawState({ permissions: [] }))).toBe(false);
      expect(can(action, drawState({ permissions: RELEASE }))).toBe(false);
    }
    expect(can(toggleSwingRoundAction, drawState({ permissions: EDIT }))).toBe(true);
    expect(
      can(toggleSwingRoundAction, drawState({ teams: [plainTeam()] })),
    ).toBe(false);
  });

  it("offers stage actions only with release permission and a round with a draw", () => {
    for (const action of stageActions) {
      const state = stagedState(action);
      expect(can(action, state)).toBe(true);
      expect(can(action, null)).toBe(false);
      expect(can(action, state, false)).toBe(false);
      expect(can(action, drawState({ rounds: [] }))).toBe(false);
      expect(can(action, stagedState(action, { permissions: [] }))).toBe(false);
      expect(can(action, stagedState(action, { permissions: EDIT }))).toBe(false);
      expect(can(action, stagedState(action, { permissions: RELEASE }))).toBe(true);
      expect(can(action, drawState({ rounds: [plainRound()] }))).toBe(false);
    }
    // A stage that does not offer the step: no unlock for a draft, no lock once released.
    expect(can(unlockDrawAction, drawState())).toBe(false);
    expect(can(lockDrawAction, stagedState(unreleaseDrawAction))).toBe(false);
    expect(drawStageActionFor("lock")).toBe(lockDrawAction);
    expect(drawStageActionFor("release")).toBe(releaseDrawAction);
  });

  it("cancels every prompt when its first answer is missing", async () => {
    const { store } = fakeStore(drawState(), SUBMIT, {
      lastRoundOpSeqs: { "draw.generate:r1": 9 },
    });
    for (const action of DRAW_ACTIONS) {
      expect(
        await action.prompt(testContext(store, scriptedPrompts([undefined]))),
      ).toBeUndefined();
    }
  });

  it("prompts for a draw's round and seed, confirming a regeneration", async () => {
    const { store } = fakeStore(drawState({ debates: [] }), SUBMIT);
    const fresh = scriptedPrompts(["r1", "7"]);
    expect(await generateDrawAction.prompt(testContext(store, fresh))).toEqual({
      roundId: "r1",
      seed: 7,
    });
    expect(fresh.asked).toEqual([t("action.draw.pickRound"), t("action.draw.pickSeed")]);

    const existing = scriptedPrompts(["r1", "7", true]);
    const { store: existingStore } = fakeStore(drawState(), SUBMIT);
    expect(await generateDrawAction.prompt(testContext(existingStore, existing))).toEqual({
      roundId: "r1",
      seed: 7,
      discardExisting: true,
    });
    expect(existing.asked).toEqual([
      t("action.draw.pickRound"),
      t("action.draw.pickSeed"),
      t("action.draw.confirmRegenerateTitle"),
    ]);
    expect(
      await generateDrawAction.prompt(
        testContext(existingStore, scriptedPrompts(["r1", "7", false])),
      ),
    ).toBeUndefined();
    expect(
      await generateDrawAction.prompt(testContext(store, scriptedPrompts(["r1", "7.5"]))),
    ).toBeUndefined();
  });

  it("picks a round with a draw to restore and confirms before restoring it", async () => {
    const { store } = fakeStore(drawState(), SUBMIT, { lastRoundOpSeqs: { "draw.generate:r1": 9 } });
    const prompts = scriptedPrompts([9, true]);
    expect(await restoreDrawAction.prompt(testContext(store, prompts))).toEqual({ seq: 9 });
    expect(prompts.asked).toEqual([
      t("action.draw.pickRound"),
      t("action.draw.confirmRestoreTitle"),
    ]);
    expect(
      await restoreDrawAction.prompt(testContext(store, scriptedPrompts([9, false]))),
    ).toBeUndefined();
    // Nothing generated this session: said, not a silent cancel.
    const none = fakeStore(drawState(), SUBMIT);
    await expect(
      restoreDrawAction.prompt(testContext(none.store, scriptedPrompts([]))),
    ).rejects.toThrow(t("action.draw.nothingToRestore"));
  });

  it("prompts for a team, its current place and its target", async () => {
    const { store } = fakeStore(drawState(), SUBMIT);
    const prompts = scriptedPrompts(["r1", SLOT_PICK, SLOT_TARGET]);
    expect(await moveTeamAction.prompt(testContext(store, prompts))).toEqual({
      pick: SLOT_PICK,
      target: SLOT_TARGET,
    });
    expect(prompts.asked).toEqual([
      t("action.draw.pickRound"),
      t("action.draw.pickTeam"),
      t("action.draw.pickTarget"),
    ]);
    const pool = scriptedPrompts(["r1", POOL_PICK, SLOT_TARGET]);
    expect(await moveTeamAction.prompt(testContext(store, pool))).toEqual({
      pick: POOL_PICK,
      target: SLOT_TARGET,
    });
    expect(
      await moveTeamAction.prompt(
        testContext(store, scriptedPrompts(["r1", SLOT_PICK, undefined])),
      ),
    ).toBeUndefined();
  });

  it("prompts for a debate to swap and to change", async () => {
    const { store } = fakeStore(drawState(), SUBMIT);
    const swap = scriptedPrompts(["d1"]);
    expect(await swapTeamsAction.prompt(testContext(store, swap))).toEqual({
      slotA: { debateId: "d1", side: "OG" },
      slotB: { debateId: "d1", side: "OO" },
    });
    expect(swap.asked).toEqual([t("action.draw.pickDebate")]);

    const update = scriptedPrompts(["d1", "v1"]);
    expect(await updateDebateAction.prompt(testContext(store, update))).toEqual({
      debateId: "d1",
      venueId: "v1",
    });
    expect(update.asked).toEqual([
      t("action.draw.pickDebate"),
      t("action.draw.pickVenue"),
    ]);
    expect(
      await updateDebateAction.prompt(testContext(store, scriptedPrompts(["d1", undefined]))),
    ).toBeUndefined();
  });

  it("prompts for a new swing team's round, name and speakers", async () => {
    const { store } = fakeStore(drawState(), SUBMIT);
    const prompts = scriptedPrompts(["r1", "New Swing", "Alice, Bob"]);
    expect(await createSwingAction.prompt(testContext(store, prompts))).toEqual({
      roundId: "r1",
      name: "New Swing",
      speakers: ["Alice", "Bob"],
    });
    expect(prompts.asked).toEqual([
      t("action.draw.pickRound"),
      t("action.draw.pickSwingName"),
      t("action.draw.pickSwingSpeakers"),
    ]);
    expect(
      await createSwingAction.prompt(
        testContext(store, scriptedPrompts(["r1", "", "Alice"])),
      ),
    ).toBeUndefined();
  });

  it("prompts for a swing team, a round and whether to include it", async () => {
    const { store } = fakeStore(drawState(), SUBMIT);
    const prompts = scriptedPrompts(["s1", "r1", true]);
    expect(await toggleSwingRoundAction.prompt(testContext(store, prompts))).toEqual({
      teamId: "s1",
      roundId: "r1",
      enabled: true,
    });
    expect(prompts.asked).toEqual([
      t("action.draw.pickSwingTeam"),
      t("action.draw.pickRound"),
      t("action.draw.pickEnabled"),
    ]);
    expect(
      await toggleSwingRoundAction.prompt(
        testContext(store, scriptedPrompts(["s1", "r1", undefined])),
      ),
    ).toBeUndefined();
  });

  it("prompts for the round to lock, unlock or release", async () => {
    for (const action of stageActions) {
      const { store } = fakeStore(stagedState(action), SUBMIT);
      const prompts = scriptedPrompts(["r1"]);
      expect(await action.prompt(testContext(store, prompts))).toEqual({ roundId: "r1" });
      expect(prompts.asked).toEqual([t("action.draw.pickRound")]);
    }
  });

  it("submits the same draw ops the page submitted", async () => {
    const state = drawState();
    const { store, calls } = fakeStore(state, SUBMIT, { undoResult: SUBMIT });
    const ctx = testContext(store, scriptedPrompts([]));

    expect(await generateDrawAction.run(ctx, { roundId: "r1", seed: 7 })).toEqual(SUBMIT);
    expect(
      await generateDrawAction.run(ctx, { roundId: "r1", seed: 7, discardExisting: true }),
    ).toEqual(SUBMIT);
    expect(await restoreDrawAction.run(ctx, { seq: 9 })).toEqual(SUBMIT);
    expect(await moveTeamAction.run(ctx, { pick: SLOT_PICK, target: SLOT_TARGET })).toEqual(SUBMIT);
    expect(await moveTeamAction.run(ctx, { pick: POOL_PICK, target: SLOT_TARGET })).toEqual(SUBMIT);
    expect(await swapTeamsAction.run(ctx, {
      slotA: { debateId: "d1", side: "OG" },
      slotB: { debateId: "d1", side: "OO" },
    })).toEqual(SUBMIT);
    expect(await updateDebateAction.run(ctx, { debateId: "d1", venueId: "v1" })).toEqual(SUBMIT);
    expect(await createSwingAction.run(ctx, {
      roundId: "r1",
      name: "  New Swing  ",
      speakers: [" Alice ", "", "Bob"],
    })).toEqual(SUBMIT);
    expect(await toggleSwingRoundAction.run(ctx, {
      teamId: "s1",
      roundId: "r1",
      enabled: true,
    })).toEqual(SUBMIT);
    for (const [index, action] of stageActions.entries()) {
      expect(await action.run(ctx, { roundId: "r1" })).toEqual(SUBMIT);
      expect(calls.submitted[8 + index]).toEqual({
        type: [
          "draw.lock",
          "draw.unlock",
          "draw.release_teams",
          "draw.release",
          "draw.unrelease",
        ][index],
        expectedVersions: { "round:r1": 4 },
        payload: { roundId: "r1" },
      });
    }

    expect(calls.undoneSeqs).toEqual([9]);
    expect(calls.submitted).toHaveLength(13);
    expect(calls.submitted[0]).toEqual({
      type: "draw.generate",
      payload: { roundId: "r1", seed: 7 },
    });
    expect(calls.submitted[1]).toEqual({
      type: "draw.generate",
      payload: { roundId: "r1", seed: 7, discardExisting: true },
    });
    expect(calls.submitted[2]).toEqual({
      type: "draw.move_team",
      expectedVersions: { "debate:d1": 5, "debate:d2": 6 },
      payload: { pick: SLOT_PICK, target: SLOT_TARGET },
    });
    expect(calls.submitted[3]).toEqual({
      type: "draw.move_team",
      expectedVersions: { "debate:d2": 6, "team:s1": 8 },
      payload: { pick: POOL_PICK, target: SLOT_TARGET },
    });
    expect(calls.submitted[4]).toEqual({
      type: "draw.swap_teams",
      expectedVersions: { "debate:d1": 5 },
      payload: {
        slotA: { debateId: "d1", side: "OG" },
        slotB: { debateId: "d1", side: "OO" },
      },
    });
    expect(calls.submitted[5]).toEqual({
      type: "draw.update_debate",
      expectedVersions: { "debate:d1": 5 },
      payload: {
        debate: expect.objectContaining({
          id: "d1",
          venueId: "v1",
          venueName: "Room 1",
        }),
      },
    });
    expect(calls.submitted[6]).toEqual({
      type: "swing.create",
      payload: {
        roundId: "r1",
        name: "New Swing",
        speakers: [{ name: "Alice" }, { name: "Bob" }],
      },
    });
    expect(calls.submitted[7]).toEqual({
      type: "swing.toggle_round",
      expectedVersions: { "team:s1": 8 },
      payload: { teamId: "s1", roundId: "r1", enabled: true },
    });
  });
});
