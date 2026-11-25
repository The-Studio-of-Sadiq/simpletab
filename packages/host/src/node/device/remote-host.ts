import type { PublicChainItem } from "@simpletab/core/changelog";
import type { OpRequest } from "@simpletab/core/ops";
import {
  COLLAB_SCHEMA,
  hostBeats,
  type HostIdentity,
  type CollabLock,
  type CollabRequestMethod,
  type CollabStateView,
  type PresenceEntry,
  type PresenceInfo,
  type StateDelta,
} from "../../common/collab-protocol";
import type {
  DeviceConnectionState,
  DeviceModeStatus,
  HostCancelLongResult,
  HostLockInfo,
  OpUndoInfo,
  ProjectedState,
  QueuedEditInfo,
  RejectedEditInfo,
  SubmitResult,
} from "../../common/host-protocol";
import { applyStateDelta } from "../../common/state-delta";
import { CollabClient, type CollabConnectResult, type CollabConnection } from "../collab/device-client";
import type { CollabJsonMessage } from "../collab/server";
import type { StoredPairing } from "./pairing-store";
import type { ReplicaStore } from "./replica-store";
import type { HandoverOpRecord } from "../handover/format";

/**
 * The device side of live collaboration (design section 4.1): keeps one authenticated connection
 * to the host, mirrors the role view from `snapshot` and `delta` messages, and forwards requests.
 *
 * While the connection is down, edits wait in an outbox in the order they were made and are sent,
 * one by one in that order, once the device has a fresh snapshot again. The host decides: an edit
 * it rejects (for example because someone changed the same record meanwhile) is listed as rejected
 * with the host's reason; it is never retried silently. The outbox is kept in memory: closing the
 * app on a device drops edits that were never sent, and the device banner says so.
 */

export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
/** Without a snapshot this long after `welcome`, the device asks for one. */
export const SNAPSHOT_WAIT_MS = 2_000;
const SUBMIT_TIMEOUT_MS = 5 * 60_000;
const READ_TIMEOUT_MS = 30_000;
const MAX_REJECTED_KEPT = 50;

export interface RemoteHostTimers {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface RemoteHostDeps {
  pairing: StoredPairing;
  connect?: (opts: Parameters<typeof CollabClient.connect>[0]) => Promise<CollabConnectResult>;
  timers?: RemoteHostTimers;
  now?: () => Date;
  /** The mirrored view, locks, presence or connection state changed. */
  onChange?: (reason: "state" | "locks" | "presence" | "connection" | "outbox") => void;
  /** The host removed this device: its copy is gone and the pairing must be deleted. */
  onRemoved?: () => void;
  /** Tab directors: the encrypted full copy kept for promotion. */
  replica?: ReplicaStore;
  /** The best host this laptop has seen, kept across re-pairing (host number, then rank). */
  bestHost?: { load(): HostIdentity | undefined; save(host: HostIdentity): void };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface OutboxItem {
  id: string;
  op: OpRequest;
  queuedAt: string;
}

const defaultTimers: RemoteHostTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isView(value: unknown): value is CollabStateView {
  return isRecord(value) && typeof value.seq === "number" && typeof value.roleId === "string";
}

function plainHelloRefusal(reason: string): string {
  switch (reason) {
    case "HOST_CERT_MISMATCH":
      return "The host's certificate is not the one this laptop paired with. If the host laptop was replaced, leave the host and pair again.";
    case "KEY_MISMATCH":
    case "UNKNOWN_DEVICE":
      return "The host does not recognise this laptop. Leave the host and pair again.";
    case "HOST_UNREACHABLE":
      return "Cannot reach the host. Check that both laptops are on the tab-room network and that the host allows devices.";
    default:
      return "The host connection failed. Trying again.";
  }
}

export class RemoteHost {
  private readonly deps: RemoteHostDeps;
  private readonly timers: RemoteHostTimers;
  private readonly now: () => Date;
  private readonly connectImpl: NonNullable<RemoteHostDeps["connect"]>;

  private connection: CollabConnection | null = null;
  private connectionState: DeviceConnectionState = "connecting";
  private view: CollabStateView | null = null;
  private locks: CollabLock[] = [];
  private presenceEntries: PresenceEntry[] = [];
  private lastConnectedAt: string | undefined;
  private lastError: string | undefined;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private nextRequest = 1;
  private nextOutboxId = 1;
  private outbox: OutboxItem[] = [];
  private rejected: RejectedEditInfo[] = [];
  private flushing = false;
  private readySnapshot = false;
  private stopped = false;
  private myPresence: PresenceInfo = {};
  private replicaQueue: Promise<void> = Promise.resolve();
  private copyError: string | undefined;

  constructor(deps: RemoteHostDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? defaultTimers;
    this.now = deps.now ?? (() => new Date());
    this.connectImpl = deps.connect ?? ((opts) => CollabClient.connect(opts));
  }

  start(): void {
    this.stopped = false;
    void this.connectOnce();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    if (this.snapshotTimer !== null) this.timers.clearTimeout(this.snapshotTimer);
    this.reconnectTimer = null;
    this.snapshotTimer = null;
    const connection = this.connection;
    this.connection = null;
    connection?.close();
    this.failPending("The connection to the host was closed.");
  }

  getState(): ProjectedState | null {
    return this.view as unknown as ProjectedState | null;
  }

  getLocks(): HostLockInfo[] {
    return this.locks.map((lock) => ({ ...lock }));
  }

  isConnected(): boolean {
    return this.connectionState === "connected" && this.readySnapshot;
  }

  status(): DeviceModeStatus {
    const p = this.deps.pairing;
    return {
      connection: this.connectionState,
      deviceId: p.deviceId,
      hostAddress: p.url.replace(/^wss:\/\//, ""),
      deviceName: p.deviceName,
      roleId: p.role.id,
      roleName: p.role.name,
      ...(this.lastConnectedAt !== undefined ? { lastConnectedAt: this.lastConnectedAt } : {}),
      ...(this.lastError !== undefined ? { error: this.lastError } : {}),
      queued: this.outbox.map<QueuedEditInfo>((item) => ({ id: item.id, opType: item.op.type, queuedAt: item.queuedAt })),
      rejected: this.rejected.map((item) => ({ ...item, errors: [...item.errors] })),
      presence: this.presenceEntries.map((entry) => ({ ...entry })),
      ...(this.deps.replica !== undefined
        ? {
            copy: {
              lastSeq: this.deps.replica.lastSeq(),
              ...(this.deps.replica.headHash() !== undefined ? { headHash: this.deps.replica.headHash()! } : {}),
              ...(this.copyError !== undefined ? { error: this.copyError } : {}),
            },
          }
        : {}),
    };
  }

  dismissRejected(): void {
    this.rejected = [];
    this.deps.onChange?.("outbox");
  }

  setPresence(info: PresenceInfo): void {
    this.myPresence = { ...info };
    this.connection?.send({ schema: COLLAB_SCHEMA, kind: "set_presence", ...this.myPresence });
  }

  /** Sends an edit, or queues it while the host is out of reach. */
  async submit(op: OpRequest): Promise<SubmitResult> {
    if (!this.isConnected() || this.outbox.length > 0 || this.flushing) {
      this.enqueue(op);
      return {
        ok: false,
        code: "QUEUED",
        errors: [
          "The host is out of reach. The change is saved on this laptop and will be sent when the connection is back.",
        ],
      };
    }
    return this.sendSubmit("submit", [op]);
  }

  async undo(seq: number): Promise<SubmitResult> {
    if (!this.isConnected()) {
      return { ok: false, code: "NO_TOURNAMENT", errors: ["Undo needs the connection to the host."] };
    }
    return this.sendSubmit("undo", [seq]);
  }

  async cancelLong(lockId: string): Promise<HostCancelLongResult> {
    if (!this.isConnected()) {
      return { ok: false, code: "NO_TOURNAMENT", errors: ["Cancelling needs the connection to the host."] };
    }
    try {
      return (await this.request("cancelLong", [lockId], READ_TIMEOUT_MS)) as HostCancelLongResult;
    } catch (error) {
      return { ok: false, code: "NOT_FOUND", errors: [error instanceof Error ? error.message : String(error)] };
    }
  }

  async getChangelog(afterSeq?: number, limit?: number): Promise<PublicChainItem[]> {
    if (!this.isConnected()) return [];
    const params: unknown[] = [];
    if (afterSeq !== undefined || limit !== undefined) params.push(afterSeq ?? null);
    if (limit !== undefined) params.push(limit);
    return (await this.request("getChangelog", params, READ_TIMEOUT_MS)) as PublicChainItem[];
  }

  async getOpUndoInfo(): Promise<OpUndoInfo[]> {
    if (!this.isConnected()) return [];
    return (await this.request("getOpUndoInfo", [], READ_TIMEOUT_MS)) as OpUndoInfo[];
  }

  // ---- connection ----------------------------------------------------------------------------

  private setConnectionState(next: DeviceConnectionState): void {
    if (this.connectionState === next) return;
    this.connectionState = next;
    this.deps.onChange?.("connection");
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped) return;
    const p = this.deps.pairing;
    let result: CollabConnectResult;
    try {
      result = await this.connectImpl({
        url: p.url,
        certificate: p.certificate,
        deviceId: p.deviceId,
        pinnedHostFingerprint: p.hostFingerprint,
        lastSeq: this.view?.seq ?? 0,
        knownHost: p.host,
      });
    } catch {
      result = { ok: false, reason: "HOST_UNREACHABLE" };
    }
    if (this.stopped) {
      if (result.ok) result.connection.close();
      return;
    }
    if (!result.ok) {
      if (result.reason === "REMOVED") {
        this.wipe();
        return;
      }
      this.lastError = plainHelloRefusal(result.reason);
      this.scheduleReconnect();
      return;
    }
    // Subscribe before yielding, so the snapshot that follows `welcome` cannot be missed.
    const connection = result.connection;
    if (this.refuseReplacedHost(connection)) return;
    this.connection = connection;
    this.readySnapshot = false;
    connection.onMessage((message) => this.handleMessage(message));
    connection.onClose(() => this.handleClose(connection));
    this.attempts = 0;
    this.lastError = undefined;
    this.lastConnectedAt = this.now().toISOString();
    this.setConnectionState("connected");
    this.snapshotTimer = this.timers.setTimeout(() => {
      this.snapshotTimer = null;
      if (!this.readySnapshot) connection.send({ schema: COLLAB_SCHEMA, kind: "resync" });
    }, SNAPSHOT_WAIT_MS);
    if (Object.keys(this.myPresence).length > 0) {
      connection.send({ schema: COLLAB_SCHEMA, kind: "set_presence", ...this.myPresence });
    }
  }

  private handleClose(connection: CollabConnection): void {
    if (this.connection !== connection) return;
    this.connection = null;
    this.readySnapshot = false;
    if (this.snapshotTimer !== null) {
      this.timers.clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    this.failPending("The connection to the host was lost.");
    if (this.stopped) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    this.setConnectionState(this.lastConnectedAt === undefined ? "connecting" : "reconnecting");
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this.attempts);
    this.attempts += 1;
    this.deps.onChange?.("connection");
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectOnce();
    }, delay);
  }

  private wipe(): void {
    this.stopped = true;
    this.view = null;
    this.locks = [];
    this.presenceEntries = [];
    this.outbox = [];
    this.deps.replica?.clear();
    this.lastError = "The host removed this laptop. Its copy of the tournament has been deleted.";
    this.setConnectionState("removed");
    this.deps.onChange?.("state");
    this.deps.onRemoved?.();
  }

  /**
   * A paired host that loses to a host this laptop already knows (design section 4, step 6) is
   * refused and told about the winner, so it can step down.
   */
  private refuseReplacedHost(connection: CollabConnection): boolean {
    const seen = connection.welcome.host;
    const best = this.deps.bestHost?.load();
    if (best !== undefined && best.hostId !== seen.hostId && hostBeats(best, seen)) {
      connection.send({ schema: COLLAB_SCHEMA, kind: "superseded", winner: best });
      connection.close();
      this.connection = null;
      this.stopped = true;
      this.lastError = `This host was replaced by host ${best.hostNumber}. Leave it and pair with the new host.`;
      this.setConnectionState("superseded");
      return true;
    }
    if (best === undefined || best.hostId === seen.hostId || hostBeats(seen, best)) {
      this.deps.bestHost?.save(seen);
    }
    return false;
  }

  /** Copy updates run one at a time, in arrival order; a failure forces a fresh copy. */
  private queueReplica(task: () => Promise<void>): void {
    this.replicaQueue = this.replicaQueue
      .then(task)
      .then(() => {
        this.copyError = undefined;
        this.deps.onChange?.("state");
      })
      .catch((error: unknown) => {
        this.copyError = `This laptop's full copy could not be updated: ${error instanceof Error ? error.message : String(error)} Reconnecting for a fresh copy.`;
        this.connection?.close();
        this.deps.onChange?.("connection");
      });
  }

  /** Waits for pending copy updates (before promotion or export). */
  async settleCopy(): Promise<void> {
    await this.replicaQueue;
  }

  getPairing(): StoredPairing {
    return this.deps.pairing;
  }

  // ---- messages ------------------------------------------------------------------------------

  private handleMessage(message: CollabJsonMessage): void {
    switch (message.kind) {
      case "snapshot": {
        if (!isView(message.state)) return;
        this.view = message.state;
        this.locks = Array.isArray(message.locks) ? (message.locks as CollabLock[]) : [];
        const wasReady = this.readySnapshot;
        this.readySnapshot = true;
        if (this.snapshotTimer !== null) {
          this.timers.clearTimeout(this.snapshotTimer);
          this.snapshotTimer = null;
        }
        this.deps.onChange?.("state");
        this.deps.onChange?.("locks");
        if (!wasReady) void this.flushOutbox();
        return;
      }
      case "delta": {
        if (this.view === null || !isRecord(message.delta)) return;
        if (message.fromSeq !== this.view.seq) {
          // A gap: this copy missed a batch. Ask for a fresh snapshot instead of guessing.
          this.connection?.send({ schema: COLLAB_SCHEMA, kind: "resync" });
          return;
        }
        this.view = applyStateDelta(this.view, message.delta as StateDelta);
        this.deps.onChange?.("state");
        return;
      }
      case "locks": {
        if (Array.isArray(message.locks)) {
          this.locks = message.locks as CollabLock[];
          this.deps.onChange?.("locks");
        }
        return;
      }
      case "presence": {
        if (Array.isArray(message.entries)) {
          this.presenceEntries = message.entries as PresenceEntry[];
          this.deps.onChange?.("presence");
        }
        return;
      }
      case "replica_init": {
        if (this.deps.replica === undefined || typeof message.handover !== "string") return;
        const bytes = Buffer.from(message.handover, "base64");
        this.queueReplica(() => this.deps.replica!.reset(bytes));
        return;
      }
      case "ops": {
        if (this.deps.replica === undefined || !Array.isArray(message.records)) return;
        const records = message.records as HandoverOpRecord[];
        this.queueReplica(() => this.deps.replica!.append(records));
        return;
      }
      case "response": {
        const requestId = typeof message.requestId === "string" ? message.requestId : "";
        const pending = this.pending.get(requestId);
        if (pending === undefined) return;
        this.pending.delete(requestId);
        this.timers.clearTimeout(pending.timer);
        if (message.ok === true) pending.resolve(message.value);
        else pending.reject(new Error(typeof message.error === "string" ? message.error : "The host refused the request."));
        return;
      }
      default:
        return;
    }
  }

  // ---- requests and outbox -------------------------------------------------------------------

  private request(method: CollabRequestMethod, params: unknown[], timeoutMs: number): Promise<unknown> {
    const connection = this.connection;
    if (connection === null) {
      return Promise.reject(new Error("The host is out of reach."));
    }
    const requestId = `r${this.nextRequest++}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("The host did not answer in time."));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      connection.send({ schema: COLLAB_SCHEMA, kind: "request", requestId, method, params });
    });
  }

  private failPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      this.timers.clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private async sendSubmit(method: "submit" | "undo", params: unknown[]): Promise<SubmitResult> {
    try {
      return (await this.request(method, params, SUBMIT_TIMEOUT_MS)) as SubmitResult;
    } catch (error) {
      return {
        ok: false,
        code: "INVALID",
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  private enqueue(op: OpRequest): void {
    this.outbox.push({ id: `q${this.nextOutboxId++}`, op: structuredClone(op), queuedAt: this.now().toISOString() });
    this.deps.onChange?.("outbox");
  }

  /** Sends queued edits in order, one at a time, after a fresh snapshot. */
  private async flushOutbox(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.outbox.length > 0 && this.isConnected()) {
        const item = this.outbox[0]!;
        let result: SubmitResult;
        try {
          result = (await this.request("submit", [item.op], SUBMIT_TIMEOUT_MS)) as SubmitResult;
        } catch {
          // The connection dropped mid-send: keep the item; the next snapshot retries it.
          return;
        }
        this.outbox.shift();
        if (!result.ok) {
          this.rejected = [
            ...this.rejected,
            { id: item.id, opType: item.op.type, queuedAt: item.queuedAt, errors: [...result.errors], at: this.now().toISOString() },
          ].slice(-MAX_REJECTED_KEPT);
        }
        this.deps.onChange?.("outbox");
      }
    } finally {
      this.flushing = false;
    }
  }
}
