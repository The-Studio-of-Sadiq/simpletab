import { gunzipSync, gzipSync } from "node:zlib";
import { canonicalize } from "@simpletab/core/changelog";
import type { TournamentState } from "@simpletab/core/ops/types";
import type { SqliteDatabase } from "../db/database";
import {
  fromContentOnlyState,
  toContentOnlyState,
  type ContentOnlyState,
} from "../state/load";
import { stateHashFromState } from "../state/state-hash";

export const DEFAULT_SNAPSHOT_EVERY = 2000;

export interface EncodedSnapshot {
  stateHash: string;
  data: Buffer;
}

export interface StoredSnapshotRow {
  seq: number;
  state_hash: string;
  data: Buffer;
}

/**
 * Decides whether committing an op at `seq` triggers a snapshot:
 * every `snapshotEvery` ops (default 2,000) and whenever `round.set_completion` marks a round completed.
 */
export function shouldTakeSnapshot(
  seq: number,
  opType: string,
  committedPayload: unknown,
  snapshotEvery = DEFAULT_SNAPSHOT_EVERY,
): boolean {
  if (seq > 0 && snapshotEvery > 0 && seq % snapshotEvery === 0) {
    return true;
  }
  if (
    opType === "round.set_completion" &&
    typeof committedPayload === "object" &&
    committedPayload !== null &&
    (committedPayload as { completed?: unknown }).completed === true
  ) {
    return true;
  }
  return false;
}

/** Encodes content-only state as gzip(canonicalize(contentOnlyState)) and computes its state hash. */
export function encodeSnapshot(state: TournamentState): EncodedSnapshot {
  const contentOnly = toContentOnlyState(state);
  const hash = stateHashFromState(contentOnly);
  const canonicalJson = canonicalize(contentOnly);
  const data = gzipSync(Buffer.from(canonicalJson, "utf8"));
  return { stateHash: hash, data };
}

/** Decodes a gzipped canonical JSON snapshot back into content-only state. */
export function decodeSnapshot(data: Uint8Array): ContentOnlyState {
  const raw = gunzipSync(data).toString("utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Snapshot payload must be a JSON object.");
  }
  const candidate = parsed as Partial<ContentOnlyState>;
  if (
    typeof candidate.tournament !== "object" ||
    candidate.tournament === null ||
    !Array.isArray(candidate.institutions) ||
    !Array.isArray(candidate.teams) ||
    !Array.isArray(candidate.adjudicators) ||
    !Array.isArray(candidate.venues) ||
    !Array.isArray(candidate.rounds) ||
    !Array.isArray(candidate.debates) ||
    !Array.isArray(candidate.motions) ||
    !Array.isArray(candidate.ballots) ||
    !Array.isArray(candidate.feedback) ||
    !Array.isArray(candidate.breakCategories) ||
    !Array.isArray(candidate.links) ||
    !Array.isArray(candidate.registrations) ||
    !Array.isArray(candidate.devices) ||
    !Array.isArray(candidate.roles) ||
    !Array.isArray(candidate.proposals)
  ) {
    throw new Error("Snapshot payload is missing required tournament collections.");
  }
  return candidate as ContentOnlyState;
}

/** Persists a snapshot row inside the caller's transaction (or standalone). */
export function writeSnapshot(
  database: SqliteDatabase,
  seq: number,
  snapshot: EncodedSnapshot,
): void {
  database.prepare(
    "INSERT INTO snapshots(seq, state_hash, data) VALUES (?, ?, ?) " +
    "ON CONFLICT(seq) DO UPDATE SET state_hash=excluded.state_hash, data=excluded.data",
  ).run(seq, snapshot.stateHash, snapshot.data);
}

/** Reads the most recent snapshot row, or `null` if no snapshot exists. */
export function readLatestSnapshot(database: SqliteDatabase): StoredSnapshotRow | null {
  const row = database.prepare(
    "SELECT seq, state_hash, data FROM snapshots ORDER BY seq DESC LIMIT 1",
  ).get() as StoredSnapshotRow | undefined;
  return row ?? null;
}

/** Reads every stored snapshot in ascending `seq` order. */
export function readAllSnapshots(database: SqliteDatabase): StoredSnapshotRow[] {
  return database.prepare(
    "SELECT seq, state_hash, data FROM snapshots ORDER BY seq ASC",
  ).all() as StoredSnapshotRow[];
}

/** Reads and decodes the seq-0 seed state stored in `meta.seed_state`, if present. */
export function readSeedState(database: SqliteDatabase): TournamentState | null {
  const row = database.prepare("SELECT value FROM meta WHERE key = 'seed_state'").get() as
    | { value: string }
    | undefined;
  if (row === undefined) {
    return null;
  }
  const bytes = Buffer.from(row.value, "base64");
  const content = decodeSnapshot(bytes);
  return fromContentOnlyState(content);
}
