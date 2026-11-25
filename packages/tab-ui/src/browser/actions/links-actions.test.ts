import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import {
  DEFAULT_ONLINE_SETTINGS,
  type ProjectedState,
} from "@simpletab/host/lib/common/host-protocol";
import { describe, expect, it } from "vitest";
import type { ActionRunner } from "./action";
import {
  buildRegenerateLinksRequest,
  generateLinksAction,
  regenerateLinksAction,
} from "./links-actions";
import { directRunner, fakeStore, scriptedPrompts, testContext } from "./test-context";

function makeState(): ProjectedState {
  return {
    seq: 1,
    roleId: BUILT_IN_ROLES.host_owner.id,
    permissions: BUILT_IN_ROLES.host_owner.permissions,
    versions: {},
    tournament: {
      id: "t1",
      format: "bp",
      slug: "test",
      preferences: { substantiveSpeakers: 2 },
    },
    rounds: [],
    institutions: [],
    teams: [
      {
        id: "team1",
        tournamentId: "t1",
        name: "Team One",
        speakers: [{ id: "s1", name: "Alice" }],
        breakCategories: [],
        speakerCategories: [],
        checkedIn: true,
      },
    ],
    adjudicators: [],
    venues: [],
    debates: [],
    motions: [],
    ballots: [],
    feedback: [],
    breakCategories: [],
  } as unknown as ProjectedState;
}

function storeWithCdn() {
  return fakeStore(makeState(), undefined, {
    status: {
      onlineSettings: {
        ...DEFAULT_ONLINE_SETTINGS,
        cdnHost: "example.pages.dev",
      },
    },
  });
}

describe("links actions", () => {
  it("builds the private_urls.regenerate payload with the requested force flag", () => {
    const request = buildRegenerateLinksRequest(makeState(), {
      cdnHost: "example.pages.dev",
      ballotsOrigin: "https://ballots.example.com",
      force: true,
    });
    expect(request.type).toBe("private_urls.regenerate");
    expect(request.payload.force).toBe(true);
    expect(request.payload.links.length).toBeGreaterThan(0);
  });

  it("submits the same request the page built", async () => {
    const harness = storeWithCdn();
    const run: ActionRunner = directRunner(harness.store);
    const result = await run(regenerateLinksAction, {
      cdnHost: "example.pages.dev",
      ballotsOrigin: "https://ballots.example.com",
      force: true,
    });
    expect(result.ok).toBe(true);
    expect(harness.submitted[0]?.type).toBe("private_urls.regenerate");
  });

  it("returns INVALID for an invalid host and treats declined confirmation as Escape", async () => {
    const harness = storeWithCdn();
    const run: ActionRunner = directRunner(harness.store);
    const invalid = await run(generateLinksAction, {
      cdnHost: "not a host",
      ballotsOrigin: "https://ballots.example.com",
      force: false,
    });
    expect(invalid.ok).toBe(false);

    const prompts = scriptedPrompts([false]);
    expect(
      await regenerateLinksAction.prompt(testContext(harness.store, prompts)),
    ).toBeUndefined();
    expect(prompts.asked).toHaveLength(1);
  });

  it("checks permission and cdn configuration in isEnabled", () => {
    expect(
      regenerateLinksAction.isEnabled?.({
        ...storeWithCdn().store.getSnapshot(),
        state: { ...makeState(), permissions: [] },
      }),
    ).toBe(false);
    const withLinks = {
      ...storeWithCdn().store.getSnapshot(),
      state: {
        ...makeState(),
        links: [{ lookupId: ["a"], entityId: "team1", secret: "secret" }],
      } as unknown as ProjectedState,
    };
    expect(regenerateLinksAction.isEnabled?.(withLinks)).toBe(true);
  });
});
