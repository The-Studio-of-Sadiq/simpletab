import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostEngine } from "../engine/engine";
import { HOST_OWNER_ACTOR } from "../host-service";
import { CollabClient } from "../collab/device-client";
import { generateSelfSignedCertificate } from "../collab/tls";
import { makeState } from "../publish/publish-test-fixtures";
import { COLLAB_DIR_NAME, HostCollab } from "./host-collab";

describe("HostCollab (host engine + device client over real TLS)", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setup() {
    const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "simpletab-collab-"));
    cleanups.push(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const engine = HostEngine.open(path.join(workspaceDir, "t.simpletab.db"), {
      initialState: makeState(),
    });
    cleanups.push(() => engine.close());
    const meta = new Map<string, string>();
    const onChanged = vi.fn();
    const collab = new HostCollab({
      engine: {
        getState: () => engine.getState(),
        submit: (request, actor) => engine.submit(request, actor),
        readMeta: (key) => meta.get(key),
        writeMeta: (key, value) => {
          meta.set(key, value);
        },
      },
      workspaceDir,
      hostOwner: HOST_OWNER_ACTOR,
      getHostIdentity: () => ({ hostNumber: 1, hostId: "host-a", hostRank: 1 }),
      onChanged,
    });
    cleanups.push(() => collab.stop());
    await collab.start(0, "127.0.0.1");
    const status = await collab.status();
    const url = `wss://127.0.0.1:${status.port}`;
    const deviceCert = await generateSelfSignedCertificate({ commonName: "Rafi's laptop" });
    return { workspaceDir, engine, collab, url, deviceCert, onChanged };
  }

  async function waitForPendingJoin(collab: HostCollab) {
    for (let i = 0; i < 100; i += 1) {
      const status = await collab.status();
      if (status.pendingJoins.length > 0) return status.pendingJoins[0]!;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("No pending join appeared");
  }

  it("pairs a device as a recorded op, reconnects it, and refuses it once removed", async () => {
    const t = await setup();
    const issued = t.collab.issueCode("tab_director");
    let deviceWords: string[] = [];

    const pairing = CollabClient.pair({
      url: t.url,
      certificate: t.deviceCert,
      code: issued.code,
      deviceName: "Rafi's laptop",
      onWords: (words) => {
        deviceWords = words;
      },
    });
    const join = await waitForPendingJoin(t.collab);
    expect(join.words).toHaveLength(6);
    expect(join.words).toEqual(deviceWords);
    expect(join.deviceFingerprint).toBe(t.deviceCert.fingerprint);
    await t.collab.approveJoin(join.joinId);

    const paired = await pairing;
    expect(paired.ok).toBe(true);
    if (!paired.ok) return;
    expect(paired.role.id).toBe("tab_director");
    const status = await t.collab.status();
    expect(paired.hostFingerprint).toBe(status.hostFingerprint);

    // The approval is an op in the log, with the device's certificate fingerprint as its key.
    const device = t.engine.getState()!.devices.find((d) => d.id === paired.deviceId)!;
    expect(device).toMatchObject({ name: "Rafi's laptop", publicKey: `sha256:${t.deviceCert.fingerprint}` });
    expect(status.codes).toEqual([]);

    const connected = await CollabClient.connect({
      url: t.url,
      certificate: t.deviceCert,
      deviceId: paired.deviceId,
      pinnedHostFingerprint: paired.hostFingerprint,
      lastSeq: 0,
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    await vi.waitFor(async () => {
      const now = await t.collab.status();
      expect(now.devices).toEqual([expect.objectContaining({ deviceId: paired.deviceId, connected: true })]);
    });

    const closed = new Promise<void>((resolve) => {
      connected.connection.onClose(() => resolve());
    });
    await t.collab.removeDevice(paired.deviceId);
    await closed;
    expect(t.engine.getState()!.devices).toEqual([]);

    const again = await CollabClient.connect({
      url: t.url,
      certificate: t.deviceCert,
      deviceId: paired.deviceId,
      pinnedHostFingerprint: paired.hostFingerprint,
      lastSeq: 0,
    });
    expect(again).toEqual({ ok: false, reason: "REMOVED" });
  });

  it("keeps the host certificate across restarts, outside the tournament file", async () => {
    const t = await setup();
    const first = (await t.collab.status()).hostFingerprint;
    await t.collab.stop();
    expect((await t.collab.status()).running).toBe(false);
    await t.collab.start(0, "127.0.0.1");
    expect((await t.collab.status()).hostFingerprint).toBe(first);
    const file = path.join(t.workspaceDir, COLLAB_DIR_NAME, "host-certificate.json");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("PRIVATE KEY");
    const db = readFileSync(path.join(t.workspaceDir, "t.simpletab.db"));
    expect(db.includes(Buffer.from("PRIVATE KEY"))).toBe(false);
  });

  it("only issues codes while running and for pairable roles", async () => {
    const t = await setup();
    expect(() => t.collab.issueCode("host_owner")).toThrow(/cannot be paired/);
    await t.collab.stop();
    expect(() => t.collab.issueCode("tab_director")).toThrow(/Allow devices to connect/);
  });

  it("refuses a rejected join without recording a device", async () => {
    const t = await setup();
    const issued = t.collab.issueCode("equity");
    const pairing = CollabClient.pair({
      url: t.url,
      certificate: t.deviceCert,
      code: issued.code,
      deviceName: "Equity laptop",
      onWords: () => undefined,
    });
    const join = await waitForPendingJoin(t.collab);
    t.collab.rejectJoin(join.joinId);
    expect(await pairing).toEqual({ ok: false, reason: "REJECTED" });
    expect(t.engine.getState()!.devices).toEqual([]);
  });
});
