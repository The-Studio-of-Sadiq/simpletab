import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ONLINE_SETTINGS, type OnlineSettings } from "../../common/host-protocol";
import type { GitHubArchiveRequest, GitHubArchiveResult } from "../../common/github-archive";
import { HostEngine } from "../engine/engine";
import { Archiver, MIN_MIRROR_INTERVAL_MS, parseGitHubRepo } from "./archiver";
import type { PublishFetch, PublisherTimers } from "./publisher";
import { makeState } from "./publish-test-fixtures";

const PAGES_URL = "https://debate-society.github.io/pto-archive/";

interface ManualTimers extends PublisherTimers {
  pending(): Array<{ ms: number; run: () => void }>;
  flush(): void;
}

function manualTimers(): ManualTimers {
  let next = 0;
  const tasks = new Map<number, { ms: number; run: () => void }>();
  return {
    setTimeout(callback, ms) {
      const id = ++next;
      tasks.set(id, { ms, run: callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(handle) {
      tasks.delete(handle as unknown as number);
    },
    pending: () => [...tasks.values()],
    flush() {
      const due = [...tasks.entries()];
      tasks.clear();
      for (const [, task] of due) task.run();
    },
  };
}

describe("parseGitHubRepo", () => {
  it("accepts owner/name and github.com addresses", () => {
    expect(parseGitHubRepo("debate-society/pto-archive")).toEqual({ owner: "debate-society", repo: "pto-archive" });
    expect(parseGitHubRepo(" https://github.com/Org/Repo.git/ ")).toEqual({ owner: "Org", repo: "Repo" });
  });

  it("rejects anything else", () => {
    for (const bad of [undefined, "", "repo", "a/b/c", "a/..", "a b/c", "https://gitlab.com/a/b"]) {
      expect(parseGitHubRepo(bad)).toBeUndefined();
    }
  });
});

describe("Archiver", () => {
  const tempDirs: string[] = [];
  const engines: HostEngine[] = [];

  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.close();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(
    options: {
      settings?: Partial<OnlineSettings>;
      result?: GitHubArchiveResult | ((req: GitHubArchiveRequest) => Promise<GitHubArchiveResult>);
      readBackHead?: "match" | "stale";
      canSync?: boolean;
    } = {},
  ) {
    const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "simpletab-archiver-"));
    tempDirs.push(workspaceDir);
    const assets = path.join(workspaceDir, "assets");
    mkdirSync(assets);
    writeFileSync(path.join(assets, "index.html"), "<!doctype html>");
    const engine = HostEngine.open(path.join(workspaceDir, "t.simpletab.db"), {
      initialState: makeState({ releaseResults: true }),
    });
    engines.push(engine);
    let settings: OnlineSettings = {
      ...DEFAULT_ONLINE_SETTINGS,
      githubArchive: true,
      githubRepo: "debate-society/pto-archive",
      ...options.settings,
    };
    const requests: GitHubArchiveRequest[] = [];
    const archive = vi.fn(async (req: GitHubArchiveRequest): Promise<GitHubArchiveResult> => {
      requests.push(req);
      // The built directory exists while the upload runs.
      expect(existsSync(path.join(req.dir, "manifest.json"))).toBe(true);
      const result = options.result;
      if (typeof result === "function") return result(req);
      return result ?? { ok: true, commitSha: "c0ffee", unchanged: false, blobsUploaded: 3, pagesUrl: PAGES_URL, durationMs: 5 };
    });
    const fetchImpl: PublishFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        const manifest = JSON.parse(readFileSync(path.join(workspaceDir, "archive", "manifest.json"), "utf8")) as {
          site: { headHash: string };
        };
        if (options.readBackHead === "stale") manifest.site.headHash = "f".repeat(64);
        return manifest;
      },
    });
    const timers = manualTimers();
    let now = Date.parse("2026-11-25T12:00:00.000Z");
    const archiver = new Archiver({
      engine: {
        getState: () => engine.getState(),
        changelog: () => engine.changelog(),
        head: () => engine.head(),
        canSync: () => options.canSync ?? true,
      },
      archiver: { archive },
      getSettings: () => settings,
      publicSiteAssetsDir: assets,
      workspaceDir,
      fetchImpl,
      clock: () => new Date(now),
      timers,
      readBackDelaysMs: [0],
    });
    return {
      archiver,
      archive,
      requests,
      timers,
      engine,
      advance: (ms: number) => {
        now += ms;
      },
      setSettings: (patch: Partial<OnlineSettings>) => {
        settings = { ...settings, ...patch };
      },
    };
  }

  it("is not configured until the archive is on and a repository is set", async () => {
    const off = setup({ settings: { githubArchive: false } });
    expect(off.archiver.getStatus()).toMatchObject({ state: "not_configured", reason: expect.stringMatching(/Turn on/) });
    const noRepo = setup({ settings: { githubRepo: "not a repo" } });
    expect(await noRepo.archiver.archiveNow()).toMatchObject({ state: "not_configured", reason: expect.stringMatching(/owner\/name/) });
    expect(noRepo.archive).not.toHaveBeenCalled();
  });

  it("builds the archive, commits it and confirms it from GitHub Pages", async () => {
    const t = setup();
    const status = await t.archiver.archiveNow();
    expect(status).toMatchObject({ state: "done", url: PAGES_URL, commitSha: "c0ffee", unchanged: false });
    expect(status.reason).toBeUndefined();
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]).toMatchObject({ owner: "debate-society", repo: "pto-archive" });
    expect(t.requests[0]!.message).toBe(`Archive: head ${t.engine.head().seq} (${t.engine.head().entryHash.slice(0, 12)})`);
    expect(t.archiver.getStatus()).toMatchObject({ state: "done" });
  });

  it("treats a commit GitHub Pages has not served yet as done, with a note", async () => {
    const t = setup({ readBackHead: "stale" });
    expect(await t.archiver.archiveNow()).toMatchObject({ state: "done", reason: expect.stringMatching(/few minutes/) });
  });

  it("explains when Pages could not be turned on", async () => {
    const t = setup({ result: { ok: true, commitSha: "abc", unchanged: true, blobsUploaded: 0, durationMs: 1 } });
    expect(await t.archiver.archiveNow()).toMatchObject({ state: "done", unchanged: true, reason: expect.stringMatching(/Pages settings/) });
  });

  it("reports a failed upload plainly", async () => {
    const t = setup({ result: { ok: false, kind: "NOT_PUBLIC", error: "The archive repository must be public." } });
    expect(await t.archiver.archiveNow()).toMatchObject({ state: "failed", reason: "The archive repository must be public." });
  });

  it("is blocked by a failed integrity check", async () => {
    const t = setup({ canSync: false });
    expect(await t.archiver.archiveNow()).toMatchObject({ state: "failed", reason: expect.stringMatching(/integrity/) });
    expect(t.archive).not.toHaveBeenCalled();
  });

  it("runs one archive at a time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const t = setup({
      result: async () => {
        await gate;
        return { ok: true, commitSha: "c1", unchanged: false, blobsUploaded: 1, pagesUrl: PAGES_URL, durationMs: 1 };
      },
    });
    const first = t.archiver.archiveNow();
    const second = t.archiver.archiveNow();
    await vi.waitFor(() => expect(t.archive).toHaveBeenCalledTimes(1));
    release();
    expect(await first).toEqual(await second);
    expect(t.archive).toHaveBeenCalledTimes(1);
  });

  it("mirrors publishes only when switched on, at most once every 10 minutes", async () => {
    const t = setup();
    t.archiver.handlePublished();
    expect(t.timers.pending()).toHaveLength(0);

    t.setSettings({ githubArchiveMirror: true });
    t.archiver.handlePublished();
    expect(t.timers.pending()).toEqual([expect.objectContaining({ ms: 0 })]);
    t.timers.flush();
    await vi.waitFor(() => expect(t.archiver.getStatus().state).toBe("done"));
    expect(t.archive).toHaveBeenCalledTimes(1);

    t.advance(60_000);
    t.archiver.handlePublished();
    t.archiver.handlePublished();
    expect(t.timers.pending()).toEqual([expect.objectContaining({ ms: MIN_MIRROR_INTERVAL_MS - 60_000 })]);

    // Switched off before the timer fires: nothing is archived.
    t.setSettings({ githubArchiveMirror: false });
    t.timers.flush();
    expect(t.archive).toHaveBeenCalledTimes(1);
  });
});
