import type {
  HostLockInfo,
  OnlineSettings,
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import { describe, expect, it, vi } from "vitest";
import type { TournamentStoreSnapshot } from "../store/tournament-store";
import {
  archiveNowAction,
  cancelLockAction,
  gateGroups,
  openSetupAction,
  publishNowAction,
  releaseTabBundleAction,
  setArchiveMirrorAction,
  setDrawGateAction,
  setGateAction,
  setLivePublicSiteAction,
  setRoundFlagAction,
  setRoundMotionsAction,
} from "./releases-actions";
import {
  fakeStore,
  scriptedPrompts,
  testContext,
  type FakeStoreOptions,
} from "./test-context";

const SUBMIT = {
  ok: true,
  seq: 1,
  writes: [],
  committedPayload: null,
} as unknown as SubmitResult;

function releaseState(patch: Partial<ProjectedState> = {}): ProjectedState {
  return {
    seq: 8,
    roleId: "host_owner",
    permissions: [
      "releases.manage",
      "draw.release",
      "motions.manage",
      "rounds.manage",
      "publish.run",
    ],
    versions: {
      "tournament:t-1": 2,
      "round:r1": 1,
      "breakCategory:bc-open": 1,
    },
    tournament: {
      id: "t-1",
      name: "Releases Test",
      preferences: {},
    },
    rounds: [
      {
        id: "r1",
        tournamentId: "t-1",
        seq: 1,
        name: "Round 1",
        cancelled: false,
        drawStatus: "draft",
        motionsStatus: "not_released",
        resultsReleased: false,
        teamSpeaksReleased: false,
        adjudicatorsRevealed: false,
      },
    ],
    breakCategories: [{ id: "bc-open", name: "Open" }],
    proposals: [],
    ...patch,
  } as unknown as ProjectedState;
}

type Enableable = {
  isEnabled?: (snapshot: TournamentStoreSnapshot) => boolean;
};

function can(
  action: Enableable,
  state: ProjectedState | null,
  options: FakeStoreOptions = {},
): boolean {
  return (
    action.isEnabled?.(fakeStore(state, SUBMIT, options).store.getSnapshot()) ??
    false
  );
}

describe("release actions", () => {
  it("offers management actions only for an open tournament with the right permission", () => {
    const state = releaseState();
    for (const action of [
      setGateAction,
      releaseTabBundleAction,
      publishNowAction,
      setLivePublicSiteAction,
    ]) {
      expect(can(action, state)).toBe(true);
      expect(can(action, null)).toBe(false);
      expect(can(action, state, { status: { open: false } })).toBe(false);
      expect(can(action, releaseState({ permissions: [] }))).toBe(false);
    }
  });

  it("asks for a gate and state, cancels at either prompt, and submits with versions", async () => {
    const state = releaseState();
    const { store, submitted } = fakeStore(state, SUBMIT);
    const spec = gateGroups(state)[0]![0]!;
    const prompts = scriptedPrompts([spec, true]);
    const ctx = testContext(store, prompts);

    expect(await setGateAction.prompt(ctx)).toEqual({
      gate: "tab_team",
      released: true,
      labelKey: "releases.gateTabTeam",
    });
    expect(prompts.asked).toHaveLength(2);
    expect(await setGateAction.run(ctx, {
      gate: "tab_team",
      released: true,
      labelKey: "releases.gateTabTeam",
    })).toEqual(SUBMIT);
    expect(submitted[0]).toEqual({
      type: "release.set_gate",
      expectedVersions: { "tournament:t-1": 2 },
      payload: { gate: "tab_team", released: true },
    });

    await setGateAction.run(ctx, {
      gate: "break_category_published",
      released: false,
      labelKey: "releases.gateBreakCategory",
      categoryId: "bc-open",
    });
    expect(submitted[1]).toEqual({
      type: "release.set_gate",
      expectedVersions: { "tournament:t-1": 2, "breakCategory:bc-open": 1 },
      payload: {
        gate: "break_category_published",
        released: false,
        categoryId: "bc-open",
      },
    });

    expect(await setGateAction.prompt(testContext(store, scriptedPrompts([undefined])))).toBeUndefined();
    expect(await setGateAction.prompt(testContext(store, scriptedPrompts([spec, undefined])))).toBeUndefined();
  });

  it("confirms and releases the final tab bundle with every break category version", async () => {
    const { store, submitted } = fakeStore(releaseState(), SUBMIT);
    expect(await releaseTabBundleAction.prompt(testContext(store, scriptedPrompts([false])))).toBeUndefined();
    expect(await releaseTabBundleAction.prompt(testContext(store, scriptedPrompts([true])))).toEqual({});

    const ctx = testContext(store, scriptedPrompts([]));
    expect(await releaseTabBundleAction.run(ctx, {})).toEqual(SUBMIT);
    expect(submitted).toEqual([
      {
        type: "release.tab_bundle",
        expectedVersions: {
          "tournament:t-1": 2,
          "breakCategory:bc-open": 1,
        },
        payload: { breakCategoryIds: ["bc-open"] },
      },
    ]);
  });

  it("offers draw release only with an active draw and asks for round, scope and state", async () => {
    const state = releaseState();
    expect(can(setDrawGateAction, state)).toBe(true);
    expect(can(setDrawGateAction, releaseState({
      rounds: [{
        id: "r1",
        seq: 1,
        name: "Round 1",
        drawStatus: "none",
      } as unknown as ProjectedState["rounds"][number]],
    }))).toBe(false);
    expect(can(setDrawGateAction, releaseState({ permissions: [] }))).toBe(false);

    const { store, submitted } = fakeStore(state, SUBMIT);
    const ctx = testContext(store, scriptedPrompts(["r1", "teams", true]));
    expect(await setDrawGateAction.prompt(ctx)).toEqual({
      roundId: "r1",
      scope: "teams",
      released: true,
    });
    expect(await setDrawGateAction.prompt(testContext(store, scriptedPrompts([undefined])))).toBeUndefined();
    expect(await setDrawGateAction.prompt(testContext(store, scriptedPrompts(["r1", undefined])))).toBeUndefined();
    expect(await setDrawGateAction.prompt(testContext(store, scriptedPrompts(["r1", "teams", undefined])))).toBeUndefined();

    await setDrawGateAction.run(ctx, { roundId: "r1", scope: "teams", released: true });
    await setDrawGateAction.run(ctx, { roundId: "r1", scope: "public", released: true });
    await setDrawGateAction.run(ctx, { roundId: "r1", scope: "public", released: false });
    expect(submitted).toEqual([
      { type: "draw.release_teams", expectedVersions: { "round:r1": 1 }, payload: { roundId: "r1" } },
      { type: "draw.release", expectedVersions: { "round:r1": 1 }, payload: { roundId: "r1" } },
      { type: "draw.unrelease", expectedVersions: { "round:r1": 1 }, payload: { roundId: "r1" } },
    ]);
    expect(() => setDrawGateAction.run(ctx, {
      roundId: "missing",
      scope: "teams",
      released: true,
    })).toThrow();
  });

  it("asks for a round and motions status, then submits the chosen status", async () => {
    const state = releaseState();
    expect(can(setRoundMotionsAction, state)).toBe(true);
    expect(can(setRoundMotionsAction, releaseState({ permissions: [] }))).toBe(false);
    expect(can(setRoundMotionsAction, releaseState({ rounds: [] }))).toBe(false);

    const { store, submitted } = fakeStore(state, SUBMIT);
    const ctx = testContext(store, scriptedPrompts(["r1", "info_slides_released"]));
    expect(await setRoundMotionsAction.prompt(ctx)).toEqual({
      roundId: "r1",
      status: "info_slides_released",
    });
    expect(await setRoundMotionsAction.prompt(testContext(store, scriptedPrompts([undefined])))).toBeUndefined();
    expect(await setRoundMotionsAction.prompt(testContext(store, scriptedPrompts(["r1", undefined])))).toBeUndefined();

    await setRoundMotionsAction.run(ctx, {
      roundId: "r1",
      status: "motions_released",
      now: "2026-11-25T10:00:00.000Z",
    });
    expect(submitted).toEqual([
      {
        type: "motion.set_round_status",
        expectedVersions: { "round:r1": 1 },
        payload: {
          roundId: "r1",
          status: "motions_released",
          now: "2026-11-25T10:00:00.000Z",
        },
      },
    ]);
    expect(() => setRoundMotionsAction.run(ctx, {
      roundId: "gone",
      status: "not_released",
    })).toThrow();
  });

  it("asks for a round, result field and state, then submits the updated round", async () => {
    const state = releaseState();
    expect(can(setRoundFlagAction, state)).toBe(true);
    expect(can(setRoundFlagAction, releaseState({ permissions: [] }))).toBe(false);
    expect(can(setRoundFlagAction, releaseState({ rounds: [] }))).toBe(false);

    const { store, submitted } = fakeStore(state, SUBMIT);
    const ctx = testContext(store, scriptedPrompts(["r1", "resultsReleased", true]));
    expect(await setRoundFlagAction.prompt(ctx)).toEqual({
      roundId: "r1",
      field: "resultsReleased",
      released: true,
    });
    expect(await setRoundFlagAction.prompt(testContext(store, scriptedPrompts([undefined])))).toBeUndefined();
    expect(await setRoundFlagAction.prompt(testContext(store, scriptedPrompts(["r1", undefined])))).toBeUndefined();
    expect(await setRoundFlagAction.prompt(testContext(store, scriptedPrompts(["r1", "resultsReleased", undefined])))).toBeUndefined();

    await setRoundFlagAction.run(ctx, {
      roundId: "r1",
      field: "teamSpeaksReleased",
      released: true,
    });
    expect(submitted).toEqual([
      {
        type: "round.update",
        expectedVersions: { "round:r1": 1 },
        payload: { round: { ...state.rounds[0], teamSpeaksReleased: true } },
      },
    ]);
    expect(() => setRoundFlagAction.run(ctx, {
      roundId: "gone",
      field: "resultsReleased",
      released: true,
    })).toThrow();
  });

  it("offers lock cancellation to the host owner with locks, and calls the host", async () => {
    const lock: HostLockInfo = {
      lockId: "lock-1",
      opType: "draw.generate",
      actorRef: "host:host-owner",
      startedAt: "2026-11-25T10:00:00.000Z",
      roundId: "r1",
    };
    const options: FakeStoreOptions = { status: { locks: [lock] } };
    expect(can(cancelLockAction, releaseState(), options)).toBe(true);
    expect(can(cancelLockAction, releaseState({ roleId: "tab_director" }), options)).toBe(false);
    expect(can(cancelLockAction, releaseState())).toBe(false);
    expect(can(cancelLockAction, null, options)).toBe(false);

    const { store, calls } = fakeStore(releaseState(), SUBMIT, options);
    expect(await cancelLockAction.prompt(testContext(store, scriptedPrompts([undefined])))).toBeUndefined();
    expect(await cancelLockAction.prompt(testContext(store, scriptedPrompts(["lock-1"])))).toEqual({ lockId: "lock-1" });
    expect(await cancelLockAction.run(testContext(store, scriptedPrompts([])), { lockId: "lock-1" })).toEqual({
      ok: true,
      lockId: "lock-1",
    });
    expect(calls.cancelLongIds).toEqual(["lock-1"]);
  });

  it("publishes and reports a failure as an error result", async () => {
    const { store, calls } = fakeStore(releaseState(), SUBMIT, {
      publishStatus: { state: "done", url: "https://example.test" },
    });
    const ctx = testContext(store, scriptedPrompts([]));
    expect(await publishNowAction.prompt(ctx)).toEqual({});
    expect(await publishNowAction.run(ctx, {})).toEqual({
      ok: true,
      status: { state: "done", url: "https://example.test" },
    });
    expect(calls.publishNow).toBe(1);

    const failed = fakeStore(releaseState(), SUBMIT, {
      publishStatus: { state: "failed", reason: "No credentials" },
    });
    expect(await publishNowAction.run(testContext(failed.store, scriptedPrompts([])), {})).toEqual({
      ok: false,
      errors: ["No credentials"],
      status: { state: "failed", reason: "No credentials" },
    });
  });

  it("asks for and applies the live-public-site switch", async () => {
    const { store, calls } = fakeStore(releaseState(), SUBMIT);
    const ctx = testContext(store, scriptedPrompts([true]));
    expect(await setLivePublicSiteAction.prompt(ctx)).toEqual({ on: true });
    expect(await setLivePublicSiteAction.prompt(testContext(store, scriptedPrompts([undefined])))).toBeUndefined();
    expect(await setLivePublicSiteAction.run(ctx, { on: false })).toEqual({ ok: true });
    expect(calls.onlineSettingsPatches).toEqual([{ livePublicSite: false }]);
  });

  it("offers archive actions only with archiving enabled and applies the mirror switch", async () => {
    const options: FakeStoreOptions = {
      status: { onlineSettings: { githubArchive: true } as OnlineSettings },
    };
    expect(can(archiveNowAction, releaseState(), options)).toBe(true);
    expect(can(setArchiveMirrorAction, releaseState(), options)).toBe(true);
    expect(can(archiveNowAction, releaseState())).toBe(false);
    expect(can(setArchiveMirrorAction, releaseState())).toBe(false);
    expect(can(archiveNowAction, null, options)).toBe(false);

    const { store, calls } = fakeStore(releaseState(), SUBMIT, options);
    const ctx = testContext(store, scriptedPrompts([false]));
    expect(await archiveNowAction.prompt(ctx)).toEqual({});
    expect(await archiveNowAction.run(ctx, {})).toEqual({
      ok: true,
      status: { state: "done" },
    });
    expect(calls.archiveNow).toBe(1);

    expect(await setArchiveMirrorAction.prompt(ctx)).toEqual({ on: false });
    expect(await setArchiveMirrorAction.prompt(testContext(store, scriptedPrompts([undefined])))).toBeUndefined();
    expect(await setArchiveMirrorAction.run(ctx, { on: true })).toEqual({ ok: true });
    expect(calls.onlineSettingsPatches).toEqual([{ githubArchiveMirror: true }]);

    const failed = fakeStore(releaseState(), SUBMIT, {
      ...options,
      archiveStatus: { state: "failed", reason: "Offline" },
    });
    expect(await archiveNowAction.run(testContext(failed.store, scriptedPrompts([])), {})).toEqual({
      ok: false,
      errors: ["Offline"],
      status: { state: "failed", reason: "Offline" },
    });
  });

  it("opens Setup from the empty Releases page", async () => {
    // "Open Setup" is the navigation command, offered whenever.
    expect(can(openSetupAction, null)).toBe(true);
    expect(can(openSetupAction, releaseState())).toBe(true);
    const { store } = fakeStore(null, SUBMIT);
    const openPage = vi.fn(async () => undefined);
    const ctx = testContext(store, scriptedPrompts([]), openPage);
    expect(await openSetupAction.prompt(ctx)).toEqual({});
    expect(await openSetupAction.run(ctx, {})).toEqual({ ok: true });
    expect(openPage).toHaveBeenCalledWith("simpletab-setup-widget");
  });
});
