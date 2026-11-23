import { describe, expect, it } from "vitest";
import { base32Encode, newLink, type LinkRole } from "@/crypto";
import type { LinkRecord } from "@/projection";
import { applyOp, defaultRegistry } from "../index";
import {
  deepFreeze,
  expectWrittenVersionBumps,
  makeFixtureDebateAndBallot,
  TAB_ASSISTANT_ACTOR,
  TAB_DIRECTOR_ACTOR,
} from "../test-helpers";

function generateLinkRecord(role: LinkRole, entityId: string): LinkRecord {
  const generated = newLink(role, "cdn.example.com", "https://ballots.example.com", "open");
  return {
    lookupId: generated.lookupId,
    entityId,
    secret: base32Encode(generated.secret),
  };
}

describe("ops links", () => {
  it("validates format and replaces or fills links cleanly in private_urls.regenerate", () => {
    const registry = defaultRegistry();
    const { state } = makeFixtureDebateAndBallot();
    const teamLink1 = generateLinkRecord("team", state.teams[0]!.id);
    const teamLink2 = generateLinkRecord("team", state.teams[1]!.id);
    const adjLink1 = generateLinkRecord("adjudicator", state.adjudicators[0]!.id);

    const forbidden = applyOp(
      deepFreeze(state),
      {
        type: "private_urls.regenerate",
        payload: { scope: "teams", force: true, links: [teamLink1] },
      },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");

    // Invalid secret rejected
    const badSecret = applyOp(
      deepFreeze(state),
      {
        type: "private_urls.regenerate",
        payload: {
          scope: "teams",
          force: true,
          links: [{ ...teamLink1, secret: "bad-secret" }],
        },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(badSecret.ok).toBe(false);
    if (!badSecret.ok) expect(badSecret.code).toBe("INVALID");

    // Wrong role for scope rejected
    const wrongScope = applyOp(
      deepFreeze(state),
      {
        type: "private_urls.regenerate",
        payload: { scope: "teams", force: true, links: [adjLink1] },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(wrongScope.ok).toBe(false);
    if (!wrongScope.ok) expect(wrongScope.code).toBe("INVALID");

    // Add initial links with force: false
    const first = applyOp(
      deepFreeze(state),
      {
        type: "private_urls.regenerate",
        payload: { scope: "all", force: false, links: [teamLink1, adjLink1] },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.state.links).toEqual([teamLink1, adjLink1]);
    expect(first.inverse).toBeNull();
    expectWrittenVersionBumps(state, first);

    // force: false keeps existing team-1 link and adds team-2 link
    const team1Replacement = generateLinkRecord("team", state.teams[0]!.id);
    const second = applyOp(
      deepFreeze(first.state),
      {
        type: "private_urls.regenerate",
        payload: {
          scope: "teams",
          force: false,
          links: [team1Replacement, teamLink2],
        },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.state.links).toEqual([teamLink1, adjLink1, teamLink2]);
    expect(second.inverse).toBeNull();
    expectWrittenVersionBumps(first.state, second);

    // force: true for teams replaces only team links and keeps adjLink1
    const third = applyOp(
      deepFreeze(second.state),
      {
        type: "private_urls.regenerate",
        payload: {
          scope: "teams",
          force: true,
          links: [team1Replacement],
        },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.state.links).toEqual([adjLink1, team1Replacement]);
    expect(third.inverse).toBeNull();
    expectWrittenVersionBumps(second.state, third);
    expect(registry.get("private_urls.regenerate")?.lock).toBe(true);
  });
});
