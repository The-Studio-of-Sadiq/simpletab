import { existsSync, rmSync } from "node:fs";
import { unzipSync } from "fflate";
import type { Actor } from "@simpletab/core/ops";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import { HostEngine } from "../engine/engine";
import { readHostNumber } from "../handover/format";
import { importHandover, verifyHandoverEntries } from "../handover/import";

export interface PromoteOptions {
  handover: Uint8Array;
  targetDbPath: string;
  rank: number;
  minHostNumber: number;
  now?: () => Date;
}

export interface PromoteResult {
  dbPath: string;
  hostNumber: number;
  hostId: string;
  hostRank: number;
  promotedFromSeq: number;
  headHash: string;
}

// Kept local to avoid an import cycle with ../host-service (which imports DeviceMode).
const HOST_OWNER_ACTOR: Actor = {
  ref: "host-owner",
  type: "human",
  role: BUILT_IN_ROLES.host_owner,
  isHostOwner: true,
};

function removeDbFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

function toPlainError(error: unknown): Error {
  if (error instanceof Error && error.constructor === Error) {
    return error;
  }
  return new Error(error instanceof Error ? error.message : String(error));
}

/**
 * Promotes a verified replica handover archive into a new host SQLite database at `targetDbPath`
 * (design section 4 "Promotion and the host number").
 */
export async function promoteReplica(opts: PromoteOptions): Promise<PromoteResult> {
  if (!Number.isInteger(opts.rank) || opts.rank < 1) {
    throw new Error(`Promotion rank must be a positive integer, got ${String(opts.rank)}.`);
  }
  if (!Number.isInteger(opts.minHostNumber) || opts.minHostNumber < 1) {
    throw new Error(
      `Promotion minHostNumber must be a positive integer, got ${String(opts.minHostNumber)}.`,
    );
  }
  if (opts.targetDbPath.trim().length === 0 || opts.targetDbPath === ":memory:") {
    throw new Error(`Invalid target database path for promotion: ${opts.targetDbPath}`);
  }
  if (existsSync(opts.targetDbPath)) {
    throw new Error(`Target database path already exists: ${opts.targetDbPath}`);
  }

  try {
    const imported = await importHandover(opts.handover, opts.targetDbPath);
    const targetHostNumber = Math.max(imported.hostNumber, opts.minHostNumber);
    const promotedFromSeq = imported.lastSeq;

    const engine = HostEngine.open(
      opts.targetDbPath,
      opts.now !== undefined ? { clock: opts.now } : {},
    );
    try {
      const updateMeta = engine.database.transaction(() => {
        const setMeta = engine.database.prepare(
          "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        );
        setMeta.run("host_rank", String(opts.rank));
        setMeta.run("host_number", String(targetHostNumber));
        setMeta.run("promoted_from_seq", String(promotedFromSeq));
      });
      updateMeta();

      const state = engine.getState();
      if (state === null) {
        throw new Error("Promoted database has no tournament state.");
      }

      const opHostNumber = (state.host?.number ?? 1) + 1;
      const submitResult = await engine.submit(
        {
          type: "host.promote",
          payload: {
            newHostNumber: opHostNumber,
            hostId: imported.hostId,
            rank: opts.rank,
          },
        },
        HOST_OWNER_ACTOR,
      );
      if (!submitResult.ok) {
        throw new Error(`Failed to commit host.promote op: ${submitResult.errors.join("; ")}`);
      }

      const hostNumber = readHostNumber(engine.database);
      const head = engine.head();

      return {
        dbPath: opts.targetDbPath,
        hostNumber,
        hostId: imported.hostId,
        hostRank: opts.rank,
        promotedFromSeq,
        headHash: head.entryHash,
      };
    } finally {
      await engine.close();
    }
  } catch (error) {
    removeDbFiles(opts.targetDbPath);
    throw toPlainError(error);
  }
}

async function verifyArchive(bytes: Uint8Array, label: string) {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    throw new Error(
      `Invalid ${label} handover archive: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return await verifyHandoverEntries(entries);
  } catch (error) {
    throw toPlainError(error);
  }
}

/**
 * Picks the copy to promote from: returns whichever is longer when one chain is a prefix of the
 * other (same `entryHash` at every shared seq); throws a plain `Error` naming the first differing
 * seq when they diverge, or when either copy is invalid.
 */
export async function chooseNewerCopy(
  own: Uint8Array,
  other: Uint8Array,
): Promise<{ handover: Uint8Array; lastSeq: number; from: "own" | "other" }> {
  const [ownVerified, otherVerified] = await Promise.all([
    verifyArchive(own, "own"),
    verifyArchive(other, "other"),
  ]);

  if (ownVerified.manifest.slug !== otherVerified.manifest.slug) {
    throw new Error(
      `Copies belong to different tournaments ("${ownVerified.manifest.slug}" vs "${otherVerified.manifest.slug}").`,
    );
  }

  const sharedCount = Math.min(ownVerified.opRecords.length, otherVerified.opRecords.length);
  for (let i = 0; i < sharedCount; i += 1) {
    const seq = i + 1;
    if (
      ownVerified.opRecords[i]!.changelog.entryHash !==
      otherVerified.opRecords[i]!.changelog.entryHash
    ) {
      throw new Error(`Copies diverge at seq ${seq}.`);
    }
  }

  if (otherVerified.manifest.lastSeq > ownVerified.manifest.lastSeq) {
    return {
      handover: other,
      lastSeq: otherVerified.manifest.lastSeq,
      from: "other",
    };
  }

  return {
    handover: own,
    lastSeq: ownVerified.manifest.lastSeq,
    from: "own",
  };
}
