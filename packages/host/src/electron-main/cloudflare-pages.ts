import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import path from "node:path";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { PagesDeployRequest, PagesDeployResult } from "../common/pages-deploy";

/**
 * Uploads a built site directory to a Cloudflare Pages project through Cloudflare's API, the same
 * Direct Upload steps `wrangler pages deploy` takes (design section 10, step 2; replaces the
 * bundled Wrangler, which needed about 220 MB of native binaries even for static files):
 *
 * 1. `GET  /accounts/{account}/pages/projects/{project}/upload-token` (API token) -> short-lived JWT
 * 2. `POST /pages/assets/check-missing` (JWT) -> hashes Cloudflare does not have yet
 * 3. `POST /pages/assets/upload` (JWT) -> those files, base64, in buckets of <= 40 MiB / 1,000 files
 * 4. `POST /pages/assets/upsert-hashes` (JWT) -> every hash of this deployment
 * 5. `POST /accounts/{account}/pages/projects/{project}/deployments` (API token, multipart):
 *    `manifest` = {"/<path>": hash}, `branch`, `commit_dirty`, and `_headers` / `_redirects` if present
 *
 * The asset key is Wrangler's: the first 32 hex characters of BLAKE3(base64(contents) + extension
 * without the dot). A different key is accepted silently and the file then 404s, so it must match.
 *
 * Runs only in electron-main. The API token and the JWT never appear in errors (scrubbed).
 */

export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
export const DEFAULT_DEPLOY_TIMEOUT_MS = 10 * 60 * 1000;

/** Wrangler's limits (packages/wrangler: MAX_ASSET_SIZE, MAX_BUCKET_SIZE, MAX_BUCKET_FILE_COUNT). */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_BUCKET_BYTES = 40 * 1024 * 1024;
export const MAX_BUCKET_FILES = 1000;
export const MAX_FILE_COUNT = 20_000;

/** Cloudflare error code for an expired upload JWT. */
const JWT_EXPIRED_CODE = 8000013;
const MAX_ATTEMPTS = 5;

const PROJECT_RE = /^[a-z0-9-]{1,58}$/;
const ACCOUNT_RE = /^[0-9a-f]{32}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,100}$/;
const TOKEN_LIKE_RE = /[A-Za-z0-9_\-.]{40,}/g;

/** Not uploaded as assets (Wrangler's ignore list). `_headers` / `_redirects` go in the form. */
const ROOT_IGNORED = new Set(["_worker.js", "_redirects", "_headers", "_routes.json", "functions", ".wrangler"]);
const ANYWHERE_IGNORED = new Set([".DS_Store", "node_modules", ".git"]);

/** Content types for what a SimpleTab site contains; anything else is sent as bytes. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
  json: "application/json",
  map: "application/json",
  webmanifest: "application/manifest+json",
  txt: "text/plain",
  csv: "text/csv",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  wasm: "application/wasm",
  pdf: "application/pdf",
  zip: "application/zip",
};

export type PagesFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface DeployToPagesDependencies {
  /** Reads the `cdnToken` credential; never logged. */
  getToken(): Promise<string | undefined>;
  fetchImpl?: PagesFetch;
  apiBase?: string;
  timeoutMs?: number;
  now?: () => number;
  /** Waits between retries; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SiteFile {
  /** Path relative to the site root, with forward slashes and no leading slash. */
  name: string;
  absPath: string;
  size: number;
  contentType: string;
  hash: string;
}

class DeployError extends Error {
  constructor(
    readonly kind: Exclude<PagesDeployResult, { ok: true }>["kind"],
    message: string,
  ) {
    super(message);
  }
}

class CloudflareApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** Wrangler's asset key: BLAKE3 of the base64 contents plus the extension (no dot), 32 hex chars. */
export function pagesAssetHash(contents: Uint8Array, fileName: string): string {
  const base64 = Buffer.from(contents).toString("base64");
  const extension = path.extname(fileName).substring(1);
  return bytesToHex(blake3.create().update(utf8ToBytes(base64)).update(utf8ToBytes(extension)).digest()).slice(0, 32);
}

export function contentTypeFor(fileName: string): string {
  const extension = path.extname(fileName).substring(1).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

/** Removes the given secrets and anything token-shaped from text that may reach the UI. */
export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  let scrubbed = text;
  for (const secret of secrets) {
    if (secret.length > 0) {
      scrubbed = scrubbed.split(secret).join("[redacted]");
    }
  }
  return scrubbed.replace(TOKEN_LIKE_RE, "[redacted]");
}

/** Lists the files to upload, as Wrangler would, with their hashes. */
export function collectSiteFiles(rootDir: string): SiteFile[] {
  const files: SiteFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (ANYWHERE_IGNORED.has(entry.name) || (prefix.length === 0 && ROOT_IGNORED.has(entry.name))) {
        continue;
      }
      const absPath = path.join(dir, entry.name);
      if (lstatSync(absPath).isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(absPath, name);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const contents = readFileSync(absPath);
      if (contents.byteLength > MAX_ASSET_BYTES) {
        throw new DeployError(
          "DEPLOY_FAILED",
          `${name} is larger than Cloudflare Pages allows (25 MiB per file).`,
        );
      }
      files.push({
        name,
        absPath,
        size: contents.byteLength,
        contentType: contentTypeFor(name),
        hash: pagesAssetHash(contents, name),
      });
    }
  };
  walk(rootDir, "");
  if (files.length > MAX_FILE_COUNT) {
    throw new DeployError(
      "DEPLOY_FAILED",
      `The site has ${files.length} files; Cloudflare Pages allows ${MAX_FILE_COUNT}.`,
    );
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/** Groups files into upload requests of at most 40 MiB and 1,000 files, largest first. */
export function bucketFiles(files: readonly SiteFile[]): SiteFile[][] {
  const buckets: Array<{ files: SiteFile[]; bytes: number }> = [];
  for (const file of [...files].sort((a, b) => b.size - a.size)) {
    const bucket = buckets.find(
      (b) => b.bytes + file.size <= MAX_BUCKET_BYTES && b.files.length < MAX_BUCKET_FILES,
    );
    if (bucket === undefined) {
      buckets.push({ files: [file], bytes: file.size });
    } else {
      bucket.files.push(file);
      bucket.bytes += file.size;
    }
  }
  return buckets.map((b) => b.files);
}

function validateRequest(req: PagesDeployRequest): void {
  if (!path.isAbsolute(req.dir) || !existsSync(req.dir)) {
    throw new DeployError("DEPLOY_FAILED", "The built site folder is missing.");
  }
  if (!PROJECT_RE.test(req.projectName)) {
    throw new DeployError("DEPLOY_FAILED", "The Cloudflare Pages project name is not valid.");
  }
  if (!ACCOUNT_RE.test(req.accountId)) {
    throw new DeployError("DEPLOY_FAILED", "The Cloudflare account id is not valid.");
  }
  if (!BRANCH_RE.test(req.branch)) {
    throw new DeployError("DEPLOY_FAILED", "The deployment branch name is not valid.");
  }
}

function jwtExpired(jwt: string, nowMs: number): boolean {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" && payload.exp * 1000 <= nowMs;
  } catch {
    // An unreadable token is treated as expired, so a fresh one is fetched.
    return true;
  }
}

interface ApiEnvelope<T> {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
}

export async function deployToPages(
  req: PagesDeployRequest,
  deps: DeployToPagesDependencies,
): Promise<PagesDeployResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const fetchImpl: PagesFetch = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const apiBase = (deps.apiBase ?? CLOUDFLARE_API_BASE).replace(/\/+$/, "");
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_DEPLOY_TIMEOUT_MS;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const secrets: string[] = [];

  const call = async <T>(
    route: string,
    bearer: string,
    init: { method: "GET" | "POST"; json?: unknown; form?: FormData },
  ): Promise<T> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.form !== undefined) {
      body = init.form;
    }
    const response = await fetchImpl(`${apiBase}${route}`, {
      method: init.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: abort.signal,
    });
    let envelope: ApiEnvelope<T> = {};
    try {
      envelope = (await response.json()) as ApiEnvelope<T>;
    } catch {
      // A non-JSON reply (a gateway page) is reported by status below.
    }
    if (!response.ok || envelope.success === false || envelope.result === undefined) {
      const first = envelope.errors?.[0];
      throw new CloudflareApiError(
        response.status,
        first?.code,
        first?.message ?? `Cloudflare answered ${response.status}.`,
      );
    }
    return envelope.result;
  };

  try {
    validateRequest(req);
    const token = (await deps.getToken())?.trim();
    if (token === undefined || token.length === 0) {
      throw new DeployError("NO_TOKEN", "No CDN token is saved. Add it under Credentials.");
    }
    secrets.push(token);

    const files = collectSiteFiles(req.dir);
    const projectRoute = `/accounts/${req.accountId}/pages/projects/${req.projectName}`;

    const fetchJwt = async (): Promise<string> => {
      const { jwt } = await call<{ jwt: string }>(`${projectRoute}/upload-token`, token, { method: "GET" });
      secrets.push(jwt);
      return jwt;
    };
    let jwt = await fetchJwt();

    // Retries with backoff; a fresh JWT when it expired. Errors other than the last are dropped.
    const withJwt = async <T>(run: (bearer: string) => Promise<T>): Promise<T> => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await run(jwt);
        } catch (error) {
          if (abort.signal.aborted || attempt >= MAX_ATTEMPTS || (error instanceof CloudflareApiError && (error.status === 401 || error.status === 403) && error.code !== JWT_EXPIRED_CODE)) {
            throw error;
          }
          await sleep(2 ** (attempt - 1) * 1000);
          if ((error instanceof CloudflareApiError && error.code === JWT_EXPIRED_CODE) || jwtExpired(jwt, now())) {
            jwt = await fetchJwt();
          }
        }
      }
    };

    const allHashes = files.map((f) => f.hash);
    const missing = new Set(
      await withJwt((bearer) =>
        call<string[]>("/pages/assets/check-missing", bearer, { method: "POST", json: { hashes: allHashes } }),
      ),
    );

    for (const bucket of bucketFiles(files.filter((f) => missing.has(f.hash)))) {
      await withJwt((bearer) =>
        call<unknown>("/pages/assets/upload", bearer, {
          method: "POST",
          json: bucket.map((file) => ({
            key: file.hash,
            value: readFileSync(file.absPath).toString("base64"),
            metadata: { contentType: file.contentType },
            base64: true,
          })),
        }),
      );
    }

    // Only speeds up the next upload; a failure here does not fail the deployment (as in Wrangler).
    await withJwt((bearer) =>
      call<unknown>("/pages/assets/upsert-hashes", bearer, { method: "POST", json: { hashes: allHashes } }),
    ).catch(() => undefined);

    const form = new FormData();
    form.append("manifest", JSON.stringify(Object.fromEntries(files.map((f) => [`/${f.name}`, f.hash]))));
    form.append("branch", req.branch);
    form.append("commit_dirty", "true");
    for (const special of ["_headers", "_redirects"]) {
      const specialPath = path.join(req.dir, special);
      if (existsSync(specialPath)) {
        form.append(special, new Blob([readFileSync(specialPath)]), special);
      }
    }
    const deployment = await call<{ id?: string; url?: string }>(`${projectRoute}/deployments`, token, {
      method: "POST",
      form,
    });

    return {
      ok: true,
      ...(typeof deployment.url === "string" ? { deploymentUrl: deployment.url } : {}),
      durationMs: now() - started,
    };
  } catch (error) {
    if (abort.signal.aborted) {
      return { ok: false, kind: "TIMEOUT", error: "The upload to Cloudflare Pages took too long and was stopped." };
    }
    if (error instanceof DeployError) {
      return { ok: false, kind: error.kind, error: scrubSecrets(error.message, secrets) };
    }
    if (error instanceof CloudflareApiError) {
      const reason =
        error.status === 401 || error.status === 403
          ? "Cloudflare rejected the CDN token. It needs permission to edit Pages on this account."
          : error.status === 404
            ? "Cloudflare could not find that account or Pages project. Check the settings under Credentials."
            : `Cloudflare refused the upload: ${error.message}`;
      return { ok: false, kind: "DEPLOY_FAILED", error: scrubSecrets(reason, secrets) };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: "DEPLOY_FAILED",
      error: scrubSecrets(`Could not reach Cloudflare: ${message}`, secrets),
    };
  } finally {
    clearTimeout(timer);
  }
}
