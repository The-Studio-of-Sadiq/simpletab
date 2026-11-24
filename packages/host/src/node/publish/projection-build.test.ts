import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpRequest, TournamentState } from "@simpletab/core/ops";
import { verifyChain, type PublicChainItem } from "@simpletab/core/changelog";
import type { FeedbackSubmission } from "@simpletab/core/types";
import { parsePublicSiteIndex } from "@simpletab/core/wire";
import { HostEngine } from "../engine/engine";
import { HOST_OWNER_ACTOR } from "../host-service";
import { buildPublicSiteFiles } from "./projection-build";
import { DEBATE_ID, makeState, ROUND_ID } from "./publish-test-fixtures";

function decodeFiles(files: ReadonlyMap<string, Uint8Array>): Map<string, string> {
  const decoded = new Map<string, string>();
  for (const [relPath, bytes] of files) {
    decoded.set(relPath, new TextDecoder().decode(bytes));
  }
  return decoded;
}

function allText(files: ReadonlyMap<string, Uint8Array>): string {
  return [...decodeFiles(files).values()].join("\n");
}

function chunkJson<T>(files: ReadonlyMap<string, Uint8Array>, relPath: string): T {
  const bytes = files.get(relPath);
  if (bytes === undefined) {
    throw new Error(`Missing file ${relPath}`);
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

describe("buildPublicSiteFiles", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeEngine(state: TournamentState): HostEngine {
    const dir = mkdtempSync(path.join(os.tmpdir(), "simpletab-projection-"));
    tempDirs.push(dir);
    return HostEngine.open(path.join(dir, "projection.simpletab.db"), {
      initialState: state,
    });
  }

  it("is deterministic and produces a valid site index with the head and optional heads URL", async () => {
    const state = makeState({ releaseResults: true });
    const engine = makeEngine(state);
    const chain = engine.changelog();
    const head = engine.head();

    const first = buildPublicSiteFiles(state, chain, head, {
      ballotsOrigin: "https://ballots.simpletab.app/",
    });
    const second = buildPublicSiteFiles(state, chain, head, {
      ballotsOrigin: "https://ballots.simpletab.app/",
    });

    expect([...second.files.keys()]).toEqual([...first.files.keys()]);
    for (const [relPath, bytes] of first.files) {
      expect(Buffer.compare(Buffer.from(bytes), Buffer.from(second.files.get(relPath)!))).toBe(0);
    }
    expect(second.site).toEqual(first.site);

    const parsed = parsePublicSiteIndex(first.site);
    expect(parsed.ok).toBe(true);
    expect(first.site.headSeq).toBe(head.seq);
    expect(first.site.headHash).toBe(head.entryHash);
    expect(first.site.headsUrl).toBe(
      "https://ballots.simpletab.app/v1/heads/publish-test",
    );

    const withoutOrigin = buildPublicSiteFiles(state, chain, head);
    expect(withoutOrigin.site.headsUrl).toBeUndefined();

    await engine.close();
  });

  it("never publishes feedback, passcodes or speaker passcodes", async () => {
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
          targetAdjudicatorName: "Chair Judge",
          score: 3,
          answers: { comment: "SECRET_FEEDBACK_TEXT" },
          confirmed: true,
          timestamp: "2026-11-24T11:00:00.000Z",
        } as unknown as FeedbackSubmission,
      ],
    });
    const engine = makeEngine(state);
    const { files, site } = buildPublicSiteFiles(
      state,
      engine.changelog(),
      engine.head(),
    );

    const text = allText(files);
    expect(text).not.toContain("SECRET_FEEDBACK_TEXT");
    expect(text).not.toContain("PRIVATE_PASSCODE_VALUE");
    expect(text).not.toContain("SPEAKER_PASSCODE_VALUE");
    expect(Object.keys(site.data)).not.toContain("feedback");
    expect([...files.keys()].some((relPath) => relPath.includes("feedback"))).toBe(false);

    // With every page that aggregates feedback released, the aggregates are published (as in
    // CrabbyTab) but no submission's text or record ever is.
    const aggregating = {
      ...state,
      tournament: {
        ...state.tournament,
        preferences: {
          ...state.tournament.preferences,
          releaseAdjudicatorTab: true,
          adjudicatorTabShows: "final" as const,
          publicDiversity: true,
          publicFeedbackProgress: true,
        },
      },
    };
    const withAggregates = buildPublicSiteFiles(aggregating, engine.changelog(), engine.head());
    const aggregateText = allText(withAggregates.files);
    expect(aggregateText).not.toContain("SECRET_FEEDBACK_TEXT");
    expect(aggregateText).not.toContain("fb-1");
    expect(Object.keys(withAggregates.site.data)).not.toContain("feedback");

    await engine.close();
  });

  it("omits unreleased draws and results", async () => {
    const draftState = makeState({ releaseDraw: false, releaseResults: false });
    const draftEngine = makeEngine(draftState);
    const draft = buildPublicSiteFiles(
      draftState,
      draftEngine.changelog(),
      draftEngine.head(),
    );
    const draftText = allText(draft.files);
    expect(draftText).not.toContain("Unreleased University");
    expect(chunkJson<unknown[]>(draft.files, draft.site.data.teams!)).toEqual([]);
    expect(chunkJson<unknown[]>(draft.files, draft.site.data.debates!)).toEqual([]);
    expect(chunkJson<unknown[]>(draft.files, draft.site.data.ballots!)).toEqual([]);
    await draftEngine.close();

    const drawnState = makeState({ releaseDraw: true, releaseResults: false });
    const drawnEngine = makeEngine(drawnState);
    const drawn = buildPublicSiteFiles(
      drawnState,
      drawnEngine.changelog(),
      drawnEngine.head(),
    );
    const drawnText = allText(drawn.files);
    expect(drawnText).toContain("Unreleased University");
    expect(chunkJson<unknown[]>(drawn.files, drawn.site.data.ballots!)).toEqual([]);
    expect(drawnText).not.toContain("78");
    await drawnEngine.close();
  });

  it("publishes a chain that verifies and ends at the engine head", async () => {
    const state = makeState({ releaseResults: true });
    const engine = makeEngine(state);
    const request: OpRequest = {
      type: "settings.update",
      payload: { preferences: {}, simpletab: {} },
    };
    const result = await engine.submit(request, HOST_OWNER_ACTOR);
    expect(result.ok).toBe(true);

    const chain = engine.changelog();
    const head = engine.head();
    const { files, site } = buildPublicSiteFiles(state, chain, head);
    const published = chunkJson<PublicChainItem[]>(files, site.chainFile);

    expect(published).toHaveLength(chain.length);
    const verified = await verifyChain(published, { expectedHead: head.entryHash });
    expect(verified).toEqual({ ok: true, head: head.entryHash });
    expect(site.headSeq).toBe(head.seq);
    expect(site.headHash).toBe(head.entryHash);

    await engine.close();
  });
});
