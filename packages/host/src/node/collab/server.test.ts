import https from "node:https";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  COLLAB_CLOSE,
  type HostIdentity,
  type PendingJoin,
} from "../../common/collab-protocol";
import { PairingCodes } from "./pairing-codes";
import { CollabServer, type DeviceRegistry, type DeviceSession } from "./server";
import { generateSelfSignedCertificate, type CollabCertificate } from "./tls";

const cleanupCallbacks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanupCallbacks.length > 0) {
    const fn = cleanupCallbacks.pop()!;
    await fn();
  }
});

function createAgent(cert?: CollabCertificate): https.Agent {
  const agent = new https.Agent({
    ...(cert !== undefined ? { cert: cert.certPem, key: cert.keyPem } : {}),
    rejectUnauthorized: false,
    minVersion: "TLSv1.3",
    checkServerIdentity: () => undefined,
    keepAlive: false,
  });
  cleanupCallbacks.push(() => agent.destroy());
  return agent;
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
    ws.once("error", reject);
  });
}

function createHostIdentity(cert: CollabCertificate): HostIdentity {
  return {
    hostNumber: 1,
    hostId: "host-1",
    hostRank: 1,
    certFingerprint: cert.fingerprint,
  };
}

describe("CollabServer", () => {
  it("closes connections without a client certificate with 4401", async () => {
    const hostCert = await generateSelfSignedCertificate({ commonName: "host" });
    const server = new CollabServer({
      certificate: hostCert,
      codes: new PairingCodes(),
      registry: {
        approve: async () => ({ deviceId: "d1", role: BUILT_IN_ROLES.tab_director }),
        lookup: () => undefined,
      },
      getHostIdentity: () => createHostIdentity(hostCert),
    });
    cleanupCallbacks.push(() => server.close());

    const { port } = await server.listen(0, "127.0.0.1");
    const ws = new WebSocket(`wss://127.0.0.1:${port}`, { agent: createAgent() });
    const closed = await waitForClose(ws);
    expect(closed.code).toBe(COLLAB_CLOSE.NO_CLIENT_CERT);
  });

  it("closes connections with 4400 for bad first frames, invalid pair_request payloads, or timeout", async () => {
    const hostCert = await generateSelfSignedCertificate({ commonName: "host" });
    const deviceCert = await generateSelfSignedCertificate({ commonName: "device" });
    const server = new CollabServer({
      certificate: hostCert,
      codes: new PairingCodes(),
      registry: {
        approve: async () => ({ deviceId: "d1", role: BUILT_IN_ROLES.tab_director }),
        lookup: () => undefined,
      },
      getHostIdentity: () => createHostIdentity(hostCert),
      firstMessageTimeoutMs: 40,
    });
    cleanupCallbacks.push(() => server.close());

    const { port } = await server.listen(0, "127.0.0.1");

    const sendAndWaitClose = async (sendFn: (ws: WebSocket) => void): Promise<number> => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}`, { agent: createAgent(deviceCert) });
      const closedPromise = waitForClose(ws);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      sendFn(ws);
      return (await closedPromise).code;
    };

    expect(await sendAndWaitClose((ws) => ws.send("{not json"))).toBe(COLLAB_CLOSE.PROTOCOL);
    expect(
      await sendAndWaitClose((ws) => ws.send(JSON.stringify({ schema: 2, kind: "hello" }))),
    ).toBe(COLLAB_CLOSE.PROTOCOL);
    expect(
      await sendAndWaitClose((ws) => ws.send(JSON.stringify({ schema: 1, kind: "unknown" }))),
    ).toBe(COLLAB_CLOSE.PROTOCOL);
    expect(await sendAndWaitClose((ws) => ws.send(Buffer.from([1, 2, 3])))).toBe(
      COLLAB_CLOSE.PROTOCOL,
    );
    expect(
      await sendAndWaitClose((ws) =>
        ws.send(JSON.stringify({ schema: 1, kind: "pair_request", code: "12345678", deviceName: "   " })),
      ),
    ).toBe(COLLAB_CLOSE.PROTOCOL);
    expect(
      await sendAndWaitClose((ws) =>
        ws.send(
          JSON.stringify({
            schema: 1,
            kind: "pair_request",
            code: "12345678",
            deviceName: "x".repeat(61),
          }),
        ),
      ),
    ).toBe(COLLAB_CLOSE.PROTOCOL);
    expect(
      await sendAndWaitClose((ws) =>
        ws.send(
          JSON.stringify({
            schema: 1,
            kind: "pair_request",
            code: "12345678",
            deviceName: "bad\nname",
          }),
        ),
      ),
    ).toBe(COLLAB_CLOSE.PROTOCOL);
    expect(await sendAndWaitClose(() => undefined)).toBe(COLLAB_CLOSE.PROTOCOL);
  });

  it("refuses with REJECTED when registry.approve throws and cleans up on mid-pending close", async () => {
    const hostCert = await generateSelfSignedCertificate({ commonName: "host" });
    const deviceCert = await generateSelfSignedCertificate({ commonName: "device" });
    const codes = new PairingCodes();
    const pendingJoins: PendingJoin[] = [];
    const resolvedJoinIds: string[] = [];

    const server = new CollabServer({
      certificate: hostCert,
      codes,
      registry: {
        approve: async () => {
          throw new Error("DB failure");
        },
        lookup: () => undefined,
      },
      getHostIdentity: () => createHostIdentity(hostCert),
      onPendingJoin: (join) => pendingJoins.push(join),
      onJoinResolved: (joinId) => resolvedJoinIds.push(joinId),
    });
    cleanupCallbacks.push(() => server.close());

    const { port } = await server.listen(0, "127.0.0.1");

    // 1. registry.approve throws -> pair_result REJECTED
    const code1 = codes.issue("tab_director").code;
    const ws1 = new WebSocket(`wss://127.0.0.1:${port}`, { agent: createAgent(deviceCert) });
    const messages1: unknown[] = [];
    ws1.on("message", (d) => messages1.push(JSON.parse(d.toString())));
    await new Promise<void>((resolve) => ws1.once("open", resolve));
    ws1.send(JSON.stringify({ schema: 1, kind: "pair_request", code: code1, deviceName: "Staff 1" }));
    await new Promise<void>((resolve) => ws1.once("message", () => resolve()));

    expect(pendingJoins).toHaveLength(1);
    const closed1 = waitForClose(ws1);
    await server.approveJoin(pendingJoins[0]!.joinId);
    expect((await closed1).code).toBe(COLLAB_CLOSE.REFUSED);
    expect(messages1[1]).toEqual({ schema: 1, kind: "pair_result", ok: false, reason: "REJECTED" });
    expect(resolvedJoinIds).toContain(pendingJoins[0]!.joinId);

    // 2. Client closes socket while pending -> onJoinResolved fires
    const code2 = codes.issue("tab_director").code;
    const ws2 = new WebSocket(`wss://127.0.0.1:${port}`, { agent: createAgent(deviceCert) });
    await new Promise<void>((resolve) => ws2.once("open", resolve));
    ws2.send(JSON.stringify({ schema: 1, kind: "pair_request", code: code2, deviceName: "Staff 2" }));
    await new Promise<void>((resolve) => ws2.once("message", () => resolve()));
    expect(server.pendingJoins()).toHaveLength(1);

    const resolvedPromise = new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (resolvedJoinIds.length >= 2) {
          clearInterval(check);
          resolve();
        }
      }, 5);
    });
    ws2.close();
    await resolvedPromise;
    expect(server.pendingJoins()).toHaveLength(0);
  });

  it("answers ping with pong without forwarding, and terminates silent sessions after 3 heartbeats", async () => {
    const hostCert = await generateSelfSignedCertificate({ commonName: "host" });
    const deviceCert = await generateSelfSignedCertificate({ commonName: "device" });
    let nowMs = 1_000;
    const disconnected: string[] = [];
    const sessions: DeviceSession[] = [];
    const forwarded: unknown[] = [];

    const registry: DeviceRegistry = {
      approve: async () => ({ deviceId: "dev-1", role: BUILT_IN_ROLES.tab_director }),
      lookup: (id) =>
        id === "dev-1"
          ? {
              fingerprint: deviceCert.fingerprint,
              role: BUILT_IN_ROLES.tab_director,
              removed: false,
              name: "Rafi laptop",
            }
          : undefined,
    };

    const server = new CollabServer({
      certificate: hostCert,
      codes: new PairingCodes(),
      registry,
      getHostIdentity: () => createHostIdentity(hostCert),
      onDeviceConnected: (s) => {
        sessions.push(s);
        s.onMessage((m) => forwarded.push(m));
      },
      onDeviceDisconnected: (id) => disconnected.push(id),
      now: () => nowMs,
      heartbeatMs: 30,
    });
    cleanupCallbacks.push(() => server.close());

    const { port } = await server.listen(0, "127.0.0.1");
    const ws = new WebSocket(`wss://127.0.0.1:${port}`, { agent: createAgent(deviceCert) });
    const received: unknown[] = [];
    ws.on("message", (d) => received.push(JSON.parse(d.toString())));
    await new Promise<void>((resolve) => ws.once("open", resolve));
    ws.send(JSON.stringify({ schema: 1, kind: "hello", deviceId: "dev-1", lastSeq: 0 }));

    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (received.length >= 1) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });

    expect(server.connected()).toHaveLength(1);
    expect(server.connected()[0]!.name).toBe("Rafi laptop");

    ws.send(JSON.stringify({ schema: 1, kind: "ping", t: 42 }));
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (received.length >= 2) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });
    expect(received[1]).toEqual({ schema: 1, kind: "pong", t: 42 });
    expect(forwarded).toEqual([]);

    // Advance virtual clock past 3 * heartbeatMs without activity -> server terminates session.
    const closed = waitForClose(ws);
    nowMs += 100;
    await closed;
    expect(disconnected).toEqual(["dev-1"]);
    expect(server.connected()).toEqual([]);
  });

  it("fires session.onClose once when replaced by a newer connection and when client disconnects", async () => {
    const hostCert = await generateSelfSignedCertificate({ commonName: "host" });
    const deviceCert = await generateSelfSignedCertificate({ commonName: "device" });
    const sessions: DeviceSession[] = [];
    const closeCounts: number[] = [];

    const registry: DeviceRegistry = {
      approve: async () => ({ deviceId: "dev-1", role: BUILT_IN_ROLES.tab_director }),
      lookup: (id) =>
        id === "dev-1"
          ? {
              fingerprint: deviceCert.fingerprint,
              role: BUILT_IN_ROLES.tab_director,
              removed: false,
              name: "Rafi laptop",
            }
          : undefined,
    };

    const server = new CollabServer({
      certificate: hostCert,
      codes: new PairingCodes(),
      registry,
      getHostIdentity: () => createHostIdentity(hostCert),
      onDeviceConnected: (s) => {
        const idx = sessions.length;
        sessions.push(s);
        closeCounts.push(0);
        s.onClose(() => {
          closeCounts[idx]! += 1;
        });
      },
    });
    cleanupCallbacks.push(() => server.close());

    const { port } = await server.listen(0, "127.0.0.1");

    const connectHello = async (): Promise<WebSocket> => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}`, { agent: createAgent(deviceCert) });
      const welcomed = new Promise<void>((resolve, reject) => {
        ws.once("message", () => resolve());
        ws.once("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      ws.send(JSON.stringify({ schema: 1, kind: "hello", deviceId: "dev-1", lastSeq: 0 }));
      await welcomed;
      return ws;
    };

    const ws1 = await connectHello();
    const ws1Closed = waitForClose(ws1);
    const ws2 = await connectHello();
    await ws1Closed;
    expect(closeCounts).toEqual([1, 0]);

    const ws2Closed = new Promise<void>((resolve) => {
      sessions[1]!.onClose(() => resolve());
    });
    ws2.close();
    await ws2Closed;
    expect(closeCounts).toEqual([1, 1]);
  });
});
