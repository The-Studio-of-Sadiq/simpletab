import { randomUUID } from "node:crypto";
import {
  PAGES_DEPLOY_IPC_CHANNEL,
  type PagesDeployRequest,
  type PagesDeployResult,
  type PagesDeployer,
} from "../../common/pages-deploy";
import {
  attachPagesDeployIpcHandler,
  isPagesDeployIpcResponse,
  type PagesDeployIpcEndpoint,
  type PagesDeployIpcHandlerOptions,
  type PagesDeployIpcRequest,
} from "../../electron-main/pages-deploy-ipc";
import { DEFAULT_DEPLOY_TIMEOUT_MS } from "../../electron-main/cloudflare-pages";

/**
 * Backend-side `PagesDeployer`: sends a deploy request over the forked-process IPC channel to
 * electron-main, which owns the Cloudflare token and runs Wrangler. Mirrors
 * `IpcCredentialsFetchClient` (request ids, per-request timers, dispose).
 */

/** Slightly above electron-main's Wrangler timeout so its own TIMEOUT result wins. */
const IPC_GRACE_MS = 15_000;

export interface IpcPagesDeployerOptions {
  endpoint?: PagesDeployIpcEndpoint;
  /** Overall client timeout; defaults to the Wrangler timeout plus a grace period. */
  defaultTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (result: PagesDeployResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

function failedResult(kind: "DEPLOY_FAILED" | "TIMEOUT", error: string): PagesDeployResult {
  return { ok: false, kind, error };
}

export class IpcPagesDeployer implements PagesDeployer {
  private readonly endpoint: PagesDeployIpcEndpoint;
  private readonly defaultTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly messageListener: (raw: unknown) => void;
  private disposed = false;

  constructor(options: IpcPagesDeployerOptions = {}) {
    this.endpoint = options.endpoint ?? (process as unknown as PagesDeployIpcEndpoint);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_DEPLOY_TIMEOUT_MS + IPC_GRACE_MS;
    this.messageListener = (raw: unknown) => {
      if (!isPagesDeployIpcResponse(raw)) {
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

  async deploy(req: PagesDeployRequest): Promise<PagesDeployResult> {
    if (this.disposed) {
      return failedResult("DEPLOY_FAILED", "Publish IPC client has been disposed.");
    }
    if (typeof this.endpoint.send !== "function" || this.endpoint.connected === false) {
      return failedResult(
        "DEPLOY_FAILED",
        "Electron main publish channel is unavailable in this process.",
      );
    }

    const id = randomUUID();
    const timeoutMs = this.defaultTimeoutMs;

    return new Promise<PagesDeployResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(
          failedResult(
            "TIMEOUT",
            `Publish request timed out after ${timeoutMs} ms waiting for electron-main.`,
          ),
        );
      }, timeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      this.pending.set(id, { resolve, timer });

      const message: PagesDeployIpcRequest = {
        __simpletabIpc: PAGES_DEPLOY_IPC_CHANNEL,
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
            "DEPLOY_FAILED",
            error instanceof Error
              ? `Failed to send publish request: ${error.message}`
              : "Failed to send publish request.",
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
        failedResult("DEPLOY_FAILED", "Publish IPC client disposed while request was pending."),
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

export interface TestPagesDeployIpcBridge {
  deployer: IpcPagesDeployer;
  sentRequests: PagesDeployIpcRequest[];
  receivedReplies: unknown[];
  dispose(): void;
}

class InMemoryIpcEndpoint implements PagesDeployIpcEndpoint {
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
 * In-memory Node test double wiring `IpcPagesDeployer` to the electron-main
 * `attachPagesDeployIpcHandler` via JSON-cloned async IPC messages.
 */
export function createTestPagesDeployIpcBridge(
  handlerOptions: PagesDeployIpcHandlerOptions,
  options: { defaultTimeoutMs?: number } = {},
): TestPagesDeployIpcBridge {
  const sentRequests: PagesDeployIpcRequest[] = [];
  const receivedReplies: unknown[] = [];

  const backendEndpoint = new InMemoryIpcEndpoint((message) => {
    sentRequests.push(message as PagesDeployIpcRequest);
  });
  const mainEndpoint = new InMemoryIpcEndpoint((message) => {
    receivedReplies.push(message);
  });
  backendEndpoint.connectPeer(mainEndpoint);
  mainEndpoint.connectPeer(backendEndpoint);

  const detach = attachPagesDeployIpcHandler(mainEndpoint, handlerOptions);

  const deployer = new IpcPagesDeployer({
    endpoint: backendEndpoint,
    ...(options.defaultTimeoutMs !== undefined
      ? { defaultTimeoutMs: options.defaultTimeoutMs }
      : {}),
  });

  return {
    deployer,
    sentRequests,
    receivedReplies,
    dispose(): void {
      deployer.dispose();
      detach();
    },
  };
}
