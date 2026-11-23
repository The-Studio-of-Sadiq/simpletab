import { describe, expect, it } from "vitest";
import { makeTournament } from "@/test/tournamentFixtures";
import type { BreakCategory } from "@/types";
import { applyOp, createTournamentState, defaultRegistry } from "../index";
import {
  deepFreeze,
  expectOpRoundTrip,
  TAB_ASSISTANT_ACTOR,
  TAB_DIRECTOR_ACTOR,
} from "../test-helpers";

describe("ops releases", () => {
  it("toggles boolean and break release gates with round-trip inverse and permission check", () => {
    const registry = defaultRegistry();
    const tournament = makeTournament("bp");
    const cat: BreakCategory = {
      id: "bc-open",
      tournamentId: tournament.id,
      name: "Open",
      slug: "open",
      seq: 1,
      breakSize: 4,
      reserveSize: 0,
      isGeneral: true,
      priority: 1,
    };
    const state = createTournamentState(tournament, { breakCategories: [cat] });

    const forbidden = applyOp(
      deepFreeze(state),
      {
        type: "release.set_gate",
        payload: { gate: "tab_team", released: true },
      },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");

    const badGate = applyOp(
      deepFreeze(state),
      {
        type: "release.set_gate",
        payload: {
          gate: "unknown_gate" as unknown as "tab_team",
          released: true,
        },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(badGate.ok).toBe(false);
    if (!badGate.ok) expect(badGate.code).toBe("INVALID");

    const badBreakCat = applyOp(
      deepFreeze(state),
      {
        type: "release.set_gate",
        payload: {
          gate: "break_category_published",
          categoryId: "missing-cat",
          released: true,
        },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(badBreakCat.ok).toBe(false);
    if (!badBreakCat.ok) expect(badBreakCat.code).toBe("INVALID");

    const afterBool = expectOpRoundTrip(
      state,
      {
        type: "release.set_gate",
        payload: { gate: "tab_team", released: true },
      },
      TAB_DIRECTOR_ACTOR,
    );
    expect(afterBool.tournament.preferences.releaseTeamTab).toBe(true);

    const afterBreak = expectOpRoundTrip(
      state,
      {
        type: "release.set_gate",
        payload: {
          gate: "break_category_published",
          categoryId: "bc-open",
          released: true,
        },
      },
      TAB_DIRECTOR_ACTOR,
    );
    expect(afterBreak.tournament.preferences.releasedBreakCategoryIds).toEqual([
      "bc-open",
    ]);
  });

  it("applies release.tab_bundle and restores exact previous preferences on inverse", () => {
    const registry = defaultRegistry();
    const tournament = makeTournament("bp");
    const cat: BreakCategory = {
      id: "bc-open",
      tournamentId: tournament.id,
      name: "Open",
      slug: "open",
      seq: 1,
      breakSize: 4,
      reserveSize: 0,
      isGeneral: true,
      priority: 1,
    };
    const state = createTournamentState(tournament, { breakCategories: [cat] });

    const forbidden = applyOp(
      deepFreeze(state),
      {
        type: "release.tab_bundle",
        payload: { breakCategoryIds: ["bc-open"] },
      },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");

    const invalidCat = applyOp(
      deepFreeze(state),
      {
        type: "release.tab_bundle",
        payload: { breakCategoryIds: ["missing"] },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(invalidCat.ok).toBe(false);
    if (!invalidCat.ok) expect(invalidCat.code).toBe("INVALID");

    const afterBundle = expectOpRoundTrip(
      state,
      {
        type: "release.tab_bundle",
        payload: { breakCategoryIds: ["bc-open"] },
      },
      TAB_DIRECTOR_ACTOR,
    );
    expect(afterBundle.tournament.preferences.releaseTeamTab).toBe(true);
    expect(afterBundle.tournament.preferences.releaseSpeakerTab).toBe(true);
    expect(afterBundle.tournament.preferences.releaseAllResults).toBe(true);
    expect(afterBundle.tournament.preferences.releasedBreakCategoryIds).toEqual([
      "bc-open",
    ]);
    expect(afterBundle.tournament.preferences.publicDraw).toBe(false);
  });
});
