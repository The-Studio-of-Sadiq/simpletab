import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GITHUB_ARCHIVE_BRANCH,
  GITHUB_ARCHIVE_IPC_CHANNEL,
  type GitHubArchiveErrorKind,
  type GitHubArchiveRequest,
} from "../common/github-archive";
import { gitBlobSha, type GitHubFetch } from "./github-archive";
import {
  attachGitHubArchiveIpcHandler,
  isGitHubArchiveIpcRequest,
  isGitHubArchiveIpcResponse,
  isGitHubArchiveRequest,
  isGitHubArchiveResult,
  type GitHubArchiveIpcEndpoint,
  type GitHubArchiveIpcMessage,
} from "./github-archive-ipc";

const TOKEN = "ghp_ipcTestToken0123456789abcdef";
const API = "https://api.github.test";

class FakeChildEndpoint implements GitHubArchiveIpcEndpoint {
  connected = true;
  sent: GitHubArchiveIpcMessage[] = [];
  private listeners = new Set<(message: unknown) => void>();

  send(message: GitHubArchiveIpcMessage): boolean {
    this.sent.push(message);
    return true;
  }

  on(_event: "message", listener: (message: unknown) => void): this {
    this.listeners.add(listener);
    return this;
  }

  off(_event: "message", listener: (message: unknown) => void): this {
    this.listeners.delete(listener);
    return this;
  }

  emit(message: unknown): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }
}

function makeFakeFetch(gate?: Promise<void>): GitHubFetch {
  return async (input, init) => {
    const route = input.replace(API, "");
    const method = init.method ?? "GET";
    if (method === "GET" && route.endsWith("/repos/debate-society/wudc2027-archive")) {
      return new Response(JSON.stringify({ private: false, permissions: { push: true } }), { status: 200 });
    }
    if (method === "GET" && route.endsWith(`/git/ref/heads/${GITHUB_ARCHIVE_BRANCH}`)) {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }
    if (method === "POST" && route.endsWith("/git/blobs")) {
      const body = JSON.parse(String(init.body)) as { content: string };
      const sha = gitBlobSha(Buffer.from(body.content, "base64"));
      return new Response(JSON.stringify({ sha }), { status: 201 });
    }
    if (method === "POST" && route.endsWith("/git/trees")) {
      return new Response(JSON.stringify({ sha: "a".repeat(40) }), { status: 201 });
    }
    if (method === "POST" && route.endsWith("/git/commits")) {
      await gate;
      return new Response(JSON.stringify({ sha: "b".repeat(40) }), { status: 201 });
    }
    if (method === "POST" && route.endsWith("/git/refs")) {
      return new Response(JSON.stringify({ ref: `refs/heads/${GITHUB_ARCHIVE_BRANCH}` }), { status: 201 });
    }
    if (method === "GET" && route.endsWith("/pages")) {
      return new Response(JSON.stringify({ html_url: "https://debate-society.github.io/wudc2027-archive/" }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  };
}

describe("github-archive-ipc", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeArchiveDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "simpletab-gh-ipc-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "manifest.json"), "{}");
    return dir;
  }

  function makeReq(dir: string): GitHubArchiveRequest {
    return {
      dir,
      owner: "debate-society",
      repo: "wudc2027-archive",
      message: "Archive: head 1",
    };
  }

  it("validates request, result, and IPC envelope type guards", () => {
    const req = makeReq("/tmp/site");
    expect(isGitHubArchiveRequest(req)).toBe(true);
    expect(isGitHubArchiveRequest({ ...req, message: 123 })).toBe(false);

    expect(
      isGitHubArchiveResult({
        ok: true,
        commitSha: "a".repeat(40),
        unchanged: false,
        blobsUploaded: 2,
        pagesUrl: "https://example.github.io/repo/",
        durationMs: 12,
      }),
    ).toBe(true);
    expect(
      isGitHubArchiveResult({
        ok: true,
        commitSha: "a".repeat(40),
        unchanged: true,
        blobsUploaded: 0,
        durationMs: 5,
      }),
    ).toBe(true);

    const allKinds: GitHubArchiveErrorKind[] = [
      "NO_TOKEN",
      "NOT_PUBLIC",
      "EMPTY_REPO",
      "CONFLICT",
      "ARCHIVE_FAILED",
      "TIMEOUT",
    ];
    for (const kind of allKinds) {
      expect(isGitHubArchiveResult({ ok: false, kind, error: "msg" })).toBe(true);
    }
    expect(isGitHubArchiveResult({ ok: false, kind: "UNKNOWN", error: "msg" })).toBe(false);

    const ipcReq = { __simpletabIpc: GITHUB_ARCHIVE_IPC_CHANNEL, kind: "request", id: "1", req };
    expect(isGitHubArchiveIpcRequest(ipcReq)).toBe(true);
    expect(isGitHubArchiveIpcRequest({ ...ipcReq, id: "" })).toBe(false);

    const ipcResp = {
      __simpletabIpc: GITHUB_ARCHIVE_IPC_CHANNEL,
      kind: "response",
      id: "1",
      result: { ok: false, kind: "NO_TOKEN", error: "missing" },
    };
    expect(isGitHubArchiveIpcResponse(ipcResp)).toBe(true);
    expect(isGitHubArchiveIpcResponse({ ...ipcResp, __simpletabIpc: "other" })).toBe(false);
  });

  it("handles a request, rejects concurrent requests while busy, and ignores invalid messages", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const endpoint = new FakeChildEndpoint();
    const detach = attachGitHubArchiveIpcHandler(endpoint, {
      getToken: async () => TOKEN,
      fetchImpl: makeFakeFetch(gate),
      apiBase: API,
      sleep: async () => undefined,
    });

    try {
      // Unrelated/invalid messages are ignored.
      endpoint.emit("not-an-object");
      endpoint.emit({ __simpletabIpc: "other.channel", kind: "request", id: "x", req: makeReq("/x") });
      expect(endpoint.sent).toHaveLength(0);

      const dir = makeArchiveDir();
      endpoint.emit({
        __simpletabIpc: GITHUB_ARCHIVE_IPC_CHANNEL,
        kind: "request",
        id: "req-1",
        req: makeReq(dir),
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      endpoint.emit({
        __simpletabIpc: GITHUB_ARCHIVE_IPC_CHANNEL,
        kind: "request",
        id: "req-2",
        req: makeReq(dir),
      });

      expect(endpoint.sent).toHaveLength(1);
      expect(endpoint.sent[0]).toEqual({
        __simpletabIpc: GITHUB_ARCHIVE_IPC_CHANNEL,
        kind: "response",
        id: "req-2",
        result: {
          ok: false,
          kind: "ARCHIVE_FAILED",
          error: "An archive is already running.",
        },
      });

      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(endpoint.sent).toHaveLength(2);
      expect(endpoint.sent[1]).toMatchObject({
        __simpletabIpc: GITHUB_ARCHIVE_IPC_CHANNEL,
        kind: "response",
        id: "req-1",
        result: {
          ok: true,
          commitSha: "b".repeat(40),
          unchanged: false,
          blobsUploaded: 1,
          pagesUrl: "https://debate-society.github.io/wudc2027-archive/",
        },
      });
    } finally {
      detach();
    }
  });
});
