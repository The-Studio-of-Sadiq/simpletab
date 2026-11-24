import { randomUUID } from "node:crypto";
import {
  GITHUB_ARCHIVE_IPC_CHANNEL,
  type GitHubArchiver,
  type GitHubArchiveRequest,
  type GitHubArchiveResult,
} from "../../common/github-archive";
import { DEFAULT_ARCHIVE_TIMEOUT_MS } from "../../electron-main/github-archive";
import {
  attachGitHubArchiveIpcHandler,
  isGitHubArchiveIpcResponse,
  type GitHubArchiveIpcEndpoint,
  type GitHubArchiveIpcHandlerOptions,
  type GitHubArchiveIpcRequest,
} from "../../electron-main/github-archive-ipc";

/**
 * Backend-side `GitHubArchiver`: sends an archive request over the forked-process IPC channel to
 * electron-main, which owns the GitHub token and commits to `gh-pages`. Mirrors
 * `IpcPagesDeployer` (request ids, per-request timers, dispose).
 */

/** Slightly above electron-main's archive timeout so its own TIMEOUT result wins. */
const IPC_GRACE_MS = 15_000;

export interface IpcGitHubArchiverOptions {
  endpoint?: GitHubArchiveIpcEndpoint;
  /** Overall client timeout; defaults to the archive timeout plus a grace period. */
  defaultTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (result: GitHubArchiveResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

function failedResult(kind: "ARCHIVE_FAILED" | "TIMEOUT", error: string): GitHubArchiveResult {
  return { ok: false, kind, error };
}

export class IpcGitHubArchiver implements GitHubArchiver {
  private readonly endpoint: GitHubArchiveIpcEndpoint;
  private readonly defaultTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly messageListener: (raw: unknown) => void;
  private disposed = false;

  constructor(options: IpcGitHubArchiverOptions = {}) {
    this.endpoint = options.endpoint ?? (process as unknown as GitHubArchiveIpcEndpoint);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_ARCHIVE_TIMEOUT_MS + IPC_GRACE_MS;
    this.messageListener = (raw: unknown) => {
      if (!isGitHubArchiveIpcResponse(raw)) {
        return;
      }
      const entry = this.pending.get(raw.id);
      if (entry === undefined) {
        return;
      }
      this.pending.delete(raw.id);
      clearTimeout(entry.timer);
      entry.resolve(raw.result);
    };
    this.endpoint.on("message", this.messageListener);
  }

  async archive(req: GitHubArchiveRequest): Promise<GitHubArchiveResult> {
    if (this.disposed) {
      return failedResult("ARCHIVE_FAILED", "GitHub archive IPC client has been disposed.");
    }
    if (typeof this.endpoint.send !== "function" || this.endpoint.connected === false) {
      return failedResult(
        "ARCHIVE_FAILED",
        "Electron main archive channel is unavailable in this process.",
      );
    }

    const id = randomUUID();
    const timeoutMs = this.defaultTimeoutMs;

    return new Promise<GitHubArchiveResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(
          failedResult(
            "TIMEOUT",
            `Archive request timed out after ${timeoutMs} ms waiting for electron-main.`,
          ),
        );
      }, timeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      this.pending.set(id, { resolve, timer });

      const message: GitHubArchiveIpcRequest = {
        __simpletabIpc: GITHUB_ARCHIVE_IPC_CHANNEL,
        kind: "request",
        id,
        req,
      };
      try {
        this.endpoint.send?.(message);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve(
          failedResult(
            "ARCHIVE_FAILED",
            error instanceof Error
              ? `Failed to send archive request: ${error.message}`
              : "Failed to send archive request.",
          ),
        );
      }
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      entry.resolve(
        failedResult("ARCHIVE_FAILED", "GitHub archive IPC client disposed while request was pending."),
      );
      this.pending.delete(id);
    }
    if (typeof this.endpoint.off === "function") {
      this.endpoint.off("message", this.messageListener);
    } else if (typeof this.endpoint.removeListener === "function") {
      this.endpoint.removeListener("message", this.messageListener);
    }
  }
}

export interface TestGitHubArchiveIpcBridge {
  archiver: IpcGitHubArchiver;
  sentRequests: GitHubArchiveIpcRequest[];
  receivedReplies: unknown[];
  dispose(): void;
}

class InMemoryIpcEndpoint implements GitHubArchiveIpcEndpoint {
  connected = true;
  private peer: InMemoryIpcEndpoint | null = null;
  private readonly listeners = new Set<(message: unknown) => void>();

  constructor(private readonly onSend?: (message: unknown) => void) {}

  connectPeer(peer: InMemoryIpcEndpoint): void {
    this.peer = peer;
  }

  send(message: unknown): boolean {
    this.onSend?.(message);
    const cloned = JSON.parse(JSON.stringify(message)) as unknown;
    const target = this.peer;
    if (target !== null) {
      queueMicrotask(() => {
        target.emitMessage(cloned);
      });
    }
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

  removeListener(_event: "message", listener: (message: unknown) => void): this {
    this.listeners.delete(listener);
    return this;
  }

  private emitMessage(message: unknown): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }
}

/**
 * In-memory Node test double wiring `IpcGitHubArchiver` to the electron-main
 * `attachGitHubArchiveIpcHandler` via JSON-cloned async IPC messages.
 */
export function createTestGitHubArchiveIpcBridge(
  handlerOptions: GitHubArchiveIpcHandlerOptions,
  options: { defaultTimeoutMs?: number } = {},
): TestGitHubArchiveIpcBridge {
  const sentRequests: GitHubArchiveIpcRequest[] = [];
  const receivedReplies: unknown[] = [];

  const backendEndpoint = new InMemoryIpcEndpoint((message) => {
    sentRequests.push(message as GitHubArchiveIpcRequest);
  });
  const mainEndpoint = new InMemoryIpcEndpoint((message) => {
    receivedReplies.push(message);
  });
  backendEndpoint.connectPeer(mainEndpoint);
  mainEndpoint.connectPeer(backendEndpoint);

  const detach = attachGitHubArchiveIpcHandler(mainEndpoint, handlerOptions);

  const archiver = new IpcGitHubArchiver({
    endpoint: backendEndpoint,
    ...(options.defaultTimeoutMs !== undefined
      ? { defaultTimeoutMs: options.defaultTimeoutMs }
      : {}),
  });

  return {
    archiver,
    sentRequests,
    receivedReplies,
    dispose(): void {
      archiver.dispose();
      detach();
    },
  };
}
