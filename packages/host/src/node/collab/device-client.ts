import https from "node:https";
import type { TLSSocket } from "node:tls";
import type { Role } from "@simpletab/core/permissions";
import { WebSocket, type RawData } from "ws";
import {
  COLLAB_FIRST_MESSAGE_TIMEOUT_MS,
  COLLAB_HEARTBEAT_MS,
  COLLAB_SCHEMA,
  PAIRING_APPROVAL_TIMEOUT_MS,
  type CertFingerprint,
  type HelloRefusalReason,
  type HostIdentity,
  type HostToDeviceMessage,
  type PairRefusalReason,
  type WelcomeMessage,
} from "../../common/collab-protocol";
import type { CollabJsonMessage, CollabTimers } from "./server";
import { certFingerprint, type CollabCertificate } from "./tls";
import { pairingWords } from "./words";

/**
 * Staff-device collaboration client over TLS WebSocket (`wss`) for pairing and authenticated
 * sessions (design section 4, amendment 7).
 */

const FINGERPRINT_HEX_RE = /^[0-9a-f]{64}$/;

const defaultTimers: CollabTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle),
};

export interface CollabPairOptions {
  url: string;
  certificate: CollabCertificate;
  code: string;
  deviceName: string;
  onWords(words: string[]): void;
  timeoutMs?: number;
  timers?: CollabTimers;
}

export type CollabPairResult =
  | {
      ok: true;
      deviceId: string;
      role: Role;
      host: HostIdentity;
      hostFingerprint: CertFingerprint;
    }
  | {
      ok: false;
      reason: PairRefusalReason | "HOST_UNREACHABLE" | "PROTOCOL";
    };

export interface CollabConnectOptions {
  url: string;
  certificate: CollabCertificate;
  deviceId: string;
  pinnedHostFingerprint: CertFingerprint;
  lastSeq: number;
  knownHost?: HostIdentity;
  timeoutMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  timers?: CollabTimers;
}

export type CollabConnectResult =
  | { ok: true; connection: CollabConnection }
  | {
      ok: false;
      reason: HelloRefusalReason | "HOST_CERT_MISMATCH" | "HOST_UNREACHABLE" | "PROTOCOL";
    };

function rawDataToString(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCollabMessage(data: RawData, isBinary: boolean): CollabJsonMessage | undefined {
  if (isBinary) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawDataToString(data));
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed) || parsed.schema !== COLLAB_SCHEMA || typeof parsed.kind !== "string") {
    return undefined;
  }
  return parsed as CollabJsonMessage;
}

function isRole(value: unknown): value is Role {
  if (!isPlainObject(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.name === "string" &&
    Array.isArray(value.permissions) &&
    value.permissions.every((p) => typeof p === "string")
  );
}

function isHostIdentity(value: unknown): value is HostIdentity {
  if (!isPlainObject(value)) {
    return false;
  }
  return (
    typeof value.hostNumber === "number" &&
    Number.isFinite(value.hostNumber) &&
    typeof value.hostId === "string" &&
    value.hostId.length > 0 &&
    typeof value.hostRank === "number" &&
    Number.isFinite(value.hostRank) &&
    typeof value.certFingerprint === "string" &&
    FINGERPRINT_HEX_RE.test(value.certFingerprint)
  );
}

function isPairRefusalReason(value: unknown): value is PairRefusalReason {
  return value === "BAD_CODE" || value === "LOCKED_OUT" || value === "REJECTED" || value === "TIMEOUT";
}

function isHelloRefusalReason(value: unknown): value is HelloRefusalReason {
  return value === "UNKNOWN_DEVICE" || value === "REMOVED" || value === "KEY_MISMATCH";
}

function readSocketPeerFingerprint(socket: unknown): CertFingerprint | undefined {
  const tlsSocket = socket as Partial<TLSSocket> | undefined;
  if (tlsSocket === undefined || typeof tlsSocket.getPeerCertificate !== "function") {
    return undefined;
  }
  const peer = tlsSocket.getPeerCertificate(true);
  if (!Buffer.isBuffer(peer.raw) || peer.raw.byteLength === 0) {
    return undefined;
  }
  try {
    return certFingerprint(peer.raw);
  } catch {
    return undefined;
  }
}

function readWsPeerFingerprint(ws: WebSocket): CertFingerprint | undefined {
  // Fallback when `upgrade` did not provide the socket directly.
  const internal = ws as unknown as { _socket?: TLSSocket };
  return readSocketPeerFingerprint(internal._socket);
}

function createCollabAgent(certificate: CollabCertificate): https.Agent {
  return new https.Agent({
    cert: certificate.certPem,
    key: certificate.keyPem,
    rejectUnauthorized: false,
    minVersion: "TLSv1.3",
    checkServerIdentity: () => undefined,
    keepAlive: false,
  });
}

function validateWssUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Host WebSocket address is not a valid URL.");
  }
  if (parsed.protocol !== "wss:") {
    throw new Error("Host collaboration address must use wss://.");
  }
}

export class CollabConnection {
  readonly welcome: WelcomeMessage;
  private readonly ws: WebSocket;
  private readonly agent: https.Agent;
  private readonly timers: CollabTimers;
  private readonly now: () => number;
  private readonly messageListeners = new Set<(message: CollabJsonMessage) => void>();
  private readonly closeListeners = new Set<(code: number, reason: string) => void>();
  private readonly pingInterval: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(opts: {
    welcome: WelcomeMessage;
    ws: WebSocket;
    agent: https.Agent;
    heartbeatMs: number;
    now: () => number;
    timers: CollabTimers;
  }) {
    this.welcome = opts.welcome;
    this.ws = opts.ws;
    this.agent = opts.agent;
    this.now = opts.now;
    this.timers = opts.timers;

    this.ws.on("message", (data, isBinary) => {
      const msg = parseCollabMessage(data, isBinary);
      if (msg === undefined) {
        this.close(4400, "Invalid message frame");
        return;
      }
      if (msg.kind === "pong") {
        return;
      }
      for (const listener of [...this.messageListeners]) {
        listener(msg);
      }
    });

    this.ws.on("error", () => {
      // `close` follows and notifies close listeners.
    });

    this.ws.on("close", (code, reasonBuf) => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.timers.clearInterval(this.pingInterval);
      this.agent.destroy();
      const reason = reasonBuf.toString("utf8");
      for (const listener of [...this.closeListeners]) {
        listener(code, reason);
      }
    });

    this.pingInterval = this.timers.setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.send({ schema: COLLAB_SCHEMA, kind: "ping", t: this.now() });
      }
    }, opts.heartbeatMs);
  }

  send(message: HostToDeviceMessage | CollabJsonMessage): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(message), (err) => {
      if (err != null) {
        this.ws.terminate();
      }
    });
  }

  onMessage(listener: (message: CollabJsonMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onClose(listener: (code: number, reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  close(code?: number, reason?: string): void {
    if (this.closed) {
      return;
    }
    this.timers.clearInterval(this.pingInterval);
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(code, reason);
    } else if (this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.terminate();
    }
  }
}

export class CollabClient {
  static async pair(opts: CollabPairOptions): Promise<CollabPairResult> {
    validateWssUrl(opts.url);

    const timers = opts.timers ?? defaultTimers;
    const timeoutMs = opts.timeoutMs ?? PAIRING_APPROVAL_TIMEOUT_MS + 30_000;
    const agent = createCollabAgent(opts.certificate);
    const ws = new WebSocket(opts.url, { agent, handshakeTimeout: timeoutMs });

    return new Promise<CollabPairResult>((resolve) => {
      let settled = false;
      let opened = false;
      let sawPending = false;
      let hostFingerprint: CertFingerprint | undefined;
      let expectedWords: string[] | undefined;

      const finish = (result: CollabPairResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        timers.clearTimeout(timer);
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000);
        } else if (ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        }
        agent.destroy();
        resolve(result);
      };

      const timer = timers.setTimeout(() => {
        finish({ ok: false, reason: opened ? "TIMEOUT" : "HOST_UNREACHABLE" });
      }, timeoutMs);

      ws.on("upgrade", (res) => {
        hostFingerprint = readSocketPeerFingerprint(res.socket);
      });

      ws.on("open", () => {
        if (settled) {
          return;
        }
        opened = true;
        hostFingerprint ??= readWsPeerFingerprint(ws);
        if (hostFingerprint === undefined) {
          finish({ ok: false, reason: "PROTOCOL" });
          return;
        }

        try {
          expectedWords = pairingWords(hostFingerprint, opts.certificate.fingerprint, opts.code);
        } catch {
          finish({ ok: false, reason: "PROTOCOL" });
          return;
        }

        opts.onWords([...expectedWords]);
        ws.send(
          JSON.stringify({
            schema: COLLAB_SCHEMA,
            kind: "pair_request",
            code: opts.code,
            deviceName: opts.deviceName,
          }),
          (err) => {
            if (err != null) {
              finish({ ok: false, reason: "HOST_UNREACHABLE" });
            }
          },
        );
      });

      ws.on("message", (data, isBinary) => {
        if (settled) {
          return;
        }
        const msg = parseCollabMessage(data, isBinary);
        if (msg === undefined) {
          finish({ ok: false, reason: "PROTOCOL" });
          return;
        }

        if (msg.kind === "pair_pending") {
          if (
            sawPending ||
            expectedWords === undefined ||
            !Array.isArray(msg.words) ||
            msg.words.length !== expectedWords.length ||
            !msg.words.every((w, i) => w === expectedWords![i])
          ) {
            finish({ ok: false, reason: "PROTOCOL" });
            return;
          }
          sawPending = true;
          return;
        }

        if (msg.kind === "pair_result") {
          if (msg.ok === false) {
            if (isPairRefusalReason(msg.reason)) {
              finish({ ok: false, reason: msg.reason });
            } else {
              finish({ ok: false, reason: "PROTOCOL" });
            }
            return;
          }
          if (
            msg.ok === true &&
            sawPending &&
            hostFingerprint !== undefined &&
            typeof msg.deviceId === "string" &&
            msg.deviceId.length > 0 &&
            isRole(msg.role) &&
            isHostIdentity(msg.host) &&
            msg.host.certFingerprint === hostFingerprint
          ) {
            finish({
              ok: true,
              deviceId: msg.deviceId,
              role: msg.role,
              host: msg.host,
              hostFingerprint,
            });
            return;
          }
          finish({ ok: false, reason: "PROTOCOL" });
          return;
        }

        if (msg.kind === "pong") {
          return;
        }

        finish({ ok: false, reason: "PROTOCOL" });
      });

      ws.on("error", () => {
        finish({ ok: false, reason: opened ? "PROTOCOL" : "HOST_UNREACHABLE" });
      });

      ws.on("close", () => {
        finish({ ok: false, reason: opened ? "PROTOCOL" : "HOST_UNREACHABLE" });
      });
    });
  }

  static async connect(opts: CollabConnectOptions): Promise<CollabConnectResult> {
    validateWssUrl(opts.url);
    if (!FINGERPRINT_HEX_RE.test(opts.pinnedHostFingerprint)) {
      throw new Error("Pinned host certificate fingerprint must be 64 lowercase hex characters.");
    }

    const timers = opts.timers ?? defaultTimers;
    const now = opts.now ?? Date.now;
    const timeoutMs = opts.timeoutMs ?? COLLAB_FIRST_MESSAGE_TIMEOUT_MS;
    const heartbeatMs = opts.heartbeatMs ?? COLLAB_HEARTBEAT_MS;
    const agent = createCollabAgent(opts.certificate);
    const ws = new WebSocket(opts.url, { agent, handshakeTimeout: timeoutMs });

    return new Promise<CollabConnectResult>((resolve) => {
      let settled = false;
      let opened = false;
      let hostFingerprint: CertFingerprint | undefined;

      const fail = (
        result: Exclude<CollabConnectResult, { ok: true }>,
        terminate = false,
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        timers.clearTimeout(timer);
        ws.off("message", onHandshakeMessage);
        ws.off("error", onHandshakeError);
        ws.off("close", onHandshakeClose);
        // Keep a no-op error listener because `ws.terminate()` during CONNECTING emits `error`.
        ws.on("error", () => {});
        if (terminate || ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        } else if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000);
        }
        agent.destroy();
        resolve(result);
      };

      const verifyPinnedHost = (): boolean => {
        if (hostFingerprint === undefined) {
          fail({ ok: false, reason: "PROTOCOL" }, true);
          return false;
        }
        if (hostFingerprint !== opts.pinnedHostFingerprint) {
          fail({ ok: false, reason: "HOST_CERT_MISMATCH" }, true);
          return false;
        }
        return true;
      };

      const timer = timers.setTimeout(() => {
        fail({ ok: false, reason: opened ? "PROTOCOL" : "HOST_UNREACHABLE" }, true);
      }, timeoutMs);

      ws.on("upgrade", (res) => {
        hostFingerprint = readSocketPeerFingerprint(res.socket);
        verifyPinnedHost();
      });

      ws.on("open", () => {
        if (settled) {
          return;
        }
        opened = true;
        hostFingerprint ??= readWsPeerFingerprint(ws);
        if (!verifyPinnedHost()) {
          return;
        }

        ws.send(
          JSON.stringify({
            schema: COLLAB_SCHEMA,
            kind: "hello",
            deviceId: opts.deviceId,
            lastSeq: opts.lastSeq,
            ...(opts.knownHost !== undefined ? { knownHost: opts.knownHost } : {}),
          }),
          (err) => {
            if (err != null) {
              fail({ ok: false, reason: "HOST_UNREACHABLE" }, true);
            }
          },
        );
      });

      const onHandshakeMessage = (data: RawData, isBinary: boolean): void => {
        if (settled) {
          return;
        }
        const msg = parseCollabMessage(data, isBinary);
        if (msg === undefined) {
          fail({ ok: false, reason: "PROTOCOL" }, true);
          return;
        }

        if (msg.kind === "refused") {
          if (isHelloRefusalReason(msg.reason)) {
            fail({ ok: false, reason: msg.reason });
          } else {
            fail({ ok: false, reason: "PROTOCOL" });
          }
          return;
        }

        if (msg.kind === "welcome") {
          if (
            msg.deviceId === opts.deviceId &&
            isRole(msg.role) &&
            isHostIdentity(msg.host) &&
            msg.host.certFingerprint === opts.pinnedHostFingerprint
          ) {
            settled = true;
            timers.clearTimeout(timer);
            ws.off("message", onHandshakeMessage);
            ws.off("error", onHandshakeError);
            ws.off("close", onHandshakeClose);

            const welcome: WelcomeMessage = {
              schema: COLLAB_SCHEMA,
              kind: "welcome",
              deviceId: msg.deviceId,
              role: msg.role,
              host: msg.host,
            };
            const connection = new CollabConnection({
              welcome,
              ws,
              agent,
              heartbeatMs,
              now,
              timers,
            });
            resolve({ ok: true, connection });
            return;
          }
          fail({ ok: false, reason: "PROTOCOL" }, true);
          return;
        }

        fail({ ok: false, reason: "PROTOCOL" }, true);
      };

      const onHandshakeError = (): void => {
        fail({ ok: false, reason: opened ? "PROTOCOL" : "HOST_UNREACHABLE" }, true);
      };

      const onHandshakeClose = (): void => {
        fail({ ok: false, reason: opened ? "PROTOCOL" : "HOST_UNREACHABLE" }, true);
      };

      ws.on("message", onHandshakeMessage);
      ws.on("error", onHandshakeError);
      ws.on("close", onHandshakeClose);
    });
  }
}
