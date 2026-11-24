import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  bucketFiles,
  collectSiteFiles,
  contentTypeFor,
  deployToPages,
  MAX_BUCKET_FILES,
  pagesAssetHash,
  scrubSecrets,
  type PagesFetch,
  type SiteFile,
} from "./cloudflare-pages";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf_api_token_SECRET_value_that_is_long_enough_0123456789";
const API = "https://api.test/client/v4";

function jwtExpiringIn(seconds: number, tag: string): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds, tag }),
  ).toString("base64url");
  return `header.${payload}.signature_${tag}_padding_padding_padding_padding`;
}

interface Call {
  method: string;
  route: string;
  auth: string | null;
  json?: unknown;
  form?: FormData;
}

/** A fake Cloudflare API: knows some hashes already, records every call. */
function fakeCloudflare(options: {
  known?: string[];
  failUploadOnce?: { code: number };
  status?: number;
  jwts?: string[];
} = {}): { fetchImpl: PagesFetch; calls: Call[] } {
  const calls: Call[] = [];
  const jwts = [...(options.jwts ?? [jwtExpiringIn(300, "a")])];
  let currentJwt = jwts[0]!;
  let failedUpload = false;
  const ok = (result: unknown): Response =>
    new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
  const fail = (status: number, code: number, message: string): Response =>
    new Response(JSON.stringify({ success: false, errors: [{ code, message }], result: null }), { status });

  const fetchImpl: PagesFetch = async (input, init) => {
    const route = input.replace(API, "");
    const auth = new Headers(init.headers).get("authorization");
    const call: Call = { method: init.method ?? "GET", route, auth };
    if (typeof init.body === "string") call.json = JSON.parse(init.body);
    if (init.body instanceof FormData) call.form = init.body;
    calls.push(call);

    if (options.status !== undefined) return fail(options.status, 10000, `denied ${TOKEN}`);
    if (route.endsWith("/upload-token")) {
      expect(auth).toBe(`Bearer ${TOKEN}`);
      currentJwt = jwts.shift() ?? currentJwt;
      return ok({ jwt: currentJwt });
    }
    if (route.startsWith("/pages/assets/")) {
      expect(auth).toBe(`Bearer ${currentJwt}`);
    }
    if (route === "/pages/assets/check-missing") {
      const { hashes } = call.json as { hashes: string[] };
      return ok(hashes.filter((h) => !(options.known ?? []).includes(h)));
    }
    if (route === "/pages/assets/upload") {
      if (options.failUploadOnce !== undefined && !failedUpload) {
        failedUpload = true;
        return fail(401, options.failUploadOnce.code, "Expired JWT");
      }
      return ok(null);
    }
    if (route === "/pages/assets/upsert-hashes") return ok(true);
    if (route.endsWith("/deployments")) {
      expect(auth).toBe(`Bearer ${TOKEN}`);
      return ok({ id: "dep-1", url: "https://abc123.wudc2027.pages.dev" });
    }
    return fail(404, 7003, "No route");
  };
  return { fetchImpl, calls };
}

describe("Cloudflare Pages direct upload", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeSite(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "simpletab-pages-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Site</title>");
    writeFileSync(path.join(dir, "manifest.json"), "{}");
    mkdirSync(path.join(dir, "data"));
    writeFileSync(path.join(dir, "data", "teams.0123456789abcdef.json"), "[]");
    writeFileSync(path.join(dir, "_headers"), "/*\n  X-Frame-Options: DENY\n");
    mkdirSync(path.join(dir, "node_modules"));
    writeFileSync(path.join(dir, "node_modules", "skip.js"), "x");
    return dir;
  }

  const deps = (fetchImpl: PagesFetch) => ({
    getToken: async () => TOKEN,
    fetchImpl,
    apiBase: API,
    sleep: async () => undefined,
  });

  it("uses standard BLAKE3 (official test vectors) and Wrangler's asset key", () => {
    // BLAKE3 test_vectors.json: input bytes are i % 251.
    const input = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);
    expect(bytesToHex(blake3(input(0)))).toBe("af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262");
    expect(bytesToHex(blake3(input(1)))).toBe("2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213");
    expect(bytesToHex(blake3(input(1024)))).toBe("42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7");
    expect(bytesToHex(blake3(input(1025)))).toBe("d00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444");

    // Key = first 32 hex of BLAKE3(base64(contents) + extension without the dot).
    const contents = new TextEncoder().encode("hello");
    const expected = bytesToHex(blake3(new TextEncoder().encode("aGVsbG8=html"))).slice(0, 32);
    expect(pagesAssetHash(contents, "index.html")).toBe(expected);
    expect(pagesAssetHash(contents, "LICENSE")).toBe(
      bytesToHex(blake3(new TextEncoder().encode("aGVsbG8="))).slice(0, 32),
    );
    expect(contentTypeFor("a/b.JSON")).toBe("application/json");
    expect(contentTypeFor("x.bin")).toBe("application/octet-stream");
  });

  it("uploads only missing files, then deploys a manifest of every file with _headers in the form", async () => {
    const dir = makeSite();
    const files = collectSiteFiles(dir);
    expect(files.map((f) => f.name)).toEqual(["data/teams.0123456789abcdef.json", "index.html", "manifest.json"]);
    const indexHash = files.find((f) => f.name === "index.html")!.hash;
    const { fetchImpl, calls } = fakeCloudflare({ known: [indexHash] });

    const result = await deployToPages({ dir, accountId: ACCOUNT, projectName: "wudc2027", branch: "main" }, deps(fetchImpl));

    expect(result).toMatchObject({ ok: true, deploymentUrl: "https://abc123.wudc2027.pages.dev" });
    expect(calls.map((c) => `${c.method} ${c.route}`)).toEqual([
      `GET /accounts/${ACCOUNT}/pages/projects/wudc2027/upload-token`,
      "POST /pages/assets/check-missing",
      "POST /pages/assets/upload",
      "POST /pages/assets/upsert-hashes",
      `POST /accounts/${ACCOUNT}/pages/projects/wudc2027/deployments`,
    ]);
    const uploaded = calls[2]!.json as Array<{ key: string; value: string; base64: boolean; metadata: { contentType: string } }>;
    expect(uploaded.map((u) => u.key).sort()).toEqual(files.filter((f) => f.hash !== indexHash).map((f) => f.hash).sort());
    expect(uploaded.every((u) => u.base64 && u.metadata.contentType === "application/json")).toBe(true);

    const form = calls[4]!.form!;
    expect(JSON.parse(String(form.get("manifest")))).toEqual(Object.fromEntries(files.map((f) => [`/${f.name}`, f.hash])));
    expect(form.get("branch")).toBe("main");
    expect(form.get("_headers")).toBeInstanceOf(Blob);
    // The token is only ever an Authorization header, never in a body.
    expect(JSON.stringify(calls.map((c) => c.json ?? null))).not.toContain(TOKEN);
  });

  it("fetches a fresh upload token when the JWT expires mid-upload", async () => {
    const dir = makeSite();
    const { fetchImpl, calls } = fakeCloudflare({
      failUploadOnce: { code: 8000013 },
      jwts: [jwtExpiringIn(300, "first"), jwtExpiringIn(300, "second")],
    });
    const result = await deployToPages({ dir, accountId: ACCOUNT, projectName: "wudc2027", branch: "main" }, deps(fetchImpl));
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.route.endsWith("/upload-token"))).toHaveLength(2);
    expect(calls.filter((c) => c.route === "/pages/assets/upload")).toHaveLength(2);
  });

  it("explains a rejected token without repeating it, and needs a saved token", async () => {
    const dir = makeSite();
    const denied = await deployToPages(
      { dir, accountId: ACCOUNT, projectName: "wudc2027", branch: "main" },
      deps(fakeCloudflare({ status: 403 }).fetchImpl),
    );
    expect(denied).toMatchObject({ ok: false, kind: "DEPLOY_FAILED" });
    expect(JSON.stringify(denied)).toContain("permission to edit Pages");
    expect(JSON.stringify(denied)).not.toContain(TOKEN);

    const noToken = await deployToPages(
      { dir, accountId: ACCOUNT, projectName: "wudc2027", branch: "main" },
      { ...deps(fakeCloudflare().fetchImpl), getToken: async () => undefined },
    );
    expect(noToken).toMatchObject({ ok: false, kind: "NO_TOKEN" });
  });

  it("rejects invalid requests before reading the token or calling Cloudflare", async () => {
    const dir = makeSite();
    const { fetchImpl, calls } = fakeCloudflare();
    let tokenRead = false;
    const d = { ...deps(fetchImpl), getToken: async () => { tokenRead = true; return TOKEN; } };
    for (const bad of [
      { dir: "relative/site", accountId: ACCOUNT, projectName: "p", branch: "main" },
      { dir, accountId: "not-hex", projectName: "p", branch: "main" },
      { dir, accountId: ACCOUNT, projectName: "Bad Name", branch: "main" },
      { dir, accountId: ACCOUNT, projectName: "p", branch: "main; rm -rf" },
    ]) {
      expect(await deployToPages(bad, d)).toMatchObject({ ok: false, kind: "DEPLOY_FAILED" });
    }
    expect(tokenRead).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("times out instead of hanging", async () => {
    const dir = makeSite();
    const hanging: PagesFetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const result = await deployToPages(
      { dir, accountId: ACCOUNT, projectName: "wudc2027", branch: "main" },
      { ...deps(hanging), timeoutMs: 20 },
    );
    expect(result).toMatchObject({ ok: false, kind: "TIMEOUT" });
  });

  it("keeps buckets within Cloudflare's per-request limits", () => {
    const many: SiteFile[] = Array.from({ length: MAX_BUCKET_FILES + 5 }, (_, i) => ({
      name: `f${i}.json`, absPath: "", size: 10, contentType: "application/json", hash: `h${i}`,
    }));
    const big: SiteFile[] = [30, 30, 30].map((mb, i) => ({
      name: `big${i}.bin`, absPath: "", size: mb * 1024 * 1024, contentType: "application/octet-stream", hash: `b${i}`,
    }));
    const buckets = bucketFiles([...many, ...big]);
    expect(buckets.every((b) => b.length <= MAX_BUCKET_FILES)).toBe(true);
    expect(buckets.every((b) => b.reduce((s, f) => s + f.size, 0) <= 40 * 1024 * 1024)).toBe(true);
    expect(buckets.flat()).toHaveLength(many.length + big.length);
  });

  it("scrubs exact secrets and token-shaped strings", () => {
    expect(scrubSecrets("token abc in text", ["abc"])).toBe("token [redacted] in text");
    expect(scrubSecrets(`x ${"A".repeat(45)} y`)).toBe("x [redacted] y");
  });
});
