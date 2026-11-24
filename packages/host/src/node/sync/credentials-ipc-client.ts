import { randomUUID } from "node:crypto";
import {
  CREDENTIALS_IPC_CHANNEL,
  isCredentialsFetchIpcReply,
  type CredentialsFetchIpcRequest,
  type IpcMessageEndpoint,
} from "../../common/credentials-ipc";
import {
  CredentialsFetchError,
  type CredentialsFetchClient,
  type CredentialsFetchErrorCode,
  type CredentialsFetchName,
  type CredentialsFetchRequest,
  type CredentialsFetchResponse,
} from "../../common/credentials-protocol";
import type { CredentialsVault } from "../../electron-main/credentials-store";

export interface IpcCredentialsFetchClientOptions {
  endpoint?: IpcMessageEndpoint;
  defaultTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (response: CredentialsFetchResponse) => void;
  reject: (error: CredentialsFetchError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const IPC_GRACE_MS = 2_000;

function sanitizeHeadersForIpc(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) {
    return undefined;
  }
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization") {
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

/**
 * Backend-side client that delegates authenticated service requests to `electron-main` over the
 * Node fork IPC channel so secret keys never leave `electron-main`.
 */
export class IpcCredentialsFetchClient implements CredentialsFetchClient {
  private readonly endpoint: IpcMessageEndpoint;
  private readonly defaultTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly messageListener: (raw: unknown) => void;
  private disposed = false;

  constructor(options: IpcCredentialsFetchClientOptions = {}) {
    this.endpoint = options.endpoint ?? (process as unknown as IpcMessageEndpoint);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.messageListener = (raw: unknown) => {
      if (!isCredentialsFetchIpcReply(raw)) {
        return;
      }
      const entry = this.pending.get(raw.id);
      if (entry === undefined) {
        return;
      }
      this.pending.delete(raw.id);
      clearTimeout(entry.timer);
      if (raw.ok) {
        entry.resolve(raw.response);
      } else {
        entry.reject(new CredentialsFetchError(raw.code, raw.message));
      }
    };
    this.endpoint.on("message", this.messageListener);
  }

  async fetch(
    name: CredentialsFetchName,
    req: CredentialsFetchRequest,
  ): Promise<CredentialsFetchResponse> {
    if (this.disposed) {
      throw new CredentialsFetchError(
        "IPC_UNAVAILABLE",
        "Credentials IPC client has been disposed.",
      );
    }
    if (typeof this.endpoint.send !== "function" || this.endpoint.connected === false) {
      throw new CredentialsFetchError(
        "IPC_UNAVAILABLE",
        "Electron main IPC channel is unavailable in this process.",
      );
    }

    const id = randomUUID();
    const cleanHeaders = sanitizeHeadersForIpc(req.headers);
    const sanitizedReq: CredentialsFetchRequest = {
      ...req,
      ...(cleanHeaders !== undefined ? { headers: cleanHeaders } : {}),
    };
    const timeoutMs = (req.timeoutMs ?? this.defaultTimeoutMs) + IPC_GRACE_MS;

    return new Promise<CredentialsFetchResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CredentialsFetchError(
            "IPC_TIMEOUT",
            `Credentials IPC request timed out after ${timeoutMs} ms.`,
          ),
        );
      }, timeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      this.pending.set(id, { resolve, reject, timer });

      const message: CredentialsFetchIpcRequest = {
        __simpletabIpc: CREDENTIALS_IPC_CHANNEL,
        kind: "request",
        id,
        name,
        req: sanitizedReq,
      };
      try {
        this.endpoint.send!(message);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          new CredentialsFetchError(
            "IPC_UNAVAILABLE",
            error instanceof Error ? error.message : "Failed to send IPC message.",
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
      entry.reject(
        new CredentialsFetchError(
          "IPC_UNAVAILABLE",
          "Credentials IPC client disposed while request was pending.",
        ),
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

export interface TestCredentialsIpcBridge {
  client: IpcCredentialsFetchClient;
  sentRequests: CredentialsFetchIpcRequest[];
  receivedReplies: unknown[];
  dispose(): void;
}

class InMemoryIpcEndpoint implements IpcMessageEndpoint {
  connected = true;
  private peer: InMemoryIpcEndpoint | null = null;
  private readonly listeners = new Set<(message: unknown) => void>();

  constructor(private readonly onSend?: (msg: unknown) => void) {}

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
 * In-memory Node test double wiring `IpcCredentialsFetchClient` to an electron-main
 * `CredentialsFetchClient` (or `CredentialsVault`) via JSON-cloned async IPC messages.
 */
export function createTestCredentialsIpcBridge(
  mainCredentials: Pick<CredentialsVault, "fetch"> | CredentialsFetchClient,
  options: { defaultTimeoutMs?: number } = {},
): TestCredentialsIpcBridge {
  const sentRequests: CredentialsFetchIpcRequest[] = [];
  const receivedReplies: unknown[] = [];

  const backendEndpoint = new InMemoryIpcEndpoint((msg) => {
    sentRequests.push(msg as CredentialsFetchIpcRequest);
  });
  const mainEndpoint = new InMemoryIpcEndpoint((msg) => {
    receivedReplies.push(msg);
  });
  backendEndpoint.connectPeer(mainEndpoint);
  mainEndpoint.connectPeer(backendEndpoint);

  const mainListener = (raw: unknown): void => {
    const req = raw as CredentialsFetchIpcRequest;
    if (
      req === null ||
      typeof req !== "object" ||
      req.__simpletabIpc !== CREDENTIALS_IPC_CHANNEL ||
      req.kind !== "request"
    ) {
      return;
    }
    void mainCredentials.fetch(req.name, req.req).then(
      (response) => {
        mainEndpoint.send({
          __simpletabIpc: CREDENTIALS_IPC_CHANNEL,
          kind: "response",
          id: req.id,
          ok: true,
          response,
        });
      },
      (error: unknown) => {
        const code: CredentialsFetchErrorCode =
          error instanceof CredentialsFetchError ? error.code : "NETWORK_ERROR";
        const message =
          error instanceof Error ? error.message : "Credentials fetch failed.";
        mainEndpoint.send({
          __simpletabIpc: CREDENTIALS_IPC_CHANNEL,
          kind: "response",
          id: req.id,
          ok: false,
          code,
          message,
        });
      },
    );
  };
  mainEndpoint.on("message", mainListener);

  const client = new IpcCredentialsFetchClient({
    endpoint: backendEndpoint,
    ...(options.defaultTimeoutMs !== undefined
      ? { defaultTimeoutMs: options.defaultTimeoutMs }
      : {}),
  });

  return {
    client,
    sentRequests,
    receivedReplies,
    dispose(): void {
      client.dispose();
      mainEndpoint.off("message", mainListener);
    },
  };
}
