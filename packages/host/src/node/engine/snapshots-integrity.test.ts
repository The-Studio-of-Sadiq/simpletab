import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { canonicalize, verifyChain } from "@simpletab/core/changelog";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import {
  createTournamentState,
  type Actor,
  type OpRequest,
  type TournamentState,
} from "@simpletab/core/ops";
import type { Team } from "@simpletab/core/types";
import { makeTeams, makeTournament } from "@simpletab/core/test/tournamentFixtures";
import { makeFixtureDebateAndBallot } from "@simpletab/core/ops/test-helpers";
import {
  HostEngine,
  decodeSnapshot,
  fastCheck,
  fullCheck,
  openDatabase,
  readAllSnapshots,
  readLatestSnapshot,
  stateHash,
  stateHashFromState,
  toContentOnlyState,
} from "../index";

const FIXED_DATE = new Date("2026-11-24T00:00:00.000Z");

const TAB_DIRECTOR: Actor = {
  ref: "tab-director-1",
  type: "human",
  role: BUILT_IN_ROLES.tab_director,
  isHostOwner: false,
};

function makeInitialState(): TournamentState {
  return createTournamentState(makeTournament("bp"));
}

function makeTeam(tournamentId: string, id: string, name = id): Team {
  const template = makeTeams(1, { tournamentId, prefix: id })[0]!;
  return { ...template, id, name };
}

function createTeamOp(tournamentId: string, id: string): OpRequest {
  return {
    type: "team.create",
    payload: { team: makeTeam(tournamentId, id) },
  };
}

describe("snapshots, startup integrity checks, and migrations", () => {
  const engines: HostEngine[] = [];
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "simpletab-snap-"));
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

  it("migrates a v1 database to v2 after creating a backup file", () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, "legacy.simpletab.db");
    const schemaSql = readFileSync(
      new URL("../db/schema.sql", import.meta.url),
      "utf8",
    );
    const legacy = new Database(dbPath);
    legacy.exec(schemaSql);
    legacy.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)").run(
      FIXED_DATE.toISOString(),
    );
    legacy.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '1')").run();
    legacy.prepare("INSERT INTO meta(key, value) VALUES ('host_number', '1')").run();
    legacy.close();

    const upgraded = openDatabase(dbPath);
    try {
      expect(existsSync(`${dbPath}.v1.bak`)).toBe(true);
      expect(upgraded.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
        .toEqual({ value: "2" });
      const cols = (upgraded.prepare("PRAGMA table_info(ops)").all() as { name: string }[])
        .map((col) => col.name);
      expect(cols).toEqual(expect.arrayContaining([
        "actor_role_id",
        "actor_role",
        "actor_is_host_owner",
        "request_payload",
        "request_forced",
      ]));
    } finally {
      upgraded.close();
    }
  });

  it("takes a snapshot every snapshotEvery ops, records stateHash on the changelog entry, and reopens with identical state hash", async () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, "snap-interval.simpletab.db");
    const engine = track(HostEngine.open(dbPath, {
      initialState: makeInitialState(),
      clock: () => new Date(FIXED_DATE),
      snapshotEvery: 50,
    }));

    for (let i = 1; i <= 55; i += 1) {
      const res = await engine.submit(createTeamOp("t-bp", `team-${String(i).padStart(3, "0")}`), TAB_DIRECTOR);
      expect(res.ok).toBe(true);
    }

    const snapshots = readAllSnapshots(engine.database);
    expect(snapshots.map((s) => s.seq)).toEqual([50]);

    const snap50 = snapshots[0]!;
    const decoded = decodeSnapshot(snap50.data);
    expect(decoded.teams).toHaveLength(50);
    expect("versions" in (decoded as Record<string, unknown>)).toBe(false);
    expect(stateHashFromState(decoded)).toBe(snap50.state_hash);

    const chain = engine.changelog();
    expect(chain[48]!.entry.stateHash).toBeUndefined();
    expect(chain[49]!.entry.stateHash).toBe(snap50.state_hash);
    expect(chain[50]!.entry.stateHash).toBeUndefined();
    expect(await verifyChain(chain, { expectedHead: engine.head().entryHash })).toEqual({
      ok: true,
      head: engine.head().entryHash,
    });

    const expectedHash = engine.getStateHash();
    const expectedState = engine.getState();
    expect(stateHashFromState(expectedState!)).toBe(expectedHash);

    await engine.close();
    engines.splice(engines.indexOf(engine), 1);

    const reopened = track(HostEngine.open(dbPath, { snapshotEvery: 50 }));
    expect(reopened.integrity).toEqual({ ok: true });
    expect(reopened.canSync()).toBe(true);
    expect(reopened.canPublish()).toBe(true);
    expect(reopened.getStateHash()).toBe(expectedHash);
    expect(reopened.getState()).toEqual(expectedState);
  });

  it("takes a snapshot whenever round.set_completion marks a round completed, but not when reopening", async () => {
    const { state } = makeFixtureDebateAndBallot();
    const roundId = state.rounds[0]!.id;
    const engine = track(HostEngine.open(":memory:", {
      initialState: state,
      clock: () => new Date(FIXED_DATE),
      snapshotEvery: 2000,
    }));

    expect(readLatestSnapshot(engine.database)).toBeNull();

    const complete = await engine.submit(
      {
        type: "round.set_completion",
        payload: { roundId, completed: true },
      },
      TAB_DIRECTOR,
    );
    expect(complete.ok).toBe(true);

    const latest = readLatestSnapshot(engine.database);
    expect(latest?.seq).toBe(1);
    expect(latest?.state_hash).toBe(engine.getStateHash());
    expect(engine.changelog()[0]!.entry.stateHash).toBe(latest?.state_hash);
    expect(await fastCheck(engine.database)).toEqual({ ok: true });
    expect(await fullCheck(engine.database)).toEqual({ ok: true });

    // Reopening the round (completed: false) should not create a new snapshot.
    const reopen = await engine.submit(
      {
        type: "round.set_completion",
        payload: { roundId, completed: false, override: { reason: "reopen" } },
      },
      TAB_DIRECTOR,
    );
    expect(reopen.ok).toBe(true);
    expect(readAllSnapshots(engine.database).map((s) => s.seq)).toEqual([1]);
    expect(engine.changelog()[1]!.entry.stateHash).toBeUndefined();
  });

  it("fastCheck passes on a clean DB and fails on (a) entity SQL edit, (b) snapshot edit, and (c) ops row edit, opening in blocked mode", async () => {
    const dir = makeTempDir();

    async function createSeededDb(name: string): Promise<string> {
      const filePath = path.join(dir, `${name}.simpletab.db`);
      const engine = HostEngine.open(filePath, {
        initialState: makeInitialState(),
        clock: () => new Date(FIXED_DATE),
        snapshotEvery: 5,
      });
      for (let i = 1; i <= 7; i += 1) {
        const res = await engine.submit(createTeamOp("t-bp", `team-${i}`), TAB_DIRECTOR);
        expect(res.ok).toBe(true);
      }
      expect(await fastCheck(engine.database)).toEqual({ ok: true });
      expect(await fullCheck(engine.database)).toEqual({ ok: true });
      await engine.close();
      return filePath;
    }

    // (a) Editing an entity row directly via SQL
    const entityPath = await createSeededDb("tamper-entity");
    {
      const raw = new Database(entityPath);
      try {
        const row = raw.prepare("SELECT data FROM teams WHERE id = 'team-7'").get() as { data: string };
        const edited = { ...(JSON.parse(row.data) as Team), name: "HACKED TEAM" };
        raw.prepare("UPDATE teams SET data = ? WHERE id = 'team-7'").run(JSON.stringify(edited));
        expect(await fastCheck(raw)).toMatchObject({ ok: false, stage: "live_state" });
      } finally {
        raw.close();
      }

      const blocked = track(HostEngine.open(entityPath));
      expect(blocked.integrity).toMatchObject({ ok: false, stage: "live_state" });
      expect(blocked.canSync()).toBe(false);
      expect(blocked.canPublish()).toBe(false);
      // Tabbing still works in blocked mode.
      const continued = await blocked.submit(createTeamOp("t-bp", "team-after-block"), TAB_DIRECTOR);
      expect(continued.ok).toBe(true);
      expect(blocked.canSync()).toBe(false);
      expect(blocked.canPublish()).toBe(false);
    }

    // (b) Editing a snapshot's data directly via SQL
    const snapPath = await createSeededDb("tamper-snapshot");
    {
      const raw = new Database(snapPath);
      try {
        const snap = readLatestSnapshot(raw)!;
        const decoded = decodeSnapshot(snap.data);
        const modified = {
          ...decoded,
          teams: decoded.teams.map((t, idx) => (idx === 0 ? { ...t, name: "TAMPERED" } : t)),
        };
        const fakeGz = gzipSync(Buffer.from(canonicalize(modified), "utf8"));
        raw.prepare("UPDATE snapshots SET data = ? WHERE seq = ?").run(fakeGz, snap.seq);
        expect(await fastCheck(raw)).toMatchObject({ ok: false, stage: "snapshot", seq: 5 });
      } finally {
        raw.close();
      }

      const blocked = track(HostEngine.open(snapPath));
      expect(blocked.integrity).toMatchObject({ ok: false, stage: "snapshot", seq: 5 });
      expect(blocked.canSync()).toBe(false);
      expect(blocked.canPublish()).toBe(false);
      expect((await blocked.submit(createTeamOp("t-bp", "team-after-snap"), TAB_DIRECTOR)).ok).toBe(true);
    }

    // (c) Editing an ops row directly via SQL
    const opsPath = await createSeededDb("tamper-ops");
    {
      const raw = new Database(opsPath);
      try {
        const row = raw.prepare("SELECT payload FROM ops WHERE seq = 7").get() as { payload: string };
        const parsed = JSON.parse(row.payload) as { team: Team };
        parsed.team.name = "ALTERED IN OPS";
        raw.prepare("UPDATE ops SET payload = ? WHERE seq = 7").run(JSON.stringify(parsed));
        expect(await fastCheck(raw)).toMatchObject({ ok: false, stage: "changelog", seq: 7 });
      } finally {
        raw.close();
      }

      const blocked = track(HostEngine.open(opsPath));
      expect(blocked.integrity).toMatchObject({ ok: false, stage: "changelog", seq: 7 });
      expect(blocked.canSync()).toBe(false);
      expect(blocked.canPublish()).toBe(false);
    }
  });

  it("fullCheck catches pre-snapshot tampering that fastCheck cannot see and blocks sync/publish", async () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, "pre-snapshot.simpletab.db");
    const first = HostEngine.open(dbPath, {
      initialState: makeInitialState(),
      clock: () => new Date(FIXED_DATE),
      snapshotEvery: 5,
    });
    for (let i = 1; i <= 12; i += 1) {
      expect((await first.submit(createTeamOp("t-bp", `team-${i}`), TAB_DIRECTOR)).ok).toBe(true);
    }
    expect(readAllSnapshots(first.database).map((s) => s.seq)).toEqual([5, 10]);
    await first.close();

    // Tamper with the earlier snapshot at seq 5 (before latest snapshot at seq 10).
    const raw = new Database(dbPath);
    try {
      const snap5 = raw.prepare("SELECT seq, data FROM snapshots WHERE seq = 5").get() as {
        seq: number;
        data: Buffer;
      };
      const content5 = decodeSnapshot(snap5.data);
      const altered5 = {
        ...content5,
        teams: content5.teams.map((t, idx) => (idx === 0 ? { ...t, name: "PRE-SNAP TAMPER" } : t)),
      };
      raw.prepare("UPDATE snapshots SET data = ? WHERE seq = 5").run(
        gzipSync(Buffer.from(canonicalize(altered5), "utf8")),
      );
      // fastCheck only inspects the latest snapshot (seq 10) + ops 11..12, so it passes.
      expect(await fastCheck(raw)).toEqual({ ok: true });
      // fullCheck replays from op 1 and verifies every snapshot, so it catches seq 5.
      expect(await fullCheck(raw)).toMatchObject({ ok: false, stage: "snapshot", seq: 5 });
    } finally {
      raw.close();
    }

    // Opening via HostEngine passes fastCheck, then background runFullCheck flips it to blocked.
    const reopened = track(HostEngine.open(dbPath, { snapshotEvery: 5 }));
    expect(reopened.integrity).toEqual({ ok: true });
    expect(reopened.canSync()).toBe(true);
    expect(reopened.canPublish()).toBe(true);

    const fullResult = await reopened.runFullCheck();
    expect(fullResult).toMatchObject({ ok: false, stage: "snapshot", seq: 5 });
    expect(reopened.integrity).toMatchObject({ ok: false, stage: "snapshot", seq: 5 });
    expect(reopened.canSync()).toBe(false);
    expect(reopened.canPublish()).toBe(false);

    // Also verify stateHash consistency helper directly.
    expect(stateHash(reopened.database)).toBe(stateHashFromState(toContentOnlyState(reopened.getState()!)));
  });

  it("fullCheck also catches a tampered request_payload before the latest snapshot", async () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, "pre-snapshot-req.simpletab.db");
    const engine = HostEngine.open(dbPath, {
      initialState: makeInitialState(),
      clock: () => new Date(FIXED_DATE),
      snapshotEvery: 5,
    });
    for (let i = 1; i <= 7; i += 1) {
      expect((await engine.submit(createTeamOp("t-bp", `team-${i}`), TAB_DIRECTOR)).ok).toBe(true);
    }
    await engine.close();

    const raw = new Database(dbPath);
    try {
      const op2 = raw.prepare("SELECT request_payload FROM ops WHERE seq = 2").get() as {
        request_payload: string;
      };
      const parsed = JSON.parse(op2.request_payload) as { team: Team };
      parsed.team.name = "CHANGED REQUEST ONLY";
      raw.prepare("UPDATE ops SET request_payload = ? WHERE seq = 2").run(JSON.stringify(parsed));

      // fastCheck starts at snapshot 5, so op 2 is not replayed.
      expect(await fastCheck(raw)).toEqual({ ok: true });
      // fullCheck replays from op 1 and detects mismatch at seq 2.
      expect(await fullCheck(raw)).toMatchObject({ ok: false, stage: "replay", seq: 2 });
    } finally {
      raw.close();
    }
  });
});
