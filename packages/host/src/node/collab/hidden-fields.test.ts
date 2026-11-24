import { describe, expect, it } from "vitest";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import { project } from "@simpletab/core/projection";
import type { Team } from "@simpletab/core/types";
import { makeState } from "../publish/publish-test-fixtures";
import { restoreHiddenFields } from "./hidden-fields";

describe("restoreHiddenFields", () => {
  const state = makeState();
  const role = BUILT_IN_ROLES.tab_assistant;

  it("puts back the fields a role could not see when it saves a whole record", () => {
    const seen = project(state, role).teams.find((t) => t.id === "team-og") as unknown as Team;
    expect(JSON.stringify(seen)).not.toContain("PRIVATE_PASSCODE_VALUE");

    const op = restoreHiddenFields({ type: "team.update", payload: { team: { ...seen, name: "Renamed" } } }, state, role);
    const team = (op.payload as { team: Team & { privatePasscode?: string } }).team;
    expect(team.name).toBe("Renamed");
    expect(team.privatePasscode).toBe("PRIVATE_PASSCODE_VALUE");
    const alice = team.speakers.find((s) => s.id === "spk-1") as { privatePasscode?: string };
    expect(alice.privatePasscode).toBe("SPEAKER_PASSCODE_VALUE");
  });

  it("keeps a visible field exactly as the device sent it, including a removal", () => {
    const seen = project(state, role).teams.find((t) => t.id === "team-og") as unknown as Team & { shortName?: string };
    const { shortName: _drop, ...withoutShortName } = seen;
    const op = restoreHiddenFields({ type: "team.update", payload: { team: withoutShortName } }, state, role);
    expect("shortName" in (op.payload as { team: object }).team).toBe(false);
  });

  it("leaves ops for new records and non-record payloads alone", () => {
    const fresh = { type: "team.create", payload: { team: { id: "team-new", name: "New" } } };
    expect(restoreHiddenFields(fresh, state, role)).toEqual(fresh);
    const plain = { type: "round.set_completion", payload: { roundId: "r-1", completed: true } };
    expect(restoreHiddenFields(plain, state, role)).toEqual(plain);
  });
});
