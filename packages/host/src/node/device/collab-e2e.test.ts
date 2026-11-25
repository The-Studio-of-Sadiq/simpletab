import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedbackSubmission } from "@simpletab/core/types";
import type { HostServiceClient } from "../../common/host-protocol";
import { HostEngine } from "../engine/engine";
import { HostServiceImpl } from "../host-service";
import { DEBATE_ID, makeState, ROUND_ID } from "../publish/publish-test-fixtures";
import { DeviceMode } from "./device-mode";
import { PairingStore } from "./pairing-store";

const SECRET = "SECRET_FEEDBACK_TEXT";

/**
 * Design section 4.1 end to end: a real host service and two laptops in device mode, talking over
 * real TLS on 127.0.0.1. Covers pairing, snapshots, an edit made on a device reaching the other
 * device, role filtering (Equity never receives feedback), the offline outbox and removal.
 */
describe("live collaboration end to end", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  async function makeHost() {
    const dir = tempDir("simpletab-e2e-host-");
    const dbPath = path.join(dir, "publish-test.simpletab.db");
    const seed = HostEngine.open(dbPath, {
      initialState: makeState({
        releaseResults: true,
        feedback: [
          {
            id: "fb-1",
            tournamentId: "t-publish",
            roundId: ROUND_ID,
            debateId: DEBATE_ID,
            sourceType: "team",
            sourceId: "team-oo",
            targetType: "adjudicator",
            targetAdjudicatorId: "adj-chair",
            score: 3,
            answers: { comment: SECRET },
            confirmed: true,
            timestamp: "2026-11-24T11:00:00.000Z",
          } as unknown as FeedbackSubmission,
        ],
      }),
    });
    await seed.close();
    const host = new HostServiceImpl();
    host.setCollabListen({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => host.onStop());
    await host.openTournament(dbPath);
    const devices = await host.setDevicesEnabled(true);
    expect(devices.running).toBe(true);
    return { host, address: `127.0.0.1:${devices.port}` };
  }

  async function makeDevice(host: HostServiceImpl, address: string, roleId: string, name: string) {
    const service = new HostServiceImpl();
    const events: string[] = [];
    const client: HostServiceClient = { onStateChanged: (event) => events.push(event.type) };
    service.setClient(client);
    const store = new PairingStore(tempDir("simpletab-e2e-device-"));
    service.setDeviceMode(new DeviceMode({ store, onChange: () => events.push("change") }));
    cleanups.push(() => service.onStop());

    const { code } = await host.issuePairingCode(roleId);
    await service.startJoin({ address, code, deviceName: name });
    await vi.waitFor(async () => {
      expect((await host.getDevicesStatus()).pendingJoins).toHaveLength(1);
    });
    const join = (await host.getDevicesStatus()).pendingJoins[0]!;
    const progress = await service.getJoinProgress();
    expect(progress.words).toEqual(join.words);
    await host.approveJoin(join.joinId);
    await vi.waitFor(async () => {
      expect((await service.getJoinProgress()).state).toBe("joined");
      expect((await service.status()).open).toBe(true);
    });
    return { service, store, events };
  }

  it("streams role views, carries edits between devices, and keeps feedback from Equity", async () => {
    const { host, address } = await makeHost();
    const director = await makeDevice(host, address, "tab_director", "Director laptop");
    const equity = await makeDevice(host, address, "equity", "Equity laptop");

    const directorState = await director.service.getState();
    const equityState = await equity.service.getState();
    expect(directorState?.feedback.map((f) => f.id)).toEqual(["fb-1"]);
    expect(equityState?.feedback).toEqual([]);
    expect(JSON.stringify(equityState)).not.toContain(SECRET);
    expect(Object.keys(equityState?.versions ?? {}).some((key) => key.startsWith("feedback:"))).toBe(false);

    const status = await director.service.status();
    expect(status.device).toMatchObject({ connection: "connected", roleId: "tab_director" });

    // An edit on the director's laptop commits on the host as that device, and reaches Equity.
    const team = directorState!.teams.find((t) => t.id === "team-oo")!;
    const result = await director.service.submit({
      type: "team.update",
      payload: { team: { ...team, name: "Cambridge Renamed" } },
    });
    expect(result).toMatchObject({ ok: true });
    const hostState = await host.getState();
    expect(hostState?.teams.find((t) => t.id === "team-oo")?.name).toBe("Cambridge Renamed");
    // The device's own change has already arrived when submit returns.
    expect((await director.service.getState())?.teams.find((t) => t.id === "team-oo")?.name).toBe("Cambridge Renamed");
    await vi.waitFor(async () => {
      const seen = await equity.service.getState();
      expect(seen?.teams.find((t) => t.id === "team-oo")?.name).toBe("Cambridge Renamed");
      expect(seen?.seq).toBe(hostState?.seq);
    });
    const changelog = await host.getChangelog();
    expect(changelog.at(-1)?.entry.actorRef).toMatch(/^device:dev-/);

    // Equity's copy still has no feedback after the update.
    expect(JSON.stringify(await equity.service.getState())).not.toContain(SECRET);

    // Host-only actions are refused on a device, in words.
    await expect(director.service.publishNow()).rejects.toThrow(/joined to the host/);
  });

  it("queues edits while the host is unreachable and sends them in order when it is back", async () => {
    const { host, address } = await makeHost();
    const director = await makeDevice(host, address, "tab_director", "Director laptop");

    await host.setDevicesEnabled(false);
    await vi.waitFor(async () => {
      expect((await director.service.status()).device?.connection).not.toBe("connected");
    });
    const team = (await director.service.getState())!.teams.find((t) => t.id === "team-oo")!;
    const queued = await director.service.submit({
      type: "team.update",
      payload: { team: { ...team, name: "Offline Rename" } },
    });
    expect(queued).toMatchObject({ ok: false, code: "QUEUED" });
    expect((await director.service.status()).queuedOps).toBe(1);

    // Back on the same port, so the device's stored address still works.
    const port = Number(address.split(":")[1]);
    host.setCollabListen({ port, host: "127.0.0.1" });
    await host.setDevicesEnabled(true);
    await vi.waitFor(
      async () => {
        expect((await host.getState())?.teams.find((t) => t.id === "team-oo")?.name).toBe("Offline Rename");
        expect((await director.service.status()).queuedOps).toBe(0);
      },
      { timeout: 15_000, interval: 100 },
    );
  }, 30_000);

  it("wipes a removed device's copy and pairing", async () => {
    const { host, address } = await makeHost();
    const director = await makeDevice(host, address, "tab_director", "Director laptop");
    const deviceId = (await director.service.status()).device!.deviceId;
    expect(director.store.load()).toBeDefined();

    await host.removeDevice(deviceId);
    await vi.waitFor(
      async () => {
        expect((await director.service.status()).device?.connection).toBe("removed");
      },
      { timeout: 15_000, interval: 100 },
    );
    expect(await director.service.getState()).toBeNull();
    expect(director.store.load()).toBeUndefined();
  }, 30_000);

  it("promotes a tab director's copy when the host is down, and the old host steps down", async () => {
    // Created first so it is removed last, after the promoted laptop has closed its database.
    const newDir = tempDir("simpletab-e2e-promoted-");
    const { host, address } = await makeHost();
    const director = await makeDevice(host, address, "tab_director", "Director laptop");
    const equity = await makeDevice(host, address, "equity", "Equity laptop");

    // The director's full copy follows every commit.
    const team = (await host.getState())!.teams.find((t) => t.id === "team-og")!;
    expect(await host.submit({ type: "team.update", payload: { team: { ...team, name: "Before Failure" } } })).toMatchObject({ ok: true });
    const sharedSeq = (await host.status()).headSeq!;
    await vi.waitFor(async () => {
      expect((await director.service.status()).device?.copy?.lastSeq).toBe(sharedSeq);
    }, { timeout: 15_000, interval: 100 });

    // Promotion is refused while the host is reachable.
    await expect(director.service.promoteToHost({ directory: newDir })).rejects.toThrow(/still reachable/);

    // The host "dies" for the devices, but keeps working on its own: that op is divergent.
    await host.setDevicesEnabled(false);
    await vi.waitFor(async () => {
      expect((await director.service.status()).device?.connection).not.toBe("connected");
    });
    const team2 = (await host.getState())!.teams.find((t) => t.id === "team-og")!;
    expect(await host.submit({ type: "team.update", payload: { team: { ...team2, name: "Divergent Name" } } })).toMatchObject({ ok: true });

    const promoted = await director.service.promoteToHost({ directory: newDir });
    expect(promoted.open).toBe(true);
    expect(promoted.device).toBeUndefined();
    expect(promoted.hostNumber).toBe(2);
    expect(promoted.headSeq).toBe(sharedSeq + 1);
    const newState = await director.service.getState();
    expect(newState?.teams.find((t) => t.id === "team-og")?.name).toBe("Before Failure");
    const changelog = await director.service.getChangelog();
    expect(changelog.at(-1)?.entry.opType).toBe("host.promote");

    // A device that already knows the new host reaches the old one: the old host steps down.
    equity.store.saveBestHost({ hostNumber: 2, hostId: "promoted-host", hostRank: 1, certFingerprint: "", promotedFromSeq: sharedSeq });
    const port = Number(address.split(":")[1]);
    host.setCollabListen({ port, host: "127.0.0.1" });
    await host.setDevicesEnabled(true);
    await vi.waitFor(async () => {
      expect((await host.status()).replacedBy).toMatchObject({ hostNumber: 2, forkSeq: sharedSeq });
    }, { timeout: 20_000, interval: 100 });
    const replaced = (await host.status()).replacedBy!;
    expect(replaced.divergentFile).toMatch(/\.divergent\.simpletab$/);
    expect(existsSync(replaced.divergentFile!)).toBe(true);
    expect((await equity.service.status()).device?.connection).toBe("superseded");
    const refused = await host.submit({ type: "team.update", payload: { team: { ...team2, name: "Too Late" } } });
    expect(refused).toMatchObject({ ok: false, code: "FORBIDDEN" });
  }, 60_000);
});
