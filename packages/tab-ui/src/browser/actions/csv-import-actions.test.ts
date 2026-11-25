import type { ProjectedState } from "@simpletab/host/lib/common/host-protocol";
import { describe, expect, it } from "vitest";
import type { ActionRunner } from "./action";
import {
  applyCsvImportAction,
  buildCsvOps,
} from "./csv-import-actions";
import { directRunner, fakeStore, scriptedPrompts, testContext } from "./test-context";

function makeState(): ProjectedState {
  return {
    seq: 1,
    roleId: "host_owner",
    permissions: [],
    versions: {},
    tournament: {
      id: "t1",
      format: "bp",
      preferences: { substantiveSpeakers: 2, speakerCategories: [] },
    },
    rounds: [],
    institutions: [],
    teams: [],
    adjudicators: [],
    venues: [],
    debates: [],
    motions: [],
    ballots: [],
    feedback: [],
    breakCategories: [],
  } as unknown as ProjectedState;
}

const CSV = [
  "name,institution,speaker1,speaker2",
  '"Oxford, Union A","Oxford, College",Alice Smith,"Bob, Jones"',
].join("\n");

describe("CSV import actions", () => {
  it("builds the same ordered ops as the panel", () => {
    const built = buildCsvOps(makeState(), "teams", CSV, {
      actions: {},
      validRowsOnly: false,
    });
    expect(built.errors).toEqual([]);
    expect(built.ops.map((op) => op.request.type)).toEqual([
      "institution.create",
      "team.create",
    ]);
    const team = built.ops[1].request.payload as {
      team: { speakers: Array<{ name: string }> };
    };
    expect(team.team.speakers.map((speaker) => speaker.name)).toEqual([
      "Alice Smith",
      "Bob, Jones",
    ]);
  });

  it("returns INVALID with page errors instead of submitting anything", async () => {
    const harness = fakeStore(makeState());
    const run: ActionRunner = directRunner(harness.store);
    const result = await run(applyCsvImportAction, {
      kind: "teams",
      csvText: "institution,speaker1\nOxford,Alice",
      choices: { actions: {}, validRowsOnly: false },
    });
    expect(result.ok).toBe(false);
    expect(harness.submitted).toHaveLength(0);
  });

  it("asks for kind, a CSV file and the valid-rows choice, then confirms; Escape cancels", async () => {
    const state = makeState();
    const cancelled = scriptedPrompts(["teams"]);
    expect(
      await applyCsvImportAction.prompt(testContext(fakeStore(state).store, cancelled)),
    ).toBeUndefined();

    // Kind, the chosen file's text, valid rows only, then the summary confirmation.
    const prompts = scriptedPrompts(["teams", CSV, true, true]);
    const args = await applyCsvImportAction.prompt(
      testContext(fakeStore(state).store, prompts),
    );
    expect(args?.kind).toBe("teams");
    expect(args?.csvText).toBe(CSV);
    expect(args?.choices.validRowsOnly).toBe(true);
  });

  it("submits every built op and reports per-op failures", async () => {
    const harness = fakeStore(makeState());
    const run: ActionRunner = directRunner(harness.store);
    const result = await run(applyCsvImportAction, {
      kind: "teams",
      csvText: CSV,
      choices: { actions: {}, validRowsOnly: false },
    });
    expect(result.ok).toBe(true);
    expect(harness.submitted).toHaveLength(2);
    if (result.ok) {
      expect(result.summary?.succeeded).toBe(2);
      expect(result.summary?.failures).toEqual([]);
    }
  });
});
