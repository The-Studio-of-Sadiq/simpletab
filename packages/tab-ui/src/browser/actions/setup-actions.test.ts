import { RULES_PRESETS } from "@simpletab/core/lib/setup/presets";
import type {
  HostStatus,
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import { describe, expect, it } from "vitest";
import { t } from "../i18n";
import type { ActionRunner } from "./action";
import {
  createTournamentAction,
  openTournamentAction,
  saveSettingsAction,
  type CreateTournamentActionResult,
  type CreateTournamentInput,
  type SaveSettingsInput,
  type SaveSettingsResult,
} from "./setup-actions";
import { directRunner, fakeStore, scriptedPrompts, testContext } from "./test-context";

function makeState(format: "bp" | "two-team" = "bp"): ProjectedState {
  return {
    seq: 1,
    roleId: "host_owner",
    permissions: [],
    versions: { "breakCategory:bc-open": 1 },
    tournament: {
      id: "t1",
      name: "Current tournament",
      slug: "current",
      format,
      preferences: {
        teamsInDebate: format === "bp" ? 4 : 2,
        substantiveSpeakers: format === "bp" ? 2 : 3,
        replyScoresEnabled: format !== "bp",
        minSpeakerScore: 70,
        maxSpeakerScore: 100,
        stepSpeakerScore: 1,
        minReplyScore: 30,
        maxReplyScore: 50,
        sideNames: "aff-neg",
      },
    },
    rounds: [
      {
        id: "r1",
        tournamentId: "t1",
        seq: 1,
        name: "Round 1",
        stage: "preliminary",
        drawStatus: "none",
      },
    ],
    institutions: [],
    teams: [],
    adjudicators: [],
    venues: [],
    debates: [],
    motions: [],
    ballots: [],
    feedback: [],
    breakCategories: [
      {
        id: "bc-open",
        tournamentId: "t1",
        name: "Open",
        slug: "open",
        seq: 1,
        breakSize: 8,
        reserveSize: 0,
        priority: 1,
        isGeneral: true,
      },
    ],
  } as unknown as ProjectedState;
}

function baseSettingsArgs(): SaveSettingsInput {
  return {
    name: "Current tournament",
    minSpeakerScore: 70,
    maxSpeakerScore: 100,
    stepSpeakerScore: 1,
    minReplyScore: 30,
    maxReplyScore: 50,
    replyScoresEnabled: false,
    sideNames: "aff-neg",
    prelimRounds: 1,
    breakSize: 8,
  };
}

describe("setup actions", () => {
  it("asks for every create field, re-asks an invalid number and treats Escape as cancel", async () => {
    const presetId = RULES_PRESETS.find((preset) => preset.format === "bp")?.id ?? "bp";
    const prompts = scriptedPrompts([
      " Example ",
      "example",
      "bp",
      presetId,
      "not a number",
      "4",
      "/tmp",
    ]);
    const args = await createTournamentAction.prompt(
      testContext(fakeStore(null).store, prompts),
    );
    expect(args).toEqual({
      name: " Example ",
      slug: "example",
      format: "bp",
      presetId,
      prelimRounds: 4,
      directory: "/tmp",
    });
    expect(prompts.asked).toContain(
      `${t("setup.prelimRoundsLabel")}: ${t("action.prompt.notANumber")}`,
    );

    const cancelled = scriptedPrompts(["Example"]);
    expect(
      await createTournamentAction.prompt(testContext(fakeStore(null).store, cancelled)),
    ).toBeUndefined();
  });

  it("returns INVALID for page validation and submits trimmed create parameters", async () => {
    const harness = fakeStore(null);
    const run: ActionRunner = directRunner(harness.store);
    const invalid = await run<CreateTournamentInput, CreateTournamentActionResult>(createTournamentAction, {
      name: " ",
      slug: "Bad Slug",
      format: "bp",
      presetId: "bp",
      prelimRounds: 99,
      directory: "",
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.code).toBe("INVALID");
    expect(harness.calls.createTournamentParams).toEqual([]);

    const valid = await run<CreateTournamentInput, CreateTournamentActionResult>(createTournamentAction, {
      name: " Example ",
      slug: " example ",
      format: "bp",
      presetId: "bp",
      prelimRounds: 4,
      directory: " /tmp ",
    });
    expect(valid.ok).toBe(true);
    expect(harness.calls.createTournamentParams).toEqual([
      {
        name: "Example",
        slug: "example",
        format: "bp",
        presetId: "bp",
        prelimRounds: 4,
        directory: "/tmp",
      },
    ]);
  });

  it("picks an existing tournament file (never a typed path) and opens it", async () => {
    const harness = fakeStore(null);
    const status: HostStatus = harness.store.getSnapshot().status;
    expect(status.open).toBe(false);
    const prompts = scriptedPrompts(["/tmp/demo.db"]);
    const args = await openTournamentAction.prompt(testContext(harness.store, prompts));
    expect(args).toEqual({ dbPath: "/tmp/demo.db" });
    expect(prompts.asked).toEqual([t("setup.openExisting")]);
    expect(
      await openTournamentAction.prompt(
        testContext(harness.store, scriptedPrompts([])),
      ),
    ).toBeUndefined();

    const result = await directRunner(harness.store)(openTournamentAction, {
      dbPath: "/tmp/demo.db",
    });
    expect(result.ok).toBe(true);
    expect(harness.calls.openTournamentPaths).toEqual(["/tmp/demo.db"]);
  });

  it("asks for every two-team settings field and re-asks invalid numbers", async () => {
    const state = makeState("two-team");
    const prompts = scriptedPrompts([
      "Renamed",
      "not a number",
      "72",
      "100",
      "1",
      true,
      "32",
      "48",
      "gov-opp",
      "3",
      "12.5",
      "12",
    ]);
    const args = await saveSettingsAction.prompt(
      testContext(fakeStore(state).store, prompts),
    );
    expect(args).toEqual({
      name: "Renamed",
      minSpeakerScore: 72,
      maxSpeakerScore: 100,
      stepSpeakerScore: 1,
      replyScoresEnabled: true,
      minReplyScore: 32,
      maxReplyScore: 48,
      sideNames: "gov-opp",
      prelimRounds: 3,
      breakSize: 12,
    });
    expect(prompts.asked).toContain(
      `${t("setup.minSpeakerScore")}: ${t("action.prompt.notANumber")}`,
    );
    expect(prompts.asked).toContain(
      `${t("setup.breakSizeLabel")}: ${t("action.prompt.wholeNumber")}`,
    );
    expect(prompts.asked).toContain(t("setup.replyScoresEnabled"));
    expect(prompts.asked).toContain(t("setup.sideNamesLabel"));

    expect(
      await saveSettingsAction.prompt(
        testContext(fakeStore(state).store, scriptedPrompts(["Renamed"])),
      ),
    ).toBeUndefined();
  });

  it("sends no ops when settings are unchanged", async () => {
    const harness = fakeStore(makeState());
    const result = await directRunner(harness.store)<SaveSettingsInput, SaveSettingsResult>(
      saveSettingsAction,
      baseSettingsArgs(),
    );
    expect(result).toEqual({ ok: true, seq: 1, unchanged: true });
    expect(harness.submitted).toEqual([]);
  });

  it("submits the same settings, prelim count and break ops as the page", async () => {
    const harness = fakeStore(makeState());
    const result = await directRunner(harness.store)<SaveSettingsInput, SaveSettingsResult>(
      saveSettingsAction,
      {
        ...baseSettingsArgs(),
        name: "Renamed",
        prelimRounds: 2,
        breakSize: 12,
      },
    );
    expect(result.ok).toBe(true);
    expect(harness.submitted.map((request) => request.type)).toEqual([
      "settings.update",
      "round.set_prelim_count",
      "break.categories_save",
    ]);
    expect(harness.submitted[0]?.payload).toEqual({
      name: "Renamed",
      preferences: {},
    });
    expect(harness.submitted[1]?.payload).toEqual({ count: 2 });
    const categoriesRequest = harness.submitted[2];
    expect(categoriesRequest?.expectedVersions).toEqual({
      "breakCategory:bc-open": 1,
    });
    const payload = categoriesRequest?.payload as {
      categories: Array<{ breakSize: number }>;
    };
    expect(payload.categories[0]?.breakSize).toBe(12);
  });

  it("maps submit errors back to the page fields", async () => {
    const failed: SubmitResult = {
      ok: false,
      code: "INVALID",
      errors: ["Tournament name is invalid."],
    };
    const harness = fakeStore(makeState(), failed);
    const result = await directRunner(harness.store)<SaveSettingsInput, SaveSettingsResult>(
      saveSettingsAction,
      {
        ...baseSettingsArgs(),
        name: "Renamed",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID");
      expect(result.fieldErrors.name).toEqual(["Tournament name is invalid."]);
      expect(result.errors).toContain("INVALID: Tournament name is invalid.");
    }
  });

  it("checks isEnabled for each setup action", () => {
    const closed = fakeStore(null).store.getSnapshot();
    const open = fakeStore(makeState()).store.getSnapshot();
    // The Setup page always offers creating or opening a tournament.
    expect(createTournamentAction.isEnabled?.(closed)).toBe(true);
    expect(createTournamentAction.isEnabled?.(open)).toBe(true);
    expect(openTournamentAction.isEnabled?.(closed)).toBe(true);
    expect(openTournamentAction.isEnabled?.(open)).toBe(true);
    expect(saveSettingsAction.isEnabled?.(closed)).toBe(false);
    expect(saveSettingsAction.isEnabled?.(open)).toBe(true);
  });
});
