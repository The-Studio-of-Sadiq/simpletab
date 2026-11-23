import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { verifyChain } from "@simpletab/core/changelog";
import { base32Encode, newLink } from "@simpletab/core/crypto";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import {
  createTournamentState,
  type Actor,
  type OpRequest,
  type TournamentState,
} from "@simpletab/core/ops";
import type { Team } from "@simpletab/core/types";
import { makeTeams, makeTournament } from "@simpletab/core/test/tournamentFixtures";
import {
  HostEngine,
  exportDivergent,
  exportHandover,
  fastCheck,
  importHandover,
  parseOpsNdjson,
  type DivergentManifest,
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

function createTeamOp(tournamentId: string, id: string): OpRequest {
  const template = makeTeams(1, { tournamentId, prefix: id })[0]!;
  const team: Team = { ...template, id, name: id };
  return {
    type: "team.create",
    payload: { team },
  };
}

describe("handover and divergent export", () => {
  const engines: HostEngine[] = [];
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "simpletab-handover-"));
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

  it("round-trips a handover with snapshot + tail ops, reproducing state hash and chain with hostNumber + 1 and new hostId", { timeout: 20_000 }, async () => {
    const dir = makeTempDir();
    const sourcePath = path.join(dir, "source.simpletab.db");
    const handoverPath = path.join(dir, "bp-open.simpletab");
    const targetPath = path.join(dir, "imported.simpletab.db");

    const source = track(HostEngine.open(sourcePath, {
      initialState: makeInitialState(),
      clock: () => new Date(FIXED_DATE),
      snapshotEvery: 5,
    }));

    for (let i = 1; i <= 7; i += 1) {
      expect((await source.submit(createTeamOp("t-bp", `team-${i}`), TAB_DIRECTOR)).ok).toBe(true);
    }

    // Add a link via private_urls.regenerate so links.json is non-empty and round-tripped.
    const generated = newLink("team", "cdn.example", "https://ballots.example", "bp-open");
    const regen = await source.submit(
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
    );
    expect(regen.ok).toBe(true);

    const sourceHostId = (
      source.database.prepare("SELECT value FROM meta WHERE key = 'host_id'").get() as {
        value: string;
      }
    ).value;
    const sourceHash = source.getStateHash();
    const sourceHead = source.head();
    const sourceChain = source.changelog();

    const exported = exportHandover(source, handoverPath, {
      createdAt: FIXED_DATE.toISOString(),
    });
    expect(exported.manifest).toEqual({
      schema: 1,
      slug: "bp-open",
      hostNumber: 1,
      lastSeq: 8,
      headHash: sourceHead.entryHash,
      createdAt: FIXED_DATE.toISOString(),
    });

    const importedResult = await importHandover(handoverPath, targetPath);
    expect(importedResult.hostNumber).toBe(2);
    expect(importedResult.hostRank).toBe(1);
    expect(importedResult.hostId).not.toBe(sourceHostId);
    expect(importedResult.stateHash).toBe(sourceHash);
    expect(importedResult.headHash).toBe(sourceHead.entryHash);

    const imported = track(HostEngine.open(targetPath));
    expect(imported.integrity).toEqual({ ok: true });
    expect(imported.canSync()).toBe(true);
    expect(imported.canPublish()).toBe(true);
    expect(await fastCheck(imported.database)).toEqual({ ok: true });
    expect(imported.getStateHash()).toBe(sourceHash);
    expect(imported.head()).toEqual(sourceHead);
    expect(imported.changelog()).toEqual(sourceChain);
    expect(imported.getState()?.links).toHaveLength(1);
    expect(imported.getState()?.links[0]?.lookupId).toBe(generated.lookupId);
    expect(
      await verifyChain(imported.changelog(), { expectedHead: sourceHead.entryHash }),
    ).toEqual({ ok: true, head: sourceHead.entryHash });

    expect(imported.database.prepare("SELECT value FROM meta WHERE key = 'host_number'").get())
      .toEqual({ value: "2" });
    expect(imported.database.prepare("SELECT value FROM meta WHERE key = 'host_id'").get())
      .toEqual({ value: importedResult.hostId });
    expect(imported.database.prepare("SELECT value FROM meta WHERE key = 'host_rank'").get())
      .toEqual({ value: "1" });
  });

  it("round-trips a handover when no snapshot has been taken yet (full state fallback)", async () => {
    const dir = makeTempDir();
    const sourcePath = path.join(dir, "nosnap.simpletab.db");
    const handoverPath = path.join(dir, "nosnap.simpletab");
    const targetPath = path.join(dir, "nosnap-imported.simpletab.db");

    const source = track(HostEngine.open(sourcePath, {
      initialState: makeInitialState(),
      clock: () => new Date(FIXED_DATE),
      snapshotEvery: 2000,
    }));
    for (let i = 1; i <= 3; i += 1) {
      expect((await source.submit(createTeamOp("t-bp", `team-${i}`), TAB_DIRECTOR)).ok).toBe(true);
    }

    exportHandover(source, handoverPath, { createdAt: FIXED_DATE.toISOString() });
    const importedResult = await importHandover(handoverPath, targetPath);
    expect(importedResult.stateHash).toBe(source.getStateHash());
    expect(importedResult.hostNumber).toBe(2);

    const reopened = track(HostEngine.open(targetPath));
    expect(reopened.integrity).toEqual({ ok: true });
    expect(reopened.getStateHash()).toBe(source.getStateHash());
    expect(reopened.changelog()).toEqual(source.changelog());
  });

  it("refuses to export if any meta key starts with 'credential'", async () => {
    const dir = makeTempDir();
    const engine = track(HostEngine.open(":memory:", {
      initialState: makeInitialState(),
      clock: () => new Date(FIXED_DATE),
    }));
    engine.database.prepare("INSERT INTO meta(key, value) VALUES ('credential_cdn', 'secret')").run();

    expect(() => exportHandover(engine, path.join(dir, "bad.simpletab"))).toThrow(/credential/i);
    expect(() => exportDivergent(engine, 0, dir)).toThrow(/credential/i);
  });

  it("rejects corrupted manifests, unsupported schemas, missing files, and divergent archives on handover import", async () => {
    const dir = makeTempDir();
    const engine = track(HostEngine.open(":memory:", {
      initialState: makeInitialState(),
      clock: () => new Date(FIXED_DATE),
    }));
    expect((await engine.submit(createTeamOp("t-bp", "team-1"), TAB_DIRECTOR)).ok).toBe(true);

    const validPath = path.join(dir, "valid.simpletab");
    exportHandover(engine, validPath, { createdAt: FIXED_DATE.toISOString() });
    const validZip = unzipSync(readFileSync(validPath));

    // Corrupted JSON in manifest.json
    const badJsonPath = path.join(dir, "bad-json.simpletab");
    writeFileSync(
      badJsonPath,
      zipSync({
        ...validZip,
        "manifest.json": Buffer.from("{not-valid-json", "utf8"),
      }),
    );
    await expect(importHandover(badJsonPath, path.join(dir, "out1.db"))).rejects.toThrow(/manifest/i);

    // Unsupported schema version
    const badSchemaPath = path.join(dir, "bad-schema.simpletab");
    const manifestObj = JSON.parse(Buffer.from(validZip["manifest.json"]!).toString("utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      badSchemaPath,
      zipSync({
        ...validZip,
        "manifest.json": Buffer.from(JSON.stringify({ ...manifestObj, schema: 99 }), "utf8"),
      }),
    );
    await expect(importHandover(badSchemaPath, path.join(dir, "out2.db"))).rejects.toThrow(/schema/i);

    // Wrong headHash in manifest
    const badHeadPath = path.join(dir, "bad-head.simpletab");
    writeFileSync(
      badHeadPath,
      zipSync({
        ...validZip,
        "manifest.json": Buffer.from(
          JSON.stringify({ ...manifestObj, headHash: "f".repeat(64) }),
          "utf8",
        ),
      }),
    );
    await expect(importHandover(badHeadPath, path.join(dir, "out3.db"))).rejects.toThrow(/verification|head/i);

    // Divergent export cannot be imported as a full handover
    const divergent = exportDivergent(engine, 0, dir, { createdAt: FIXED_DATE.toISOString() });
    await expect(importHandover(divergent.filePath, path.join(dir, "out4.db"))).rejects.toThrow(
      /divergent/i,
    );
  });

  it("exportDivergent writes <slug>.divergent.simpletab containing exactly ops with seq > forkSeq", async () => {
    const dir = makeTempDir();
    const engine = track(HostEngine.open(":memory:", {
      initialState: makeInitialState(),
      clock: () => new Date(FIXED_DATE),
    }));

    for (let i = 1; i <= 6; i += 1) {
      expect((await engine.submit(createTeamOp("t-bp", `team-${i}`), TAB_DIRECTOR)).ok).toBe(true);
    }

    const result = exportDivergent(engine, 3, dir, { createdAt: FIXED_DATE.toISOString() });
    expect(result.filePath).toBe(path.join(dir, "bp-open.divergent.simpletab"));
    expect(result.opCount).toBe(3);

    const archive = unzipSync(readFileSync(result.filePath));
    expect(Object.keys(archive).sort()).toEqual([
      "links.json",
      "manifest.json",
      "ops.ndjson",
      "snapshot.json.gz",
    ]);

    const manifest = JSON.parse(Buffer.from(archive["manifest.json"]!).toString("utf8")) as DivergentManifest;
    expect(manifest).toEqual({
      schema: 1,
      kind: "divergent",
      slug: "bp-open",
      hostNumber: 1,
      forkSeq: 3,
      lastSeq: 6,
      headHash: engine.head().entryHash,
      createdAt: FIXED_DATE.toISOString(),
    });

    const ops = parseOpsNdjson(archive["ops.ndjson"]!);
    expect(ops.map((op) => op.seq)).toEqual([4, 5, 6]);
    expect(ops.map((op) => (op.payload as { team: Team }).team.id)).toEqual([
      "team-4",
      "team-5",
      "team-6",
    ]);
  });
});
