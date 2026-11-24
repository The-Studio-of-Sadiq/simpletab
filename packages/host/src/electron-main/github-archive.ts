import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  GITHUB_ARCHIVE_BRANCH,
  type GitHubArchiveErrorKind,
  type GitHubArchiveRequest,
  type GitHubArchiveResult,
} from "../common/github-archive";

/**
 * Commits a built archive directory to the `gh-pages` branch of a public GitHub repository
 * using GitHub's REST Git Data API (`fetch` only, no `git` binary or Octokit) and ensures
 * GitHub Pages is enabled (design section 10.1).
 *
 * Runs only in electron-main. The GitHub token never appears in errors (scrubbed).
 */

export const GITHUB_API_BASE = "https://api.github.com";
export const DEFAULT_ARCHIVE_TIMEOUT_MS = 10 * 60 * 1000;

/** GitHub REST Git Data API blob size limit (100 MiB). */
export const MAX_BLOB_BYTES = 100 * 1024 * 1024;

const MAX_RETRIES = 4;
const MAX_RETRY_AFTER_MS = 60_000;
const BLOB_UPLOAD_CONCURRENCY = 4;

const OWNER_OR_REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_TOKEN_RE = /(?:github_pat|ghp|gho|ghs)_[A-Za-z0-9_]+/g;
const BEARER_RE = /Bearer\s+\S+/gi;

const TIMEOUT_MESSAGE = "Archiving to GitHub took too long and was stopped. Try again.";

export type GitHubFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ArchiveToGitHubOptions {
  /** Reads the `githubToken` credential; never logged. */
  getToken(): Promise<string | undefined>;
  fetchImpl?: GitHubFetch;
  apiBase?: string;
  timeoutMs?: number;
  now?: () => number;
  /** Waits between retries; tests pass a no-op or fake clock advancer. */
  sleep?: (ms: number) => Promise<void>;
}

interface LocalArchiveFile {
  /** Path relative to the archive root, forward slashes, no leading slash. */
  path: string;
  absPath: string;
  sha: string;
}

class ArchiveError extends Error {
  constructor(
    readonly kind: GitHubArchiveErrorKind,
    message: string,
  ) {
    super(message);
  }
}

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly githubMessage: string | undefined,
    readonly retryAfterMs: number | undefined,
    readonly rateLimitRemainingZero: boolean,
  ) {
    super(githubMessage ?? `GitHub answered ${status}.`);
  }
}

/** Computes Git's blob SHA-1 digest (`"blob " + byteLength + "\0" + bytes`). */
export function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

/** Removes the given secrets and GitHub/Bearer token substrings from text that may reach the UI. */
export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  let scrubbed = text;
  for (const secret of secrets) {
    if (secret.length > 0) {
      scrubbed = scrubbed.split(secret).join("[redacted]");
    }
  }
  return scrubbed.replace(BEARER_RE, "[redacted]").replace(GITHUB_TOKEN_RE, "[redacted]");
}

function validateName(value: string, label: "owner" | "repository"): void {
  if (!OWNER_OR_REPO_RE.test(value) || value === "." || value === "..") {
    throw new ArchiveError("ARCHIVE_FAILED", `The GitHub ${label} name is not valid.`);
  }
}

function validateRequest(req: GitHubArchiveRequest): void {
  validateName(req.owner, "owner");
  validateName(req.repo, "repository");
  if (!path.isAbsolute(req.dir) || !existsSync(req.dir) || !lstatSync(req.dir).isDirectory()) {
    throw new ArchiveError("ARCHIVE_FAILED", "The built archive folder is missing.");
  }
}

function collectArchiveFiles(rootDir: string): LocalArchiveFile[] {
  const files: LocalArchiveFile[] = [];

  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") {
        continue;
      }
      const relPath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absPath = path.join(dir, entry.name);
      const stat = lstatSync(absPath);
      if (stat.isSymbolicLink()) {
        continue;
      }
      if (stat.isDirectory()) {
        walk(absPath, relPath);
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }
      // Case-insensitive: on Windows a "Rounds/" folder is the same folder as "rounds/".
      const lowerRelPath = relPath.toLowerCase();
      if (lowerRelPath.startsWith("rounds/") || lowerRelPath.startsWith("forms/")) {
        throw new ArchiveError(
          "ARCHIVE_FAILED",
          `Refusing to archive private file "${relPath}": rounds/ and forms/ must never be uploaded.`,
        );
      }
      if (stat.size > MAX_BLOB_BYTES) {
        throw new ArchiveError(
          "ARCHIVE_FAILED",
          `${relPath} is larger than GitHub allows (100 MiB per file).`,
        );
      }
      const bytes = readFileSync(absPath);
      if (bytes.byteLength > MAX_BLOB_BYTES) {
        throw new ArchiveError(
          "ARCHIVE_FAILED",
          `${relPath} is larger than GitHub allows (100 MiB per file).`,
        );
      }
      files.push({
        path: relPath,
        absPath,
        sha: gitBlobSha(bytes),
      });
    }
  };

  walk(rootDir, "");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  if (!files.some((f) => f.path === "manifest.json")) {
    throw new ArchiveError(
      "ARCHIVE_FAILED",
      "The archive folder is missing manifest.json at the root.",
    );
  }
  return files;
}

function parseRetryAfterMs(headerValue: string | null, nowMs: number): number | undefined {
  if (headerValue === null) {
    return undefined;
  }
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, Math.ceil(seconds * 1000)));
  }
  const targetMs = Date.parse(trimmed);
  if (Number.isFinite(targetMs)) {
    return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, targetMs - nowMs));
  }
  return undefined;
}

function isRetryableApiError(error: GitHubApiError): boolean {
  if (error.status >= 500 || error.status === 429) {
    return true;
  }
  if (error.status === 403 && (error.rateLimitRemainingZero || error.retryAfterMs !== undefined)) {
    return true;
  }
  return false;
}

function appendGitHubMessage(base: string, githubMessage: string | undefined): string {
  if (githubMessage === undefined || githubMessage.trim().length === 0) {
    return base;
  }
  return `${base} (${githubMessage.trim()})`;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

export async function archiveToGitHub(
  req: GitHubArchiveRequest,
  options: ArchiveToGitHubOptions,
): Promise<GitHubArchiveResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const fetchImpl: GitHubFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const apiBase = (options.apiBase ?? GITHUB_API_BASE).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_ARCHIVE_TIMEOUT_MS;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const secrets: string[] = [];

  const defaultSleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (abort.signal.aborted || ms <= 0) {
        resolve();
        return;
      }
      const onAbort = (): void => {
        clearTimeout(sleepTimer);
        resolve();
      };
      const sleepTimer = setTimeout(() => {
        abort.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      abort.signal.addEventListener("abort", onAbort, { once: true });
    });
  const sleep = options.sleep ?? defaultSleep;

  const isTimedOut = (): boolean => abort.signal.aborted || now() - started >= timeoutMs;

  const checkDeadline = (): void => {
    if (isTimedOut()) {
      throw new ArchiveError("TIMEOUT", TIMEOUT_MESSAGE);
    }
  };

  try {
    // 1. Token
    const token = (await options.getToken())?.trim();
    if (token === undefined || token.length === 0) {
      throw new ArchiveError("NO_TOKEN", "Add a GitHub token in Credentials first.");
    }
    secrets.push(token);

    // 2. Validate owner, repo, and directory
    validateRequest(req);

    // 3. Collect and validate local archive files before making API calls
    const files = collectArchiveFiles(req.dir);

    const ownerSeg = encodeURIComponent(req.owner);
    const repoSeg = encodeURIComponent(req.repo);
    const repoPath = `/repos/${ownerSeg}/${repoSeg}`;
    const branchSeg = encodeURIComponent(GITHUB_ARCHIVE_BRANCH);

    const requestJson = async <T>(
      method: "GET" | "POST" | "PATCH",
      route: string,
      jsonBody?: unknown,
    ): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        checkDeadline();
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "SimpleTab",
        };
        let body: string | undefined;
        if (jsonBody !== undefined) {
          headers["Content-Type"] = "application/json";
          body = JSON.stringify(jsonBody);
        }

        let apiError: GitHubApiError | undefined;
        let networkError: unknown;
        try {
          const response = await fetchImpl(`${apiBase}${route}`, {
            method,
            headers,
            ...(body !== undefined ? { body } : {}),
            signal: abort.signal,
          });
          if (response.ok) {
            if (response.status === 204) {
              return undefined as T;
            }
            return (await response.json()) as T;
          }

          let githubMessage: string | undefined;
          try {
            const parsed = (await response.json()) as { message?: unknown };
            if (typeof parsed.message === "string") {
              githubMessage = parsed.message;
            }
          } catch {
            // Non-JSON error bodies fall back to HTTP status.
          }
          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), now());
          const rateLimitRemainingZero =
            response.headers.get("x-ratelimit-remaining")?.trim() === "0";
          apiError = new GitHubApiError(
            response.status,
            githubMessage,
            retryAfterMs,
            rateLimitRemainingZero,
          );
        } catch (error) {
          if (isTimedOut()) {
            throw new ArchiveError("TIMEOUT", TIMEOUT_MESSAGE);
          }
          networkError = error;
        }

        checkDeadline();

        const shouldRetry =
          attempt < MAX_RETRIES &&
          (networkError !== undefined || (apiError !== undefined && isRetryableApiError(apiError)));
        if (!shouldRetry) {
          if (apiError !== undefined) {
            throw apiError;
          }
          throw networkError;
        }

        const backoffMs = apiError?.retryAfterMs ?? 1000 * 2 ** attempt;
        await sleep(backoffMs);
        checkDeadline();
      }
    };

    const requestGitData = async <T>(
      method: "GET" | "POST" | "PATCH",
      gitRoute: string,
      jsonBody?: unknown,
    ): Promise<T> => {
      try {
        return await requestJson<T>(method, `${repoPath}${gitRoute}`, jsonBody);
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 409) {
          throw new ArchiveError(
            "EMPTY_REPO",
            `The repository ${req.owner}/${req.repo} is empty. Create it on GitHub with "Add a README file" ticked, then archive again.`,
          );
        }
        throw error;
      }
    };

    // 4. Verify repository exists, is public, and is writable
    interface RepoResponse {
      private?: boolean;
      permissions?: { push?: boolean };
    }
    let repoInfo: RepoResponse;
    try {
      repoInfo = await requestJson<RepoResponse>("GET", repoPath);
    } catch (error) {
      if (error instanceof GitHubApiError) {
        if (error.status === 401) {
          throw new ArchiveError(
            "ARCHIVE_FAILED",
            appendGitHubMessage("GitHub rejected the token.", error.githubMessage),
          );
        }
        if (error.status === 403 || error.status === 404) {
          throw new ArchiveError(
            "ARCHIVE_FAILED",
            appendGitHubMessage(
              `The repository ${req.owner}/${req.repo} was not found, or the token cannot read it. The token needs access to this repository with Contents and Pages read and write.`,
              error.githubMessage,
            ),
          );
        }
      }
      throw error;
    }

    if (repoInfo.private === true) {
      throw new ArchiveError(
        "NOT_PUBLIC",
        "The archive repository must be public: GitHub Pages is free only for public repositories.",
      );
    }
    if (repoInfo.permissions !== undefined && repoInfo.permissions.push === false) {
      throw new ArchiveError(
        "ARCHIVE_FAILED",
        `The token cannot write to ${req.owner}/${req.repo}.`,
      );
    }

    // 5. Inspect existing gh-pages ref and tree (if branch exists)
    let parentSha: string | undefined;
    let parentTreeSha: string | undefined;
    const existingBlobs = new Map<string, string>();

    try {
      const refData = await requestGitData<{ object?: { sha?: string } }>(
        "GET",
        `/git/ref/heads/${branchSeg}`,
      );
      if (typeof refData.object?.sha === "string") {
        parentSha = refData.object.sha;
      }
    } catch (error) {
      if (!(error instanceof GitHubApiError && error.status === 404)) {
        throw error;
      }
    }

    if (parentSha !== undefined) {
      const commitData = await requestGitData<{ tree?: { sha?: string } }>(
        "GET",
        `/git/commits/${encodeURIComponent(parentSha)}`,
      );
      if (typeof commitData.tree?.sha === "string") {
        parentTreeSha = commitData.tree.sha;
        const treeData = await requestGitData<{
          truncated?: boolean;
          tree?: Array<{ path?: string; type?: string; sha?: string }>;
        }>("GET", `/git/trees/${encodeURIComponent(parentTreeSha)}?recursive=1`);
        if (treeData.truncated !== true && Array.isArray(treeData.tree)) {
          for (const entry of treeData.tree) {
            if (
              entry.type === "blob" &&
              typeof entry.path === "string" &&
              typeof entry.sha === "string"
            ) {
              existingBlobs.set(entry.path, entry.sha);
            }
          }
        }
      }
    }

    // 6. Upload missing/changed blobs with concurrency 4
    const filesToUpload = files.filter((file) => existingBlobs.get(file.path) !== file.sha);
    let blobsUploaded = 0;
    let nextUploadIndex = 0;

    const uploadWorker = async (): Promise<void> => {
      while (nextUploadIndex < filesToUpload.length) {
        const file = filesToUpload[nextUploadIndex++];
        if (file === undefined) {
          return;
        }
        const content = readFileSync(file.absPath).toString("base64");
        const created = await requestGitData<{ sha?: string }>("POST", "/git/blobs", {
          content,
          encoding: "base64",
        });
        if (created.sha !== file.sha) {
          throw new ArchiveError(
            "ARCHIVE_FAILED",
            `GitHub returned an unexpected blob SHA for ${file.path}.`,
          );
        }
        blobsUploaded++;
      }
    };

    const workerCount = Math.min(BLOB_UPLOAD_CONCURRENCY, filesToUpload.length);
    if (workerCount > 0) {
      await Promise.all(Array.from({ length: workerCount }, () => uploadWorker()));
    }

    // 7. Create full tree (no base_tree so deleted local files disappear)
    const createdTree = await requestGitData<{ sha?: string }>("POST", "/git/trees", {
      tree: files.map((file) => ({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: file.sha,
      })),
    });
    if (typeof createdTree.sha !== "string" || createdTree.sha.length === 0) {
      throw new ArchiveError("ARCHIVE_FAILED", "GitHub did not return a tree SHA.");
    }
    const newTreeSha = createdTree.sha;

    const resolvePagesUrl = async (): Promise<string | undefined> => {
      try {
        interface PagesResponse {
          html_url?: string;
        }
        let pages: PagesResponse | undefined;
        try {
          pages = await requestJson<PagesResponse>("GET", `${repoPath}/pages`);
        } catch (error) {
          if (!(error instanceof GitHubApiError && error.status === 404)) {
            return undefined;
          }
          try {
            pages = await requestJson<PagesResponse>("POST", `${repoPath}/pages`, {
              source: { branch: GITHUB_ARCHIVE_BRANCH, path: "/" },
            });
          } catch (postError) {
            if (postError instanceof GitHubApiError && postError.status === 409) {
              pages = await requestJson<PagesResponse>("GET", `${repoPath}/pages`);
            } else {
              return undefined;
            }
          }
        }
        if (typeof pages?.html_url === "string" && pages.html_url.trim().length > 0) {
          return ensureTrailingSlash(pages.html_url.trim());
        }
        return undefined;
      } catch {
        // Pages issues must never turn a landed commit into a failure.
        return undefined;
      }
    };

    if (parentSha !== undefined && parentTreeSha !== undefined && newTreeSha === parentTreeSha) {
      const pagesUrl = await resolvePagesUrl();
      return {
        ok: true,
        commitSha: parentSha,
        unchanged: true,
        blobsUploaded,
        ...(pagesUrl !== undefined ? { pagesUrl } : {}),
        durationMs: Math.max(0, now() - started),
      };
    }

    // 8. Create commit and advance/create gh-pages ref (never force)
    const createdCommit = await requestGitData<{ sha?: string }>("POST", "/git/commits", {
      message: req.message,
      tree: newTreeSha,
      parents: parentSha !== undefined ? [parentSha] : [],
    });
    if (typeof createdCommit.sha !== "string" || createdCommit.sha.length === 0) {
      throw new ArchiveError("ARCHIVE_FAILED", "GitHub did not return a commit SHA.");
    }
    const newCommitSha = createdCommit.sha;

    try {
      if (parentSha !== undefined) {
        await requestGitData<unknown>("PATCH", `/git/refs/heads/${branchSeg}`, {
          sha: newCommitSha,
          force: false,
        });
      } else {
        await requestGitData<unknown>("POST", "/git/refs", {
          ref: `refs/heads/${GITHUB_ARCHIVE_BRANCH}`,
          sha: newCommitSha,
        });
      }
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 422) {
        throw new ArchiveError(
          "CONFLICT",
          "The gh-pages branch changed on GitHub while archiving. Archive again.",
        );
      }
      throw error;
    }

    // 9. Best-effort GitHub Pages configuration
    const pagesUrl = await resolvePagesUrl();

    return {
      ok: true,
      commitSha: newCommitSha,
      unchanged: false,
      blobsUploaded,
      ...(pagesUrl !== undefined ? { pagesUrl } : {}),
      durationMs: Math.max(0, now() - started),
    };
  } catch (error) {
    if (isTimedOut()) {
      return { ok: false, kind: "TIMEOUT", error: TIMEOUT_MESSAGE };
    }
    if (error instanceof ArchiveError) {
      return { ok: false, kind: error.kind, error: scrubSecrets(error.message, secrets) };
    }
    if (error instanceof GitHubApiError) {
      return {
        ok: false,
        kind: "ARCHIVE_FAILED",
        error: scrubSecrets(
          `GitHub refused the archive (${error.status}): ${error.message}`,
          secrets,
        ),
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: "ARCHIVE_FAILED",
      error: scrubSecrets(`Could not reach GitHub: ${message}`, secrets),
    };
  } finally {
    clearTimeout(timer);
  }
}
