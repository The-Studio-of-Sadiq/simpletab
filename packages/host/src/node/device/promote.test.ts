import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTournamentState,
  type Actor,
  type OpRequest,
  type TournamentState,
} from "@simpletab/core/ops";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import type { Team } from "@simpletab/core/types";
import { makeTeams, makeTournament } from "@simpletab/core/test/tournamentFixtures";
import { HostEngine, exportHandover, importHandover } from "../index";
import { readOpRecordsAfter } from "../handover/format";
import { chooseNewerCopy, promoteReplica } from "./promote";
import { ReplicaStore } from "./replica-store";

const FIXED_DATE = new Date("2026-11-25T01:00:00.000Z");

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
  const team: Team = { ...template, id, name: id };
  return {
    type: "team.create",
    payload: { team },
  };
}

function makePrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

describe("promoteReplica and chooseNewerCopy", () => {
  const engines: HostEngine[] = [];
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "simpletab-promote-"));
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

  it("promotes a replica handover into a valid host DB with host.promote op and meta fields", { timeout: 20_000 }, async () => {
    const dir = makeTempDir();
    const sourcePath = path.join(dir, "source.simpletab.db");
    const initZipPath = path.join(dir, "init.simpletab");
    const promotedDbPath = path.join(dir, "promoted.simpletab.db");

    const source = track(
      HostEngine.open(sourcePath, {
        initialState: makeInitialState(),
        clock: () => new Date(FIXED_DATE),
      }),
    );
    expect((await source.submit(createTeamOp("t-bp", "team-1"), TAB_DIRECTOR)).ok).toBe(true);
    expect((await source.submit(createTeamOp("t-bp", "team-2"), TAB_DIRECTOR)).ok).toBe(true);
    exportHandover(source, initZipPath, { createdAt: FIXED_DATE.toISOString() });

    const store = new ReplicaStore(path.join(dir, "replica"), makePrivateKeyPem());
    await store.reset(new Uint8Array(readFileSync(initZipPath)));
    expect((await source.submit(createTeamOp("t-bp", "team-3"), TAB_DIRECTOR)).ok).toBe(true);
    await store.append(readOpRecordsAfter(source.database, 2));

    const handover = await store.buildHandover();
    const result = await promoteReplica({
      handover,
      targetDbPath: promotedDbPath,
      rank: 2,
      minHostNumber: 2,
      now: () => new Date(FIXED_DATE),
    });

    expect(result.dbPath).toBe(promotedDbPath);
    expect(result.hostNumber).toBe(2);
    expect(result.hostRank).toBe(2);
    expect(result.promotedFromSeq).toBe(3);
    expect(result.hostId.length).toBeGreaterThan(0);

    const promoted = track(HostEngine.open(promotedDbPath));
    expect(promoted.integrity).toEqual({ ok: true });
    expect(promoted.head()).toEqual({ seq: 4, entryHash: result.headHash });

    const metaRow = (key: string) =>
      promoted.database.prepare("SELECT value FROM meta WHERE key = ?").get(key) as {
        value: string;
      };
    expect(metaRow("host_rank").value).toBe("2");
    expect(metaRow("host_number").value).toBe("2");
    expect(metaRow("promoted_from_seq").value).toBe("3");
    expect(metaRow("host_id").value).toBe(result.hostId);

    const state = promoted.getState()!;
    expect(state.host).toEqual({
      number: 2,
      id: result.hostId,
      rank: 2,
    });

    const chain = promoted.changelog();
    expect(chain).toHaveLength(4);
    expect(chain[3]?.entry.opType).toBe("host.promote");
  });

  it("uses minHostNumber when larger than imported hostNumber + 1", { timeout: 20_000 }, async () => {
    const dir = makeTempDir();
    const sourcePath = path.join(dir, "source.simpletab.db");
    const handoverPath = path.join(dir, "handover.simpletab");
    const promotedDbPath = path.join(dir, "promoted-high.simpletab.db");

    const source = track(
      HostEngine.open(sourcePath, {
        initialState: makeInitialState(),
        clock: () => new Date(FIXED_DATE),
      }),
    );
    expect((await source.submit(createTeamOp("t-bp", "team-1"), TAB_DIRECTOR)).ok).toBe(true);
    exportHandover(source, handoverPath, { createdAt: FIXED_DATE.toISOString() });

    const result = await promoteReplica({
      handover: new Uint8Array(readFileSync(handoverPath)),
      targetDbPath: promotedDbPath,
      rank: 3,
      minHostNumber: 7,
      now: () => new Date(FIXED_DATE),
    });

    expect(result.hostNumber).toBe(7);
    expect(result.hostRank).toBe(3);
    expect(result.promotedFromSeq).toBe(1);

    const promoted = track(HostEngine.open(promotedDbPath));
    expect(promoted.integrity).toEqual({ ok: true });
    expect(promoted.database.prepare("SELECT value FROM meta WHERE key = 'host_number'").get()).toEqual({
      value: "7",
    });
    expect(promoted.head().seq).toBe(2);
  });

  it("refuses an existing targetDbPath without deleting it and cleans up on invalid handover", { timeout: 20_000 }, async () => {
    const dir = makeTempDir();
    const existingPath = path.join(dir, "existing.simpletab.db");
    writeFileSync(existingPath, "keep-me", "utf8");

    await expect(
      promoteReplica({
        handover: new Uint8Array([1, 2, 3]),
        targetDbPath: existingPath,
        rank: 1,
        minHostNumber: 2,
      }),
    ).rejects.toThrow(/already exists/i);
    expect(readFileSync(existingPath, "utf8")).toBe("keep-me");

    const badTargetPath = path.join(dir, "failed.simpletab.db");
    await expect(
      promoteReplica({
        handover: new Uint8Array([1, 2, 3]),
        targetDbPath: badTargetPath,
        rank: 1,
        minHostNumber: 2,
      }),
    ).rejects.toThrow();
    expect(existsSync(badTargetPath)).toBe(false);

    await expect(
      promoteReplica({
        handover: new Uint8Array([1, 2, 3]),
        targetDbPath: path.join(dir, "bad-rank.db"),
        rank: 0,
        minHostNumber: 2,
      }),
    ).rejects.toThrow(/rank/i);
  });

  it("chooseNewerCopy selects longer prefix, prefers own on equal, and throws naming seq on divergence", { timeout: 20_000 }, async () => {
    const dir = makeTempDir();
    const hostPath = path.join(dir, "host.simpletab.db");
    const shortPath = path.join(dir, "short.simpletab");
    const longPath = path.join(dir, "long.simpletab");

    const host = track(
      HostEngine.open(hostPath, {
        initialState: makeInitialState(),
        clock: () => new Date(FIXED_DATE),
      }),
    );
    expect((await host.submit(createTeamOp("t-bp", "team-1"), TAB_DIRECTOR)).ok).toBe(true);
    expect((await host.submit(createTeamOp("t-bp", "team-2"), TAB_DIRECTOR)).ok).toBe(true);
    exportHandover(host, shortPath, { createdAt: FIXED_DATE.toISOString() });

    expect((await host.submit(createTeamOp("t-bp", "team-3"), TAB_DIRECTOR)).ok).toBe(true);
    exportHandover(host, longPath, { createdAt: FIXED_DATE.toISOString() });

    const shortBytes = new Uint8Array(readFileSync(shortPath));
    const longBytes = new Uint8Array(readFileSync(longPath));

    const otherWins = await chooseNewerCopy(shortBytes, longBytes);
    expect(otherWins.from).toBe("other");
    expect(otherWins.lastSeq).toBe(3);
    expect(otherWins.handover).toBe(longBytes);

    const ownWins = await chooseNewerCopy(longBytes, shortBytes);
    expect(ownWins.from).toBe("own");
    expect(ownWins.lastSeq).toBe(3);
    expect(ownWins.handover).toBe(longBytes);

    const equalWins = await chooseNewerCopy(longBytes, new Uint8Array(longBytes));
    expect(equalWins.from).toBe("own");
    expect(equalWins.lastSeq).toBe(3);
    expect(equalWins.handover).toBe(longBytes);

    // Fork two engines from shortPath (seq 2) and commit different ops at seq 3.
    const forkAPath = path.join(dir, "fork-a.simpletab.db");
    const forkBPath = path.join(dir, "fork-b.simpletab.db");
    await importHandover(shortBytes, forkAPath);
    await importHandover(shortBytes, forkBPath);

    const forkA = track(HostEngine.open(forkAPath, { clock: () => new Date(FIXED_DATE) }));
    const forkB = track(HostEngine.open(forkBPath, { clock: () => new Date(FIXED_DATE) }));
    expect((await forkA.submit(createTeamOp("t-bp", "team-alpha"), TAB_DIRECTOR)).ok).toBe(true);
    expect((await forkB.submit(createTeamOp("t-bp", "team-beta"), TAB_DIRECTOR)).ok).toBe(true);

    const forkAZipPath = path.join(dir, "fork-a.simpletab");
    const forkBZipPath = path.join(dir, "fork-b.simpletab");
    exportHandover(forkA, forkAZipPath, { createdAt: FIXED_DATE.toISOString() });
    exportHandover(forkB, forkBZipPath, { createdAt: FIXED_DATE.toISOString() });

    await expect(
      chooseNewerCopy(
        new Uint8Array(readFileSync(forkAZipPath)),
        new Uint8Array(readFileSync(forkBZipPath)),
      ),
    ).rejects.toThrow(/\b3\b/);

    await expect(chooseNewerCopy(shortBytes, new Uint8Array([9, 9, 9]))).rejects.toThrow();
  });
});
