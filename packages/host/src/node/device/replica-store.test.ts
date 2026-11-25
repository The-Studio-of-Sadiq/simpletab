import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalize } from "@simpletab/core/changelog";
import { base32Encode, newLink } from "@simpletab/core/crypto";
import {
  createTournamentState,
  type Actor,
  type OpRequest,
  type TournamentState,
} from "@simpletab/core/ops";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import type { Team } from "@simpletab/core/types";
import { makeTeams, makeTournament } from "@simpletab/core/test/tournamentFixtures";
import {
  HostEngine,
  exportHandover,
  importHandover,
  stateHashFromState,
  type HandoverOpRecord,
} from "../index";
import { readOpRecordsAfter } from "../handover/format";
import { ReplicaStore } from "./replica-store";

const FIXED_DATE = new Date("2026-11-25T00:00:00.000Z");

const TAB_DIRECTOR: Actor = {
  ref: "tab-director-1",
  type: "human",
  role: BUILT_IN_ROLES.tab_director,
  isHostOwner: false,
};

function makeInitialState(): TournamentState {
  return createTournamentState(makeTournament("bp"));
}

function createTeamOp(tournamentId: string, id: string): OpRequest {
  const template = makeTeams(1, { tournamentId, prefix: id })[0]!;
  const team: Team = { ...template, id, name: `SecretName-${id}` };
  return {
    type: "team.create",
    payload: { team },
  };
}

function makePrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

describe("ReplicaStore", () => {
  const engines: HostEngine[] = [];
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "simpletab-replica-"));
    tempDirs.push(dir);
    return dir;
  }

  function track(engine: HostEngine): HostEngine {
    engines.push(engine);
    return engine;
  }

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => engine.close()));
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resets, appends ops, round-trips via buildHandover and importHandover, and encrypts at rest", { timeout: 20_000 }, async () => {
    const dir = makeTempDir();
    const replicaDir = path.join(dir, "replica");
    const dbPath = path.join(dir, "host.simpletab.db");
    const initZipPath = path.join(dir, "init.simpletab");
    const importDbPath = path.join(dir, "restored.simpletab.db");
    const keyPem = makePrivateKeyPem();

    const engine = track(
      HostEngine.open(dbPath, {
        initialState: makeInitialState(),
        clock: () => new Date(FIXED_DATE),
        snapshotEvery: 2000,
      }),
    );

    for (let i = 1; i <= 3; i += 1) {
      expect((await engine.submit(createTeamOp("t-bp", `team-${i}`), TAB_DIRECTOR)).ok).toBe(true);
    }
    exportHandover(engine, initZipPath, { createdAt: FIXED_DATE.toISOString() });
    const initZip = new Uint8Array(readFileSync(initZipPath));

    const store = new ReplicaStore(replicaDir, keyPem);
    expect(store.exists()).toBe(false);
    expect(store.lastSeq()).toBe(0);
    expect(store.headHash()).toBeUndefined();
    await expect(store.buildHandover()).rejects.toThrow();

    await store.reset(initZip);
    expect(store.exists()).toBe(true);
    expect(store.lastSeq()).toBe(3);
    expect(store.headHash()).toBe(engine.head().entryHash);

    // Commit more ops on host, including a link op, and append them to the replica.
    expect((await engine.submit(createTeamOp("t-bp", "team-4"), TAB_DIRECTOR)).ok).toBe(true);
    const generated = newLink("team", "cdn.example", "https://ballots.example", "bp-open");
    expect(
      (
        await engine.submit(
          {
            type: "private_urls.regenerate",
            payload: {
              scope: "teams",
              force: false,
              links: [
                {
                  lookupId: generated.lookupId,
                  entityId: "team-1",
                  secret: base32Encode(generated.secret),
                },
              ],
            },
          },
          TAB_DIRECTOR,
        )
      ).ok,
    ).toBe(true);

    const newRecords = readOpRecordsAfter(engine.database, 3);
    expect(newRecords).toHaveLength(2);
    await store.append(newRecords);

    expect(store.lastSeq()).toBe(5);
    expect(store.headHash()).toBe(engine.head().entryHash);

    // Build handover and verify importHandover reproduces the exact host state.
    const rebuiltZip = await store.buildHandover();
    const imported = await importHandover(rebuiltZip, importDbPath);
    const hostState = engine.getState()!;
    expect(imported.stateHash).toBe(stateHashFromState(hostState));
    expect(imported.lastSeq).toBe(5);
    expect(imported.headHash).toBe(engine.head().entryHash);

    const importedEngine = track(HostEngine.open(importDbPath));
    expect(importedEngine.integrity).toEqual({ ok: true });
    expect(canonicalize(importedEngine.getState()!.links)).toBe(canonicalize(hostState.links));

    // A fresh ReplicaStore on the same directory and key reads the copy back and can append more.
    const reopenedStore = new ReplicaStore(replicaDir, keyPem);
    expect(reopenedStore.exists()).toBe(true);
    expect(reopenedStore.lastSeq()).toBe(5);
    expect(reopenedStore.headHash()).toBe(engine.head().entryHash);

    expect((await engine.submit(createTeamOp("t-bp", "team-6"), TAB_DIRECTOR)).ok).toBe(true);
    const tailRecord = readOpRecordsAfter(engine.database, 5);
    await reopenedStore.append(tailRecord);
    expect(reopenedStore.lastSeq()).toBe(6);

    const reopenedZip = await reopenedStore.buildHandover();
    const reopenedImported = await importHandover(
      reopenedZip,
      path.join(dir, "restored-2.simpletab.db"),
    );
    expect(reopenedImported.stateHash).toBe(stateHashFromState(engine.getState()!));

    // Verify no plaintext tournament data is written to disk.
    const rawInit = readFileSync(path.join(replicaDir, "init.bin")).toString("utf8");
    const rawOps = readFileSync(path.join(replicaDir, "ops.bin")).toString("utf8");
    const rawStateText = readFileSync(path.join(replicaDir, "state.json"), "utf8");
    for (const content of [rawInit, rawOps, rawStateText]) {
      expect(content).not.toContain("SecretName-team-1");
      expect(content).not.toContain("bp-open");
    }
    expect(Object.keys(JSON.parse(rawStateText) as Record<string, unknown>).sort()).toEqual([
      "headHash",
      "lastSeq",
    ]);

    // Wrong key fails with the expected plain Error message.
    const wrongKeyStore = new ReplicaStore(replicaDir, makePrivateKeyPem());
    await expect(wrongKeyStore.buildHandover()).rejects.toThrow(
      "This copy cannot be read with this laptop's key.",
    );

    // Clear removes the stored copy.
    reopenedStore.clear();
    expect(reopenedStore.exists()).toBe(false);
    expect(reopenedStore.lastSeq()).toBe(0);
    expect(reopenedStore.headHash()).toBeUndefined();
  });

  it("handles snapshots in both init and appended ops when building handover", { timeout: 20_000 }, async () => {
    const dir = makeTempDir();
    const replicaDir = path.join(dir, "replica-snap");
    const dbPath = path.join(dir, "host-snap.simpletab.db");
    const initZipPath = path.join(dir, "init-snap.simpletab");
    const keyPem = makePrivateKeyPem();

    const engine = track(
      HostEngine.open(dbPath, {
        initialState: makeInitialState(),
        clock: () => new Date(FIXED_DATE),
        snapshotEvery: 3,
      }),
    );

    for (let i = 1; i <= 4; i += 1) {
      expect((await engine.submit(createTeamOp("t-bp", `team-${i}`), TAB_DIRECTOR)).ok).toBe(true);
    }
    exportHandover(engine, initZipPath, { createdAt: FIXED_DATE.toISOString() });

    const store = new ReplicaStore(replicaDir, keyPem);
    await store.reset(new Uint8Array(readFileSync(initZipPath)));

    // Append across seq 6 (another snapshot op) and seq 7.
    for (let i = 5; i <= 7; i += 1) {
      expect((await engine.submit(createTeamOp("t-bp", `team-${i}`), TAB_DIRECTOR)).ok).toBe(true);
    }
    await store.append(readOpRecordsAfter(engine.database, 4));

    const rebuilt = await store.buildHandover();
    const imported = await importHandover(rebuilt, path.join(dir, "snap-imported.simpletab.db"));
    expect(imported.stateHash).toBe(stateHashFromState(engine.getState()!));
    expect(imported.lastSeq).toBe(7);

    // Reopen from disk to confirm snapshot verification during ensureLoaded.
    const reloaded = new ReplicaStore(replicaDir, keyPem);
    const rebuilt2 = await reloaded.buildHandover();
    const imported2 = await importHandover(rebuilt2, path.join(dir, "snap-imported-2.simpletab.db"));
    expect(imported2.stateHash).toBe(stateHashFromState(engine.getState()!));
  });

  it("rejects gaps, tampered records, and invalid reset archives without mutating the stored copy", { timeout: 20_000 }, async () => {
    const dir = makeTempDir();
    const replicaDir = path.join(dir, "replica-err");
    const dbPath = path.join(dir, "host-err.simpletab.db");
    const initZipPath = path.join(dir, "init-err.simpletab");
    const keyPem = makePrivateKeyPem();

    const engine = track(
      HostEngine.open(dbPath, {
        initialState: makeInitialState(),
        clock: () => new Date(FIXED_DATE),
      }),
    );
    expect((await engine.submit(createTeamOp("t-bp", "team-1"), TAB_DIRECTOR)).ok).toBe(true);
    expect((await engine.submit(createTeamOp("t-bp", "team-2"), TAB_DIRECTOR)).ok).toBe(true);
    exportHandover(engine, initZipPath, { createdAt: FIXED_DATE.toISOString() });

    const store = new ReplicaStore(replicaDir, keyPem);
    await store.reset(new Uint8Array(readFileSync(initZipPath)));
    const originalHead = store.headHash();

    // Commit two more ops so we can test gaps and tampering.
    expect((await engine.submit(createTeamOp("t-bp", "team-3"), TAB_DIRECTOR)).ok).toBe(true);
    expect((await engine.submit(createTeamOp("t-bp", "team-4"), TAB_DIRECTOR)).ok).toBe(true);
    const [op3, op4] = readOpRecordsAfter(engine.database, 2) as [HandoverOpRecord, HandoverOpRecord];

    // Gap (seq 4 instead of seq 3)
    await expect(store.append([op4])).rejects.toThrow(/sequence/i);
    expect(store.lastSeq()).toBe(2);
    expect(store.headHash()).toBe(originalHead);

    // Tampered payload
    const tamperedPayload: HandoverOpRecord = {
      ...op3,
      payload: { team: { ...(op3.payload as { team: Team }).team, name: "Tampered" } },
    };
    await expect(store.append([tamperedPayload])).rejects.toThrow(/payloadCommit/i);
    expect(store.lastSeq()).toBe(2);
    expect(store.headHash()).toBe(originalHead);

    // Tampered entryHash
    const tamperedHash: HandoverOpRecord = {
      ...op3,
      changelog: {
        ...op3.changelog,
        entryHash: "a".repeat(64),
      },
    };
    await expect(store.append([tamperedHash])).rejects.toThrow(/entryHash/i);
    expect(store.lastSeq()).toBe(2);
    expect(store.headHash()).toBe(originalHead);

    // Invalid reset archive leaves existing valid copy intact.
    await expect(store.reset(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
    expect(store.lastSeq()).toBe(2);
    expect(store.headHash()).toBe(originalHead);

    // Copy still accepts the real op3 and op4 afterwards.
    await store.append([op3, op4]);
    expect(store.lastSeq()).toBe(4);
    expect(store.headHash()).toBe(engine.head().entryHash);
  });
});
