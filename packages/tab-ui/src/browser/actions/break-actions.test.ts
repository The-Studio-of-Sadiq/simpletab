import type { ProjectedState, SubmitResult } from "@simpletab/host/lib/common/host-protocol";
import { describe, expect, it } from "vitest";
import type { TournamentStoreSnapshot } from "../store/tournament-store";
import {
  advanceRoundAction,
  BREAK_ACTIONS,
  BREAK_PAGE,
  clearBreakAction,
  computeBreakAction,
  saveBreakCategoriesAction,
  setTeamOverrideAction,
} from "./break-actions";
import { fakeStore, scriptedPrompts, testContext } from "./test-context";

const SUBMIT = {
  ok: true,
  seq: 1,
  writes: [],
  committedPayload: null,
} as unknown as SubmitResult;

function breakState(patch: Partial<ProjectedState> = {}): ProjectedState {
  return {
    seq: 8,
    roleId: "host_owner",
    permissions: ["break.manage"],
    versions: {
      "tournament:t-1": 2,
      "breakCategory:bc-open": 3,
      "team:t2": 4,
      "round:ef1": 5,
    },
    tournament: {
      id: "t-1",
      format: "bp",
      preferences: { teamsInDebate: 4 },
    },
    rounds: [
      {
        id: "ef1",
        tournamentId: "t-1",
        seq: 2,
        name: "Final",
        stage: "elimination",
        cancelled: false,
        drawStatus: "none",
        breakCategoryIds: ["bc-open"],
      },
    ],
    teams: [
      {
        id: "t2",
        tournamentId: "t-1",
        name: "Team Two",
        isSwing: false,
        breakCategories: ["bc-open"],
      },
    ],
    debates: [],
    ballots: [],
    feedback: [],
    breakCategories: [
      {
        id: "bc-open",
        tournamentId: "t-1",
        name: "Open",
        slug: "open",
        seq: 1,
        breakSize: 4,
        reserveSize: 0,
        priority: 1,
        isGeneral: true,
      },
    ],
    ...patch,
  } as unknown as ProjectedState;
}

function can(
  action: { isEnabled?: (snapshot: TournamentStoreSnapshot) => boolean },
  state: ProjectedState | null,
): boolean {
  const { store } = fakeStore(state, SUBMIT);
  return action.isEnabled?.(store.getSnapshot()) ?? false;
}

describe("break actions", () => {
  it("registers one command per Break mutation, gated by permission", () => {
    expect(BREAK_PAGE).toBe("simpletab-break-widget");
    expect(BREAK_ACTIONS.map((action) => action.id)).toEqual([
      "simpletab.break.save-categories",
      "simpletab.break.set-team-override",
      "simpletab.break.compute-break",
      "simpletab.break.clear-break",
      "simpletab.break.advance-round",
    ]);
    for (const action of BREAK_ACTIONS) {
      expect(action.page).toBe(BREAK_PAGE);
      expect(action.labelKey).toMatch(/^action\.break\./);
      expect(can(action, breakState())).toBe(true);
      expect(can(action, null)).toBe(false);
      expect(can(action, breakState({ roleId: "tab_assistant", permissions: [] }))).toBe(false);
    }
  });

  it("asks step by step for a category and submits categories_save with fresh versions", async () => {
    const state = breakState();
    const { store, submitted } = fakeStore(state, SUBMIT);
    const prompts = scriptedPrompts([
      "add",
      "Novice",
      "4",
      "0",
      "2",
      "standard",
      "0",
      "0",
      false,
    ]);
    const args = await saveBreakCategoriesAction.prompt(testContext(store, prompts));
    expect(args).toBeDefined();
    expect(args!.categories.map((category) => category.name)).toEqual(["Open", "Novice"]);
    expect(prompts.asked).toHaveLength(9);

    await saveBreakCategoriesAction.run(testContext(store, prompts), { categories: state.breakCategories });
    expect(submitted[0]).toEqual({
      type: "break.categories_save",
      expectedVersions: { "breakCategory:bc-open": 3 },
      payload: { categories: state.breakCategories },
    });
  });

  it("asks again for a bad number and refuses a save the page would refuse", async () => {
    const state = breakState();
    const { store, submitted } = fakeStore(state, SUBMIT);
    const prompts = scriptedPrompts([
      "add",
      "open",
      "abc",
      "4",
      "0",
      "2",
      "standard",
      "0",
      "0",
      false,
    ]);
    const args = await saveBreakCategoriesAction.prompt(testContext(store, prompts));
    expect(prompts.asked).toHaveLength(10);
    expect(args!.categories.map((category) => category.breakSize)).toEqual([4, 4]);

    // "open" duplicates the existing "Open" category: run reports it and submits nothing.
    const result = await saveBreakCategoriesAction.run(testContext(store, scriptedPrompts([])), args!);
    expect(result.ok).toBe(false);
    expect(submitted).toHaveLength(0);
  });

  it("submits override, compute, clear and advance ops with live versions", async () => {
    const state = breakState();
    const { store, submitted } = fakeStore(state, SUBMIT);
    const ctx = testContext(store, scriptedPrompts([]));

    await setTeamOverrideAction.run(ctx, {
      categoryId: "bc-open",
      teamId: "t2",
      override: "include",
    });
    expect(submitted[0]).toEqual({
      type: "break.team_override",
      expectedVersions: { "breakCategory:bc-open": 3, "team:t2": 4 },
      payload: { categoryId: "bc-open", teamId: "t2", override: "include" },
    });

    await computeBreakAction.run(ctx, {
      categoryId: "bc-open",
      generatedAt: "2026-11-25T09:00:00.000Z",
      reason: "tie resolved",
    });
    expect(submitted[1]).toEqual({
      type: "break.compute",
      expectedVersions: { "tournament:t-1": 2, "breakCategory:bc-open": 3 },
      payload: {
        categoryId: "bc-open",
        generatedAt: "2026-11-25T09:00:00.000Z",
        override: { reason: "tie resolved" },
      },
    });

    await clearBreakAction.run(ctx, { categoryId: "bc-open" });
    expect(submitted[2]).toEqual({
      type: "break.clear",
      expectedVersions: { "breakCategory:bc-open": 3 },
      payload: { categoryId: "bc-open" },
    });

    await advanceRoundAction.run(ctx, { roundId: "ef1" });
    expect(submitted[3]).toEqual({
      type: "elimination.advance",
      expectedVersions: { "round:ef1": 5 },
      payload: { roundId: "ef1" },
    });
  });

  it("cancels prompts cleanly and confirms destructive Break commands", async () => {
    const state = breakState();
    const { store } = fakeStore(state, SUBMIT);

    expect(
      await clearBreakAction.prompt(testContext(store, scriptedPrompts([undefined]))),
    ).toBeUndefined();
    expect(
      await clearBreakAction.prompt(testContext(store, scriptedPrompts(["bc-open", false]))),
    ).toBeUndefined();
    expect(
      await clearBreakAction.prompt(testContext(store, scriptedPrompts(["bc-open", true]))),
    ).toEqual({ categoryId: "bc-open" });

    expect(
      await advanceRoundAction.prompt(testContext(store, scriptedPrompts(["ef1", false]))),
    ).toBeUndefined();
    expect(
      await advanceRoundAction.prompt(testContext(store, scriptedPrompts(["ef1", true]))),
    ).toEqual({ roundId: "ef1" });

    expect(
      await setTeamOverrideAction.prompt(
        testContext(store, scriptedPrompts(["bc-open", "t2", undefined])),
      ),
    ).toBeUndefined();
  });
});
