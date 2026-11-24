import https from "node:https";
import { BUILT_IN_ROLES, type Role } from "@simpletab/core/permissions";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  COLLAB_SCHEMA,
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_WRONG_ATTEMPTS,
  type HostIdentity,
  type PendingJoin,
} from "../../common/collab-protocol";
import { CollabClient, type CollabConnection } from "./device-client";
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

interface StoredDevice {
  deviceId: string;
  name: string;
  role: Role;
  fingerprint: string;
  removed: boolean;
}

function createHarness(opts: {
  hostCert: CollabCertificate;
  now?: () => number;
  approvalTimeoutMs?: number;
  heartbeatMs?: number;
}) {
  const codes = new PairingCodes(opts.now !== undefined ? { now: opts.now } : {});
  const devices = new Map<string, StoredDevice>();
  const pendingJoins: PendingJoin[] = [];
  const sessions: DeviceSession[] = [];
  const lookupCalls: string[] = [];
  let nextDeviceNum = 1;

  const registry: DeviceRegistry = {
    approve: async ({ deviceName, roleId, fingerprint }) => {
      const role =
        roleId in BUILT_IN_ROLES
          ? BUILT_IN_ROLES[roleId as keyof typeof BUILT_IN_ROLES]
          : { id: roleId, name: roleId, permissions: [] };
      const deviceId = `device-${nextDeviceNum++}`;
      devices.set(deviceId, {
        deviceId,
        name: deviceName,
        role,
        fingerprint,
        removed: false,
      });
      return { deviceId, role };
    },
    lookup: (deviceId) => {
      lookupCalls.push(deviceId);
      const found = devices.get(deviceId);
      if (found === undefined) {
        return undefined;
      }
      return {
        fingerprint: found.fingerprint,
        role: found.role,
        removed: found.removed,
        name: found.name,
      };
    },
  };

  const hostIdentity: HostIdentity = {
    hostNumber: 1,
    hostId: "host-uuid-1",
    hostRank: 1,
    certFingerprint: opts.hostCert.fingerprint,
  };

  const server = new CollabServer({
    certificate: opts.hostCert,
    codes,
    registry,
    getHostIdentity: () => hostIdentity,
    onPendingJoin: (join) => pendingJoins.push(join),
    onDeviceConnected: (session) => sessions.push(session),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.approvalTimeoutMs !== undefined
      ? { approvalTimeoutMs: opts.approvalTimeoutMs }
      : {}),
    ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
  });

  cleanupCallbacks.push(() => server.close());

  return { server, codes, devices, pendingJoins, sessions, lookupCalls, hostIdentity };
}

describe("CollabClient + CollabServer integration", () => {
  it("completes the full pairing happy path with matching words and real device fingerprint", async () => {
    const hostCert = await generateSelfSignedCertificate({ commonName: "host" });
    const deviceCert = await generateSelfSignedCertificate({ commonName: "device" });
    const harness = createHarness({ hostCert });
    const { port } = await harness.server.listen(0, "127.0.0.1");
    const url = `wss://127.0.0.1:${port}`;

    const issued = harness.codes.issue("tab_director");
    let clientWords: string[] | undefined;

    const pairPromise = CollabClient.pair({
      url,
      certificate: deviceCert,
      code: issued.code,
      deviceName: "Rafi's Laptop",
      onWords: (words) => {
        clientWords = words;
      },
    });

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (harness.pendingJoins.length === 1) {
          clearInterval(check);
          resolve();
        }
      }, 5);
    });

    const pending = harness.pendingJoins[0]!;
    expect(clientWords).toHaveLength(6);
    expect(pending.words).toEqual(clientWords);
    expect(pending.deviceName).toBe("Rafi's Laptop");
    expect(pending.roleId).toBe("tab_director");
    expect(pending.deviceFingerprint).toBe(deviceCert.fingerprint);

    await harness.server.approveJoin(pending.joinId);
    const result = await pairPromise;

    expect(result).toEqual({
      ok: true,
      deviceId: "device-1",
      role: BUILT_IN_ROLES.tab_director,
      host: harness.hostIdentity,
      hostFingerprint: hostCert.fingerprint,
    });
    expect(harness.devices.get("device-1")?.fingerprint).toBe(deviceCert.fingerprint);
  });

  it("enforces BAD_CODE, 5-attempt LOCKED_OUT, single-use, and TTL expiry", async () => {
    let nowMs = 1_700_000_000_000;
    const hostCert = await generateSelfSignedCertificate({ commonName: "host" });
    const deviceCert = await generateSelfSignedCertificate({ commonName: "device" });
    const harness = createHarness({ hostCert, now: () => nowMs });
    const { port } = await harness.server.listen(0, "127.0.0.1");
    const url = `wss://127.0.0.1:${port}`;

    const valid = harness.codes.issue("tab_assistant");
    for (let i = 1; i < PAIRING_MAX_WRONG_ATTEMPTS; i++) {
      const wrong = await CollabClient.pair({
        url,
        certificate: deviceCert,
        code: "99999999",
        deviceName: "Staff",
        onWords: () => undefined,
      });
      expect(wrong).toEqual({ ok: false, reason: "BAD_CODE" });
    }

    const lockout = await CollabClient.pair({
      url,
      certificate: deviceCert,
      code: "99999999",
      deviceName: "Staff",
      onWords: () => undefined,
    });
    expect(lockout).toEqual({ ok: false, reason: "LOCKED_OUT" });

    // Even the valid code was cancelled by lockout.
    const validAfterLockout = await CollabClient.pair({
      url,
      certificate: deviceCert,
      code: valid.code,
      deviceName: "Staff",
      onWords: () => undefined,
    });
    expect(validAfterLockout).toEqual({ ok: false, reason: "LOCKED_OUT" });

    // Issue fresh code -> single use succeeds, reuse returns BAD_CODE.
    const fresh = harness.codes.issue("equity");
    const okPair = CollabClient.pair({
      url,
      certificate: deviceCert,
      code: fresh.code,
      deviceName: "Equity",
      onWords: () => undefined,
    });
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (harness.pendingJoins.length === 1) {
          clearInterval(check);
          resolve();
        }
      }, 5);
    });
    await harness.server.approveJoin(harness.pendingJoins[0]!.joinId);
    expect((await okPair).ok).toBe(true);

    const reuse = await CollabClient.pair({
      url,
      certificate: deviceCert,
      code: fresh.code,
      deviceName: "Equity",
      onWords: () => undefined,
    });
    expect(reuse).toEqual({ ok: false, reason: "BAD_CODE" });

    // Expiry via injected clock.
    const expiring = harness.codes.issue("display");
    nowMs += PAIRING_CODE_TTL_MS;
    const expiredResult = await CollabClient.pair({
      url,
      certificate: deviceCert,
      code: expiring.code,
      deviceName: "Display",
      onWords: () => undefined,
    });
    expect(expiredResult).toEqual({ ok: false, reason: "BAD_CODE" });
  });

  it("handles rejectJoin -> REJECTED and approval timeout -> TIMEOUT", async () => {
    const hostCert = await generateSelfSignedCertificate({ commonName: "host" });
    const deviceCert = await generateSelfSignedCertificate({ commonName: "device" });
    const harness = createHarness({ hostCert, approvalTimeoutMs: 50 });
    const { port } = await harness.server.listen(0, "127.0.0.1");
    const url = `wss://127.0.0.1:${port}`;

    const code1 = harness.codes.issue("tab_director").code;
    const rejectPromise = CollabClient.pair({
      url,
      certificate: deviceCert,
      code: code1,
      deviceName: "Device A",
      onWords: () => undefined,
    });
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (harness.pendingJoins.length === 1) {
          clearInterval(check);
          resolve();
        }
      }, 5);
    });
    harness.server.rejectJoin(harness.pendingJoins[0]!.joinId);
    expect(await rejectPromise).toEqual({ ok: false, reason: "REJECTED" });

    const code2 = harness.codes.issue("tab_director").code;
    const timeoutResult = await CollabClient.pair({
      url,
      certificate: deviceCert,
      code: code2,
      deviceName: "Device B",
      onWords: () => undefined,
    });
    expect(timeoutResult).toEqual({ ok: false, reason: "TIMEOUT" });
  });

  it("handles reconnects, refusals, pinned host mismatch, message forwarding, heartbeat, and session replacement", async () => {
    const hostCert = await generateSelfSignedCertificate({ commonName: "host" });
    const deviceCert = await generateSelfSignedCertificate({ commonName: "device" });
    const otherCert = await generateSelfSignedCertificate({ commonName: "other-device" });
    const wrongHostCert = await generateSelfSignedCertificate({ commonName: "evil-host" });
    const harness = createHarness({ hostCert });
    const { port } = await harness.server.listen(0, "127.0.0.1");
    const url = `wss://127.0.0.1:${port}`;

    // Unknown device
    expect(
      await CollabClient.connect({
        url,
        certificate: deviceCert,
        deviceId: "missing",
        pinnedHostFingerprint: hostCert.fingerprint,
        lastSeq: 0,
      }),
    ).toEqual({ ok: false, reason: "UNKNOWN_DEVICE" });

    // Seed approved device
    harness.devices.set("device-1", {
      deviceId: "device-1",
      name: "Floor Laptop",
      role: BUILT_IN_ROLES.tab_director,
      fingerprint: deviceCert.fingerprint,
      removed: false,
    });

    // Wrong pinned host fingerprint -> HOST_CERT_MISMATCH before hello is ever sent
    const lookupsBeforeMismatch = harness.lookupCalls.length;
    expect(
      await CollabClient.connect({
        url,
        certificate: deviceCert,
        deviceId: "device-1",
        pinnedHostFingerprint: wrongHostCert.fingerprint,
        lastSeq: 0,
      }),
    ).toEqual({ ok: false, reason: "HOST_CERT_MISMATCH" });
    expect(harness.lookupCalls).toHaveLength(lookupsBeforeMismatch);

    // Different client cert -> KEY_MISMATCH
    expect(
      await CollabClient.connect({
        url,
        certificate: otherCert,
        deviceId: "device-1",
        pinnedHostFingerprint: hostCert.fingerprint,
        lastSeq: 0,
      }),
    ).toEqual({ ok: false, reason: "KEY_MISMATCH" });

    // Successful connect
    const conn1Result = await CollabClient.connect({
      url,
      certificate: deviceCert,
      deviceId: "device-1",
      pinnedHostFingerprint: hostCert.fingerprint,
      lastSeq: 5,
      heartbeatMs: 25,
    });
    expect(conn1Result.ok).toBe(true);
    if (!conn1Result.ok) return;
    const conn1: CollabConnection = conn1Result.connection;
    cleanupCallbacks.push(() => conn1.close());

    expect(conn1.welcome).toEqual({
      schema: COLLAB_SCHEMA,
      kind: "welcome",
      deviceId: "device-1",
      role: BUILT_IN_ROLES.tab_director,
      host: harness.hostIdentity,
    });

    const serverSession1 = harness.sessions[0]!;
    const receivedByServer: unknown[] = [];
    const receivedByClient: unknown[] = [];
    serverSession1.onMessage((msg) => receivedByServer.push(msg));
    conn1.onMessage((msg) => receivedByClient.push(msg));

    conn1.send({ schema: 1, kind: "op_submit", opId: "op-1" });
    serverSession1.send({ schema: 1, kind: "delta", seq: 6 });

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (receivedByServer.length === 1 && receivedByClient.length === 1) {
          clearInterval(check);
          resolve();
        }
      }, 5);
    });

    expect(receivedByServer[0]).toEqual({ schema: 1, kind: "op_submit", opId: "op-1" });
    expect(receivedByClient[0]).toEqual({ schema: 1, kind: "delta", seq: 6 });

    // Wait briefly to let automatic client heartbeat ping/pong cycle without breaking the session.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(harness.server.connected()).toHaveLength(1);

    // Second connection with same deviceId closes the first.
    const conn1Closed = new Promise<number>((resolve) => {
      conn1.onClose((code) => resolve(code));
    });
    const conn2Result = await CollabClient.connect({
      url,
      certificate: deviceCert,
      deviceId: "device-1",
      pinnedHostFingerprint: hostCert.fingerprint,
      lastSeq: 6,
    });
    expect(conn2Result.ok).toBe(true);
    if (!conn2Result.ok) return;
    cleanupCallbacks.push(() => conn2Result.connection.close());

    expect(await conn1Closed).toBe(1000);
    expect(harness.server.connected()).toHaveLength(1);
    conn2Result.connection.close();

    // Removed device -> REMOVED
    harness.devices.get("device-1")!.removed = true;
    expect(
      await CollabClient.connect({
        url,
        certificate: deviceCert,
        deviceId: "device-1",
        pinnedHostFingerprint: hostCert.fingerprint,
        lastSeq: 6,
      }),
    ).toEqual({ ok: false, reason: "REMOVED" });
  });

  it("refuses MITM or mismatched words/hostFingerprint during pairing with PROTOCOL", async () => {
    const serverCert = await generateSelfSignedCertificate({ commonName: "mitm-host" });
    const deviceCert = await generateSelfSignedCertificate({ commonName: "device" });

    const httpsServer = https.createServer({
      cert: serverCert.certPem,
      key: serverCert.keyPem,
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: "TLSv1.3",
    });
    const wss = new WebSocketServer({ server: httpsServer });
    wss.on("connection", (ws) => {
      ws.on("message", () => {
        ws.send(
          JSON.stringify({
            schema: COLLAB_SCHEMA,
            kind: "pair_pending",
            words: ["wrong", "wrong", "wrong", "wrong", "wrong", "wrong"],
          }),
        );
      });
    });

    await new Promise<void>((resolve) => httpsServer.listen(0, "127.0.0.1", resolve));
    cleanupCallbacks.push(async () => {
      wss.close();
      await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
    });

    const address = httpsServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected TCP port");
    }

    const result = await CollabClient.pair({
      url: `wss://127.0.0.1:${address.port}`,
      certificate: deviceCert,
      code: "12345678",
      deviceName: "Device",
      onWords: () => undefined,
    });
    expect(result).toEqual({ ok: false, reason: "PROTOCOL" });
  });
});
