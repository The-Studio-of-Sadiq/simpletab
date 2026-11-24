import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import type { Role } from "@simpletab/core/permissions";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  COLLAB_CLOSE,
  COLLAB_FIRST_MESSAGE_TIMEOUT_MS,
  COLLAB_HEARTBEAT_MS,
  COLLAB_SCHEMA,
  PAIRING_APPROVAL_TIMEOUT_MS,
  type CertFingerprint,
  type ConnectedDeviceInfo,
  type HostIdentity,
  type HostToDeviceMessage,
  type PairRefusalReason,
  type PendingJoin,
} from "../../common/collab-protocol";
import type { PairingCodes } from "./pairing-codes";
import { certFingerprint, type CollabCertificate } from "./tls";
import { pairingWords } from "./words";

/**
 * Host-side TLS WebSocket collaboration server for pairing and authenticated staff device
 * sessions (design section 4, amendment 7).
 */

const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_DEVICE_NAME_LENGTH = 60;
const PAIRING_CODE_RE = /^\d{8}$/;

export interface CollabTimers {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

const defaultTimers: CollabTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle),
};

export interface CollabJsonMessage {
  schema: 1;
  kind: string;
  [key: string]: unknown;
}

export interface DeviceRegistry {
  approve(input: {
    deviceName: string;
    roleId: string;
    fingerprint: CertFingerprint;
  }): Promise<{ deviceId: string; role: Role }>;
  lookup(deviceId: string):
    | {
        fingerprint: CertFingerprint;
        role: Role;
        removed: boolean;
        name?: string;
      }
    | undefined;
}

export interface DeviceSession {
  deviceId: string;
  role: Role;
  fingerprint: CertFingerprint;
  remoteAddress?: string;
  send(message: HostToDeviceMessage | CollabJsonMessage): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (message: CollabJsonMessage) => void): () => void;
  onClose(listener: () => void): () => void;
}

export interface CollabServerDeps {
  certificate: CollabCertificate;
  codes: PairingCodes;
  registry: DeviceRegistry;
  getHostIdentity(): HostIdentity;
  onPendingJoin?(join: PendingJoin): void;
  onJoinResolved?(joinId: string): void;
  onDeviceConnected?(session: DeviceSession): void;
  onDeviceDisconnected?(deviceId: string): void;
  now?: () => number;
  timers?: CollabTimers;
  firstMessageTimeoutMs?: number;
  approvalTimeoutMs?: number;
  heartbeatMs?: number;
}

interface PendingJoinEntry {
  join: PendingJoin;
  ws: WebSocket;
  remoteAddress?: string;
  timer: ReturnType<typeof setTimeout>;
  resolving: boolean;
  closed: boolean;
}

interface ActiveSessionEntry {
  session: DeviceSession;
  info: ConnectedDeviceInfo;
  ws: WebSocket;
  listeners: Set<(message: CollabJsonMessage) => void>;
  closeListeners: Set<() => void>;
  lastActivityMs: number;
  disconnectedNotified: boolean;
}

type ConnectionStage = "awaiting_first" | "pending_join" | "session" | "closed";

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

function parseCollabFrame(data: RawData, isBinary: boolean): CollabJsonMessage | undefined {
  if (isBinary) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawDataToString(data));
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) {
    return undefined;
  }
  if (parsed.schema !== COLLAB_SCHEMA || typeof parsed.kind !== "string") {
    return undefined;
  }
  return parsed as CollabJsonMessage;
}

function validateDeviceName(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DEVICE_NAME_LENGTH) {
    return undefined;
  }
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return undefined;
    }
  }
  return trimmed;
}

function isValidKnownHost(value: unknown): boolean {
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
    value.certFingerprint.length > 0
  );
}

function readPeerCertFingerprint(req: IncomingMessage): CertFingerprint | undefined {
  const socket = req.socket as TLSSocket;
  if (typeof socket.getPeerCertificate !== "function") {
    return undefined;
  }
  const peer = socket.getPeerCertificate(true);
  if (!Buffer.isBuffer(peer.raw) || peer.raw.byteLength === 0) {
    return undefined;
  }
  try {
    return certFingerprint(peer.raw);
  } catch {
    return undefined;
  }
}

export class CollabServer {
  private readonly deps: CollabServerDeps;
  private readonly now: () => number;
  private readonly timers: CollabTimers;
  private readonly firstMessageTimeoutMs: number;
  private readonly approvalTimeoutMs: number;
  private readonly heartbeatMs: number;

  private httpsServer: https.Server | null = null;
  private wss: WebSocketServer | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closing = false;

  private readonly pending = new Map<string, PendingJoinEntry>();
  private readonly sessions = new Map<string, ActiveSessionEntry>();
  /** Lets `promoteToSession` move a connection's local state machine into the session stage. */
  private readonly sessionAttachers = new WeakMap<WebSocket, (entry: ActiveSessionEntry) => void>();

  constructor(deps: CollabServerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? defaultTimers;
    this.firstMessageTimeoutMs = deps.firstMessageTimeoutMs ?? COLLAB_FIRST_MESSAGE_TIMEOUT_MS;
    this.approvalTimeoutMs = deps.approvalTimeoutMs ?? PAIRING_APPROVAL_TIMEOUT_MS;
    this.heartbeatMs = deps.heartbeatMs ?? COLLAB_HEARTBEAT_MS;
  }

  async listen(port: number, host?: string): Promise<{ port: number }> {
    if (this.httpsServer !== null || this.closing) {
      throw new Error("Collaboration server is already running.");
    }

    const server = https.createServer(
      {
        cert: this.deps.certificate.certPem,
        key: this.deps.certificate.keyPem,
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
      },
      (_req, res) => {
        res.statusCode = 426;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("WebSocket connection required.");
      },
    );

    const wss = new WebSocketServer({
      server,
      maxPayload: MAX_PAYLOAD_BYTES,
    });

    wss.on("connection", (ws, req) => {
      this.handleConnection(ws, req);
    });
    wss.on("error", () => {
      // Errors on the underlying https server or sockets are handled directly.
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });

    server.on("error", () => {
      // Keep the process alive on transient socket errors.
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      wss.close();
      server.close();
      throw new Error("Collaboration server did not bind to a TCP port.");
    }

    this.httpsServer = server;
    this.wss = wss;
    this.heartbeatTimer = this.timers.setInterval(() => {
      this.sweepSilentSessions();
    }, this.heartbeatMs);

    return { port: address.port };
  }

  async close(): Promise<void> {
    if (this.closing) {
      return;
    }
    this.closing = true;

    if (this.heartbeatTimer !== null) {
      this.timers.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const [joinId, entry] of this.pending) {
      this.timers.clearTimeout(entry.timer);
      this.pending.delete(joinId);
      entry.closed = true;
      this.safeCloseSocket(entry.ws, COLLAB_CLOSE.REFUSED, "REJECTED");
      this.deps.onJoinResolved?.(joinId);
    }

    for (const [deviceId, entry] of this.sessions) {
      this.sessions.delete(deviceId);
      this.notifySessionDisconnected(entry);
      this.safeCloseSocket(entry.ws, 1001, "Server closing");
    }

    const wss = this.wss;
    const server = this.httpsServer;
    this.wss = null;
    this.httpsServer = null;

    if (wss !== null) {
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
          client.terminate();
        }
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    }

    if (server !== null) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }

    this.closing = false;
  }

  async approveJoin(joinId: string): Promise<void> {
    const entry = this.pending.get(joinId);
    if (entry === undefined || entry.resolving) {
      throw new Error("Pending join request was not found.");
    }

    entry.resolving = true;
    this.timers.clearTimeout(entry.timer);
    this.pending.delete(joinId);

    let approved: { deviceId: string; role: Role };
    try {
      approved = await this.deps.registry.approve({
        deviceName: entry.join.deviceName,
        roleId: entry.join.roleId,
        fingerprint: entry.join.deviceFingerprint,
      });
    } catch {
      this.sendPairRefusal(entry.ws, "REJECTED");
      this.deps.onJoinResolved?.(joinId);
      return;
    }

    if (entry.closed || entry.ws.readyState !== WebSocket.OPEN) {
      this.deps.onJoinResolved?.(joinId);
      return;
    }

    this.sendJson(entry.ws, {
      schema: COLLAB_SCHEMA,
      kind: "pair_result",
      ok: true,
      deviceId: approved.deviceId,
      role: approved.role,
      host: this.deps.getHostIdentity(),
    });
    this.deps.onJoinResolved?.(joinId);

    this.promoteToSession({
      ws: entry.ws,
      deviceId: approved.deviceId,
      deviceName: entry.join.deviceName,
      role: approved.role,
      fingerprint: entry.join.deviceFingerprint,
      ...(entry.remoteAddress !== undefined ? { remoteAddress: entry.remoteAddress } : {}),
    });
  }

  rejectJoin(joinId: string): void {
    const entry = this.pending.get(joinId);
    if (entry === undefined || entry.resolving) {
      return;
    }

    entry.resolving = true;
    this.timers.clearTimeout(entry.timer);
    this.pending.delete(joinId);

    this.sendPairRefusal(entry.ws, "REJECTED");
    this.deps.onJoinResolved?.(joinId);
  }

  pendingJoins(): PendingJoin[] {
    return Array.from(this.pending.values(), (entry) => ({
      ...entry.join,
      words: [...entry.join.words],
    }));
  }

  connected(): ConnectedDeviceInfo[] {
    return Array.from(this.sessions.values(), (entry) => ({ ...entry.info }));
  }

  disconnect(deviceId: string): void {
    const entry = this.sessions.get(deviceId);
    if (entry === undefined) {
      return;
    }
    this.sessions.delete(deviceId);
    this.notifySessionDisconnected(entry);
    this.safeCloseSocket(entry.ws, 1000, "Disconnected");
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    ws.on("error", () => {
      // Socket errors also trigger `close`.
    });

    const clientFingerprint = readPeerCertFingerprint(req);
    if (clientFingerprint === undefined) {
      this.safeCloseSocket(ws, COLLAB_CLOSE.NO_CLIENT_CERT, "Client certificate required");
      return;
    }

    const remoteAddress =
      typeof req.socket.remoteAddress === "string" && req.socket.remoteAddress.length > 0
        ? req.socket.remoteAddress
        : undefined;

    let stage: ConnectionStage = "awaiting_first";
    let activeJoinId: string | undefined;
    let sessionEntry: ActiveSessionEntry | undefined;

    const firstMessageTimer = this.timers.setTimeout(() => {
      if (stage !== "awaiting_first") {
        return;
      }
      stage = "closed";
      this.safeCloseSocket(ws, COLLAB_CLOSE.PROTOCOL, "First message timeout");
    }, this.firstMessageTimeoutMs);

    const closeProtocol = (reason: string): void => {
      this.timers.clearTimeout(firstMessageTimer);
      stage = "closed";
      if (activeJoinId !== undefined) {
        const entry = this.pending.get(activeJoinId);
        if (entry !== undefined && !entry.resolving) {
          this.timers.clearTimeout(entry.timer);
          this.pending.delete(activeJoinId);
          this.deps.onJoinResolved?.(activeJoinId);
        }
        activeJoinId = undefined;
      }
      this.safeCloseSocket(ws, COLLAB_CLOSE.PROTOCOL, reason);
    };

    ws.on("message", (data, isBinary) => {
      if (stage === "closed") {
        return;
      }

      const msg = parseCollabFrame(data, isBinary);
      if (msg === undefined) {
        closeProtocol("Invalid message frame");
        return;
      }

      if (stage === "session" && sessionEntry !== undefined) {
        sessionEntry.lastActivityMs = this.now();
        if (msg.kind === "ping") {
          if (typeof msg.t !== "number" || !Number.isFinite(msg.t)) {
            closeProtocol("Invalid ping payload");
            return;
          }
          this.sendJson(ws, { schema: COLLAB_SCHEMA, kind: "pong", t: msg.t });
          return;
        }
        for (const listener of [...sessionEntry.listeners]) {
          listener(msg);
        }
        return;
      }

      if (stage === "pending_join") {
        if (msg.kind === "ping" && typeof msg.t === "number" && Number.isFinite(msg.t)) {
          this.sendJson(ws, { schema: COLLAB_SCHEMA, kind: "pong", t: msg.t });
          return;
        }
        closeProtocol("Unexpected message while awaiting pairing approval");
        return;
      }

      // stage === "awaiting_first"
      this.timers.clearTimeout(firstMessageTimer);

      if (msg.kind === "pair_request") {
        const deviceName = validateDeviceName(msg.deviceName);
        if (deviceName === undefined || typeof msg.code !== "string" || !PAIRING_CODE_RE.test(msg.code)) {
          closeProtocol("Invalid pair_request payload");
          return;
        }

        const redeemed = this.deps.codes.redeem(msg.code);
        if (!redeemed.ok) {
          stage = "closed";
          this.sendPairRefusal(ws, redeemed.reason);
          return;
        }

        const words = pairingWords(
          this.deps.certificate.fingerprint,
          clientFingerprint,
          msg.code,
        );
        const joinId = randomUUID();
        const expiresAt = new Date(this.now() + this.approvalTimeoutMs).toISOString();
        const join: PendingJoin = {
          joinId,
          deviceName,
          roleId: redeemed.roleId,
          words,
          deviceFingerprint: clientFingerprint,
          expiresAt,
        };

        const approvalTimer = this.timers.setTimeout(() => {
          const entry = this.pending.get(joinId);
          if (entry === undefined || entry.resolving) {
            return;
          }
          entry.resolving = true;
          this.pending.delete(joinId);
          stage = "closed";
          this.sendPairRefusal(ws, "TIMEOUT");
          this.deps.onJoinResolved?.(joinId);
        }, this.approvalTimeoutMs);

        const entry: PendingJoinEntry = {
          join,
          ws,
          ...(remoteAddress !== undefined ? { remoteAddress } : {}),
          timer: approvalTimer,
          resolving: false,
          closed: false,
        };

        this.pending.set(joinId, entry);
        activeJoinId = joinId;
        stage = "pending_join";

        this.sendJson(ws, { schema: COLLAB_SCHEMA, kind: "pair_pending", words: [...words] });
        this.deps.onPendingJoin?.({ ...join, words: [...words] });
        return;
      }

      if (msg.kind === "hello") {
        if (
          typeof msg.deviceId !== "string" ||
          msg.deviceId.trim().length === 0 ||
          typeof msg.lastSeq !== "number" ||
          !Number.isInteger(msg.lastSeq) ||
          msg.lastSeq < 0
        ) {
          closeProtocol("Invalid hello payload");
          return;
        }
        if (msg.knownHost !== undefined && !isValidKnownHost(msg.knownHost)) {
          closeProtocol("Invalid knownHost payload");
          return;
        }

        const record = this.deps.registry.lookup(msg.deviceId);
        if (record === undefined) {
          stage = "closed";
          this.sendHelloRefusal(ws, "UNKNOWN_DEVICE");
          return;
        }
        if (record.removed) {
          stage = "closed";
          this.sendHelloRefusal(ws, "REMOVED");
          return;
        }
        if (record.fingerprint !== clientFingerprint) {
          stage = "closed";
          this.sendHelloRefusal(ws, "KEY_MISMATCH");
          return;
        }

        this.sendJson(ws, {
          schema: COLLAB_SCHEMA,
          kind: "welcome",
          deviceId: msg.deviceId,
          role: record.role,
          host: this.deps.getHostIdentity(),
        });

        stage = "session";
        sessionEntry = this.promoteToSession({
          ws,
          deviceId: msg.deviceId,
          deviceName: record.name ?? msg.deviceId,
          role: record.role,
          fingerprint: clientFingerprint,
          ...(remoteAddress !== undefined ? { remoteAddress } : {}),
        });
        return;
      }

      closeProtocol("Expected pair_request or hello");
    });

    ws.on("close", () => {
      this.timers.clearTimeout(firstMessageTimer);
      stage = "closed";

      if (activeJoinId !== undefined) {
        const pendingEntry = this.pending.get(activeJoinId);
        if (pendingEntry !== undefined) {
          pendingEntry.closed = true;
          if (!pendingEntry.resolving) {
            this.timers.clearTimeout(pendingEntry.timer);
            this.pending.delete(activeJoinId);
            this.deps.onJoinResolved?.(activeJoinId);
          }
        }
      }

      if (sessionEntry !== undefined) {
        if (this.sessions.get(sessionEntry.session.deviceId) === sessionEntry) {
          this.sessions.delete(sessionEntry.session.deviceId);
        }
        this.notifySessionDisconnected(sessionEntry);
      }
    });

    this.sessionAttachers.set(ws, (entry) => {
      stage = "session";
      sessionEntry = entry;
    });
  }

  private promoteToSession(opts: {
    ws: WebSocket;
    deviceId: string;
    deviceName: string;
    role: Role;
    fingerprint: CertFingerprint;
    remoteAddress?: string;
  }): ActiveSessionEntry {
    const existing = this.sessions.get(opts.deviceId);
    if (existing !== undefined) {
      this.sessions.delete(opts.deviceId);
      this.notifySessionDisconnected(existing);
      this.safeCloseSocket(existing.ws, 1000, "Replaced by newer connection");
    }

    const listeners = new Set<(message: CollabJsonMessage) => void>();
    const closeListeners = new Set<() => void>();
    const session: DeviceSession = {
      deviceId: opts.deviceId,
      role: opts.role,
      fingerprint: opts.fingerprint,
      ...(opts.remoteAddress !== undefined ? { remoteAddress: opts.remoteAddress } : {}),
      send: (message) => {
        this.sendJson(opts.ws, message);
      },
      close: (code, reason) => {
        this.safeCloseSocket(opts.ws, code, reason);
      },
      onMessage: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      onClose: (listener) => {
        closeListeners.add(listener);
        return () => {
          closeListeners.delete(listener);
        };
      },
    };

    const info: ConnectedDeviceInfo = {
      deviceId: opts.deviceId,
      name: opts.deviceName,
      roleId: opts.role.id,
      connectedAt: new Date(this.now()).toISOString(),
      ...(opts.remoteAddress !== undefined ? { remoteAddress: opts.remoteAddress } : {}),
    };

    const entry: ActiveSessionEntry = {
      session,
      info,
      ws: opts.ws,
      listeners,
      closeListeners,
      lastActivityMs: this.now(),
      disconnectedNotified: false,
    };

    this.sessionAttachers.get(opts.ws)?.(entry);
    this.sessions.set(opts.deviceId, entry);
    this.deps.onDeviceConnected?.(session);
    return entry;
  }

  private notifySessionDisconnected(entry: ActiveSessionEntry): void {
    if (entry.disconnectedNotified) {
      return;
    }
    entry.disconnectedNotified = true;
    const closeListeners = [...entry.closeListeners];
    entry.closeListeners.clear();
    for (const listener of closeListeners) {
      try {
        listener();
      } catch {
        // Keep disconnect notifications isolated from listener errors.
      }
    }
    this.deps.onDeviceDisconnected?.(entry.session.deviceId);
  }

  private sweepSilentSessions(): void {
    const cutoff = this.heartbeatMs * 3;
    const nowMs = this.now();
    for (const [deviceId, entry] of this.sessions) {
      if (nowMs - entry.lastActivityMs >= cutoff) {
        this.sessions.delete(deviceId);
        this.notifySessionDisconnected(entry);
        entry.ws.terminate();
      }
    }
  }

  private sendJson(ws: WebSocket, payload: object): void {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify(payload), (err) => {
      if (err != null) {
        ws.terminate();
      }
    });
  }

  private sendPairRefusal(ws: WebSocket, reason: PairRefusalReason): void {
    this.sendAndClose(
      ws,
      { schema: COLLAB_SCHEMA, kind: "pair_result", ok: false, reason },
      COLLAB_CLOSE.REFUSED,
      reason,
    );
  }

  private sendHelloRefusal(
    ws: WebSocket,
    reason: "UNKNOWN_DEVICE" | "REMOVED" | "KEY_MISMATCH",
  ): void {
    this.sendAndClose(
      ws,
      { schema: COLLAB_SCHEMA, kind: "refused", reason },
      COLLAB_CLOSE.REFUSED,
      reason,
    );
  }

  private sendAndClose(ws: WebSocket, payload: object, code: number, reason: string): void {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify(payload), (err) => {
      if (err != null) {
        ws.terminate();
        return;
      }
      this.safeCloseSocket(ws, code, reason);
    });
  }

  private safeCloseSocket(ws: WebSocket, code?: number, reason?: string): void {
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      return;
    }
    if (ws.readyState === WebSocket.CONNECTING) {
      ws.terminate();
      return;
    }
    try {
      ws.close(code, reason);
    } catch {
      ws.terminate();
    }
  }
}
