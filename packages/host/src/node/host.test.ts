import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import { verifyChain } from "@simpletab/core/changelog";
import {
  createTournamentState,
  recordKey,
  type Actor,
  type OpRequest,
  type TournamentState,
} from "@simpletab/core/ops";
import type { Team } from "@simpletab/core/types";
import { makeTeams, makeTournament } from "@simpletab/core/test/tournamentFixtures";
import { HostEngine, stateHash } from "./index";

const FIXED_DATE = new Date("2026-11-24T00:00:00.000Z");
const TAB_DIRECTOR: Actor = {
  ref: "tab-director-1",
  type: "human",
  role: BUILT_IN_ROLES.tab_director,
  isHostOwner: false,
};
const DISPLAY: Actor = {
  ref: "display-1",
  type: "human",
  role: BUILT_IN_ROLES.display,
  isHostOwner: false,
};

function initialState(): TournamentState {
  return createTournamentState(makeTournament("bp"));
}

function createTeam(tournamentId: string, id: string, name = id): Team {
  const template = makeTeams(1, { tournamentId, prefix: id })[0]!;
  return { ...template, id, name };
}

function createTeamRequest(tournamentId: string, id: string): OpRequest {
  return {
    type: "team.create",
    payload: { team: createTeam(tournamentId, id) },
  };
}

describe("host storage and engine", () => {
  const engines: HostEngine[] = [];
  const temporaryDirectories: string[] = [];

  function openMemory(state = initialState()): HostEngine {
    const engine = HostEngine.open(":memory:", {
      initialState: state,
      clock: () => new Date(FIXED_DATE),
    });
    engines.push(engine);
    return engine;
  }

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => engine.close()));
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates all host tables, generated lookup columns, indexes and migration metadata", () => {
    const engine = openMemory();
    const tableNames = (engine.database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as { name: string }[]).map((row) => row.name);
    expect(tableNames).toEqual(expect.arrayContaining([
      "tournament",
      "institutions",
      "teams",
      "adjudicators",
      "venues",
      "rounds",
      "debates",
      "motions",
      "ballots",
      "feedback",
      "break_categories",
      "registrations",
      "links",
      "ballot_intake",
      "late_submissions",
      "host",
      "ops",
      "changelog",
      "snapshots",
      "proposals",
      "devices",
      "roles",
      "staff",
      "meta",
      "schema_migrations",
    ]));
    const indexNames = (engine.database.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name",
    ).all() as { name: string }[]).map((row) => row.name);
    expect(indexNames).toEqual(expect.arrayContaining([
      "teams_institution_id_idx",
      "adjudicators_institution_id_idx",
      "debates_round_id_idx",
      "ballots_debate_id_idx",
      "ballots_round_id_idx",
      "feedback_round_id_idx",
      "feedback_adjudicator_id_idx",
      "links_lookup_id_unique",
      "links_entity_id_idx",
    ]));
    const generatedColumns = engine.database.prepare("PRAGMA table_xinfo(teams)").all() as {
      name: string;
      hidden: number;
    }[];
    expect(generatedColumns.find((column) => column.name === "institution_id")?.hidden).toBe(3);
    expect(engine.database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(engine.database.prepare("SELECT value FROM meta WHERE key='schema_version'").get())
      .toEqual({ value: "1" });
  });

  it("commits the entity, op and changelog together and emits a post-commit event", async () => {
    const engine = openMemory();
    const events: number[] = [];
    engine.onCommitted((event) => events.push(event.seq));
    const request = createTeamRequest("t-bp", "team-new");
    const result = await engine.submit(request, TAB_DIRECTOR);
    expect(result.ok).toBe(true);
    expect(engine.database.prepare("SELECT data, version, last_seq FROM teams WHERE id = ?")
      .get("team-new")).toMatchObject({ version: 1, last_seq: 1 });
    expect(engine.database.prepare("SELECT type, payload FROM ops WHERE seq = 1").get())
      .toMatchObject({ type: "team.create" });
    expect(engine.database.prepare("SELECT seq, entry_hash FROM changelog WHERE seq = 1").get())
      .toMatchObject({ seq: 1 });
    expect(events).toEqual([1]);
  });

  it("rolls back record and log writes when the changelog insert fails", async () => {
    const engine = openMemory();
    const initialHash = engine.getStateHash();
    engine.database.exec(
      "CREATE TRIGGER reject_changelog BEFORE INSERT ON changelog " +
      "BEGIN SELECT RAISE(ABORT, 'simulated changelog failure'); END",
    );
    await expect(engine.submit(createTeamRequest("t-bp", "team-rollback"), TAB_DIRECTOR))
      .rejects.toThrow("simulated changelog failure");
    expect(engine.database.prepare("SELECT COUNT(*) AS count FROM teams WHERE id='team-rollback'").get())
      .toEqual({ count: 0 });
    expect(engine.database.prepare("SELECT COUNT(*) AS count FROM ops").get()).toEqual({ count: 0 });
    expect(engine.database.prepare("SELECT COUNT(*) AS count FROM changelog").get()).toEqual({ count: 0 });
    expect(engine.getState()?.teams).toEqual([]);
    expect(engine.getStateHash()).toBe(initialHash);
  });

  it("serializes twenty concurrent submissions in call order", async () => {
    const engine = openMemory();
    const requests = Array.from({ length: 20 }, (_, index) =>
      createTeamRequest("t-bp", `team-${String(index + 1).padStart(2, "0")}`));
    const results = await Promise.all(requests.map((request) => engine.submit(request, TAB_DIRECTOR)));
    expect(results.every((result) => result.ok)).toBe(true);
    const committed = engine.database.prepare("SELECT seq, payload FROM ops ORDER BY seq").all() as {
      seq: number;
      payload: string;
    }[];
    expect(committed.map((row) => row.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(committed.map((row) => (JSON.parse(row.payload) as { team: Team }).team.id))
      .toEqual(requests.map((request) => (request.payload as { team: Team }).team.id));
  });

  it("produces a verifiable changelog chain after thirty operations", async () => {
    const engine = openMemory();
    for (let index = 1; index <= 30; index += 1) {
      const result = await engine.submit(createTeamRequest("t-bp", `team-${index}`), TAB_DIRECTOR);
      expect(result.ok).toBe(true);
    }
    const head = engine.head();
    expect(head.seq).toBe(30);
    expect(await verifyChain(engine.changelog(), { expectedHead: head.entryHash })).toEqual({
      ok: true,
      head: head.entryHash,
    });
  });

  it("writes nothing for version conflicts and forbidden operations", async () => {
    const engine = openMemory();
    const key = recordKey("team", "team-conflict");
    const conflicted = await engine.submit({
      ...createTeamRequest("t-bp", "team-conflict"),
      expectedVersions: { [key]: 9 },
    }, TAB_DIRECTOR);
    const forbidden = await engine.submit(createTeamRequest("t-bp", "team-forbidden"), DISPLAY);
    expect(conflicted).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    expect(forbidden).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(engine.head().seq).toBe(0);
    expect(engine.getState()?.teams).toEqual([]);
    expect(engine.database.prepare("SELECT COUNT(*) AS count FROM ops").get()).toEqual({ count: 0 });
    expect(engine.database.prepare("SELECT COUNT(*) AS count FROM changelog").get()).toEqual({ count: 0 });
  });

  it("reopens a file database with the same state and state hash", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "simpletab-host-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "bp-open.simpletab.db");
    const first = HostEngine.open(filePath, {
      initialState: initialState(),
      clock: () => new Date(FIXED_DATE),
    });
    engines.push(first);
    const result = await first.submit(createTeamRequest("t-bp", "team-durable"), TAB_DIRECTOR);
    expect(result.ok).toBe(true);
    const expectedState = first.getState();
    const expectedHash = first.getStateHash();
    await first.close();
    engines.splice(engines.indexOf(first), 1);

    const reopened = HostEngine.open(filePath);
    engines.push(reopened);
    expect(reopened.getState()).toEqual(expectedState);
    expect(reopened.getStateHash()).toBe(expectedHash);
  });

  it("undoes an op with its stored inverse and refuses when a later op wrote the same record", async () => {
    const engine = openMemory();
    const created = await engine.submit(createTeamRequest("t-bp", "team-undo"), TAB_DIRECTOR);
    expect(created.ok).toBe(true);
    const undone = await engine.undo(1, TAB_DIRECTOR);
    expect(undone.ok).toBe(true);
    expect(engine.getState()?.teams).toEqual([]);
    expect(engine.database.prepare("SELECT inverse_of FROM ops WHERE seq = 2").get())
      .toEqual({ inverse_of: 1 });

    const secondEngine = openMemory();
    const create = await secondEngine.submit(createTeamRequest("t-bp", "team-blocked"), TAB_DIRECTOR);
    expect(create.ok).toBe(true);
    const current = secondEngine.getState()!.teams[0]!;
    const update = await secondEngine.submit({
      type: "team.update",
      payload: { team: { ...current, name: "Updated team" } },
    }, TAB_DIRECTOR);
    expect(update.ok).toBe(true);
    const refused = await secondEngine.undo(1, TAB_DIRECTOR);
    expect(refused).toMatchObject({ ok: false, code: "CANNOT_UNDO", blockingSeqs: [2] });
    expect(secondEngine.getState()?.teams[0]?.name).toBe("Updated team");
  });

  it("hashes record content but excludes row versions and last sequence", () => {
    const team = createTeam("t-bp", "team-hash");
    const seed = createTournamentState(makeTournament("bp"), { teams: [team] });
    const seededEngine = openMemory(seed);
    const initialHash = stateHash(seededEngine.database);
    seededEngine.database.prepare("UPDATE teams SET version = version + 1, last_seq = 99 WHERE id = ?")
      .run(team.id);
    expect(stateHash(seededEngine.database)).toBe(initialHash);
    const updatedTeam = { ...team, name: "Changed content" };
    seededEngine.database.prepare("UPDATE teams SET data = ? WHERE id = ?")
      .run(JSON.stringify(updatedTeam), team.id);
    expect(stateHash(seededEngine.database)).not.toBe(initialHash);
  });
});
