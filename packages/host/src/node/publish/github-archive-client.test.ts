import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GITHUB_ARCHIVE_BRANCH,
  type GitHubArchiveRequest,
} from "../../common/github-archive";
import { gitBlobSha, type GitHubFetch } from "../../electron-main/github-archive";
import { createTestGitHubArchiveIpcBridge } from "./github-archive-client";

const TOKEN = "ghp_clientBridgeTestToken0123456789abcdef";
const API = "https://api.github.test";
const OWNER = "debate-society";
const REPO = "wudc2027-archive";

/** A GitHub API stand-in; `gate` holds the commit call open until released. */
function fakeGitHubApi(gate?: Promise<void>): { fetchImpl: GitHubFetch; authHeaders: string[] } {
  const authHeaders: string[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const fetchImpl: GitHubFetch = async (input, init) => {
    authHeaders.push(new Headers(init.headers).get("authorization") ?? "");
    const route = input.replace(API, "");
    const method = init.method ?? "GET";
    if (method === "GET" && route === `/repos/${OWNER}/${REPO}`) {
      return json(200, { private: false, permissions: { push: true } });
    }
    if (method === "GET" && route === `/repos/${OWNER}/${REPO}/git/ref/heads/${GITHUB_ARCHIVE_BRANCH}`) {
      return json(404, { message: "Not Found" });
    }
    if (method === "POST" && route === `/repos/${OWNER}/${REPO}/git/blobs`) {
      const body = JSON.parse(String(init.body)) as { content: string };
      return json(201, { sha: gitBlobSha(Buffer.from(body.content, "base64")) });
    }
    if (method === "POST" && route === `/repos/${OWNER}/${REPO}/git/trees`) {
      return json(201, { sha: "a".repeat(40) });
    }
    if (method === "POST" && route === `/repos/${OWNER}/${REPO}/git/commits`) {
      await gate;
      return json(201, { sha: "b".repeat(40) });
    }
    if (method === "POST" && route === `/repos/${OWNER}/${REPO}/git/refs`) {
      return json(201, { ref: `refs/heads/${GITHUB_ARCHIVE_BRANCH}` });
    }
    if (method === "GET" && route === `/repos/${OWNER}/${REPO}/pages`) {
      return json(200, { html_url: `https://${OWNER}.github.io/${REPO}/` });
    }
    return json(404, { message: "Not Found" });
  };
  return { fetchImpl, authHeaders };
}

describe("IpcGitHubArchiver over the in-memory bridge", () => {
  const tempDirs: string[] = [];

  function makeArchiveDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "simpletab-gh-client-"));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, "manifest.json"), "{}");
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Archive</title>");
    return dir;
  }

  function makeRequest(dir: string): GitHubArchiveRequest {
    return { dir, owner: OWNER, repo: REPO, message: "Archive: head 1" };
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips an archive request and reply; the token stays on the electron-main side", async () => {
    const api = fakeGitHubApi();
    const bridge = createTestGitHubArchiveIpcBridge({
      getToken: async () => TOKEN,
      fetchImpl: api.fetchImpl,
      apiBase: API,
      sleep: async () => undefined,
      timeoutMs: 5000,
    });

    try {
      const result = await bridge.archiver.archive(makeRequest(makeArchiveDir()));
      expect(result).toEqual({
        ok: true,
        commitSha: "b".repeat(40),
        unchanged: false,
        blobsUploaded: 2,
        pagesUrl: `https://${OWNER}.github.io/${REPO}/`,
        durationMs: expect.any(Number),
      });
      expect(bridge.sentRequests).toHaveLength(1);
      expect(bridge.sentRequests[0]?.req.repo).toBe(REPO);
      expect(bridge.receivedReplies).toHaveLength(1);
      expect(api.authHeaders).toContain(`Bearer ${TOKEN}`);
      expect(JSON.stringify(bridge.sentRequests)).not.toContain(TOKEN);
      expect(JSON.stringify(bridge.receivedReplies)).not.toContain(TOKEN);
    } finally {
      bridge.dispose();
    }
  });

  it("rejects a second archive while one is already running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = createTestGitHubArchiveIpcBridge({
      getToken: async () => TOKEN,
      fetchImpl: fakeGitHubApi(gate).fetchImpl,
      apiBase: API,
      sleep: async () => undefined,
      timeoutMs: 5000,
    });

    try {
      const dir = makeArchiveDir();
      const first = bridge.archiver.archive(makeRequest(dir));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const second = await bridge.archiver.archive(makeRequest(dir));
      expect(second).toMatchObject({ ok: false, kind: "ARCHIVE_FAILED" });
      if (!second.ok) {
        expect(second.error).toMatch(/already running/i);
      }

      release();
      await expect(first).resolves.toMatchObject({ ok: true });
    } finally {
      bridge.dispose();
    }
  });

  it("reports an unavailable IPC channel instead of throwing", async () => {
    const bridge = createTestGitHubArchiveIpcBridge({
      getToken: async () => TOKEN,
      fetchImpl: fakeGitHubApi().fetchImpl,
      apiBase: API,
    });
    bridge.dispose();

    const result = await bridge.archiver.archive(makeRequest(makeArchiveDir()));
    expect(result).toMatchObject({ ok: false, kind: "ARCHIVE_FAILED" });
    if (!result.ok) {
      expect(result.error).toMatch(/disposed/i);
    }
  });

  it("times out on the client if electron-main does not reply in time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = createTestGitHubArchiveIpcBridge(
      {
        getToken: async () => TOKEN,
        fetchImpl: fakeGitHubApi(gate).fetchImpl,
        apiBase: API,
        sleep: async () => undefined,
        timeoutMs: 5000,
      },
      { defaultTimeoutMs: 25 },
    );

    try {
      const result = await bridge.archiver.archive(makeRequest(makeArchiveDir()));
      expect(result).toMatchObject({ ok: false, kind: "TIMEOUT" });
    } finally {
      release();
      bridge.dispose();
    }
  });
});
