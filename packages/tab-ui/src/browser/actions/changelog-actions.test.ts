import type { PublicChainItem } from "@simpletab/core/changelog";
import type { ProjectedState, SubmitResult } from "@simpletab/host/lib/common/host-protocol";
import { describe, expect, it } from "vitest";
import type { TournamentStoreSnapshot } from "../store/tournament-store";
import {
  CHANGELOG_ACTIONS,
  CHANGELOG_PAGE,
  undoChangelogOpAction,
} from "./changelog-actions";
import { fakeStore, scriptedPrompts, testContext } from "./test-context";

const SUBMIT = {
  ok: true,
  seq: 4,
  writes: [],
  committedPayload: null,
} as unknown as SubmitResult;

function changelogState(patch: Partial<ProjectedState> = {}): ProjectedState {
  return {
    seq: 3,
    roleId: "host_owner",
    permissions: [],
    versions: {},
    rounds: [],
    breakCategories: [],
    tournament: { id: "t-1", preferences: {} },
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

describe("changelog actions", () => {
  it("registers the single Undo command on an open tournament, as the page offers Undo", () => {
    expect(CHANGELOG_PAGE).toBe("simpletab-changelog-widget");
    expect(CHANGELOG_ACTIONS.map((action) => action.id)).toEqual([
      "simpletab.changelog.undo-op",
    ]);
    expect(undoChangelogOpAction.labelKey).toBe("action.changelog.undoOp");
    expect(undoChangelogOpAction.page).toBe(CHANGELOG_PAGE);
    expect(can(undoChangelogOpAction, changelogState())).toBe(true);
    expect(can(undoChangelogOpAction, null)).toBe(false);
  });

  it("offers undoable changes newest first, confirms, then calls undo rather than submitting an op", async () => {
    const state = changelogState();
    const undoResult = {
      ok: true,
      seq: 4,
      writes: [],
      committedPayload: {},
    } as unknown as SubmitResult;
    const entry = (seq: number) =>
      ({
        entry: { seq, ts: `2026-11-25T10:0${seq}:00Z`, summary: `change ${seq}`, opType: "x" },
        entryHash: `h${seq}`,
      }) as unknown as PublicChainItem;
    const { store, submitted, calls } = fakeStore(state, SUBMIT, {
      undoResult,
      changelog: [entry(1), entry(2), entry(3)],
      opUndoInfo: [
        { seq: 1, writes: [], hasInverse: true, inverseOf: null, undoable: true, blockingSeqs: [] },
        { seq: 2, writes: [], hasInverse: false, inverseOf: null, undoable: false, blockingSeqs: [] },
      ],
    });

    const offered: number[][] = [];
    const recordingPrompts = {
      ...scriptedPrompts([undefined]),
      pick: async <T,>(items: ReadonlyArray<{ value: T }>): Promise<T | undefined> => {
        offered.push(items.map((item) => item.value as unknown as number));
        return undefined;
      },
    };
    expect(await undoChangelogOpAction.prompt(testContext(store, recordingPrompts))).toBeUndefined();
    expect(offered).toEqual([[3, 1]]);

    expect(
      await undoChangelogOpAction.prompt(testContext(store, scriptedPrompts([3, false]))),
    ).toBeUndefined();
    expect(
      await undoChangelogOpAction.prompt(testContext(store, scriptedPrompts([3, true]))),
    ).toEqual({ seq: 3 });

    const result = await undoChangelogOpAction.run(testContext(store, scriptedPrompts([])), {
      seq: 3,
    });
    expect(result).toBe(undoResult);
    expect(calls.undoneSeqs).toEqual([3]);
    expect(submitted).toEqual([]);
  });
});
