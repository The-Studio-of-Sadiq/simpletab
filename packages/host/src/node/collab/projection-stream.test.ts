import type { Actor } from "@simpletab/core/ops";
import { BUILT_IN_ROLES, type Role } from "@simpletab/core/permissions";
import { describe, expect, it } from "vitest";
import {
  COLLAB_DELTA_BATCH_MS,
  COLLAB_PRESENCE_THROTTLE_MS,
  COLLAB_SCHEMA,
  type CollabLock,
  type CollabRequestMethod,
  type CollabStateView,
  type DeltaMessage,
  type HostToDeviceMessage,
  type SnapshotMessage,
} from "../../common/collab-protocol";
import { applyStateDelta, stableEqual } from "../../common/state-delta";
import { ProjectionStream, type ProjectionStreamDeps } from "./projection-stream";
import type { CollabJsonMessage, CollabTimers, DeviceSession } from "./server";

interface FakeSessionHandle {
  session: DeviceSession;
  sent: Array<HostToDeviceMessage | CollabJsonMessage>;
  emitMessage(msg: CollabJsonMessage): void;
  emitClose(): void;
  setThrowOnSend(enabled: boolean): void;
}

function createFakeSession(deviceId: string, role: Role): FakeSessionHandle {
  const messageListeners = new Set<(msg: CollabJsonMessage) => void>();
  const closeListeners = new Set<() => void>();
  const sent: Array<HostToDeviceMessage | CollabJsonMessage> = [];
  let closed = false;
  let throwOnSend = false;

  const session: DeviceSession = {
    deviceId,
    role,
    fingerprint: `fp-${deviceId}`,
    send: (msg) => {
      if (throwOnSend) {
        throw new Error("Simulated send failure");
      }
      sent.push(msg);
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const listener of [...closeListeners]) {
        listener();
      }
    },
    onMessage: (listener) => {
      messageListeners.add(listener);
      return () => {
        messageListeners.delete(listener);
      };
    },
    onClose: (listener) => {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
  };

  return {
    session,
    sent,
    emitMessage: (msg) => {
      for (const listener of [...messageListeners]) {
        listener(msg);
      }
    },
    emitClose: () => {
      session.close();
    },
    setThrowOnSend: (enabled) => {
      throwOnSend = enabled;
    },
  };
}

interface FakeTimerEntry {
  id: number;
  runAt: number;
  callback: () => void;
  cleared: boolean;
}

function createFakeClock(initialMs = 1_000): {
  now: () => number;
  timers: CollabTimers;
  advanceBy: (ms: number) => void;
  activeTimeoutCount: () => number;
} {
  let currentMs = initialMs;
  let nextId = 1;
  const timeouts = new Map<number, FakeTimerEntry>();

  const timers: CollabTimers = {
    setTimeout: (callback, ms) => {
      const id = nextId++;
      timeouts.set(id, {
        id,
        runAt: currentMs + Math.max(0, ms),
        callback,
        cleared: false,
      });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      const id = handle as unknown as number;
      const entry = timeouts.get(id);
      if (entry !== undefined) {
        entry.cleared = true;
        timeouts.delete(id);
      }
    },
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => undefined,
  };

  const advanceBy = (ms: number): void => {
    const targetMs = currentMs + ms;
    while (true) {
      let earliest: FakeTimerEntry | undefined;
      for (const entry of timeouts.values()) {
        if (!entry.cleared && entry.runAt <= targetMs) {
          if (earliest === undefined || entry.runAt < earliest.runAt || (entry.runAt === earliest.runAt && entry.id < earliest.id)) {
            earliest = entry;
          }
        }
      }
      if (earliest === undefined) {
        break;
      }
      currentMs = earliest.runAt;
      timeouts.delete(earliest.id);
      earliest.callback();
    }
    currentMs = targetMs;
  };

  return {
    now: () => currentMs,
    timers,
    advanceBy,
    activeTimeoutCount: () => timeouts.size,
  };
}

function createBaseDeps(overrides: Partial<ProjectionStreamDeps> = {}): ProjectionStreamDeps {
  return {
    getView: (role) => ({
      seq: 1,
      roleId: role.id,
      teams: [{ id: "t-1", name: "Alpha" }],
      versions: { "team:t-1": 1 },
    }),
    getLocks: () => [],
    handleRequest: async () => ({ ok: true }),
    ...overrides,
  };
}

describe("ProjectionStream", () => {
  it("sends snapshot with locks on join, batches commits into one delta, and delta round-trips via applyStateDelta", () => {
    const clock = createFakeClock();
    let currentView: CollabStateView = {
      seq: 1,
      roleId: BUILT_IN_ROLES.tab_director.id,
      tournament: { id: "tour-1", name: "Worlds" },
      teams: [{ id: "t-1", name: "Alpha" }],
      versions: { "team:t-1": 1 },
    };
    const locks: CollabLock[] = [
      {
        lockId: "lock-1",
        opType: "draw.generate",
        actorRef: "host",
        startedAt: "2026-01-01T00:00:00.000Z",
        roundId: "r-1",
      },
    ];

    const stream = new ProjectionStream(
      createBaseDeps({
        getView: () => currentView,
        getLocks: () => locks,
        now: clock.now,
        timers: clock.timers,
      }),
    );

    const dev = createFakeSession("dev-1", BUILT_IN_ROLES.tab_director);
    stream.addSession(dev.session);

    expect(dev.sent[0]).toEqual({
      schema: COLLAB_SCHEMA,
      kind: "snapshot",
      state: currentView,
      locks,
    });

    const snapshotState = (dev.sent[0] as unknown as SnapshotMessage).state;
    const sentBeforeCommit = dev.sent.length;

    currentView = {
      seq: 4,
      roleId: BUILT_IN_ROLES.tab_director.id,
      tournament: { id: "tour-1", name: "Worlds" },
      teams: [
        { id: "t-1", name: "Alpha" },
        { id: "t-2", name: "Beta" },
      ],
      versions: { "team:t-1": 1, "team:t-2": 1 },
    };

    stream.notifyCommitted("team.create");
    stream.notifyCommitted("team.rename");
    stream.notifyCommitted("draw.save");
    expect(dev.sent).toHaveLength(sentBeforeCommit);

    clock.advanceBy(COLLAB_DELTA_BATCH_MS - 1);
    expect(dev.sent).toHaveLength(sentBeforeCommit);

    clock.advanceBy(1);
    const deltas = dev.sent.slice(sentBeforeCommit).filter((m) => m.kind === "delta");
    expect(deltas).toHaveLength(1);

    const deltaMsg = deltas[0] as unknown as DeltaMessage;
    expect(deltaMsg.fromSeq).toBe(1);
    expect(deltaMsg.toSeq).toBe(4);
    expect(deltaMsg.opTypes).toEqual(["team.create", "team.rename", "draw.save"]);

    const reconstructed = applyStateDelta(snapshotState, deltaMsg.delta);
    expect(stableEqual(reconstructed, currentView)).toBe(true);
  });

  it("never leaks feedback records or keys to equity while delivering them to tab_director", () => {
    const clock = createFakeClock();
    let seq = 1;
    let includeFeedback = false;

    const getView = (role: Role): CollabStateView => {
      const base: CollabStateView = {
        seq,
        roleId: role.id,
        teams: [{ id: "t-1", name: "Alpha" }],
        versions: { "team:t-1": 1 },
      };
      if (role.id === BUILT_IN_ROLES.tab_director.id) {
        return {
          ...base,
          feedback: includeFeedback
            ? [{ id: "feedback-1", score: 8, comment: "Great chair" }]
            : [],
          versions: {
            "team:t-1": 1,
            ...(includeFeedback ? { "feedback:feedback-1": 1 } : {}),
          },
        };
      }
      return base;
    };

    const stream = new ProjectionStream(
      createBaseDeps({
        getView,
        now: clock.now,
        timers: clock.timers,
      }),
    );

    const equity = createFakeSession("dev-eq", BUILT_IN_ROLES.equity);
    const director = createFakeSession("dev-td", BUILT_IN_ROLES.tab_director);
    stream.addSession(equity.session);
    stream.addSession(director.session);

    seq = 2;
    includeFeedback = true;
    stream.notifyCommitted("round.release");
    clock.advanceBy(COLLAB_DELTA_BATCH_MS);

    for (const msg of equity.sent) {
      const serialized = JSON.stringify(msg);
      expect(serialized).not.toContain("feedback");
    }

    const directorDelta = director.sent.find((m) => m.kind === "delta") as unknown as DeltaMessage | undefined;
    expect(directorDelta).toBeDefined();
    expect(JSON.stringify(directorDelta)).toContain("feedback-1");
  });

  it("shares one baseline per role, calls getView once per role per flush, and sends identical deltas", () => {
    const clock = createFakeClock();
    let seq = 1;
    let getViewCalls = 0;

    const stream = new ProjectionStream(
      createBaseDeps({
        getView: (role) => {
          getViewCalls += 1;
          return {
            seq,
            roleId: role.id,
            teams: [{ id: "t-1", name: `Alpha-${seq}` }],
          };
        },
        now: clock.now,
        timers: clock.timers,
      }),
    );

    const d1 = createFakeSession("dev-1", BUILT_IN_ROLES.tab_director);
    const d2 = createFakeSession("dev-2", BUILT_IN_ROLES.tab_director);
    stream.addSession(d1.session);
    stream.addSession(d2.session);

    getViewCalls = 0;
    seq = 2;
    stream.notifyCommitted("team.update");
    clock.advanceBy(COLLAB_DELTA_BATCH_MS);

    expect(getViewCalls).toBe(1);
    const delta1 = d1.sent.find((m) => m.kind === "delta");
    const delta2 = d2.sent.find((m) => m.kind === "delta");
    expect(delta1).toBeDefined();
    expect(delta1).toEqual(delta2);
  });

  it("executes requests with device actor, flushes delta before submit/undo response, and handles errors", async () => {
    const clock = createFakeClock();
    let seq = 1;
    const receivedActors: Actor[] = [];
    const calls: Array<{ method: CollabRequestMethod; params: unknown[] }> = [];

    const stream = new ProjectionStream(
      createBaseDeps({
        getView: (role) => ({
          seq,
          roleId: role.id,
          teams: [{ id: "t-1", name: `Name-${seq}` }],
        }),
        handleRequest: async (method, params, actor) => {
          calls.push({ method, params });
          receivedActors.push(actor);
          if (method === "cancelLong") {
            throw new Error("Cannot cancel lock");
          }
          seq = 2;
          stream.notifyCommitted("team.rename");
          return { ok: true, seq: 2 };
        },
        now: clock.now,
        timers: clock.timers,
      }),
    );

    const dev = createFakeSession("dev-42", BUILT_IN_ROLES.adjudication_core);
    stream.addSession(dev.session);
    const initialLen = dev.sent.length;

    dev.emitMessage({
      schema: COLLAB_SCHEMA,
      kind: "request",
      requestId: "req-1",
      method: "submit",
      params: [{ type: "team.rename", payload: { id: "t-1", name: "Name-2" } }],
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(receivedActors).toEqual([
      {
        ref: "device:dev-42",
        type: "human",
        role: BUILT_IN_ROLES.adjudication_core,
        isHostOwner: false,
      },
    ]);
    expect(calls[0]?.method).toBe("submit");

    const afterSubmit = dev.sent.slice(initialLen);
    expect(afterSubmit.map((m) => m.kind)).toEqual(["delta", "response"]);
    expect(afterSubmit[1]).toEqual({
      schema: COLLAB_SCHEMA,
      kind: "response",
      requestId: "req-1",
      ok: true,
      value: { ok: true, seq: 2 },
    });

    // Rejecting handleRequest yields ok: false with error message
    dev.emitMessage({
      schema: COLLAB_SCHEMA,
      kind: "request",
      requestId: "req-2",
      method: "cancelLong",
      params: ["lock-99"],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(dev.sent.at(-1)).toEqual({
      schema: COLLAB_SCHEMA,
      kind: "response",
      requestId: "req-2",
      ok: false,
      error: "Cannot cancel lock",
    });

    // Invalid request shapes: with requestId -> ok: false; without requestId -> ignored
    const lenBeforeInvalid = dev.sent.length;
    dev.emitMessage({
      schema: COLLAB_SCHEMA,
      kind: "request",
      requestId: "req-bad",
      method: "unknownMethod",
      params: [],
    });
    expect(dev.sent).toHaveLength(lenBeforeInvalid + 1);
    expect(dev.sent.at(-1)).toEqual({
      schema: COLLAB_SCHEMA,
      kind: "response",
      requestId: "req-bad",
      ok: false,
      error: "Invalid request",
    });

    dev.emitMessage({
      schema: COLLAB_SCHEMA,
      kind: "request",
      method: "submit",
      params: [],
    });
    expect(dev.sent).toHaveLength(lenBeforeInvalid + 1);
  });

  it("handles resync, presence throttling with trailing broadcast, host presence, close, replacement, and send errors", () => {
    const clock = createFakeClock(10_000);
    let seq = 1;
    const locks: CollabLock[] = [];

    const stream = new ProjectionStream(
      createBaseDeps({
        getView: (role) => ({
          seq,
          roleId: role.id,
          teams: [{ id: "t-1", name: `T-${seq}` }],
        }),
        getLocks: () => locks,
        deviceName: (id) => (id === "dev-1" ? "Rafi laptop" : id),
        now: clock.now,
        timers: clock.timers,
      }),
    );

    stream.setHostPresence({ name: "Host Tab", view: "overview", roundId: "r-1" });

    const dev1 = createFakeSession("dev-1", BUILT_IN_ROLES.tab_director);
    const dev2 = createFakeSession("dev-2", BUILT_IN_ROLES.equity);
    stream.addSession(dev1.session);
    stream.addSession(dev2.session);
    expect(stream.sessionCount()).toBe(2);

    // Presence includes host entry and deviceName
    expect(stream.presence()).toEqual([
      {
        deviceId: "host",
        name: "Host Tab",
        roleId: BUILT_IN_ROLES.host_owner.id,
        since: new Date(10_000).toISOString(),
        view: "overview",
        roundId: "r-1",
      },
      {
        deviceId: "dev-1",
        name: "Rafi laptop",
        roleId: BUILT_IN_ROLES.tab_director.id,
        since: new Date(10_000).toISOString(),
      },
      {
        deviceId: "dev-2",
        name: "dev-2",
        roleId: BUILT_IN_ROLES.equity.id,
        since: new Date(10_000).toISOString(),
      },
    ]);

    // set_presence sanitizes fields and throttles per device with trailing broadcast
    const countBeforePresence = dev2.sent.length;
    dev1.emitMessage({
      schema: COLLAB_SCHEMA,
      kind: "set_presence",
      view: "allocation",
      roundId: "r-3",
      debateId: "x".repeat(101), // dropped (>100 chars)
      extra: "ignored",
    });
    expect(dev2.sent).toHaveLength(countBeforePresence + 1);
    expect(dev2.sent.at(-1)).toEqual({
      schema: COLLAB_SCHEMA,
      kind: "presence",
      entries: expect.arrayContaining([
        expect.objectContaining({
          deviceId: "dev-1",
          view: "allocation",
          roundId: "r-3",
        }),
      ]),
    });
    const firstPresenceMsg = JSON.stringify(dev2.sent.at(-1));
    expect(firstPresenceMsg).not.toContain("debateId");
    expect(firstPresenceMsg).not.toContain("extra");

    // Rapid updates within throttle window coalesce into trailing broadcast with latest value
    clock.advanceBy(50);
    dev1.emitMessage({
      schema: COLLAB_SCHEMA,
      kind: "set_presence",
      view: "ballots",
      debateId: "d-1",
    });
    clock.advanceBy(50);
    dev1.emitMessage({
      schema: COLLAB_SCHEMA,
      kind: "set_presence",
      view: "ballots",
      debateId: "d-2",
    });
    expect(dev2.sent).toHaveLength(countBeforePresence + 1);

    clock.advanceBy(COLLAB_PRESENCE_THROTTLE_MS - 100);
    expect(dev2.sent).toHaveLength(countBeforePresence + 2);
    const dev1Entry = stream.presence().find((e) => e.deviceId === "dev-1");
    expect(dev1Entry?.debateId).toBe("d-2");

    // resync flushes pending view and sends snapshot only to requesting session
    seq = 2;
    stream.notifyCommitted("team.rename");
    clock.advanceBy(COLLAB_DELTA_BATCH_MS);
    const dev2LenBeforeResync = dev2.sent.length;
    dev1.emitMessage({ schema: COLLAB_SCHEMA, kind: "resync" });
    expect(dev1.sent.at(-1)).toEqual({
      schema: COLLAB_SCHEMA,
      kind: "snapshot",
      state: { seq: 2, roleId: BUILT_IN_ROLES.tab_director.id, teams: [{ id: "t-1", name: "T-2" }] },
      locks: [],
    });
    expect(dev2.sent).toHaveLength(dev2LenBeforeResync);

    // Throwing send on one session does not stop delivery to others
    dev1.setThrowOnSend(true);
    locks.push({
      lockId: "l-1",
      opType: "draw.generate",
      actorRef: "host",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    stream.notifyLocksChanged();
    expect(dev2.sent.at(-1)).toEqual({
      schema: COLLAB_SCHEMA,
      kind: "locks",
      locks,
    });
    dev1.setThrowOnSend(false);

    // Replacing a session with the same deviceId stops messages to the old session
    const dev1Replacement = createFakeSession("dev-1", BUILT_IN_ROLES.tab_director);
    const dev1LenBeforeReplace = dev1.sent.length;
    stream.addSession(dev1Replacement.session);
    expect(stream.sessionCount()).toBe(2);
    stream.notifyLocksChanged();
    expect(dev1.sent).toHaveLength(dev1LenBeforeReplace);
    expect(dev1Replacement.sent.at(-1)).toEqual({
      schema: COLLAB_SCHEMA,
      kind: "locks",
      locks,
    });

    // Closing a session removes it, updates presence, and stops further sends
    const dev1ReplLenBeforeClose = dev1Replacement.sent.length;
    dev2.emitClose();
    expect(stream.sessionCount()).toBe(1);
    expect(stream.presence().map((e) => e.deviceId)).toEqual(["host", "dev-1"]);
    expect(dev1Replacement.sent).toHaveLength(dev1ReplLenBeforeClose + 1);
    expect(dev1Replacement.sent.at(-1)?.kind).toBe("presence");

    const dev2LenAfterClose = dev2.sent.length;
    stream.notifyLocksChanged();
    expect(dev2.sent).toHaveLength(dev2LenAfterClose);

    // dispose clears timers and prevents further activity
    stream.notifyCommitted("team.create");
    expect(clock.activeTimeoutCount()).toBe(1);
    stream.dispose();
    expect(clock.activeTimeoutCount()).toBe(0);
    expect(stream.sessionCount()).toBe(0);
  });
});
