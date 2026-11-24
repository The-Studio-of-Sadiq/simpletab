import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTournamentState, type OpRound, type TournamentState } from "@simpletab/core/ops";
import type { Debate } from "@simpletab/core/types";
import { parseManifest, SCHEMA_VERSION } from "@simpletab/core/wire";
import { DEFAULT_ONLINE_SETTINGS, type OnlineSettings } from "../../common/host-protocol";
import type { PagesDeployRequest, PagesDeployResult, PagesDeployer } from "../../common/pages-deploy";
import { HostEngine } from "../engine/engine";
import { HOST_OWNER_ACTOR } from "../host-service";
import {
  Publisher,
  type PublishFetch,
  type PublisherServiceClient,
} from "./publisher";

const ROUND_ID = "r-1";

function makeState(): TournamentState {
  const tournamentId = "t-publisher";
  return createTournamentState(
    {
      id: tournamentId,
      name: "Publisher Test Open",
      shortName: "PTO",
      slug: "publisher-test",
      format: "bp",
      active: true,
      ownerId: "host-owner",
      admins: { "host-owner": true },
      preferences: {
        teamsInDebate: 4,
        substantiveSpeakers: 2,
        replyScoresEnabled: false,
        minSpeakerScore: 50,
        maxSpeakerScore: 100,
        stepSpeakerScore: 1,
        minReplyScore: 25,
        maxReplyScore: 50,
        drawRule: "power_paired",
        sideAllocationRule: "balanced",
        ballotDoubleEntry: false,
        publicDraw: true,
        publicResults: true,
        publicStandings: true,
        publicMotions: true,
        feedbackEnabled: false,
        feedbackMinScore: 1,
        feedbackMaxScore: 5,
      },
      createdAt: "2026-11-24T00:00:00.000Z",
      updatedAt: "2026-11-24T00:00:00.000Z",
    },
    {
      rounds: [
        {
          id: ROUND_ID,
          tournamentId,
          seq: 1,
          name: "Round 1",
          abbreviation: "R1",
          stage: "preliminary",
          drawType: "random",
          drawStatus: "released",
          adjudicatorsRevealed: false,
          feedbackWeight: 1,
          silent: false,
          motionsReleased: false,
          resultsReleased: false,
          completed: false,
          createdAt: "2026-11-24T00:00:00.000Z",
        } as OpRound,
      ],
      teams: [
        {
          id: "team-og",
          tournamentId,
          name: "Oxford A",
          shortName: "OXF A",
          breakCategories: [],
          speakerCategories: [],
          speakers: [
            { id: "spk-1", name: "Alice" },
            { id: "spk-2", name: "Bob" },
          ],
        },
        {
          id: "team-oo",
          tournamentId,
          name: "Cambridge A",
          shortName: "CAM A",
          breakCategories: [],
          speakerCategories: [],
          speakers: [
            { id: "spk-3", name: "Cara" },
            { id: "spk-4", name: "Dan" },
          ],
        },
      ],
      debates: [
        {
          id: "d-1",
          tournamentId,
          roundId: ROUND_ID,
          roundSeq: 1,
          bracket: 0,
          roomRank: 1,
          importance: 1,
          sidesConfirmed: true,
          flags: [],
          venueName: "Room 101",
          teams: {
            OG: { side: "OG", teamId: "team-og", teamName: "Oxford A" },
            OO: { side: "OO", teamId: "team-oo", teamName: "Cambridge A" },
          } as Debate["teams"],
          adjudicators: {
            chairId: undefined,
            chairName: undefined,
            panellistIds: [],
            panellistNames: [],
            traineeIds: [],
            traineeNames: [],
          },
          resultStatus: "none",
        } as Debate,
      ],
    },
  );
}

const CONFIGURED: OnlineSettings = {
  ...DEFAULT_ONLINE_SETTINGS,
  livePublicSite: true,
  cdnHost: "publisher-test.pages.dev",
  ballotsOrigin: "https://ballots.simpletab.app",
  cloudflareAccountId: "0123456789abcdef0123456789abcdef",
  pagesProject: "publisher-test",
};

interface Fixture {
  dir: string;
  workspaceDir: string;
  assetsDir: string;
  engine: HostEngine;
  state: TournamentState;
}

describe("Publisher", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const publishers: Publisher[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    for (const publisher of publishers.splice(0)) {
      publisher.dispose();
    }
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  function makeFixture(): Fixture {
    const dir = mkdtempSync(path.join(os.tmpdir(), "simpletab-publisher-"));
    const workspaceDir = path.join(dir, "workspace");
    const assetsDir = path.join(dir, "assets");
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(path.join(assetsDir, "index.html"), "<!doctype html><title>Site</title>");
    const state = makeState();
    const engine = HostEngine.open(path.join(workspaceDir, "publish.simpletab.db"), {
      initialState: state,
    });
    cleanups.push(async () => {
      await engine.close();
      rmSync(dir, { recursive: true, force: true });
    });
    return { dir, workspaceDir, assetsDir, engine, state };
  }

  function makeDeployer(options: {
    fail?: boolean;
    gate?: Promise<void>;
    onDeploy?: (req: PagesDeployRequest) => void;
  } = {}): {
    deployer: PagesDeployer;
    requests: PagesDeployRequest[];
  } {
    const requests: PagesDeployRequest[] = [];
    let calls = 0;
    const deployer: PagesDeployer = {
      async deploy(req): Promise<PagesDeployResult> {
        calls += 1;
        requests.push(req);
        options.onDeploy?.(req);
        if (calls === 1 && options.gate !== undefined) {
          await options.gate;
        }
        if (options.fail === true) {
          return { ok: false, kind: "DEPLOY_FAILED", error: "Cloudflare rejected the upload." };
        }
        return { ok: true, deploymentUrl: "https://deploy.example/publisher-test", durationMs: 5 };
      },
    };
    return { deployer, requests };
  }

  function makeFetch(
    deployedDir: { current: string | null },
    options: { wrongHead?: boolean } = {},
  ): PublishFetch {
    return async () => {
      const dir = deployedDir.current;
      if (dir === null) {
        return { ok: false, status: 404, json: async () => null };
      }
      const manifest = JSON.parse(
        readFileSync(path.join(dir, "manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      if (options.wrongHead === true && manifest.site !== undefined) {
        manifest.site = { ...(manifest.site as object), headHash: "f".repeat(64) };
      }
      return { ok: true, status: 200, json: async () => manifest };
    };
  }

  function makeServiceClient(): PublisherServiceClient & {
    publishHead: ReturnType<typeof vi.fn>;
  } {
    return {
      publishHead: vi.fn(async () => ({ ok: true })),
    };
  }

  function makePublisher(
    fixture: Fixture,
    options: {
      settings?: OnlineSettings;
      deployer?: PagesDeployer;
      fetchImpl?: PublishFetch;
      serviceClient?: PublisherServiceClient;
      readBackDelaysMs?: number[];
    } = {},
  ): Publisher {
    const publisher = new Publisher({
      engine: fixture.engine,
      deployer: options.deployer ?? makeDeployer().deployer,
      ...(options.serviceClient !== undefined
        ? { serviceClient: options.serviceClient }
        : {}),
      getSettings: () => options.settings ?? CONFIGURED,
      publicSiteAssetsDir: fixture.assetsDir,
      workspaceDir: fixture.workspaceDir,
      fetchImpl: options.fetchImpl ?? makeFetch({ current: null }),
      readBackDelaysMs: options.readBackDelaysMs ?? [0],
      clock: () => new Date(),
    });
    publishers.push(publisher);
    return publisher;
  }

  it("builds the file set, writes a valid manifest last, uploads, anchors and confirms", async () => {
    const fixture = makeFixture();
    const deployedDir: { current: string | null } = { current: null };
    let order: { manifestMtime: number; dataMtimes: number[] } | null = null;
    const { deployer, requests } = makeDeployer({
      onDeploy: (req) => {
        deployedDir.current = req.dir;
        const manifestPath = path.join(req.dir, "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          site: { data: Record<string, string>; chainFile: string };
        };
        const dataPaths = [...Object.values(manifest.site.data), manifest.site.chainFile];
        order = {
          manifestMtime: statSync(manifestPath).mtimeMs,
          dataMtimes: dataPaths.map((relPath) => statSync(path.join(req.dir, relPath)).mtimeMs),
        };
      },
    });
    const service = makeServiceClient();
    const publisher = makePublisher(fixture, {
      deployer,
      serviceClient: service,
      fetchImpl: makeFetch(deployedDir),
    });

    // A stale file from an earlier publish must never be uploaded again.
    mkdirSync(path.join(fixture.workspaceDir, "site"), { recursive: true });
    writeFileSync(path.join(fixture.workspaceDir, "site", "stale.txt"), "old");

    const status = await publisher.publishNow();

    expect(status.state).toBe("done");
    expect(status.url).toBe("https://deploy.example/publisher-test");
    expect(typeof status.at).toBe("string");
    expect(existsSync(path.join(fixture.workspaceDir, "site", "stale.txt"))).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      dir: path.join(fixture.workspaceDir, "site"),
      accountId: CONFIGURED.cloudflareAccountId,
      projectName: CONFIGURED.pagesProject,
      branch: "main",
    });

    const manifestPath = path.join(fixture.workspaceDir, "site", "manifest.json");
    const parsed = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.site).toBeDefined();
      expect(parsed.value.site?.headSeq).toBe(fixture.engine.head().seq);
      expect(parsed.value.site?.headHash).toBe(fixture.engine.head().entryHash);
      expect(existsSync(path.join(fixture.workspaceDir, "site", parsed.value.site!.chainFile))).toBe(
        true,
      );
      for (const relPath of Object.values(parsed.value.site!.data)) {
        expect(existsSync(path.join(fixture.workspaceDir, "site", relPath!))).toBe(true);
      }
    }

    const head = fixture.engine.head();
    expect(service.publishHead).toHaveBeenCalledWith({
      schema: SCHEMA_VERSION,
      seq: head.seq,
      headHash: head.entryHash,
    });
    expect(order).not.toBeNull();
    const recorded = order as unknown as { manifestMtime: number; dataMtimes: number[] };
    expect(recorded.manifestMtime).toBeGreaterThanOrEqual(Math.max(...recorded.dataMtimes));
  });

  it("batches to one publish every 30 seconds and coalesces extra requests into one follow-up", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fixture = makeFixture();
    const deployedDir: { current: string | null } = { current: null };
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const { deployer, requests } = makeDeployer({
      gate,
      onDeploy: (req) => {
        deployedDir.current = req.dir;
      },
    });
    const publisher = makePublisher(fixture, {
      deployer,
      fetchImpl: makeFetch(deployedDir),
    });

    const first = publisher.publishNow();
    for (let i = 0; i < 20 && requests.length === 0; i += 1) {
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(requests).toHaveLength(1);

    const second = publisher.publishNow();
    const third = publisher.publishNow();
    releaseGate();
    await first;

    await vi.advanceTimersByTimeAsync(29_000);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([second, third]);

    expect(requests).toHaveLength(2);
    expect((await second).state).toBe("done");
    expect((await third).state).toBe("done");
  });

  it("reports a deploy failure without throwing and leaves the engine writable", async () => {
    const fixture = makeFixture();
    const { deployer } = makeDeployer({ fail: true });
    const service = makeServiceClient();
    const publisher = makePublisher(fixture, {
      deployer,
      serviceClient: service,
    });

    const status = await publisher.publishNow();
    expect(status.state).toBe("failed");
    expect(status.reason).toContain("Cloudflare rejected the upload");
    expect(status.nextRetryAt).toBeDefined();
    expect(service.publishHead).not.toHaveBeenCalled();

    const result = await fixture.engine.submit(
      { type: "settings.update", payload: { preferences: {}, simpletab: {} } },
      HOST_OWNER_ACTOR,
    );
    expect(result.ok).toBe(true);
  });

  it("reports a read-back mismatch as uploaded but not yet visible", async () => {
    const fixture = makeFixture();
    const deployedDir: { current: string | null } = { current: null };
    const { deployer, requests } = makeDeployer({
      onDeploy: (req) => {
        deployedDir.current = req.dir;
      },
    });
    const service = makeServiceClient();
    const publisher = makePublisher(fixture, {
      deployer,
      serviceClient: service,
      fetchImpl: makeFetch(deployedDir, { wrongHead: true }),
      readBackDelaysMs: [0, 0, 0],
    });

    const status = await publisher.publishNow();
    expect(status.state).toBe("failed");
    expect(status.reason).toContain("not visible on the CDN yet");
    expect(requests).toHaveLength(1);
    expect(service.publishHead).toHaveBeenCalledTimes(1);
  });

  it("is not_configured when the CDN settings are incomplete", async () => {
    const fixture = makeFixture();
    const { deployer, requests } = makeDeployer();
    const publisher = makePublisher(fixture, {
      deployer,
      settings: { ...DEFAULT_ONLINE_SETTINGS, livePublicSite: true },
    });

    expect(publisher.getStatus().state).toBe("not_configured");
    const status = await publisher.publishNow();
    expect(status.state).toBe("not_configured");
    expect(status.reason).toContain("Cloudflare");
    expect(requests).toHaveLength(0);
  });

  /** A publisher whose clock the test moves, so the 30 s batch window can be passed at once. */
  function makeClockedPublisher(
    fixture: Fixture,
    deployer: PagesDeployer,
    deployedDir: { current: string | null },
    settings: OnlineSettings = CONFIGURED,
  ): { publisher: Publisher; advance: (ms: number) => void } {
    let nowMs = Date.parse("2026-11-24T10:00:00.000Z");
    const publisher = new Publisher({
      engine: fixture.engine,
      deployer,
      getSettings: () => settings,
      publicSiteAssetsDir: fixture.assetsDir,
      workspaceDir: fixture.workspaceDir,
      fetchImpl: makeFetch(deployedDir),
      readBackDelaysMs: [0],
      clock: () => new Date(nowMs),
    });
    publishers.push(publisher);
    return { publisher, advance: (ms) => (nowMs += ms) };
  }

  it("skips an automatic upload when nothing public changed, but Publish now always uploads", async () => {
    const fixture = makeFixture();
    const deployedDir: { current: string | null } = { current: null };
    const { deployer, requests } = makeDeployer({
      onDeploy: (req) => {
        deployedDir.current = req.dir;
      },
    });
    const { publisher, advance } = makeClockedPublisher(fixture, deployer, deployedDir);

    publisher.handleCommitted({ type: "draw.release" });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await vi.waitFor(() => expect(publisher.getStatus().state).toBe("done"));

    // A private op (an institution) changes the chain but nothing a reader sees.
    const write = await fixture.engine.submit(
      {
        type: "institution.create",
        payload: {
          institution: { id: "inst-private-op", tournamentId: "t-publisher", name: "Quiet U", code: "QU" },
        },
      },
      HOST_OWNER_ACTOR,
    );
    expect(write.ok).toBe(true);
    advance(31_000);
    publisher.handleCommitted({ type: "institution.create" });
    // The automatic publish builds, sees no public change, and returns without uploading.
    await vi.waitFor(() => expect(publisher.getStatus().state).toBe("done"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(publisher.getStatus().state).toBe("done");
    expect(requests).toHaveLength(1);

    advance(31_000);
    const manual = await publisher.publishNow();
    expect(manual.state).toBe("done");
    expect(requests).toHaveLength(2);
  });

  it("publishes only the portal files when the portal is on and the live site is off", async () => {
    const fixture = makeFixture();
    const deployedDir: { current: string | null } = { current: null };
    const { deployer, requests } = makeDeployer({
      onDeploy: (req) => {
        deployedDir.current = req.dir;
      },
    });
    const portalOnly: OnlineSettings = {
      ...CONFIGURED,
      livePublicSite: false,
      ballotPortal: true,
      ballotCollection: "online",
    };
    const { publisher } = makeClockedPublisher(fixture, deployer, deployedDir, portalOnly);

    publisher.handleCommitted({ type: "draw.release" });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const dir = requests[0]!.dir;
    const manifest = parseManifest(JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")));
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(manifest.value.site).toBeUndefined();
    expect(existsSync(path.join(dir, "data"))).toBe(false);
    expect(existsSync(path.join(dir, "index.html"))).toBe(false);
  });

  it("does not publish after a failed integrity check, and tabbing is unaffected", async () => {
    const fixture = makeFixture();
    const { deployer, requests } = makeDeployer();
    const blocked = new Publisher({
      engine: {
        getState: () => fixture.engine.getState(),
        changelog: () => fixture.engine.changelog(),
        head: () => fixture.engine.head(),
        canSync: () => false,
      },
      deployer,
      getSettings: () => CONFIGURED,
      publicSiteAssetsDir: fixture.assetsDir,
      workspaceDir: fixture.workspaceDir,
      fetchImpl: makeFetch({ current: null }),
      readBackDelaysMs: [0],
    });
    publishers.push(blocked);
    const status = await blocked.publishNow();
    expect(status.state).toBe("failed");
    expect(status.reason).toContain("integrity");
    expect(requests).toHaveLength(0);
  });
});
