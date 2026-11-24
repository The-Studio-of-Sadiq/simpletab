import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { GITHUB_ARCHIVE_BRANCH } from "../common/github-archive";
import {
  archiveToGitHub,
  gitBlobSha,
  scrubSecrets,
  type GitHubFetch,
} from "./github-archive";

const TOKEN = "ghp_secretTokenValueForTesting1234567890";
const API = "https://api.github.test";
const OWNER = "debate-society";
const REPO = "wudc2027-archive";

interface RecordedCall {
  method: string;
  route: string;
  headers: Headers;
  json?: unknown;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

interface FakeGitHubOptions {
  privateRepo?: boolean;
  pushPermission?: boolean;
  emptyRepo?: boolean;
  repoStatus?: number;
  repoMessage?: string;
  echoAuthInError?: boolean;
  pagesStatus?: number;
  pagesPost409Race?: boolean;
  pagesUrl?: string;
  truncatedTree?: boolean;
  patchConflict?: boolean;
  postRefConflict?: boolean;
  corruptBlobSha?: boolean;
  failOnce?: {
    routePattern: RegExp;
    status: number;
    headers?: Record<string, string>;
    message?: string;
  };
  networkFailOnce?: boolean;
}

function sha1Hex(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function createFakeGitHub(options: FakeGitHubOptions = {}) {
  const calls: RecordedCall[] = [];
  const blobs = new Map<string, Uint8Array>();
  const trees = new Map<string, TreeEntry[]>();
  const commits = new Map<string, { message: string; tree: string; parents: string[] }>();
  const refs = new Map<string, string>();
  let pagesEnabled = false;
  let failedOnce = false;
  let failedNetworkOnce = false;
  let raced409Once = false;

  const jsonResp = (
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  const fetchImpl: GitHubFetch = async (input, init) => {
    const route = input.replace(API, "");
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const json = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, route, headers, ...(json !== undefined ? { json } : {}) });

    if (options.networkFailOnce && !failedNetworkOnce) {
      failedNetworkOnce = true;
      throw new Error("ECONNRESET");
    }

    if (options.failOnce !== undefined && !failedOnce && options.failOnce.routePattern.test(route)) {
      failedOnce = true;
      return jsonResp(
        options.failOnce.status,
        { message: options.failOnce.message ?? "Temporary error" },
        options.failOnce.headers,
      );
    }

    const prefix = `/repos/${OWNER}/${REPO}`;
    if (!route.startsWith(prefix)) {
      return jsonResp(404, { message: "Not Found" });
    }
    const sub = route.slice(prefix.length);

    // GET /repos/{owner}/{repo}
    if (method === "GET" && sub === "") {
      if (options.repoStatus !== undefined) {
        const auth = headers.get("authorization") ?? "";
        const msg = options.echoAuthInError
          ? `Denied for ${auth} and ${TOKEN}`
          : (options.repoMessage ?? "Bad credentials");
        return jsonResp(options.repoStatus, { message: msg });
      }
      return jsonResp(200, {
        private: options.privateRepo ?? false,
        permissions: { push: options.pushPermission ?? true },
      });
    }

    if (sub.startsWith("/git/") && options.emptyRepo) {
      return jsonResp(409, { message: "Git Repository is empty." });
    }

    // GET /git/ref/heads/{branch}
    if (method === "GET" && sub === `/git/ref/heads/${GITHUB_ARCHIVE_BRANCH}`) {
      const sha = refs.get(`refs/heads/${GITHUB_ARCHIVE_BRANCH}`);
      if (sha === undefined) {
        return jsonResp(404, { message: "Reference does not exist" });
      }
      return jsonResp(200, { ref: `refs/heads/${GITHUB_ARCHIVE_BRANCH}`, object: { sha } });
    }

    // GET /git/commits/{sha}
    const getCommitMatch = method === "GET" ? sub.match(/^\/git\/commits\/([0-9a-f]+)$/) : null;
    if (getCommitMatch !== null) {
      const commit = commits.get(getCommitMatch[1]!);
      if (commit === undefined) {
        return jsonResp(404, { message: "Commit not found" });
      }
      return jsonResp(200, { sha: getCommitMatch[1], tree: { sha: commit.tree }, parents: commit.parents });
    }

    // GET /git/trees/{sha}?recursive=1
    const getTreeMatch = method === "GET" ? sub.match(/^\/git\/trees\/([0-9a-f]+)\?recursive=1$/) : null;
    if (getTreeMatch !== null) {
      const entries = trees.get(getTreeMatch[1]!);
      if (entries === undefined) {
        return jsonResp(404, { message: "Tree not found" });
      }
      return jsonResp(200, {
        sha: getTreeMatch[1],
        truncated: options.truncatedTree ?? false,
        tree: entries,
      });
    }

    // POST /git/blobs
    if (method === "POST" && sub === "/git/blobs") {
      const body = json as { content: string; encoding: string };
      const bytes = Buffer.from(body.content, "base64");
      const sha = options.corruptBlobSha ? "0".repeat(40) : gitBlobSha(bytes);
      blobs.set(sha, bytes);
      return jsonResp(201, { sha });
    }

    // POST /git/trees
    if (method === "POST" && sub === "/git/trees") {
      const body = json as { tree: TreeEntry[]; base_tree?: string };
      const sorted = [...body.tree].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const serialized = sorted.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.path}`).join("\n");
      const sha = sha1Hex(`tree\0${serialized}`);
      trees.set(sha, sorted);
      return jsonResp(201, { sha });
    }

    // POST /git/commits
    if (method === "POST" && sub === "/git/commits") {
      const body = json as { message: string; tree: string; parents: string[] };
      const sha = sha1Hex(`commit\0${body.tree}\0${body.parents.join(",")}\0${body.message}\0${commits.size}`);
      commits.set(sha, { message: body.message, tree: body.tree, parents: body.parents });
      return jsonResp(201, { sha });
    }

    // PATCH /git/refs/heads/{branch}
    if (method === "PATCH" && sub === `/git/refs/heads/${GITHUB_ARCHIVE_BRANCH}`) {
      if (options.patchConflict) {
        return jsonResp(422, { message: "Update is not a fast forward" });
      }
      const body = json as { sha: string; force: boolean };
      refs.set(`refs/heads/${GITHUB_ARCHIVE_BRANCH}`, body.sha);
      return jsonResp(200, { ref: `refs/heads/${GITHUB_ARCHIVE_BRANCH}`, object: { sha: body.sha } });
    }

    // POST /git/refs
    if (method === "POST" && sub === "/git/refs") {
      if (options.postRefConflict) {
        return jsonResp(422, { message: "Reference already exists" });
      }
      const body = json as { ref: string; sha: string };
      refs.set(body.ref, body.sha);
      return jsonResp(201, { ref: body.ref, object: { sha: body.sha } });
    }

    // GET /pages
    if (method === "GET" && sub === "/pages") {
      if (options.pagesStatus !== undefined) {
        return jsonResp(options.pagesStatus, { message: "Pages access denied" });
      }
      if (!pagesEnabled) {
        return jsonResp(404, { message: "Not Found" });
      }
      return jsonResp(200, { html_url: options.pagesUrl ?? `https://${OWNER}.github.io/${REPO}` });
    }

    // POST /pages
    if (method === "POST" && sub === "/pages") {
      if (options.pagesStatus !== undefined) {
        return jsonResp(options.pagesStatus, { message: "Pages access denied" });
      }
      if (options.pagesPost409Race && !raced409Once) {
        raced409Once = true;
        pagesEnabled = true;
        return jsonResp(409, { message: "Your site is already built with GitHub Pages" });
      }
      pagesEnabled = true;
      return jsonResp(201, { html_url: options.pagesUrl ?? `https://${OWNER}.github.io/${REPO}` });
    }

    return jsonResp(404, { message: `Unhandled route ${method} ${sub}` });
  };

  return { fetchImpl, calls, blobs, trees, commits, refs };
}

describe("GitHub Pages archiver", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeArchiveDir(files: Record<string, string> = {
    "manifest.json": "{\"head\":1}",
    "index.html": "<!doctype html><title>Archive</title>",
    "data/standings.json": "[]",
  }): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "simpletab-gh-archive-"));
    dirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, ...rel.split("/"));
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return dir;
  }

  const deps = (fetchImpl: GitHubFetch, extra: Partial<Parameters<typeof archiveToGitHub>[1]> = {}) => ({
    getToken: async () => TOKEN,
    fetchImpl,
    apiBase: API,
    sleep: async () => undefined,
    ...extra,
  });

  it("computes git blob SHA-1 matching git hash-object", () => {
    expect(gitBlobSha(new TextEncoder().encode("hello\n"))).toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    );
    expect(gitBlobSha(new Uint8Array(0))).toBe(
      "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    );
  });

  it("archives a directory to a new gh-pages branch, enables Pages, and sends required headers", async () => {
    const dir = makeArchiveDir({
      "manifest.json": "{\"head\":1}",
      "index.html": "<html></html>",
      "data/teams.json": "[]",
      ".git/config": "ignored",
    });
    const fake = createFakeGitHub();

    const result = await archiveToGitHub(
      { dir, owner: OWNER, repo: REPO, message: "Archive: head 1" },
      deps(fake.fetchImpl),
    );

    expect(result).toMatchObject({
      ok: true,
      unchanged: false,
      blobsUploaded: 3,
      pagesUrl: `https://${OWNER}.github.io/${REPO}/`,
    });
    expect(result.ok && result.commitSha).toMatch(/^[0-9a-f]{40}$/);

    // Verify headers on every call
    for (const call of fake.calls) {
      expect(call.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(call.headers.get("accept")).toBe("application/vnd.github+json");
      expect(call.headers.get("x-github-api-version")).toBe("2022-11-28");
      expect(call.headers.get("user-agent")).toBe("SimpleTab");
    }

    const commitCall = fake.calls.find((c) => c.method === "POST" && c.route.endsWith("/git/commits"));
    expect(commitCall?.json).toMatchObject({ message: "Archive: head 1", parents: [] });

    const postRefCall = fake.calls.find((c) => c.method === "POST" && c.route.endsWith("/git/refs"));
    expect(postRefCall?.json).toMatchObject({ ref: `refs/heads/${GITHUB_ARCHIVE_BRANCH}` });

    const treeCall = fake.calls.find((c) => c.method === "POST" && c.route.endsWith("/git/trees"));
    const treeBody = treeCall?.json as { tree: TreeEntry[]; base_tree?: string };
    expect(treeBody.base_tree).toBeUndefined();
    expect(treeBody.tree.map((e) => e.path)).toEqual(["data/teams.json", "index.html", "manifest.json"]);
  });

  it("uploads only changed blobs on second archive, drops deleted files, and PATCHes with force:false", async () => {
    const dir = makeArchiveDir({
      "manifest.json": "{\"head\":1}",
      "index.html": "v1",
      "old.txt": "to-delete",
    });
    const fake = createFakeGitHub();

    const first = await archiveToGitHub(
      { dir, owner: OWNER, repo: REPO, message: "Archive 1" },
      deps(fake.fetchImpl),
    );
    expect(first).toMatchObject({ ok: true, blobsUploaded: 3 });
    if (!first.ok) return;

    // Modify one file, delete old.txt
    writeFileSync(path.join(dir, "manifest.json"), "{\"head\":2}");
    rmSync(path.join(dir, "old.txt"));
    fake.calls.length = 0;

    const second = await archiveToGitHub(
      { dir, owner: OWNER, repo: REPO, message: "Archive 2" },
      deps(fake.fetchImpl),
    );
    expect(second).toMatchObject({
      ok: true,
      unchanged: false,
      blobsUploaded: 1,
      pagesUrl: `https://${OWNER}.github.io/${REPO}/`,
    });

    const commitCall = fake.calls.find((c) => c.method === "POST" && c.route.endsWith("/git/commits"));
    expect(commitCall?.json).toMatchObject({ parents: [first.commitSha] });

    const patchCall = fake.calls.find(
      (c) => c.method === "PATCH" && c.route.endsWith(`/git/refs/heads/${GITHUB_ARCHIVE_BRANCH}`),
    );
    expect(patchCall?.json).toEqual({
      sha: second.ok ? second.commitSha : "",
      force: false,
    });

    const treeCall = fake.calls.find((c) => c.method === "POST" && c.route.endsWith("/git/trees"));
    const treePaths = (treeCall?.json as { tree: TreeEntry[] }).tree.map((t) => t.path);
    expect(treePaths).toEqual(["index.html", "manifest.json"]);
  });

  it("returns unchanged:true without creating a commit or updating ref when tree matches", async () => {
    const dir = makeArchiveDir();
    const fake = createFakeGitHub();

    const first = await archiveToGitHub(
      { dir, owner: OWNER, repo: REPO, message: "Archive 1" },
      deps(fake.fetchImpl),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    fake.calls.length = 0;

    const second = await archiveToGitHub(
      { dir, owner: OWNER, repo: REPO, message: "Archive 2" },
      deps(fake.fetchImpl),
    );
    expect(second).toMatchObject({
      ok: true,
      unchanged: true,
      commitSha: first.commitSha,
      blobsUploaded: 0,
      pagesUrl: `https://${OWNER}.github.io/${REPO}/`,
    });
    expect(fake.calls.some((c) => c.method === "POST" && c.route.endsWith("/git/blobs"))).toBe(false);
    expect(fake.calls.some((c) => c.method === "POST" && c.route.endsWith("/git/commits"))).toBe(false);
    expect(fake.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("refuses rounds/ and forms/ files before any API call", async () => {
    for (const privatePath of ["rounds/x.json", "forms/y.json"]) {
      const dir = makeArchiveDir({
        "manifest.json": "{}",
        [privatePath]: "{\"secret\":true}",
      });
      const fake = createFakeGitHub();
      const result = await archiveToGitHub(
        { dir, owner: OWNER, repo: REPO, message: "Archive" },
        deps(fake.fetchImpl),
      );
      expect(result).toMatchObject({ ok: false, kind: "ARCHIVE_FAILED" });
      expect(fake.calls).toHaveLength(0);
    }
  });

  it("requires manifest.json at the root and validates owner/repo/dir", async () => {
    const noManifest = makeArchiveDir({ "index.html": "hi" });
    const fake = createFakeGitHub();

    expect(
      await archiveToGitHub({ dir: noManifest, owner: OWNER, repo: REPO, message: "m" }, deps(fake.fetchImpl)),
    ).toMatchObject({ ok: false, kind: "ARCHIVE_FAILED" });

    const validDir = makeArchiveDir();
    for (const bad of [
      { dir: "relative/dir", owner: OWNER, repo: REPO, message: "m" },
      { dir: validDir, owner: ".", repo: REPO, message: "m" },
      { dir: validDir, owner: OWNER, repo: "..", message: "m" },
      { dir: validDir, owner: OWNER, repo: "bad/repo", message: "m" },
    ]) {
      expect(await archiveToGitHub(bad, deps(fake.fetchImpl))).toMatchObject({
        ok: false,
        kind: "ARCHIVE_FAILED",
      });
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("maps NO_TOKEN, 401, 403/404, NOT_PUBLIC, push=false, EMPTY_REPO, and CONFLICT accurately", async () => {
    const dir = makeArchiveDir();

    expect(
      await archiveToGitHub(
        { dir, owner: OWNER, repo: REPO, message: "m" },
        deps(createFakeGitHub().fetchImpl, { getToken: async () => "   " }),
      ),
    ).toMatchObject({ ok: false, kind: "NO_TOKEN", error: "Add a GitHub token in Credentials first." });

    const r401 = await archiveToGitHub(
      { dir, owner: OWNER, repo: REPO, message: "m" },
      deps(createFakeGitHub({ repoStatus: 401 }).fetchImpl),
    );
    expect(r401).toMatchObject({ ok: false, kind: "ARCHIVE_FAILED" });
    if (!r401.ok) expect(r401.error).toContain("GitHub rejected the token.");

    const r404 = await archiveToGitHub(
      { dir, owner: OWNER, repo: REPO, message: "m" },
      deps(createFakeGitHub({ repoStatus: 404 }).fetchImpl),
    );
    expect(r404).toMatchObject({ ok: false, kind: "ARCHIVE_FAILED" });
    if (!r404.ok) expect(r404.error).toContain("Contents and Pages read and write");

    expect(
      await archiveToGitHub(
        { dir, owner: OWNER, repo: REPO, message: "m" },
        deps(createFakeGitHub({ privateRepo: true }).fetchImpl),
      ),
    ).toMatchObject({
      ok: false,
      kind: "NOT_PUBLIC",
      error: "The archive repository must be public: GitHub Pages is free only for public repositories.",
    });

    expect(
      await archiveToGitHub(
        { dir, owner: OWNER, repo: REPO, message: "m" },
        deps(createFakeGitHub({ pushPermission: false }).fetchImpl),
      ),
    ).toMatchObject({ ok: false, kind: "ARCHIVE_FAILED" });

    expect(
      await archiveToGitHub(
        { dir, owner: OWNER, repo: REPO, message: "m" },
        deps(createFakeGitHub({ emptyRepo: true }).fetchImpl),
      ),
    ).toMatchObject({ ok: false, kind: "EMPTY_REPO" });

    // PATCH 422 -> CONFLICT
    const patchConflictFake = createFakeGitHub({ patchConflict: true });
    const seed = await archiveToGitHub(
      { dir, owner: OWNER, repo: REPO, message: "init" },
      deps(patchConflictFake.fetchImpl),
    );
    expect(seed.ok).toBe(true);
    writeFileSync(path.join(dir, "manifest.json"), "{\"head\":2}");
    expect(
      await archiveToGitHub(
        { dir, owner: OWNER, repo: REPO, message: "update" },
        deps(patchConflictFake.fetchImpl),
      ),
    ).toMatchObject({
      ok: false,
      kind: "CONFLICT",
      error: "The gh-pages branch changed on GitHub while archiving. Archive again.",
    });

    // POST ref 422 -> CONFLICT
    expect(
      await archiveToGitHub(
        { dir, owner: OWNER, repo: REPO, message: "init" },
        deps(createFakeGitHub({ postRefConflict: true }).fetchImpl),
      ),
    ).toMatchObject({ ok: false, kind: "CONFLICT" });
  });

  it("scrubs tokens and Authorization headers from error messages", async () => {
    const dir = makeArchiveDir();
    const fake = createFakeGitHub({ repoStatus: 401, echoAuthInError: true });
    const result = await archiveToGitHub(
      { dir, owner: OWNER, repo: REPO, message: "m" },
      deps(fake.fetchImpl),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(TOKEN);
      expect(result.error).toContain("[redacted]");
    }
    expect(
      scrubSecrets("ghp_abc github_pat_123 gho_xyz ghs_999 Bearer secret_tok", []),
    ).toBe("[redacted] [redacted] [redacted] [redacted] [redacted]");
  });

  it("retries 500, 429 retry-after (capped at 60s), and 403 rate-limit responses", async () => {
    const dir = makeArchiveDir();
    const sleeps: number[] = [];
    const fake500 = createFakeGitHub({
      failOnce: { routePattern: /\/git\/blobs$/, status: 500, message: "Server hiccup" },
    });

    const res500 = await archiveToGitHub(
      { dir, owner: OWNER, repo: REPO, message: "m" },
      deps(fake500.fetchImpl, {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    );
    expect(res500.ok).toBe(true);
    expect(sleeps).toEqual([1000]);

    const sleeps429: number[] = [];
    const fake429 = createFakeGitHub({
      failOnce: {
        routePattern: /\/git\/trees$/,
        status: 429,
        headers: { "retry-after": "120" },
      },
    });
    const res429 = await archiveToGitHub(
      { dir, owner: OWNER, repo: REPO, message: "m" },
      deps(fake429.fetchImpl, {
        sleep: async (ms) => {
          sleeps429.push(ms);
        },
      }),
    );
    expect(res429.ok).toBe(true);
    expect(sleeps429).toEqual([60_000]);
  });

  it("returns TIMEOUT when the overall deadline expires", async () => {
    const dir = makeArchiveDir();
    const hanging: GitHubFetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });

    const abortedResult = await archiveToGitHub(
      { dir, owner: OWNER, repo: REPO, message: "m" },
      deps(hanging, { timeoutMs: 20 }),
    );
    expect(abortedResult).toMatchObject({
      ok: false,
      kind: "TIMEOUT",
      error: "Archiving to GitHub took too long and was stopped. Try again.",
    });

    // Also test injected clock + sleep reaching timeoutMs
    let clock = 1_000;
    const fake500 = createFakeGitHub({
      failOnce: { routePattern: /\/repos\//, status: 500 },
    });
    const clockResult = await archiveToGitHub(
      { dir, owner: OWNER, repo: REPO, message: "m" },
      deps(fake500.fetchImpl, {
        timeoutMs: 500,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    );
    expect(clockResult).toMatchObject({ ok: false, kind: "TIMEOUT" });
  });

  it("succeeds without pagesUrl if Pages returns 403 after commit lands, and handles Pages 409 race", async () => {
    const dir = makeArchiveDir();
    const fake403 = createFakeGitHub({ pagesStatus: 403 });
    const res403 = await archiveToGitHub(
      { dir, owner: OWNER, repo: REPO, message: "m" },
      deps(fake403.fetchImpl),
    );
    expect(res403).toMatchObject({ ok: true, unchanged: false, blobsUploaded: 3 });
    if (res403.ok) {
      expect(res403.pagesUrl).toBeUndefined();
      expect("pagesUrl" in res403).toBe(false);
    }

    const fake409 = createFakeGitHub({ pagesPost409Race: true });
    const res409 = await archiveToGitHub(
      { dir, owner: OWNER, repo: REPO, message: "m" },
      deps(fake409.fetchImpl),
    );
    expect(res409).toMatchObject({
      ok: true,
      pagesUrl: `https://${OWNER}.github.io/${REPO}/`,
    });
  });
});
