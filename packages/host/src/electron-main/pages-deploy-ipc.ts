import {
  PAGES_DEPLOY_IPC_CHANNEL,
  type PagesDeployRequest,
  type PagesDeployResult,
} from "../common/pages-deploy";
import { deployToPages, type PagesFetch } from "./cloudflare-pages";

/**
 * electron-main side of the publish upload bridge. The backend asks for a directory it has already
 * built; electron-main reads the `cdnToken` from the credentials vault, uploads the directory through
 * Cloudflare's Pages API, and replies
 * with a scrubbed result. Only one deploy runs at a time (design section 10: publishes are batched).
 */

export interface PagesDeployIpcRequest {
  __simpletabIpc: typeof PAGES_DEPLOY_IPC_CHANNEL;
  kind: "request";
  id: string;
  req: PagesDeployRequest;
}

export interface PagesDeployIpcResponse {
  __simpletabIpc: typeof PAGES_DEPLOY_IPC_CHANNEL;
  kind: "response";
  id: string;
  result: PagesDeployResult;
}

export type PagesDeployIpcMessage = PagesDeployIpcRequest | PagesDeployIpcResponse;

/** Minimal transport shape shared with the backend client (a forked Node process). */
export interface PagesDeployIpcEndpoint {
  connected?: boolean;
  send?: (message: PagesDeployIpcMessage) => unknown;
  on(event: "message", listener: (message: unknown) => void): unknown;
  off?(event: "message", listener: (message: unknown) => void): unknown;
  removeListener?(event: "message", listener: (message: unknown) => void): unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isPagesDeployRequest(value: unknown): value is PagesDeployRequest {
  return (
    isPlainRecord(value) &&
    typeof value.dir === "string" &&
    typeof value.accountId === "string" &&
    typeof value.projectName === "string" &&
    typeof value.branch === "string"
  );
}

const DEPLOY_ERROR_KINDS: ReadonlySet<string> = new Set([
  "NO_TOKEN",
  "DEPLOY_FAILED",
  "TIMEOUT",
]);

export function isPagesDeployResult(value: unknown): value is PagesDeployResult {
  if (!isPlainRecord(value) || typeof value.ok !== "boolean") {
    return false;
  }
  if (value.ok) {
    return (
      typeof value.durationMs === "number" &&
      (value.deploymentUrl === undefined || typeof value.deploymentUrl === "string")
    );
  }
  return typeof value.error === "string" && DEPLOY_ERROR_KINDS.has(String(value.kind));
}

export function isPagesDeployIpcRequest(value: unknown): value is PagesDeployIpcRequest {
  return (
    isPlainRecord(value) &&
    value.__simpletabIpc === PAGES_DEPLOY_IPC_CHANNEL &&
    value.kind === "request" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    isPagesDeployRequest(value.req)
  );
}

export function isPagesDeployIpcResponse(value: unknown): value is PagesDeployIpcResponse {
  return (
    isPlainRecord(value) &&
    value.__simpletabIpc === PAGES_DEPLOY_IPC_CHANNEL &&
    value.kind === "response" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    isPagesDeployResult(value.result)
  );
}

export interface PagesDeployIpcHandlerOptions {
  getToken(): Promise<string | undefined>;
  /** Electron's `net.fetch` in the app (system proxy settings); a fake in tests. */
  fetchImpl?: PagesFetch;
  /** Test override of the Cloudflare API base URL. */
  apiBase?: string;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function reply(child: PagesDeployIpcEndpoint, message: PagesDeployIpcResponse): void {
  if (child.connected !== false) {
    child.send?.(message);
  }
}

/**
 * Attaches the PAGES_DEPLOY_IPC_CHANNEL listener to the forked backend child process.
 */
export function attachPagesDeployIpcHandler(
  child: PagesDeployIpcEndpoint,
  options: PagesDeployIpcHandlerOptions,
): () => void {
  let busy = false;

  const onMessage = (raw: unknown): void => {
    if (!isPagesDeployIpcRequest(raw)) {
      return;
    }
    const { id, req } = raw;

    if (busy) {
      reply(child, {
        __simpletabIpc: PAGES_DEPLOY_IPC_CHANNEL,
        kind: "response",
        id,
        result: {
          ok: false,
          kind: "DEPLOY_FAILED",
          error: "A publish is already running.",
        },
      });
      return;
    }
    busy = true;

    void (async () => {
      let result: PagesDeployResult;
      try {
        result = await deployToPages(req, {
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
          kind: "DEPLOY_FAILED",
          error: `Publish failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        };
      } finally {
        busy = false;
      }
      reply(child, {
        __simpletabIpc: PAGES_DEPLOY_IPC_CHANNEL,
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
