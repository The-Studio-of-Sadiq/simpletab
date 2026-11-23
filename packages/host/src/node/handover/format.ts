import {
  GENESIS_HASH,
  type ActorType,
  type ChangelogEntry,
} from "@simpletab/core/changelog";
import type { OpRequest, RecordKey } from "@simpletab/core/ops";
import type { Role } from "@simpletab/core/permissions";
import type { SqliteDatabase } from "../db/database";
import type { StoredOpRowFull } from "../engine/integrity";

export interface HandoverManifest {
  schema: 1;
  kind?: "handover" | "divergent";
  slug: string;
  hostNumber: number;
  lastSeq: number;
  headHash: string;
  createdAt: string;
  forkSeq?: number;
}

export interface DivergentManifest extends HandoverManifest {
  kind: "divergent";
  forkSeq: number;
}

export interface HandoverOpRecord {
  seq: number;
  ts: string;
  actorRef: string;
  actorType: ActorType;
  actorRoleId: string;
  actorRole: Role | null;
  actorIsHostOwner: boolean;
  type: string;
  requestPayload: unknown;
  requestForced: boolean;
  payload: unknown;
  writes: RecordKey[];
  inverse: OpRequest<unknown> | null;
  inverseOf: number | null;
  hostNumber: number;
  changelog: {
    entry: ChangelogEntry;
    salt: string;
    entryHash: string;
  };
}

interface JoinedOpChangelogRow extends StoredOpRowFull {
  cl_entry: string;
  cl_salt: Buffer;
  cl_entry_hash: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;
const HEX_64_RE = /^[0-9a-f]{64}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** Asserts that `meta` contains no keys starting with `"credential"` (case-insensitive). */
export function assertNoCredentialMeta(database: SqliteDatabase): void {
  const rows = database.prepare(
    "SELECT key FROM meta WHERE lower(key) LIKE 'credential%'",
  ).all() as { key: string }[];
  if (rows.length > 0) {
    throw new Error(
      `Refusing to export: database meta contains credential key(s): ${rows.map((r) => r.key).join(", ")}.`,
    );
  }
}

export function readHostNumber(database: SqliteDatabase): number {
  const row = database.prepare("SELECT value FROM meta WHERE key = 'host_number'")
    .get() as { value: string } | undefined;
  const parsed = row === undefined ? 1 : Number(row.value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid host_number in meta: ${row?.value ?? "<missing>"}`);
  }
  return parsed;
}

/** Reads joined ops + changelog rows with `seq > afterSeq` in ascending order. */
export function readOpRecordsAfter(
  database: SqliteDatabase,
  afterSeq: number,
): HandoverOpRecord[] {
  const rows = database.prepare(
    "SELECT o.seq, o.ts, o.actor_ref, o.actor_type, o.actor_role_id, o.actor_role, " +
    "o.actor_is_host_owner, o.type, o.payload, o.request_payload, o.request_forced, " +
    "o.writes, o.inverse, o.inverse_of, o.host_number, " +
    "c.entry AS cl_entry, c.salt AS cl_salt, c.entry_hash AS cl_entry_hash " +
    "FROM ops o INNER JOIN changelog c ON c.seq = o.seq " +
    "WHERE o.seq > ? ORDER BY o.seq ASC",
  ).all(afterSeq) as JoinedOpChangelogRow[];

  return rows.map((row) => {
    const saltBuf = Buffer.isBuffer(row.cl_salt) ? row.cl_salt : Buffer.from(row.cl_salt);
    const salt = saltBuf.toString("base64url");
    const committedPayload: unknown = JSON.parse(row.payload);
    const requestPayload: unknown =
      row.request_payload !== null ? JSON.parse(row.request_payload) : committedPayload;
    return {
      seq: row.seq,
      ts: row.ts,
      actorRef: row.actor_ref,
      actorType: row.actor_type as ActorType,
      actorRoleId: row.actor_role_id,
      actorRole: row.actor_role !== null ? (JSON.parse(row.actor_role) as Role) : null,
      actorIsHostOwner: row.actor_is_host_owner === 1,
      type: row.type,
      requestPayload,
      requestForced: row.request_forced === 1,
      payload: committedPayload,
      writes: JSON.parse(row.writes) as RecordKey[],
      inverse: row.inverse !== null ? (JSON.parse(row.inverse) as OpRequest<unknown>) : null,
      inverseOf: row.inverse_of,
      hostNumber: row.host_number,
      changelog: {
        entry: JSON.parse(row.cl_entry) as ChangelogEntry,
        salt,
        entryHash: row.cl_entry_hash,
      },
    };
  });
}

export function serializeOpsNdjson(records: readonly HandoverOpRecord[]): Uint8Array {
  if (records.length === 0) {
    return new Uint8Array(0);
  }
  const text = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  return Buffer.from(text, "utf8");
}

export function parseOpsNdjson(bytes: Uint8Array): HandoverOpRecord[] {
  const text = Buffer.from(bytes).toString("utf8").trim();
  if (text.length === 0) {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const records: HandoverOpRecord[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Invalid JSON in ops.ndjson at line ${i + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Invalid op record in ops.ndjson at line ${i + 1}.`);
    }
    const candidate = parsed as Partial<HandoverOpRecord>;
    if (
      typeof candidate.seq !== "number" ||
      !Number.isInteger(candidate.seq) ||
      candidate.seq < 1 ||
      typeof candidate.ts !== "string" ||
      typeof candidate.actorRef !== "string" ||
      typeof candidate.actorType !== "string" ||
      typeof candidate.type !== "string" ||
      !Array.isArray(candidate.writes) ||
      typeof candidate.changelog !== "object" ||
      candidate.changelog === null ||
      typeof candidate.changelog.entry !== "object" ||
      candidate.changelog.entry === null ||
      typeof candidate.changelog.salt !== "string" ||
      typeof candidate.changelog.entryHash !== "string"
    ) {
      throw new Error(`Malformed op record in ops.ndjson at line ${i + 1}.`);
    }
    records.push(candidate as HandoverOpRecord);
  }
  return records;
}

/** Validates a parsed handover manifest object. Rejects malformed or divergent manifests. */
export function validateHandoverManifest(raw: unknown): HandoverManifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Handover manifest must be a JSON object.");
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.schema !== 1) {
    throw new Error(`Unsupported handover manifest schema: ${String(candidate.schema)}.`);
  }
  if (candidate.kind !== undefined && candidate.kind !== "handover") {
    throw new Error(`Cannot import archive of kind "${String(candidate.kind)}" as a handover file.`);
  }
  if (typeof candidate.slug !== "string" || !SLUG_RE.test(candidate.slug)) {
    throw new Error(`Invalid handover manifest slug: ${String(candidate.slug)}.`);
  }
  if (
    typeof candidate.hostNumber !== "number" ||
    !Number.isInteger(candidate.hostNumber) ||
    candidate.hostNumber < 1
  ) {
    throw new Error(`Invalid handover manifest hostNumber: ${String(candidate.hostNumber)}.`);
  }
  if (
    typeof candidate.lastSeq !== "number" ||
    !Number.isInteger(candidate.lastSeq) ||
    candidate.lastSeq < 0
  ) {
    throw new Error(`Invalid handover manifest lastSeq: ${String(candidate.lastSeq)}.`);
  }
  if (typeof candidate.headHash !== "string" || !HEX_64_RE.test(candidate.headHash)) {
    throw new Error(`Invalid handover manifest headHash: ${String(candidate.headHash)}.`);
  }
  if (candidate.lastSeq === 0 && candidate.headHash !== GENESIS_HASH) {
    throw new Error("Handover manifest with lastSeq 0 must have the genesis headHash.");
  }
  if (
    typeof candidate.createdAt !== "string" ||
    !ISO_UTC_RE.test(candidate.createdAt) ||
    Number.isNaN(Date.parse(candidate.createdAt))
  ) {
    throw new Error(`Invalid handover manifest createdAt: ${String(candidate.createdAt)}.`);
  }

  return {
    schema: 1,
    ...(candidate.kind === "handover" ? { kind: "handover" } : {}),
    slug: candidate.slug,
    hostNumber: candidate.hostNumber,
    lastSeq: candidate.lastSeq,
    headHash: candidate.headHash,
    createdAt: candidate.createdAt,
  };
}
