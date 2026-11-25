import os from "node:os";
import path from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { TournamentState } from "@simpletab/core/ops";
import type { FeedbackSubmission, Team } from "@simpletab/core/types";
import { HostEngine } from "../../packages/host/src/node/engine/engine";
import { HostServiceImpl } from "../../packages/host/src/node/host-service";
import { DeviceMode } from "../../packages/host/src/node/device/device-mode";
import { PairingStore } from "../../packages/host/src/node/device/pairing-store";
import { generateBenchTournament } from "../bench/generate";

/**
 * M5 checkpoint (design: milestone table, `npm run e2e:collab`): a WUDC-size tournament (400 teams,
 * five rounds played) on one host, 15 staff devices on real TLS connections, and edits made from
 * devices and the host. Passes when:
 * - p95 of "commit to every device holding it" is at most 1 s;
 * - Equity devices never hold feedback, its text or its record ids;
 * - promotion keeps every op the host broadcast (the promoted chain extends the old one);
 * - the old host steps down once a device that knows the new host reaches it.
 */

const ROLES = [
  "tab_director", "tab_director", "tab_director",
  "adjudication_core", "adjudication_core", "adjudication_core",
  "equity", "equity",
  "tab_assistant", "tab_assistant", "tab_assistant", "tab_assistant", "tab_assistant",
  "display", "display",
] as const;
const EDITS = 40;
const SECRET = "E2E_SECRET_FEEDBACK_COMMENT";
const P95_LIMIT_MS = 1_000;

interface Device {
  role: string;
  service: HostServiceImpl;
  store: PairingStore;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("M5 live collaboration checkpoint (e2e:collab)", () => {
  const dirs: string[] = [];
  const services: HostServiceImpl[] = [];
  const tempDir = (label: string): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), `simpletab-collab-${label}-`));
    dirs.push(dir);
    return dir;
  };
  afterAll(async () => {
    for (const service of services.reverse()) await service.onStop().catch(() => undefined);
    for (const dir of dirs.reverse()) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Windows may keep SQLite files locked for a moment; temp folders are left to the OS.
      }
    }
  });

  it("serves 15 devices within 1 s at p95, keeps feedback from Equity, and survives a promotion", async () => {
    // A WUDC-size tournament with feedback in it.
    const { state: bench } = generateBenchTournament("wudc");
    const feedback = bench.debates.slice(0, 300).map(
      (debate, index) =>
        ({
          id: `fb-${index + 1}`,
          tournamentId: bench.tournament.id,
          roundId: debate.roundId,
          debateId: debate.id,
          sourceType: "adjudicator",
          sourceId: bench.adjudicators[index % bench.adjudicators.length]!.id,
          targetType: "adjudicator",
          targetAdjudicatorId: bench.adjudicators[(index + 1) % bench.adjudicators.length]!.id,
          score: 3,
          answers: { comment: SECRET },
          confirmed: true,
          timestamp: "2026-11-24T12:00:00.000Z",
        }) as unknown as FeedbackSubmission,
    );
    const hostDir = tempDir("host");
    const dbPath = path.join(hostDir, `${bench.tournament.slug}.simpletab.db`);
    const seed = HostEngine.open(dbPath, { initialState: { ...bench, feedback } as TournamentState });
    await seed.close();

    const host = new HostServiceImpl();
    services.push(host);
    host.setCollabListen({ port: 0, host: "127.0.0.1" });
    await host.openTournament(dbPath);
    const started = await host.setDevicesEnabled(true);
    const address = `127.0.0.1:${started.port}`;

    // Pair 15 devices.
    const devices: Device[] = [];
    const pairStart = Date.now();
    for (const [index, role] of ROLES.entries()) {
      const service = new HostServiceImpl();
      services.push(service);
      const store = new PairingStore(tempDir(`device-${index}`));
      service.setDeviceMode(new DeviceMode({ store }));
      const { code } = await host.issuePairingCode(role);
      await service.startJoin({ address, code, deviceName: `${role} ${index + 1}` });
      await until(async () => (await host.getDevicesStatus()).pendingJoins.length > 0, 20_000, `join ${index}`);
      const join = (await host.getDevicesStatus()).pendingJoins[0]!;
      expect((await service.getJoinProgress()).words).toEqual(join.words);
      await host.approveJoin(join.joinId);
      await until(async () => (await service.status()).open, 30_000, `snapshot ${index}`);
      devices.push({ role, service, store });
    }
    const pairMs = Date.now() - pairStart;

    // Edits from tab directors, tab assistants and the host; measure commit -> every device.
    const editors: Array<HostServiceImpl> = [
      host,
      ...devices.filter((d) => d.role === "tab_director" || d.role === "tab_assistant").map((d) => d.service),
    ];
    const latencies: number[] = [];
    for (let i = 0; i < EDITS; i += 1) {
      const editor = editors[i % editors.length]!;
      const view = await editor.getState();
      const team = view!.teams[i % view!.teams.length] as Team;
      const t0 = performance.now();
      const result = await editor.submit({ type: "team.update", payload: { team: { ...team, name: `Renamed ${i}` } } });
      expect(result, `edit ${i}`).toMatchObject({ ok: true });
      if (!result.ok) return;
      await until(
        async () => {
          for (const device of devices) {
            if (((await device.service.getState())?.seq ?? 0) < result.seq) return false;
          }
          return true;
        },
        10_000,
        `edit ${i} on every device`,
      );
      latencies.push(performance.now() - t0);
    }
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const max = Math.max(...latencies);

    // Equity never holds feedback.
    for (const device of devices.filter((d) => d.role === "equity")) {
      const held = await device.service.getState();
      expect(held?.feedback).toEqual([]);
      const text = JSON.stringify(held);
      expect(text).not.toContain(SECRET);
      expect(Object.keys(held?.versions ?? {}).some((key) => key.startsWith("feedback:"))).toBe(false);
    }
    const directorHeld = await devices[0]!.service.getState();
    expect(directorHeld?.feedback.length).toBe(300);

    // Every tab director's copy holds every broadcast op.
    const hostHead = (await host.status()).headSeq!;
    for (const device of devices.filter((d) => d.role === "tab_director")) {
      await until(async () => (await device.service.status()).device?.copy?.lastSeq === hostHead, 30_000, "director copies");
    }
    const hostChain = await host.getChangelog();

    // The host laptop "dies" for the devices; the first tab director is promoted.
    await host.setDevicesEnabled(false);
    const promoter = devices[0]!;
    await until(async () => (await promoter.service.status()).device?.connection !== "connected", 10_000, "disconnect");
    const promotedDir = tempDir("promoted");
    const promoted = await promoter.service.promoteToHost({ directory: promotedDir });
    expect(promoted.hostNumber).toBe(2);
    expect(promoted.headSeq).toBe(hostHead + 1);
    const promotedChain = await promoter.service.getChangelog();
    expect(promotedChain.slice(0, hostChain.length).map((item) => item.entryHash)).toEqual(
      hostChain.map((item) => item.entryHash),
    );
    expect(promotedChain.at(-1)?.entry.opType).toBe("host.promote");

    // A device that knows the new host reaches the old one: the old host steps down.
    const messenger = devices.find((d) => d.role === "equity")!;
    messenger.store.saveBestHost({
      hostNumber: 2,
      hostId: "promoted",
      hostRank: 1,
      certFingerprint: "",
      promotedFromSeq: hostHead,
    });
    host.setCollabListen({ port: started.port!, host: "127.0.0.1" });
    await host.setDevicesEnabled(true);
    await until(async () => (await host.status()).replacedBy !== undefined, 30_000, "old host steps down");
    const refused = await host.submit({ type: "team.update", payload: { team: { ...(directorHeld!.teams[0] as Team), name: "Late" } } });
    expect(refused).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const replaced = (await host.status()).replacedBy!;
    expect(replaced.divergentFile === undefined || existsSync(replaced.divergentFile)).toBe(true);

    console.log(
      [
        "M5 e2e:collab (WUDC size: 400 teams, 5 rounds played, 300 feedback records)",
        `devices: ${devices.length} (${ROLES.join(", ")})`,
        `pairing all devices: ${pairMs} ms`,
        `edits: ${EDITS}; commit -> all ${devices.length} devices: p50 ${p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, max ${max.toFixed(0)} ms (limit p95 ${P95_LIMIT_MS} ms)`,
        `promotion: new host 2 at seq ${hostHead + 1}, every one of ${hostChain.length} broadcast ops kept`,
      ].join("\n"),
    );
    expect(p95).toBeLessThanOrEqual(P95_LIMIT_MS);
  });
});
