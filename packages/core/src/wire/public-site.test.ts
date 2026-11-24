import { describe, expect, it } from "vitest";
import { parseManifest } from "./manifest";
import { isPublicDataPath, parsePublicHeadsResponse, parsePublicSiteIndex } from "./public-site";

const HEAD = "a".repeat(64);

function validSite(): Record<string, unknown> {
  return {
    schema: 1,
    data: {
      tournament: "data/tournament.0123abcd.json",
      derived: "data/derived.89abcdef.json",
      teams: "data/teams.deadbeef.json",
    },
    chainFile: "data/chain.feedface.json",
    headSeq: 42,
    headHash: HEAD,
    headsUrl: "https://ballots.simpletab.app/v1/heads/wudc2027",
  };
}

describe("public site index", () => {
  it("accepts a valid index and ignores chunks it does not know", () => {
    const site = validSite();
    (site.data as Record<string, string>).futureChunk = "data/futureChunk.00000000.json";
    const parsed = parsePublicSiteIndex(site);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.data).toEqual({
      tournament: "data/tournament.0123abcd.json",
      derived: "data/derived.89abcdef.json",
      teams: "data/teams.deadbeef.json",
    });
    expect(parsed.value.headsUrl).toBe("https://ballots.simpletab.app/v1/heads/wudc2027");
  });

  it("rejects paths that could leave the site root or are not content-hashed", () => {
    for (const bad of ["/data/teams.deadbeef.json", "../data/teams.deadbeef.json", "data/teams.json", "data/../x.deadbeef.json", "https://evil/data/teams.deadbeef.json"]) {
      expect(isPublicDataPath(bad)).toBe(false);
    }
    const site = validSite();
    (site.data as Record<string, string>).teams = "../secrets.deadbeef.json";
    expect(parsePublicSiteIndex(site).ok).toBe(false);
  });

  it("requires the tournament and derived chunks, a hex head and an https heads URL", () => {
    const missing = validSite();
    delete (missing.data as Record<string, string>).tournament;
    expect(parsePublicSiteIndex(missing)).toMatchObject({ ok: false });
    expect(parsePublicSiteIndex({ ...validSite(), headHash: "ABC" }).ok).toBe(false);
    expect(parsePublicSiteIndex({ ...validSite(), headsUrl: "http://plain" }).ok).toBe(false);
    expect(parsePublicSiteIndex({ ...validSite(), schema: 2 }).ok).toBe(false);
    const noHeads = validSite();
    delete noHeads.headsUrl;
    expect(parsePublicSiteIndex(noHeads).ok).toBe(true);
  });

  it("is carried by the published manifest and validated with it", () => {
    const base = {
      schema: 1,
      slug: "wudc2027",
      tournamentName: "WUDC 2027",
      timeZone: "Asia/Dhaka",
      publishedAt: "2026-11-24T10:00:00.000Z",
      ballotCollectionMode: "online",
      currentRoundSeq: 1,
      rounds: [],
    };
    const withSite = parseManifest({ ...base, site: validSite() });
    expect(withSite.ok && withSite.value.site?.headSeq).toBe(42);
    expect(parseManifest(base).ok && parseManifest(base)).toMatchObject({ ok: true });
    expect(parseManifest({ ...base, site: { ...validSite(), chainFile: "chain.json" } }).ok).toBe(false);
  });

  it("parses the service heads response", () => {
    expect(
      parsePublicHeadsResponse({
        schema: 1,
        slug: "wudc2027",
        heads: [{ seq: 3, headHash: HEAD, publishedAt: "2026-11-24T10:00:00.000Z" }],
      }).ok,
    ).toBe(true);
    expect(parsePublicHeadsResponse({ schema: 1, slug: "x", heads: [{ seq: -1, headHash: HEAD, publishedAt: "t" }] }).ok).toBe(false);
  });
});
