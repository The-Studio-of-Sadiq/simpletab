import type { Actor } from "@simpletab/core/ops";
import { BUILT_IN_ROLES, type Role } from "@simpletab/core/permissions";
import {
  COLLAB_DELTA_BATCH_MS,
  COLLAB_PRESENCE_THROTTLE_MS,
  COLLAB_SCHEMA,
  deviceActorRef,
  type CollabLock,
  type CollabRequestMethod,
  type CollabStateView,
  type PresenceEntry,
  type PresenceInfo,
} from "../../common/collab-protocol";
import { diffProjectedState, isEmptyDelta } from "../../common/state-delta";
import type { CollabJsonMessage, CollabTimers, DeviceSession } from "./server";

const MAX_PRESENCE_FIELD_LENGTH = 100;

const VALID_REQUEST_METHODS: ReadonlySet<string> = new Set<CollabRequestMethod>([
  "submit",
  "undo",
  "cancelLong",
  "getChangelog",
  "getOpUndoInfo",
  "receiveQrBallot",
]);

const defaultTimers: CollabTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle),
};

function isCollabRequestMethod(value: unknown): value is CollabRequestMethod {
  return typeof value === "string" && VALID_REQUEST_METHODS.has(value);
}

function sanitizePresenceField(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_PRESENCE_FIELD_LENGTH) {
    return undefined;
  }
  return value;
}

function sanitizePresenceInfo(raw: {
  view?: unknown;
  roundId?: unknown;
  debateId?: unknown;
}): PresenceInfo {
  const out: PresenceInfo = {};
  const view = sanitizePresenceField(raw.view);
  const roundId = sanitizePresenceField(raw.roundId);
  const debateId = sanitizePresenceField(raw.debateId);
  if (view !== undefined) {
    out.view = view;
  }
  if (roundId !== undefined) {
    out.roundId = roundId;
  }
  if (debateId !== undefined) {
    out.debateId = debateId;
  }
  return out;
}

export interface ProjectionStreamDeps {
  /** The role's current view, or null when no tournament is open. */
  getView(role: Role): CollabStateView | null;
  getLocks(): CollabLock[];
  /** Runs a device request as `actor`; resolves with the value to send back or rejects with an Error (message sent to the device). */
  handleRequest(method: CollabRequestMethod, params: unknown[], actor: Actor): Promise<unknown>;
  /** Display name of a device for presence; defaults to the deviceId. */
  deviceName?(deviceId: string): string;
  now?: () => number;
  timers?: CollabTimers;
  batchMs?: number;
}

interface SessionRecord {
  session: DeviceSession;
  roleId: string;
  closed: boolean;
  unsubscribeMessage: () => void;
  unsubscribeClose: () => void;
  presence: PresenceInfo;
  presenceSince: string;
  lastPresenceBroadcastMs: number | null;
  presenceTimer: ReturnType<typeof setTimeout> | null;
  presenceDirty: boolean;
}

interface RoleBucket {
  role: Role;
  baseline: CollabStateView | null;
  sessions: Set<SessionRecord>;
}

/**
 * Feeds connected staff device sessions with per-role state snapshots, batched state deltas,
 * lock updates, presence broadcasts, and device RPC responses.
 */
export class ProjectionStream {
  private readonly deps: ProjectionStreamDeps;
  private readonly now: () => number;
  private readonly timers: CollabTimers;
  private readonly batchMs: number;

  private readonly sessions = new Map<string, SessionRecord>();
  private readonly roleBuckets = new Map<string, RoleBucket>();

  private pendingOpTypes: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private hostPresence: PresenceEntry | null = null;
  private disposed = false;

  constructor(deps: ProjectionStreamDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? defaultTimers;
    this.batchMs = deps.batchMs ?? COLLAB_DELTA_BATCH_MS;
  }

  addSession(session: DeviceSession): void {
    if (this.disposed) {
      return;
    }

    const existing = this.sessions.get(session.deviceId);
    if (existing !== undefined) {
      this.dropSessionRecord(existing);
    }

    this.flush();
    if (this.disposed) {
      return;
    }

    let bucket = this.roleBuckets.get(session.role.id);
    if (bucket === undefined) {
      bucket = {
        role: session.role,
        baseline: null,
        sessions: new Set(),
      };
      this.roleBuckets.set(session.role.id, bucket);
    }

    const record: SessionRecord = {
      session,
      roleId: session.role.id,
      closed: false,
      unsubscribeMessage: () => undefined,
      unsubscribeClose: () => undefined,
      presence: {},
      presenceSince: new Date(this.now()).toISOString(),
      lastPresenceBroadcastMs: null,
      presenceTimer: null,
      presenceDirty: false,
    };

    record.unsubscribeMessage = session.onMessage((msg) => {
      this.handleMessage(record, msg);
    });
    record.unsubscribeClose = session.onClose(() => {
      if (this.disposed || record.closed) {
        return;
      }
      this.dropSessionRecord(record);
      this.broadcastPresence();
    });

    this.sessions.set(session.deviceId, record);
    bucket.sessions.add(record);

    if (bucket.baseline === null) {
      bucket.baseline = this.deps.getView(bucket.role);
    }
    if (bucket.baseline !== null) {
      this.safeSend(record, {
        schema: COLLAB_SCHEMA,
        kind: "snapshot",
        state: bucket.baseline,
        locks: this.deps.getLocks(),
      });
    }

    this.broadcastPresence();
  }

  notifyCommitted(opType: string): void {
    if (this.disposed) {
      return;
    }
    this.pendingOpTypes.push(opType);
    if (this.flushTimer === null) {
      this.flushTimer = this.timers.setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, this.batchMs);
    }
  }

  notifyLocksChanged(): void {
    if (this.disposed) {
      return;
    }
    const locks = this.deps.getLocks();
    for (const record of [...this.sessions.values()]) {
      this.safeSend(record, {
        schema: COLLAB_SCHEMA,
        kind: "locks",
        locks,
      });
    }
  }

  setHostPresence(info: PresenceInfo & { name: string }): void {
    if (this.disposed) {
      return;
    }
    this.hostPresence = {
      deviceId: "host",
      name: info.name,
      roleId: BUILT_IN_ROLES.host_owner.id,
      since: new Date(this.now()).toISOString(),
      ...sanitizePresenceInfo(info),
    };
    this.broadcastPresence();
  }

  presence(): PresenceEntry[] {
    const entries: PresenceEntry[] = [];
    if (this.hostPresence !== null) {
      entries.push({ ...this.hostPresence });
    }
    for (const record of this.sessions.values()) {
      if (record.closed) {
        continue;
      }
      entries.push({
        deviceId: record.session.deviceId,
        name: this.deps.deviceName?.(record.session.deviceId) ?? record.session.deviceId,
        roleId: record.session.role.id,
        since: record.presenceSince,
        ...record.presence,
      });
    }
    return entries;
  }

  flush(): void {
    if (this.disposed) {
      return;
    }
    if (this.flushTimer !== null) {
      this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const opTypes = this.pendingOpTypes;
    this.pendingOpTypes = [];

    for (const bucket of [...this.roleBuckets.values()]) {
      if (bucket.sessions.size === 0) {
        continue;
      }
      const next = this.deps.getView(bucket.role);
      if (next === null) {
        continue;
      }

      if (bucket.baseline === null) {
        bucket.baseline = next;
        const locks = this.deps.getLocks();
        for (const record of [...bucket.sessions]) {
          this.safeSend(record, {
            schema: COLLAB_SCHEMA,
            kind: "snapshot",
            state: next,
            locks,
          });
        }
        continue;
      }

      const delta = diffProjectedState(bucket.baseline, next);
      if (isEmptyDelta(delta)) {
        continue;
      }

      const fromSeq = bucket.baseline.seq;
      bucket.baseline = next;

      for (const record of [...bucket.sessions]) {
        this.safeSend(record, {
          schema: COLLAB_SCHEMA,
          kind: "delta",
          fromSeq,
          toSeq: next.seq,
          delta,
          opTypes,
        });
      }
    }
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    if (this.flushTimer !== null) {
      this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    for (const record of [...this.sessions.values()]) {
      this.dropSessionRecord(record);
    }

    this.sessions.clear();
    this.roleBuckets.clear();
    this.pendingOpTypes = [];
  }

  private dropSessionRecord(record: SessionRecord): void {
    if (record.closed) {
      return;
    }
    record.closed = true;
    record.unsubscribeMessage();
    record.unsubscribeClose();
    if (record.presenceTimer !== null) {
      this.timers.clearTimeout(record.presenceTimer);
      record.presenceTimer = null;
    }
    record.presenceDirty = false;

    if (this.sessions.get(record.session.deviceId) === record) {
      this.sessions.delete(record.session.deviceId);
    }

    const bucket = this.roleBuckets.get(record.roleId);
    if (bucket !== undefined) {
      bucket.sessions.delete(record);
      if (bucket.sessions.size === 0) {
        this.roleBuckets.delete(record.roleId);
      }
    }
  }

  private handleMessage(record: SessionRecord, msg: CollabJsonMessage): void {
    if (this.disposed || record.closed) {
      return;
    }

    if (msg.kind === "request") {
      if (typeof msg.requestId !== "string" || msg.requestId.length === 0) {
        return;
      }
      const requestId = msg.requestId;
      if (!isCollabRequestMethod(msg.method) || !Array.isArray(msg.params)) {
        this.safeSend(record, {
          schema: COLLAB_SCHEMA,
          kind: "response",
          requestId,
          ok: false,
          error: "Invalid request",
        });
        return;
      }

      const method = msg.method;
      const params = msg.params;
      const actor: Actor = {
        ref: deviceActorRef(record.session.deviceId),
        type: "human",
        role: record.session.role,
        isHostOwner: false,
      };

      void this.executeRequest(record, requestId, method, params, actor);
      return;
    }

    if (msg.kind === "set_presence") {
      const nowMs = this.now();
      record.presence = sanitizePresenceInfo({
        view: msg.view,
        roundId: msg.roundId,
        debateId: msg.debateId,
      });
      record.presenceSince = new Date(nowMs).toISOString();

      if (
        record.lastPresenceBroadcastMs === null ||
        nowMs - record.lastPresenceBroadcastMs >= COLLAB_PRESENCE_THROTTLE_MS
      ) {
        if (record.presenceTimer !== null) {
          this.timers.clearTimeout(record.presenceTimer);
          record.presenceTimer = null;
        }
        record.presenceDirty = false;
        record.lastPresenceBroadcastMs = nowMs;
        this.broadcastPresence();
        return;
      }

      record.presenceDirty = true;
      if (record.presenceTimer === null) {
        const remainingMs = Math.max(
          0,
          COLLAB_PRESENCE_THROTTLE_MS - (nowMs - record.lastPresenceBroadcastMs),
        );
        record.presenceTimer = this.timers.setTimeout(() => {
          record.presenceTimer = null;
          if (this.disposed || record.closed || !record.presenceDirty) {
            return;
          }
          record.presenceDirty = false;
          record.lastPresenceBroadcastMs = this.now();
          this.broadcastPresence();
        }, remainingMs);
      }
      return;
    }

    if (msg.kind === "resync") {
      this.flush();
      if (this.disposed || record.closed) {
        return;
      }
      const bucket = this.roleBuckets.get(record.roleId);
      if (bucket === undefined) {
        return;
      }
      if (bucket.baseline === null) {
        bucket.baseline = this.deps.getView(bucket.role);
      }
      if (bucket.baseline !== null) {
        this.safeSend(record, {
          schema: COLLAB_SCHEMA,
          kind: "snapshot",
          state: bucket.baseline,
          locks: this.deps.getLocks(),
        });
      }
    }
  }

  private async executeRequest(
    record: SessionRecord,
    requestId: string,
    method: CollabRequestMethod,
    params: unknown[],
    actor: Actor,
  ): Promise<void> {
    try {
      const value = await this.deps.handleRequest(method, params, actor);
      if (this.disposed) {
        return;
      }
      if (method === "submit" || method === "undo" || method === "receiveQrBallot") {
        this.flush();
      }
      if (this.disposed || record.closed) {
        return;
      }
      this.safeSend(record, {
        schema: COLLAB_SCHEMA,
        kind: "response",
        requestId,
        ok: true,
        value,
      });
    } catch (error) {
      if (this.disposed || record.closed) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.safeSend(record, {
        schema: COLLAB_SCHEMA,
        kind: "response",
        requestId,
        ok: false,
        error: message,
      });
    }
  }

  private broadcastPresence(): void {
    if (this.disposed) {
      return;
    }
    const entries = this.presence();
    for (const record of [...this.sessions.values()]) {
      this.safeSend(record, {
        schema: COLLAB_SCHEMA,
        kind: "presence",
        entries,
      });
    }
  }

  private safeSend(record: SessionRecord, message: CollabJsonMessage): void {
    if (record.closed) {
      return;
    }
    try {
      record.session.send(message);
    } catch {
      // Never allow one failing session send to stop delivery to other sessions.
    }
  }
}
