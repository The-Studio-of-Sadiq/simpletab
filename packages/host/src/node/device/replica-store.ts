import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { provePrivate } from "@simpletab/core/changelog";
import { computeEntryHash } from "@simpletab/core/changelog/v2";
import { defaultRegistry, type OpRegistryLookup, type TournamentState } from "@simpletab/core/ops";
import { replayOpRow } from "../engine/integrity";
import { encodeSnapshot } from "../engine/snapshots";
import {
  serializeOpsNdjson,
  type HandoverManifest,
  type HandoverOpRecord,
} from "../handover/format";
import { toStoredOpRow, verifyHandoverEntries } from "../handover/import";
import { stateHashFromState } from "../state/state-hash";

const KEY_DOMAIN = "simpletab-replica-v1\n";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const INIT_FILE = "init.bin";
const OPS_FILE = "ops.bin";
const STATE_FILE = "state.json";
const HEX_64_RE = /^[0-9a-f]{64}$/;
const WRONG_KEY_ERROR = "This copy cannot be read with this laptop's key.";

interface ReplicaStateMeta {
  lastSeq: number;
  headHash: string;
}

interface ReplicaCache {
  initManifest: HandoverManifest;
  initSnapshotBytes: Uint8Array;
  initHasRealSnapshot: boolean;
  initOpRecords: HandoverOpRecord[];
  appendedRecords: HandoverOpRecord[];
  encryptedOpLines: string[];
  currentState: TournamentState;
  latestAppendedSnapshotBytes: Uint8Array | null;
  lastSeq: number;
  headHash: string;
}

interface VerifiedBatch {
  nextState: TournamentState;
  lastSeq: number;
  headHash: string;
  latestSnapshotBytes: Uint8Array | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidOpRecordShape(candidate: unknown): candidate is HandoverOpRecord {
  if (!isPlainObject(candidate)) {
    return false;
  }
  const changelog = candidate.changelog;
  if (!isPlainObject(changelog) || !isPlainObject(changelog.entry)) {
    return false;
  }
  return (
    typeof candidate.seq === "number" &&
    Number.isInteger(candidate.seq) &&
    candidate.seq >= 1 &&
    typeof candidate.ts === "string" &&
    typeof candidate.actorRef === "string" &&
    typeof candidate.actorType === "string" &&
    typeof candidate.type === "string" &&
    Array.isArray(candidate.writes) &&
    typeof changelog.salt === "string" &&
    typeof changelog.entryHash === "string"
  );
}

function writeFileAtomic(filePath: string, data: Uint8Array | string): void {
  mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tempPath, data);
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

/**
 * Encrypted at-rest tournament replica for tab-director laptops (design section 4).
 * Stores the initial handover archive (`init.bin`), appended op records (`ops.bin`), and
 * non-sensitive chain cursor (`state.json`: `{ lastSeq, headHash }`).
 */
export class ReplicaStore {
  private readonly key: Buffer;
  private readonly registry: OpRegistryLookup = defaultRegistry();
  private cache: ReplicaCache | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    keyMaterial: string,
  ) {
    this.key = createHash("sha256")
      .update(KEY_DOMAIN + keyMaterial, "utf8")
      .digest();
  }

  private get initPath(): string {
    return path.join(this.dir, INIT_FILE);
  }

  private get opsPath(): string {
    return path.join(this.dir, OPS_FILE);
  }

  private get statePath(): string {
    return path.join(this.dir, STATE_FILE);
  }

  exists(): boolean {
    return this.cache !== null || this.readStateFile() !== null;
  }

  lastSeq(): number {
    return this.cache?.lastSeq ?? this.readStateFile()?.lastSeq ?? 0;
  }

  headHash(): string | undefined {
    return this.cache?.headHash ?? this.readStateFile()?.headHash;
  }

  /**
   * Replaces the copy with a complete handover zip from the host (`replica_init`).
   * Verifies the archive before updating disk or cache, and throws a plain `Error` if invalid.
   */
  reset(handoverZip: Uint8Array): Promise<void> {
    return this.enqueue(async () => {
      let entries: Record<string, Uint8Array>;
      try {
        entries = unzipSync(handoverZip);
      } catch (error) {
        throw new Error(
          `Invalid handover archive: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const verified = await verifyHandoverEntries(entries, { registry: this.registry });
      const encryptedInit = this.encrypt(handoverZip);
      const stateMeta: ReplicaStateMeta = {
        lastSeq: verified.manifest.lastSeq,
        headHash: verified.manifest.headHash,
      };

      // Drop the cursor first: a crash mid-reset then leaves "no copy" instead of an old
      // state.json pointing into a new init archive.
      this.cache = null;
      rmSync(this.statePath, { force: true });
      writeFileAtomic(this.initPath, encryptedInit);
      writeFileAtomic(this.opsPath, "");
      writeFileAtomic(this.statePath, JSON.stringify(stateMeta));

      this.cache = {
        initManifest: verified.manifest,
        initSnapshotBytes: verified.snapshotBytes,
        initHasRealSnapshot: verified.hasRealSnapshot,
        initOpRecords: verified.opRecords,
        appendedRecords: [],
        encryptedOpLines: [],
        currentState: verified.finalState,
        latestAppendedSnapshotBytes: null,
        lastSeq: verified.manifest.lastSeq,
        headHash: verified.manifest.headHash,
      };
    });
  }

  /**
   * Appends contiguous op records received after the copy (`ops` message).
   * Verifies sequence numbers, changelog commitments, chain hashes, and replay against the
   * previous head before mutating disk or cache.
   */
  append(records: HandoverOpRecord[]): Promise<void> {
    return this.enqueue(async () => {
      const cache = await this.ensureLoaded();
      if (records.length === 0) {
        return;
      }

      const batch = await this.verifyAndReplayBatch(
        cache.currentState,
        cache.lastSeq,
        cache.headHash,
        records,
      );

      const newLines = records.map((record) =>
        this.encrypt(Buffer.from(JSON.stringify(record), "utf8")).toString("base64"),
      );
      const nextLines = [...cache.encryptedOpLines, ...newLines];
      const nextStateMeta: ReplicaStateMeta = {
        lastSeq: batch.lastSeq,
        headHash: batch.headHash,
      };

      // Append-only when the file is exactly what this copy wrote; otherwise (after a crash left
      // extra or partial lines) rewrite it whole, once. state.json is the commit point either way.
      const expectedBytes = Buffer.byteLength(
        cache.encryptedOpLines.length > 0 ? `${cache.encryptedOpLines.join("\n")}\n` : "",
        "utf8",
      );
      const actualBytes = existsSync(this.opsPath) ? statSync(this.opsPath).size : -1;
      if (actualBytes === expectedBytes) {
        appendFileSync(this.opsPath, `${newLines.join("\n")}\n`, "utf8");
      } else {
        writeFileAtomic(this.opsPath, `${nextLines.join("\n")}\n`);
      }
      writeFileAtomic(this.statePath, JSON.stringify(nextStateMeta));

      cache.appendedRecords.push(...records);
      cache.encryptedOpLines = nextLines;
      cache.currentState = batch.nextState;
      if (batch.latestSnapshotBytes !== null) {
        cache.latestAppendedSnapshotBytes = batch.latestSnapshotBytes;
      }
      cache.lastSeq = batch.lastSeq;
      cache.headHash = batch.headHash;
    });
  }

  /**
   * Produces a complete, valid `.simpletab` handover zip representing the current replica state.
   */
  buildHandover(): Promise<Uint8Array> {
    return this.enqueue(async () => {
      const cache = await this.ensureLoaded();
      const allRecords = [...cache.initOpRecords, ...cache.appendedRecords];

      let snapshotBytes: Uint8Array;
      if (cache.appendedRecords.length === 0) {
        snapshotBytes = cache.initSnapshotBytes;
      } else if (cache.latestAppendedSnapshotBytes !== null) {
        snapshotBytes = cache.latestAppendedSnapshotBytes;
      } else if (cache.initHasRealSnapshot) {
        snapshotBytes = cache.initSnapshotBytes;
      } else {
        // Without any snapshot entry in 1..lastSeq, importHandover treats snapshot.json.gz as
        // the state at manifest.lastSeq and replays zero ops.
        snapshotBytes = new Uint8Array(encodeSnapshot(cache.currentState).data);
      }

      const manifest: HandoverManifest = {
        schema: 1,
        slug: cache.initManifest.slug,
        hostNumber: cache.initManifest.hostNumber,
        lastSeq: cache.lastSeq,
        headHash: cache.headHash,
        createdAt: new Date().toISOString(),
      };

      return zipSync({
        "manifest.json": Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
        "ops.ndjson": serializeOpsNdjson(allRecords),
        "snapshot.json.gz": snapshotBytes,
        "links.json": Buffer.from(JSON.stringify(cache.currentState.links), "utf8"),
      });
    });
  }

  clear(): void {
    this.cache = null;
    rmSync(this.initPath, { force: true });
    rmSync(this.opsPath, { force: true });
    rmSync(this.statePath, { force: true });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private encrypt(plaintext: Uint8Array): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, ciphertext, tag]);
  }

  private decrypt(blob: Uint8Array): Buffer {
    if (blob.length < IV_BYTES + TAG_BYTES) {
      throw new Error(WRONG_KEY_ERROR);
    }
    try {
      const iv = blob.subarray(0, IV_BYTES);
      const tag = blob.subarray(blob.length - TAG_BYTES);
      const ciphertext = blob.subarray(IV_BYTES, blob.length - TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error(WRONG_KEY_ERROR);
    }
  }

  private readStateFile(): ReplicaStateMeta | null {
    if (!existsSync(this.initPath) || !existsSync(this.statePath)) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (!isPlainObject(parsed)) {
        return null;
      }
      if (
        typeof parsed.lastSeq !== "number" ||
        !Number.isInteger(parsed.lastSeq) ||
        parsed.lastSeq < 0 ||
        typeof parsed.headHash !== "string" ||
        !HEX_64_RE.test(parsed.headHash)
      ) {
        return null;
      }
      return { lastSeq: parsed.lastSeq, headHash: parsed.headHash };
    } catch {
      return null;
    }
  }

  private async ensureLoaded(): Promise<ReplicaCache> {
    if (this.cache !== null) {
      return this.cache;
    }
    const stateMeta = this.readStateFile();
    if (stateMeta === null) {
      throw new Error("No local tournament copy is stored.");
    }

    const encryptedInit = readFileSync(this.initPath);
    const initZip = this.decrypt(encryptedInit);

    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(initZip);
    } catch (error) {
      throw new Error(
        `Invalid stored init archive: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const verified = await verifyHandoverEntries(entries, { registry: this.registry });

    const expectedAppendedCount = stateMeta.lastSeq - verified.manifest.lastSeq;
    if (expectedAppendedCount < 0) {
      throw new Error("Stored replica state is behind its init archive.");
    }

    const rawLines = existsSync(this.opsPath)
      ? readFileSync(this.opsPath, "utf8")
          .split(/\r?\n/)
          .filter((line) => line.length > 0)
      : [];
    if (rawLines.length < expectedAppendedCount) {
      throw new Error(
        `Stored replica ops log is truncated (expected ${expectedAppendedCount} appended records, got ${rawLines.length}).`,
      );
    }

    // Ignore trailing lines beyond state.json's committed seq in case a crash occurred mid-append.
    const encryptedOpLines = rawLines.slice(0, expectedAppendedCount);
    const appendedRecords: HandoverOpRecord[] = [];
    for (const line of encryptedOpLines) {
      const plainBytes = this.decrypt(Buffer.from(line, "base64"));
      let parsed: unknown;
      try {
        parsed = JSON.parse(plainBytes.toString("utf8"));
      } catch (error) {
        throw new Error(
          `Corrupted op record in replica store: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!isValidOpRecordShape(parsed)) {
        throw new Error("Malformed op record in replica store.");
      }
      appendedRecords.push(parsed);
    }

    const batch = await this.verifyAndReplayBatch(
      verified.finalState,
      verified.manifest.lastSeq,
      verified.manifest.headHash,
      appendedRecords,
    );

    if (batch.lastSeq !== stateMeta.lastSeq || batch.headHash !== stateMeta.headHash) {
      throw new Error("Stored replica ops log does not match state.json head.");
    }

    this.cache = {
      initManifest: verified.manifest,
      initSnapshotBytes: verified.snapshotBytes,
      initHasRealSnapshot: verified.hasRealSnapshot,
      initOpRecords: verified.opRecords,
      appendedRecords,
      encryptedOpLines,
      currentState: batch.nextState,
      latestAppendedSnapshotBytes: batch.latestSnapshotBytes,
      lastSeq: batch.lastSeq,
      headHash: batch.headHash,
    };
    return this.cache;
  }

  private async verifyAndReplayBatch(
    baseState: TournamentState,
    startSeq: number,
    startHash: string,
    records: readonly HandoverOpRecord[],
  ): Promise<VerifiedBatch> {
    let state = baseState;
    let prevHash = startHash;
    let expectedSeq = startSeq + 1;
    let latestSnapshotBytes: Uint8Array | null = null;

    for (const record of records) {
      if (!isValidOpRecordShape(record)) {
        throw new Error(`Malformed op record at expected seq ${expectedSeq}.`);
      }
      if (record.seq !== expectedSeq) {
        throw new Error(
          `Replica op sequence mismatch: expected seq ${expectedSeq}, got ${record.seq}.`,
        );
      }

      const { entry, salt, entryHash } = record.changelog;
      if (entry.v !== 2) {
        throw new Error(`Unsupported changelog entry version at seq ${expectedSeq}: ${String(entry.v)}.`);
      }
      if (entry.seq !== expectedSeq) {
        throw new Error(
          `Changelog entry seq mismatch at seq ${expectedSeq}: got ${entry.seq}.`,
        );
      }
      if (
        record.type !== entry.opType ||
        record.ts !== entry.ts ||
        record.actorRef !== entry.actorRef ||
        record.actorType !== entry.actorType
      ) {
        throw new Error(`Op ${expectedSeq} metadata does not match its changelog entry.`);
      }

      const payloadOk = await provePrivate(entry, record.payload, salt);
      if (!payloadOk) {
        throw new Error(`Op ${expectedSeq} payload does not match its changelog payloadCommit.`);
      }

      const expectedEntryHash = await computeEntryHash(prevHash, entry);
      if (entryHash !== expectedEntryHash) {
        throw new Error(`Op ${expectedSeq} entryHash mismatch against previous head.`);
      }

      const step = replayOpRow(state, toStoredOpRow(record), this.registry);
      if (!step.ok) {
        throw new Error(`Replica replay failed at seq ${expectedSeq}: ${step.reason}`);
      }

      if (entry.stateHash !== undefined) {
        const computedStateHash = stateHashFromState(step.state);
        if (computedStateHash !== entry.stateHash) {
          throw new Error(
            `Op ${expectedSeq} replayed state hash (${computedStateHash}) does not match changelog stateHash (${entry.stateHash}).`,
          );
        }
        latestSnapshotBytes = new Uint8Array(encodeSnapshot(step.state).data);
      }

      state = step.state;
      prevHash = entryHash;
      expectedSeq += 1;
    }

    return {
      nextState: state,
      lastSeq: expectedSeq - 1,
      headHash: prevHash,
      latestSnapshotBytes,
    };
  }
}
