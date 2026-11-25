import type { ProjectedState } from "@simpletab/host/lib/common/host-protocol";
import { describe, expect, it } from "vitest";
import type { ActionRunner } from "./action";
import {
  buildAdjudicatorRequest,
  buildInstitutionRequest,
  buildTeamRequest,
  buildVenueRequest,
  deleteTeamAction,
  saveAdjudicatorAction,
  saveAdjudicatorConflictsAction,
  saveInstitutionAction,
  saveTeamAction,
  saveTeamConflictsAction,
  updateTeamAction,
} from "./participants-actions";
import { t } from "../i18n";
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
      preferences: { substantiveSpeakers: 2 },
    },
    rounds: [],
    institutions: [{ id: "i1", name: "Oxford", code: "OX" }],
    teams: [
      {
        id: "team1",
        tournamentId: "t1",
        name: "Oxford A",
        speakers: [{ id: "spk-1", name: "Alice" }],
        breakCategories: ["open"],
        speakerCategories: ["esl"],
        checkedIn: true,
      },
    ],
    adjudicators: [
      {
        id: "adj1",
        tournamentId: "t1",
        name: "Judge One",
        baseScore: 5,
        trainee: false,
        independent: false,
        conflicts: [],
        checkedIn: true,
      },
    ],
    venues: [{ id: "v1", tournamentId: "t1", name: "Room 1", priority: 10 }],
    debates: [],
    motions: [],
    ballots: [],
    feedback: [],
    breakCategories: [],
  } as unknown as ProjectedState;
}

describe("participants actions", () => {
  it("builds the same institution, team, adjudicator and venue ops as the page", () => {
    const state = makeState();
    expect(buildInstitutionRequest(state, { name: " Cambridge ", code: " CAM " })).toEqual({
      type: "institution.create",
      payload: {
        institution: expect.objectContaining({
          tournamentId: "t1",
          name: "Cambridge",
          code: "CAM",
          region: undefined,
        }),
      },
    });

    const team = buildTeamRequest(state, {
      id: "team1",
      name: " Oxford B ",
      codeName: "OXB",
      institutionId: "i1",
      speakers: [{ id: "spk-1", name: " Alice ", email: "a@example.com" }],
    });
    expect(team.type).toBe("team.update");
    expect(team.payload).toEqual({
      team: expect.objectContaining({
        id: "team1",
        name: "Oxford B",
        codeName: "OXB",
        institutionId: "i1",
        institutionName: "Oxford",
        breakCategories: ["open"],
        speakerCategories: ["esl"],
        checkedIn: true,
        speakers: [expect.objectContaining({ id: "spk-1", name: "Alice", email: "a@example.com" })],
      }),
    });

    const adjudicator = buildAdjudicatorRequest(state, {
      id: "adj1",
      name: "Judge Two",
      baseScore: 7,
      institutionId: "i1",
      email: "",
      trainee: true,
      independent: false,
    });
    expect(adjudicator.type).toBe("adjudicator.update");
    expect(adjudicator.payload).toEqual({
      adjudicator: expect.objectContaining({
        id: "adj1",
        name: "Judge Two",
        baseScore: 7,
        trainee: true,
        institutionId: "i1",
        institutionName: "Oxford",
        conflicts: [{ institutionId: "i1", type: "institution" }],
      }),
    });

    expect(buildVenueRequest(state, {
      id: "v1",
      name: "Room 2",
      priority: 5,
      category: " Main ",
      capacity: 20,
      accessible: true,
      online: false,
      nearTabRoom: false,
      available: true,
    })).toEqual({
      type: "venue.update",
      payload: {
        venue: expect.objectContaining({
          id: "v1",
          name: "Room 2",
          priority: 5,
          category: "Main",
          categories: ["Main"],
          capacity: 20,
        }),
      },
    });
  });

  it("submits the conflict payload with clearWhenEmpty", async () => {
    const harness = fakeStore(makeState());
    const run: ActionRunner = directRunner(harness.store);
    const result = await run(saveTeamConflictsAction, {
      teamId: "team1",
      institutionIds: [],
    });
    expect(result.ok).toBe(true);
    expect(harness.submitted).toEqual([
      {
        type: "conflict.set_team_institutions",
        payload: { teamId: "team1", institutionIds: [], clearWhenEmpty: true },
      },
    ]);
  });

  it("confirms deletions in the palette before returning the item", async () => {
    const harness = fakeStore(makeState());
    const declined = scriptedPrompts(["team1", false]);
    expect(
      await deleteTeamAction.prompt(testContext(harness.store, declined)),
    ).toBeUndefined();
    expect(declined.asked).toContain(t("action.participants.confirmDeleteTitle", { name: "Oxford A" }));

    const confirmed = scriptedPrompts(["team1", true]);
    expect(
      await deleteTeamAction.prompt(testContext(harness.store, confirmed)),
    ).toEqual({ id: "team1" });
  });

  it("treats undefined at any prompt as Escape", async () => {
    const harness = fakeStore(makeState());
    const ctx = testContext(harness.store, scriptedPrompts(["Named"]));
    expect(await saveInstitutionAction.prompt(ctx)).toBeUndefined();
    expect(harness.submitted).toHaveLength(0);
  });

  it("re-asks a bad number or a blank name instead of cancelling", async () => {
    const harness = fakeStore(makeState());
    const prompts = scriptedPrompts([
      "  ",
      "New Judge",
      "not a number",
      "8.5",
      false,
      "i1",
      "judge@example.com",
      true,
    ]);
    const args = await saveAdjudicatorAction.prompt(testContext(harness.store, prompts));
    expect(args).toEqual({
      name: "New Judge",
      baseScore: 8.5,
      institutionId: "i1",
      email: "judge@example.com",
      trainee: true,
      independent: false,
    });
    expect(prompts.asked).toContain(
      t("action.prompt.requiredField", { field: t("participants.adj.name") }),
    );
    expect(prompts.asked).toContain(
      `${t("participants.adj.baseScore")}: ${t("action.prompt.notANumber")}`,
    );
  });

  it("keeps a team's extra speakers when it is edited from the palette", async () => {
    const state = makeState();
    state.teams[0].speakers.push({ id: "spk-2", name: "Bob" }, { id: "spk-3", name: "Cara" });
    const harness = fakeStore(state);
    const prompts = scriptedPrompts([
      "team1",
      "Oxford A",
      "",
      "i1",
      "Alice",
      "",
      "Bob",
      "",
      "Cara",
      "",
    ]);
    const args = await updateTeamAction.prompt(testContext(harness.store, prompts));
    expect(args?.speakers.map((speaker) => speaker.id)).toEqual(["spk-1", "spk-2", "spk-3"]);
  });

  it("starts conflict editing from the current conflicts", async () => {
    const state = makeState();
    state.adjudicators[0].conflicts = [{ type: "team", teamId: "team1" }] as never;
    const harness = fakeStore(state);
    // Keep the team conflict, then add the institution conflict.
    const prompts = scriptedPrompts(["adj1", "", "", "i1", ""]);
    const args = await saveAdjudicatorConflictsAction.prompt(testContext(harness.store, prompts));
    expect(args).toEqual({
      adjudicatorId: "adj1",
      teamIds: ["team1"],
      adjudicatorIds: [],
      institutionIds: ["i1"],
    });
  });

  it("reports an invalid entry instead of submitting it, and checks isEnabled", async () => {
    const harness = fakeStore(makeState());
    const run: ActionRunner = directRunner(harness.store);
    const failure = await run(saveTeamAction, { name: "  ", speakers: [] });
    expect(failure.ok).toBe(false);
    expect(harness.submitted).toHaveLength(0);
    expect(
      deleteTeamAction.isEnabled?.({ ...harness.store.getSnapshot(), state: null }),
    ).toBe(false);
    expect(deleteTeamAction.isEnabled?.(harness.store.getSnapshot())).toBe(true);
  });
});
