import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";
import type { HostEngine } from "../engine/engine";
import { encodeSnapshot, readLatestSnapshot } from "../engine/snapshots";
import {
  assertNoCredentialMeta,
  readHostNumber,
  readOpRecordsAfter,
  serializeOpsNdjson,
  type DivergentManifest,
} from "./format";

export interface ExportDivergentOptions {
  createdAt?: string;
}

export interface ExportDivergentResult {
  filePath: string;
  manifest: DivergentManifest;
  opCount: number;
}

function resolveDivergentPath(outputPath: string, slug: string): string {
  const filename = `${slug}.divergent.simpletab`;
  if (
    outputPath.endsWith("/") ||
    outputPath.endsWith("\\") ||
    (existsSync(outputPath) && statSync(outputPath).isDirectory())
  ) {
    return path.join(outputPath, filename);
  }
  return outputPath;
}

/**
 * Exports all ops committed after `forkSeq` to `<slug>.divergent.simpletab` (design section 4,
 * promotion step 7) using the same `.simpletab` zip layout with `manifest.kind = "divergent"`
 * and `manifest.forkSeq`.
 */
export function exportDivergent(
  engine: HostEngine,
  forkSeq: number,
  outputPath: string,
  options: ExportDivergentOptions = {},
): ExportDivergentResult {
  if (!Number.isInteger(forkSeq) || forkSeq < 0) {
    throw new RangeError(`forkSeq must be a non-negative integer, got ${forkSeq}.`);
  }
  assertNoCredentialMeta(engine.database);

  const state = engine.getState();
  if (state === null) {
    throw new Error("Cannot export divergent ops from an uninitialized tournament database.");
  }

  const head = engine.head();
  const hostNumber = readHostNumber(engine.database);
  const createdAt = options.createdAt ?? new Date().toISOString();

  const manifest: DivergentManifest = {
    schema: 1,
    kind: "divergent",
    slug: state.tournament.slug,
    hostNumber,
    forkSeq,
    lastSeq: head.seq,
    headHash: head.entryHash,
    createdAt,
  };

  const divergentOps = readOpRecordsAfter(engine.database, forkSeq);
  const latestSnapshot = readLatestSnapshot(engine.database);
  const snapshotBytes =
    latestSnapshot !== null && latestSnapshot.seq >= forkSeq
      ? new Uint8Array(
          latestSnapshot.data.buffer,
          latestSnapshot.data.byteOffset,
          latestSnapshot.data.byteLength,
        )
      : new Uint8Array(encodeSnapshot(state).data);

  const archiveBytes = zipSync({
    "manifest.json": Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
    "ops.ndjson": serializeOpsNdjson(divergentOps),
    "snapshot.json.gz": snapshotBytes,
    "links.json": Buffer.from(JSON.stringify(state.links), "utf8"),
  });

  const filePath = resolveDivergentPath(outputPath, state.tournament.slug);
  mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  writeFileSync(filePath, archiveBytes);

  return { filePath, manifest, opCount: divergentOps.length };
}
