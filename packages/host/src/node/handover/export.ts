import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";
import type { HostEngine } from "../engine/engine";
import { encodeSnapshot, readLatestSnapshot } from "../engine/snapshots";
import {
  assertNoCredentialMeta,
  readHostNumber,
  readOpRecordsAfter,
  serializeOpsNdjson,
  type HandoverManifest,
} from "./format";

export interface ExportHandoverOptions {
  createdAt?: string;
}

export interface ExportHandoverResult {
  filePath: string;
  manifest: HandoverManifest;
}

/**
 * Exports a `.simpletab` handover archive (zip via `fflate`) containing:
 * - `manifest.json`
 * - `ops.ndjson`
 * - `snapshot.json.gz` (latest snapshot, or full current state if no snapshot exists)
 * - `links.json` (`state.links`)
 *
 * Credentials are never stored in SQLite or included; exports fail if any `meta` key
 * starts with `"credential"`.
 */
export function exportHandover(
  engine: HostEngine,
  outputPath: string,
  options: ExportHandoverOptions = {},
): ExportHandoverResult {
  assertNoCredentialMeta(engine.database);

  const state = engine.getState();
  if (state === null) {
    throw new Error("Cannot export a handover from an uninitialized tournament database.");
  }

  const head = engine.head();
  const hostNumber = readHostNumber(engine.database);
  const createdAt = options.createdAt ?? new Date().toISOString();

  const manifest: HandoverManifest = {
    schema: 1,
    slug: state.tournament.slug,
    hostNumber,
    lastSeq: head.seq,
    headHash: head.entryHash,
    createdAt,
  };

  const opRecords = readOpRecordsAfter(engine.database, 0);
  const latestSnapshot = readLatestSnapshot(engine.database);
  const snapshotBytes =
    latestSnapshot !== null
      ? new Uint8Array(
          latestSnapshot.data.buffer,
          latestSnapshot.data.byteOffset,
          latestSnapshot.data.byteLength,
        )
      : new Uint8Array(encodeSnapshot(state).data);

  const archiveBytes = zipSync({
    "manifest.json": Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
    "ops.ndjson": serializeOpsNdjson(opRecords),
    "snapshot.json.gz": snapshotBytes,
    "links.json": Buffer.from(JSON.stringify(state.links), "utf8"),
  });

  mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  writeFileSync(outputPath, archiveBytes);

  return { filePath: outputPath, manifest };
}
