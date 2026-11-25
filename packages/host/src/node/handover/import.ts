import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { unzipSync } from "fflate";
import {
  canonicalize,
  verifyChain,
  type PublicChainItem,
} from "@simpletab/core/changelog";
import {
  defaultRegistry,
  type OpRegistryLookup,
  type TournamentState,
} from "@simpletab/core/ops";
import type { LinkRecord } from "@simpletab/core/projection";
import { openDatabase } from "../db/database";
import { replayOpRow, type StoredOpRowFull } from "../engine/integrity";
import { decodeSnapshot, writeSnapshot } from "../engine/snapshots";
import {
  allRecordKeys,
  fromContentOnlyState,
  writeChangedRecords,
  type ContentOnlyState,
} from "../state/load";
import { stateHash, stateHashFromState } from "../state/state-hash";
import {
  parseOpsNdjson,
  validateHandoverManifest,
  type HandoverManifest,
  type HandoverOpRecord,
} from "./format";

export interface ImportHandoverOptions {
  registry?: OpRegistryLookup;
}

export interface ImportHandoverResult {
  targetPath: string;
  manifest: HandoverManifest;
  slug: string;
  hostNumber: number;
  hostId: string;
  hostRank: 1;
  lastSeq: number;
  headHash: string;
  stateHash: string;
}

export interface VerifiedHandover {
  manifest: HandoverManifest;
  opRecords: HandoverOpRecord[];
  snapshotBytes: Uint8Array;
  snapshotContent: ContentOnlyState;
  snapshotHash: string;
  hasRealSnapshot: boolean;
  initialSnapshotState: TournamentState;
  finalState: TournamentState;
  snapshotSeq: number;
  replayedSteps: { record: HandoverOpRecord; state: TournamentState }[];
}

export function toStoredOpRow(record: HandoverOpRecord): StoredOpRowFull {
  return {
    seq: record.seq,
    ts: record.ts,
    actor_ref: record.actorRef,
    actor_type: record.actorType,
    actor_role_id: record.actorRoleId ?? "host_owner",
    actor_role: record.actorRole !== null ? JSON.stringify(record.actorRole) : null,
    actor_is_host_owner: record.actorIsHostOwner ? 1 : 0,
    type: record.type,
    payload: JSON.stringify(record.payload),
    request_payload: JSON.stringify(record.requestPayload),
    request_forced: record.requestForced ? 1 : 0,
    writes: JSON.stringify(record.writes),
    inverse: record.inverse === null ? null : JSON.stringify(record.inverse),
    inverse_of: record.inverseOf,
    host_number: record.hostNumber,
  };
}

/**
 * Verifies the extracted entries of a `.simpletab` handover archive:
 * 1. Validates `manifest.json`, `ops.ndjson`, `snapshot.json.gz`, and `links.json`.
 * 2. Verifies the entire changelog chain and payload commitments via core's `verifyChain`.
 * 3. Verifies the snapshot hash against its changelog entry (if a snapshot existed) and replays
 *    all subsequent ops through core's `applyOp`, checking `links.json` matches.
 */
export async function verifyHandoverEntries(
  entries: Record<string, Uint8Array>,
  options: ImportHandoverOptions = {},
): Promise<VerifiedHandover> {
  const registry = options.registry ?? defaultRegistry();

  const manifestBytes = entries["manifest.json"];
  const opsBytes = entries["ops.ndjson"];
  const snapshotBytes = entries["snapshot.json.gz"];
  const linksBytes = entries["links.json"];
  if (
    manifestBytes === undefined ||
    opsBytes === undefined ||
    snapshotBytes === undefined ||
    linksBytes === undefined
  ) {
    throw new Error(
      "Handover archive is missing one or more required files (manifest.json, ops.ndjson, snapshot.json.gz, links.json).",
    );
  }

  let parsedManifestRaw: unknown;
  try {
    parsedManifestRaw = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
  } catch (error) {
    throw new Error(
      `Corrupted manifest.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = validateHandoverManifest(parsedManifestRaw);

  const opRecords = parseOpsNdjson(opsBytes);
  if (opRecords.length !== manifest.lastSeq) {
    throw new Error(
      `Handover ops count (${opRecords.length}) does not match manifest lastSeq (${manifest.lastSeq}).`,
    );
  }

  const chainItems: PublicChainItem[] = [];
  for (let i = 0; i < opRecords.length; i += 1) {
    const expectedSeq = i + 1;
    const record = opRecords[i]!;
    if (record.seq !== expectedSeq) {
      throw new Error(`Handover op sequence mismatch: expected ${expectedSeq}, got ${record.seq}.`);
    }
    const { entry } = record.changelog;
    if (
      record.type !== entry.opType ||
      record.ts !== entry.ts ||
      record.actorRef !== entry.actorRef ||
      record.actorType !== entry.actorType
    ) {
      throw new Error(`Handover op ${expectedSeq} metadata does not match its changelog entry.`);
    }
    chainItems.push({
      entry,
      entryHash: record.changelog.entryHash,
      payload: record.payload,
      salt: record.changelog.salt,
    });
  }

  const chainCheck = await verifyChain(chainItems, { expectedHead: manifest.headHash });
  if (!chainCheck.ok) {
    throw new Error(
      `Handover changelog verification failed at seq ${chainCheck.seq}: ${chainCheck.reason}`,
    );
  }

  let snapshotContent: ContentOnlyState;
  try {
    snapshotContent = decodeSnapshot(snapshotBytes);
  } catch (error) {
    throw new Error(
      `Corrupted snapshot.json.gz: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (snapshotContent.tournament.slug !== manifest.slug) {
    throw new Error(
      `Handover snapshot slug ("${snapshotContent.tournament.slug}") does not match manifest slug ("${manifest.slug}").`,
    );
  }

  let parsedLinks: unknown;
  try {
    parsedLinks = JSON.parse(Buffer.from(linksBytes).toString("utf8"));
  } catch (error) {
    throw new Error(
      `Corrupted links.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsedLinks)) {
    throw new Error("Handover links.json must be a JSON array.");
  }
  const linksFromFile = parsedLinks as LinkRecord[];

  const snapshotHash = stateHashFromState(snapshotContent);
  let lastSnapshotOp: HandoverOpRecord | null = null;
  for (const record of opRecords) {
    if (record.changelog.entry.stateHash !== undefined) {
      lastSnapshotOp = record;
    }
  }

  let snapshotSeq: number;
  const hasRealSnapshot = lastSnapshotOp !== null;
  if (lastSnapshotOp !== null) {
    snapshotSeq = lastSnapshotOp.seq;
    if (lastSnapshotOp.changelog.entry.stateHash !== snapshotHash) {
      throw new Error(
        `Handover snapshot hash (${snapshotHash}) does not match changelog stateHash at seq ${snapshotSeq} (${lastSnapshotOp.changelog.entry.stateHash}).`,
      );
    }
  } else {
    snapshotSeq = manifest.lastSeq;
  }

  // Reconstruct state by replaying ops after `snapshotSeq`.
  const initialSnapshotState = fromContentOnlyState(snapshotContent);
  let currentState: TournamentState = initialSnapshotState;
  const replayedSteps: { record: HandoverOpRecord; state: TournamentState }[] = [];

  for (const record of opRecords) {
    if (record.seq <= snapshotSeq) {
      continue;
    }
    const step = replayOpRow(currentState, toStoredOpRow(record), registry);
    if (!step.ok) {
      throw new Error(`Handover replay failed at seq ${record.seq}: ${step.reason}`);
    }
    currentState = step.state;
    replayedSteps.push({ record, state: currentState });
  }

  if (canonicalize(currentState.links) !== canonicalize(linksFromFile)) {
    throw new Error("Handover links.json does not match reconstructed state links.");
  }

  return {
    manifest,
    opRecords,
    snapshotBytes,
    snapshotContent,
    snapshotHash,
    hasRealSnapshot,
    initialSnapshotState,
    finalState: currentState,
    snapshotSeq,
    replayedSteps,
  };
}

/**
 * Imports a `.simpletab` handover file into `targetPath`:
 * 1. Unzips and validates `manifest.json`, `ops.ndjson`, `snapshot.json.gz`, and `links.json`.
 * 2. Verifies the entire changelog chain and payload commitments via core's `verifyChain`.
 * 3. Verifies the snapshot hash against its changelog entry (if a snapshot existed) and replays
 *    all subsequent ops through core's `applyOp`.
 * 4. Rebuilds the SQLite database with `host_number = imported + 1`, a fresh random `host_id`,
 *    and `host_rank = 1`.
 */
export async function importHandover(
  file: string | Uint8Array,
  targetPath: string,
  options: ImportHandoverOptions = {},
): Promise<ImportHandoverResult> {
  const rawBytes = typeof file === "string" ? readFileSync(file) : file;

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(rawBytes);
  } catch (error) {
    throw new Error(
      `Invalid handover archive: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const {
    manifest,
    opRecords,
    snapshotBytes,
    snapshotHash,
    hasRealSnapshot,
    initialSnapshotState,
    finalState: currentState,
    snapshotSeq,
    replayedSteps,
  } = await verifyHandoverEntries(entries, options);

  const newHostNumber = manifest.hostNumber + 1;
  const newHostId = randomUUID();
  const newHostRank = 1 as const;

  if (targetPath !== ":memory:" && existsSync(targetPath)) {
    throw new Error(`Target database path already exists: ${targetPath}`);
  }

  const database = openDatabase(targetPath);
  try {
    const rebuild = database.transaction(() => {
      // Seed live entity tables at snapshotSeq, then apply replayed tail ops so versions/last_seq advance.
      writeChangedRecords(
        database,
        initialSnapshotState,
        allRecordKeys(initialSnapshotState),
        snapshotSeq,
      );
      for (const step of replayedSteps) {
        writeChangedRecords(database, step.state, step.record.writes, step.record.seq);
      }

      const insertOp = database.prepare(
        "INSERT INTO ops(" +
          "seq, ts, actor_ref, actor_type, actor_role_id, actor_role, actor_is_host_owner, " +
          "type, payload, request_payload, request_forced, writes, inverse, inverse_of, host_number" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insertChangelog = database.prepare(
        "INSERT INTO changelog(seq, entry, salt, entry_hash) VALUES (?, ?, ?, ?)",
      );

      for (const record of opRecords) {
        insertOp.run(
          record.seq,
          record.ts,
          record.actorRef,
          record.actorType,
          record.actorRoleId ?? "host_owner",
          record.actorRole !== null ? JSON.stringify(record.actorRole) : null,
          record.actorIsHostOwner ? 1 : 0,
          record.type,
          JSON.stringify(record.payload),
          JSON.stringify(record.requestPayload),
          record.requestForced ? 1 : 0,
          JSON.stringify(record.writes),
          record.inverse === null ? null : JSON.stringify(record.inverse),
          record.inverseOf,
          record.hostNumber,
        );
        insertChangelog.run(
          record.seq,
          canonicalize(record.changelog.entry),
          Buffer.from(record.changelog.salt, "base64url"),
          record.changelog.entryHash,
        );
      }

      if (hasRealSnapshot) {
        writeSnapshot(database, snapshotSeq, {
          stateHash: snapshotHash,
          data: Buffer.from(snapshotBytes),
        });
      }

      const setMeta = database.prepare(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      );
      setMeta.run("slug", manifest.slug);
      setMeta.run("host_number", String(newHostNumber));
      setMeta.run("host_id", newHostId);
      setMeta.run("host_rank", String(newHostRank));
      if (manifest.lastSeq === 0) {
        setMeta.run("seed_state", Buffer.from(snapshotBytes).toString("base64"));
      }
    });
    rebuild();

    const finalStateHash = stateHash(database);
    const expectedStateHash = stateHashFromState(currentState);
    if (finalStateHash !== expectedStateHash) {
      throw new Error(
        `Rebuilt database state hash (${finalStateHash}) does not match expected state hash (${expectedStateHash}).`,
      );
    }

    return {
      targetPath,
      manifest,
      slug: manifest.slug,
      hostNumber: newHostNumber,
      hostId: newHostId,
      hostRank: newHostRank,
      lastSeq: manifest.lastSeq,
      headHash: manifest.headHash,
      stateHash: finalStateHash,
    };
  } catch (error) {
    database.close();
    if (targetPath !== ":memory:") {
      rmSync(targetPath, { force: true });
      rmSync(`${targetPath}-wal`, { force: true });
      rmSync(`${targetPath}-shm`, { force: true });
    }
    throw error;
  } finally {
    if (database.open) {
      database.close();
    }
  }
}
