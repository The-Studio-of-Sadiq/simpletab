import {
  GITHUB_ARCHIVE_IPC_CHANNEL,
  type GitHubArchiveRequest,
  type GitHubArchiveResult,
} from "../common/github-archive";
import { archiveToGitHub, type GitHubFetch } from "./github-archive";

/**
 * electron-main side of the GitHub archive bridge. The backend asks to archive a directory it has
 * already built; electron-main reads `githubToken` from the credentials vault, commits it to the
 * repository's `gh-pages` branch through GitHub's REST API, and replies with a scrubbed result.
 * Only one archive runs at a time.
 */

export interface GitHubArchiveIpcRequest {
  __simpletabIpc: typeof GITHUB_ARCHIVE_IPC_CHANNEL;
  kind: "request";
  id: string;
  req: GitHubArchiveRequest;
}

export interface GitHubArchiveIpcResponse {
  __simpletabIpc: typeof GITHUB_ARCHIVE_IPC_CHANNEL;
  kind: "response";
  id: string;
  result: GitHubArchiveResult;
}

export type GitHubArchiveIpcMessage = GitHubArchiveIpcRequest | GitHubArchiveIpcResponse;

/** Minimal transport shape shared with the backend client (a forked Node process). */
export interface GitHubArchiveIpcEndpoint {
  connected?: boolean;
  send?: (message: GitHubArchiveIpcMessage) => unknown;
  on(event: "message", listener: (message: unknown) => void): unknown;
  off?(event: "message", listener: (message: unknown) => void): unknown;
  removeListener?(event: "message", listener: (message: unknown) => void): unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isGitHubArchiveRequest(value: unknown): value is GitHubArchiveRequest {
  return (
    isPlainRecord(value) &&
    typeof value.dir === "string" &&
    typeof value.owner === "string" &&
    typeof value.repo === "string" &&
    typeof value.message === "string"
  );
}

const ARCHIVE_ERROR_KINDS: ReadonlySet<string> = new Set([
  "NO_TOKEN",
  "NOT_PUBLIC",
  "EMPTY_REPO",
  "CONFLICT",
  "ARCHIVE_FAILED",
  "TIMEOUT",
]);

export function isGitHubArchiveResult(value: unknown): value is GitHubArchiveResult {
  if (!isPlainRecord(value) || typeof value.ok !== "boolean") {
    return false;
  }
  if (value.ok) {
    return (
      typeof value.commitSha === "string" &&
      typeof value.unchanged === "boolean" &&
      typeof value.blobsUploaded === "number" &&
      typeof value.durationMs === "number" &&
      (value.pagesUrl === undefined || typeof value.pagesUrl === "string")
    );
  }
  return typeof value.error === "string" && ARCHIVE_ERROR_KINDS.has(String(value.kind));
}

export function isGitHubArchiveIpcRequest(value: unknown): value is GitHubArchiveIpcRequest {
  return (
    isPlainRecord(value) &&
    value.__simpletabIpc === GITHUB_ARCHIVE_IPC_CHANNEL &&
    value.kind === "request" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    isGitHubArchiveRequest(value.req)
  );
}

export function isGitHubArchiveIpcResponse(value: unknown): value is GitHubArchiveIpcResponse {
  return (
    isPlainRecord(value) &&
    value.__simpletabIpc === GITHUB_ARCHIVE_IPC_CHANNEL &&
    value.kind === "response" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    isGitHubArchiveResult(value.result)
  );
}

export interface GitHubArchiveIpcHandlerOptions {
  getToken(): Promise<string | undefined>;
  /** Electron's `net.fetch` in the app (system proxy settings); a fake in tests. */
  fetchImpl?: GitHubFetch;
  /** Test override of the GitHub API base URL. */
  apiBase?: string;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function reply(child: GitHubArchiveIpcEndpoint, message: GitHubArchiveIpcResponse): void {
  if (child.connected !== false) {
    child.send?.(message);
  }
}

/**
 * Attaches the GITHUB_ARCHIVE_IPC_CHANNEL listener to the forked backend child process.
 */
export function attachGitHubArchiveIpcHandler(
  child: GitHubArchiveIpcEndpoint,
  options: GitHubArchiveIpcHandlerOptions,
): () => void {
  let busy = false;

  const onMessage = (raw: unknown): void => {
    if (!isGitHubArchiveIpcRequest(raw)) {
      return;
    }
    const { id, req } = raw;

    if (busy) {
      reply(child, {
        __simpletabIpc: GITHUB_ARCHIVE_IPC_CHANNEL,
        kind: "response",
        id,
        result: {
          ok: false,
          kind: "ARCHIVE_FAILED",
          error: "An archive is already running.",
        },
      });
      return;
    }
    busy = true;

    void (async () => {
      let result: GitHubArchiveResult;
      try {
        result = await archiveToGitHub(req, {
          getToken: options.getToken,
          ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
          ...(options.apiBase !== undefined ? { apiBase: options.apiBase } : {}),
          ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.now !== undefined ? { now: options.now } : {}),
        });
      } catch (error) {
        result = {
          ok: false,
          kind: "ARCHIVE_FAILED",
          error: `Archive failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        };
      } finally {
        busy = false;
      }
      reply(child, {
        __simpletabIpc: GITHUB_ARCHIVE_IPC_CHANNEL,
        kind: "response",
        id,
        result,
      });
    })();
  };

  child.on("message", onMessage);
  return () => {
    if (typeof child.off === "function") {
      child.off("message", onMessage);
    } else if (typeof child.removeListener === "function") {
      child.removeListener("message", onMessage);
    }
  };
}
