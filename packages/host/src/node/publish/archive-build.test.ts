import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TournamentState } from "@simpletab/core/ops";
import type { PublicProjection } from "@simpletab/core/lib/publicView/projection";
import type { FeedbackSubmission } from "@simpletab/core/types";
import { parseManifest } from "@simpletab/core/wire";
import { HostEngine } from "../engine/engine";
import { assertArchivePathsAllowed, buildArchiveFiles, findChampions } from "./archive-build";
import { DEBATE_ID, makeState, ROUND_ID } from "./publish-test-fixtures";

const PUBLISHED_AT = "2026-11-25T12:00:00.000Z";

describe("buildArchiveFiles", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function assetsDir(extra: Record<string, string> = {}): string {
    const dir = tempDir("simpletab-archive-assets-");
    const files = { "index.html": "<!doctype html><title>Site</title>", "assets/app.js": "console.log(1)", ...extra };
    for (const [relPath, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, relPath)), { recursive: true });
      writeFileSync(path.join(dir, relPath), text);
    }
    return dir;
  }

  function engineFor(state: TournamentState): HostEngine {
    const dir = tempDir("simpletab-archive-db-");
    return HostEngine.open(path.join(dir, "archive.simpletab.db"), { initialState: state });
  }

  function text(files: ReadonlyMap<string, Uint8Array>, relPath: string): string {
    const bytes = files.get(relPath);
    if (bytes === undefined) throw new Error(`Missing ${relPath}`);
    return new TextDecoder().decode(bytes);
  }

  it("holds the site, a valid manifest, the exports and a README, and never feedback or passcodes", async () => {
    const state = makeState({
      releaseResults: true,
      feedback: [
        {
          id: "fb-1",
          tournamentId: "t-publish",
          roundId: ROUND_ID,
          debateId: DEBATE_ID,
          sourceType: "team",
          sourceId: "team-oo",
          targetType: "adjudicator",
          targetAdjudicatorId: "adj-chair",
          score: 3,
          answers: { comment: "SECRET_FEEDBACK_TEXT" },
          confirmed: true,
          timestamp: "2026-11-24T11:00:00.000Z",
        } as unknown as FeedbackSubmission,
      ],
    });
    const engine = engineFor(state);
    const head = engine.head();
    const result = buildArchiveFiles(state, engine.changelog(), head, {
      publicSiteAssetsDir: assetsDir(),
      publishedAt: PUBLISHED_AT,
      liveSiteUrl: "https://publish-test.pages.dev/",
    });
    const paths = [...result.files.keys()];

    expect(paths).toEqual(expect.arrayContaining(["index.html", "assets/app.js", "manifest.json", "README.md", ".nojekyll"]));
    expect(paths.some((p) => p.startsWith("data/tournament."))).toBe(true);
    expect(paths.some((p) => p.startsWith("rounds/") || p.startsWith("forms/"))).toBe(false);

    const manifest = parseManifest(JSON.parse(text(result.files, "manifest.json")));
    expect(manifest.ok).toBe(true);
    if (manifest.ok) {
      expect(manifest.value.site?.headHash).toBe(head.entryHash);
      expect(manifest.value.rounds).toEqual([]);
      expect(manifest.value.publishedAt).toBe(PUBLISHED_AT);
      expect(result.files.has(manifest.value.site!.chainFile)).toBe(true);
    }

    const results = text(result.files, "exports/results.csv");
    expect(results.split("\r\n")[0]).toBe("Round,Room,Side,Team,Rank,Points,Won,Speaker Total");
    expect(results).toContain("Unreleased University");

    const readme = text(result.files, "README.md");
    expect(readme).toContain("# Publish Test Open");
    expect(readme).toContain("British Parliamentary");
    expect(readme).toContain(head.entryHash);
    expect(readme).toContain("https://publish-test.pages.dev/");
    expect(readme).toContain("[results.csv](./exports/results.csv)");

    const everything = [...result.files.values()].map((b) => new TextDecoder().decode(b)).join("\n");
    expect(everything).not.toContain("SECRET_FEEDBACK_TEXT");
    expect(everything).not.toContain("PRIVATE_PASSCODE_VALUE");
    expect(everything).not.toContain("SPEAKER_PASSCODE_VALUE");
    await engine.close();
  });

  it("explains a skipped DebateXML export in the README instead of failing", async () => {
    // The fixture has no venues, which DebateXML requires.
    const state = makeState({ releaseResults: true });
    const engine = engineFor(state);
    const result = buildArchiveFiles(state, engine.changelog(), engine.head(), {
      publicSiteAssetsDir: assetsDir(),
      publishedAt: PUBLISHED_AT,
    });
    expect(result.skippedExports).toEqual([expect.stringMatching(/^DebateXML: .*venue/)]);
    expect(text(result.files, "README.md")).toContain("Not included:");
    await engine.close();
  });

  it("writes a DebateXML file when the released data allows one", async () => {
    const base = makeState({ releaseResults: true });
    const state = {
      ...base,
      venues: [{ id: "v-1", tournamentId: "t-publish", name: "Room 101", priority: 1 }],
      debates: base.debates.map((d) => ({ ...d, venueId: "v-1" })),
    } as unknown as TournamentState;
    const engine = engineFor(state);
    const result = buildArchiveFiles(state, engine.changelog(), engine.head(), {
      publicSiteAssetsDir: assetsDir(),
      publishedAt: PUBLISHED_AT,
    });
    expect(result.skippedExports).toEqual([]);
    const xml = text(result.files, "exports/publish-test.debatexml.xml");
    expect(xml).toMatch(/^<\?xml version="1.0"/);
    expect(xml).toContain('name="Publish Test Open"');
    expect(xml).not.toContain("<feedback");
    await engine.close();
  });

  it("leaves results out while they are unreleased", async () => {
    const state = makeState({ releaseResults: false });
    const engine = engineFor(state);
    const result = buildArchiveFiles(state, engine.changelog(), engine.head(), {
      publicSiteAssetsDir: assetsDir(),
      publishedAt: PUBLISHED_AT,
    });
    expect(result.files.has("exports/results.csv")).toBe(false);
    expect(text(result.files, "README.md")).not.toContain("results.csv");
    await engine.close();
  });

  it("is deterministic for the same state and time", async () => {
    const state = makeState({ releaseResults: true });
    const engine = engineFor(state);
    const assets = assetsDir();
    const build = () =>
      buildArchiveFiles(state, engine.changelog(), engine.head(), { publicSiteAssetsDir: assets, publishedAt: PUBLISHED_AT });
    const a = build();
    const b = build();
    expect([...b.files.keys()].sort()).toEqual([...a.files.keys()].sort());
    for (const [relPath, bytes] of a.files) {
      expect(Buffer.compare(Buffer.from(bytes), Buffer.from(b.files.get(relPath)!))).toBe(0);
    }
    await engine.close();
  });

  it("refuses round bundles and forms, even from the site assets", async () => {
    const state = makeState({ releaseResults: true });
    const engine = engineFor(state);
    for (const bad of ["rounds/r1.json", "forms/ballot.json"]) {
      expect(() =>
        buildArchiveFiles(state, engine.changelog(), engine.head(), {
          publicSiteAssetsDir: assetsDir({ [bad]: "{}" }),
          publishedAt: PUBLISHED_AT,
        }),
      ).toThrow(/never archived/);
    }
    expect(() => assertArchivePathsAllowed(["\\rounds\\x.json"])).toThrow();
    expect(() => assertArchivePathsAllowed(["data/rounds.json", "roundsabout.txt"])).not.toThrow();
    await engine.close();
  });
});

describe("findChampions", () => {
  it("names the winners of each break category's last elimination round", () => {
    const projection = {
      tournament: {},
      collections: {
        rounds: [
          { id: "sf", seq: 5, stage: "elimination", breakCategoryIds: ["open"] },
          { id: "gf", seq: 6, stage: "elimination", breakCategoryIds: ["open"] },
          { id: "esl-f", seq: 6, stage: "elimination", breakCategoryIds: ["esl"] },
          { id: "r1", seq: 1, stage: "preliminary" },
        ],
        teams: [
          { id: "a", name: "Alpha" },
          { id: "b", name: "Beta" },
          { id: "c", name: "Gamma" },
        ],
        breakCategories: [
          { id: "open", name: "Open" },
          { id: "esl", name: "ESL" },
        ],
        debates: [
          { id: "d-sf", roundId: "sf", teams: { OG: { teamId: "b" } } },
          { id: "d-gf", roundId: "gf", teams: { OG: { teamId: "a" }, OO: { teamId: "b" } } },
          { id: "d-esl", roundId: "esl-f", teams: { prop: { teamId: "c" } } },
        ],
        ballots: [
          { debateId: "d-sf", confirmed: true, teamScores: { OG: { teamId: "b", rank: 1 } } },
          { debateId: "d-gf", confirmed: true, teamScores: { OG: { teamId: "a", rank: 1 }, OO: { teamId: "b", rank: 2 } } },
          { debateId: "d-esl", confirmed: true, discarded: true, teamScores: { prop: { teamId: "c", win: true } } },
        ],
        adjudicators: [],
        venues: [],
        motions: [],
        institutions: [],
        feedback: [],
      },
      derived: {},
    } as unknown as PublicProjection;
    expect(findChampions(projection)).toEqual([{ category: "Open", teams: ["Alpha"] }]);
  });
});
