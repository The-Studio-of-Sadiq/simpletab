import { makeEntry, GENESIS_HASH, type PublicChainItem } from "@simpletab/core/changelog";
import {
  applyOp,
  canUndo,
  defaultRegistry,
  type Actor,
  type ApplyResult,
  type OpRegistryLookup,
  type OpRequest,
  type RecordKey,
  type TournamentState,
} from "@simpletab/core/ops";
import { canonicalize } from "@simpletab/core/changelog";
import type { SqliteDatabase } from "../db/database";
import { openDatabase } from "../db/database";
import { loadState, seedState, writeChangedRecords } from "../state/load";
import { stateHash as computeStateHash } from "../state/state-hash";

export interface HostEngineOptions {
  initialState?: TournamentState;
  clock?: () => Date;
  registry?: OpRegistryLookup;
}

export interface CommittedEvent {
  seq: number;
  type: string;
  writes: RecordKey[];
  committedPayload: unknown;
}

export type CommitListener = (event: CommittedEvent) => void;

export interface HostHead {
  seq: number;
  entryHash: string;
}

export interface UndoFailure {
  ok: false;
  code: "CANNOT_UNDO";
  errors: string[];
  blockingSeqs: number[];
}

export type UndoResult = ApplyResult | UndoFailure;

interface ChangelogRow {
  seq: number;
  entry: string;
  entry_hash: string;
}

interface OpLogRow {
  seq: number;
  writes: string;
  inverse_of: number | null;
}

interface StoredOpRow {
  inverse: string | null;
}

/** Serial SQLite wrapper around core's pure tournament operation engine. */
export class HostEngine {
  readonly database: SqliteDatabase;
  private readonly registry: OpRegistryLookup;
  private readonly clock: () => Date;
  private cachedState: TournamentState | null;
  private queue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<CommitListener>();

  private constructor(database: SqliteDatabase, options: HostEngineOptions) {
    this.database = database;
    this.registry = options.registry ?? defaultRegistry();
    this.clock = options.clock ?? (() => new Date());
    this.cachedState = loadState(database);
    if (this.cachedState === null && options.initialState !== undefined) {
      seedState(database, options.initialState);
      this.cachedState = loadState(database);
    }
  }

  /** Opens an existing DB or creates one. An empty DB can be seeded with `initialState`. */
  static open(filePath: string, options: HostEngineOptions = {}): HostEngine {
    const database = openDatabase(filePath);
    try {
      return new HostEngine(database, options);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  submit<P>(request: OpRequest<P>, actor: Actor): Promise<ApplyResult<P>> {
    return this.enqueue(() => this.commit(request, actor));
  }

  /** Undoes an op if no later op wrote any of its records. */
  undo(seq: number, actor: Actor): Promise<UndoResult> {
    return this.enqueue(async () => {
      const logRows = this.database.prepare(
        "SELECT seq, writes, inverse_of FROM ops ORDER BY seq",
      ).all() as OpLogRow[];
      const log = logRows.map((row) => ({
        seq: row.seq,
        writes: JSON.parse(row.writes) as RecordKey[],
        ...(row.inverse_of !== null ? { inverseOf: row.inverse_of } : {}),
      }));
      const undoCheck = canUndo(log, seq);
      if (!undoCheck.ok) {
        return {
          ok: false,
          code: "CANNOT_UNDO",
          errors: undoCheck.blockingSeqs.length > 0
            ? [`Operation ${seq} is blocked by later operations: ${undoCheck.blockingSeqs.join(", ")}.`]
            : [`Operation ${seq} does not exist.`],
          blockingSeqs: undoCheck.blockingSeqs,
        } satisfies UndoFailure;
      }

      const stored = this.database.prepare("SELECT inverse FROM ops WHERE seq = ?")
        .get(seq) as StoredOpRow | undefined;
      if (stored?.inverse === null || stored === undefined) {
        return {
          ok: false,
          code: "CANNOT_UNDO",
          errors: [`Operation ${seq} has no inverse.`],
          blockingSeqs: [],
        } satisfies UndoFailure;
      }
      const inverse = JSON.parse(stored.inverse) as OpRequest<unknown>;
      return this.commit(inverse, actor, seq);
    });
  }

  /** Adds a post-commit listener and returns an unsubscribe function. */
  onCommitted(listener: CommitListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  head(): HostHead {
    const row = this.database.prepare(
      "SELECT seq, entry_hash FROM changelog ORDER BY seq DESC LIMIT 1",
    ).get() as { seq: number; entry_hash: string } | undefined;
    return row === undefined
      ? { seq: 0, entryHash: GENESIS_HASH }
      : { seq: row.seq, entryHash: row.entry_hash };
  }

  /** Returns the current cached domain state, without exposing the mutable cache. */
  getState(): TournamentState | null {
    return this.cachedState === null ? null : structuredClone(this.cachedState);
  }

  getStateHash(): string {
    return computeStateHash(this.database);
  }

  /** Returns headers and entry hashes, safe for passing to core's `verifyChain`. */
  changelog(): PublicChainItem[] {
    const rows = this.database.prepare(
      "SELECT seq, entry, entry_hash FROM changelog ORDER BY seq",
    ).all() as ChangelogRow[];
    return rows.map((row) => ({
      entry: JSON.parse(row.entry) as PublicChainItem["entry"],
      entryHash: row.entry_hash,
    }));
  }

  async close(): Promise<void> {
    await this.queue;
    this.database.close();
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async commit<P>(
    request: OpRequest<P>,
    actor: Actor,
    inverseOf?: number,
  ): Promise<ApplyResult<P>> {
    if (this.cachedState === null) {
      throw new Error("Cannot submit an operation before the tournament database is initialized.");
    }
    const before = this.cachedState;
    const result = applyOp(before, request, actor, this.registry);
    if (!result.ok) {
      return result;
    }

    const operation = this.registry.get(request.type);
    if (operation === undefined) {
      throw new Error(`Operation disappeared from registry during commit: ${request.type}`);
    }
    const nextHead = this.head();
    const seq = nextHead.seq + 1;
    const timestamp = this.clock().toISOString();
    const entry = await makeEntry(
      {
        seq,
        ts: timestamp,
        actorType: actor.type,
        actorRef: actor.ref,
        opType: request.type,
        category: operation.category,
        summary: request.type,
        visibility: operation.visibility,
        payload: result.committedPayload,
      },
      nextHead.entryHash,
    );
    const hostNumberRow = this.database.prepare("SELECT value FROM meta WHERE key = 'host_number'")
      .get() as { value: string } | undefined;
    const hostNumber = hostNumberRow === undefined ? 1 : Number(hostNumberRow.value);
    const transaction = this.database.transaction(() => {
      writeChangedRecords(this.database, result.state, result.writes, seq);
      this.database.prepare(
        "INSERT INTO ops(seq, ts, actor_ref, actor_type, type, payload, writes, inverse, inverse_of, host_number) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        seq,
        timestamp,
        actor.ref,
        actor.type,
        request.type,
        JSON.stringify(result.committedPayload),
        JSON.stringify(result.writes),
        result.inverse === null ? null : JSON.stringify(result.inverse),
        inverseOf ?? null,
        hostNumber,
      );
      this.database.prepare(
        "INSERT INTO changelog(seq, entry, salt, entry_hash) VALUES (?, ?, ?, ?)",
      ).run(
        seq,
        canonicalize(entry.entry),
        Buffer.from(entry.salt, "base64url"),
        entry.entryHash,
      );
    });
    transaction();

    this.cachedState = result.state;
    const event: CommittedEvent = {
      seq,
      type: request.type,
      writes: [...result.writes],
      committedPayload: result.committedPayload,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A subscriber cannot roll back or reject an already committed tournament op.
      }
    }
    return result;
  }
}
