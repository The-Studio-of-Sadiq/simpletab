import {
  GENESIS_HASH,
  canonicalize,
  makeEntry,
  type PublicChainItem,
} from "@simpletab/core/changelog";
import {
  applyOp,
  canUndo,
  defaultRegistry,
  type Actor,
  type ApplyErrorCode,
  type ApplyResult,
  type ApplySuccess,
  type OpDef,
  type OpLogEntry,
  type OpRegistryLookup,
  type OpRequest,
  type RecordKey,
  type TournamentState,
} from "@simpletab/core/ops";
import type { OpUndoInfo } from "../../common/host-protocol";
import type { SqliteDatabase } from "../db/database";
import { openDatabase } from "../db/database";
import { loadState, seedState, writeChangedRecords } from "../state/load";
import { stateHash as computeStateHash } from "../state/state-hash";
import {
  fastCheck,
  fastCheckWithStateSync,
  fullCheck,
  type IntegrityCheckResult,
} from "./integrity";
import {
  LockManager,
  type ActiveLock,
  type DetailedActiveLock,
  type ManagedLock,
} from "./locks";
import {
  DEFAULT_SNAPSHOT_EVERY,
  encodeSnapshot,
  shouldTakeSnapshot,
  writeSnapshot,
} from "./snapshots";
import {
  LongOpWorkerPool,
  WorkerCancelledError,
  type RunningWorkerTask,
} from "./workers";

export interface HostEngineOptions {
  initialState?: TournamentState;
  clock?: () => Date;
  registry?: OpRegistryLookup;
  /** Take a snapshot every N committed ops (defaults to 2,000). */
  snapshotEvery?: number;
  /** Override worker pool size (defaults to `max(1, cpus - 1)`). */
  workerPoolSize?: number;
  /** Optional synchronous worker-thread delay in ms for deterministic tests. */
  longOpWorkerDelayMs?: number;
  /**
   * Start a long-op worker as soon as the engine opens, so the first draw or allocation does not
   * pay the worker's start-up cost. The desktop app turns this on; tests leave it off.
   */
  prewarmWorkers?: boolean;
}

export interface CommittedEvent {
  seq: number;
  type: string;
  writes: RecordKey[];
  committedPayload: unknown;
}

export type CommitListener = (event: CommittedEvent) => void;
export type LocksListener = (locks: DetailedActiveLock[]) => void;

export interface HostHead {
  seq: number;
  entryHash: string;
}

export type HostApplyErrorCode = ApplyErrorCode | "LOCKED" | "CANCELLED";

export interface HostApplyFailure {
  ok: false;
  code: HostApplyErrorCode;
  errors: string[];
  current?: Record<RecordKey, number>;
  lockId?: string;
}

export type HostApplyResult<P = unknown> = ApplySuccess<P> | HostApplyFailure;

export interface UndoFailure {
  ok: false;
  code: "CANNOT_UNDO";
  errors: string[];
  blockingSeqs: number[];
}

export type UndoResult = HostApplyResult | UndoFailure;

export type CancelLongResult =
  | { ok: true; lockId: string }
  | { ok: false; code: "FORBIDDEN" | "NOT_FOUND"; errors: string[] };

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

interface OpUndoInfoRow {
  seq: number;
  writes: string;
  inverse: string | null;
  inverse_of: number | null;
}

interface SubsequentWritesRow {
  writes: string;
}

type SubmitPhase1Result<P> =
  | { kind: "done"; result: HostApplyResult<P> }
  | {
      kind: "long";
      lock: ManagedLock;
      task: RunningWorkerTask<P> | null;
      snapshotState: TournamentState;
      startSeq: number;
      readKeys: ReadonlySet<RecordKey>;
      readKinds: ReadonlySet<string>;
    };

function recordKindOf(key: RecordKey): string {
  const index = key.indexOf(":");
  return index < 0 ? key : key.slice(0, index);
}

/** Merges only the written records from `computed` onto `current` when non-overlapping ops ran concurrently. */
function mergeDisjointWrites(
  current: TournamentState,
  computed: TournamentState,
  writes: readonly RecordKey[],
): TournamentState {
  const next: TournamentState = {
    ...current,
    versions: { ...current.versions },
  };
  const mergeList = <T>(
    currentItems: readonly T[],
    computedItems: readonly T[],
    id: string,
    getId: (item: T) => string,
  ): T[] => {
    const replacement = computedItems.find((item) => getId(item) === id);
    const filtered = currentItems.filter((item) => getId(item) !== id);
    return replacement === undefined ? filtered : [...filtered, replacement];
  };

  for (const key of writes) {
    const sep = key.indexOf(":");
    const kind = key.slice(0, sep);
    const id = key.slice(sep + 1);
    next.versions[key] = (next.versions[key] ?? 0) + 1;
    switch (kind) {
      case "tournament":
        next.tournament = computed.tournament;
        break;
      case "institution":
        next.institutions = mergeList(next.institutions, computed.institutions, id, (x) => x.id);
        break;
      case "team":
        next.teams = mergeList(next.teams, computed.teams, id, (x) => x.id);
        break;
      case "adjudicator":
        next.adjudicators = mergeList(next.adjudicators, computed.adjudicators, id, (x) => x.id);
        break;
      case "venue":
        next.venues = mergeList(next.venues, computed.venues, id, (x) => x.id);
        break;
      case "round":
        next.rounds = mergeList(next.rounds, computed.rounds, id, (x) => x.id);
        break;
      case "debate":
        next.debates = mergeList(next.debates, computed.debates, id, (x) => x.id);
        break;
      case "motion":
        next.motions = mergeList(next.motions, computed.motions, id, (x) => x.id);
        break;
      case "ballot":
        next.ballots = mergeList(next.ballots, computed.ballots, id, (x) => x.id);
        break;
      case "ballotIntake":
        next.ballotIntake = mergeList(next.ballotIntake ?? [], computed.ballotIntake ?? [], id, (x) => x.id);
        break;
      case "lateSubmission":
        next.lateSubmissions = mergeList(
          next.lateSubmissions ?? [],
          computed.lateSubmissions ?? [],
          id,
          (x) => x.id,
        );
        break;
      case "feedback":
        next.feedback = mergeList(next.feedback, computed.feedback, id, (x) => x.id);
        break;
      case "breakCategory":
        next.breakCategories = mergeList(
          next.breakCategories,
          computed.breakCategories,
          id,
          (x) => x.id,
        );
        break;
      case "link":
        next.links = mergeList(next.links, computed.links, id, (x) => x.lookupId);
        break;
      case "registration":
        next.registrations = mergeList(
          next.registrations,
          computed.registrations,
          id,
          (x) => x.id,
        );
        break;
      case "device":
        next.devices = mergeList(next.devices, computed.devices, id, (x) => x.id);
        break;
      case "role":
        next.roles = mergeList(next.roles, computed.roles, id, (x) => x.id);
        break;
      case "proposal":
        next.proposals = mergeList(next.proposals, computed.proposals, id, (x) => x.id);
        break;
      case "host":
        next.host = computed.host;
        break;
      default:
        throw new Error(`Unsupported record kind during merge: ${kind}`);
    }
  }
  return next;
}

/** Serial SQLite wrapper around core's pure tournament operation engine. */
export class HostEngine {
  readonly database: SqliteDatabase;
  private readonly registry: OpRegistryLookup;
  private readonly usingDefaultRegistry: boolean;
  private readonly clock: () => Date;
  private readonly snapshotEvery: number;
  private readonly lockManager = new LockManager();
  private readonly workerPool: LongOpWorkerPool;
  private readonly workersWarm: Promise<void>;
  private cachedState: TournamentState | null;
  private _integrity: IntegrityCheckResult;
  private portalEnforcing = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<CommitListener>();
  private readonly lockListeners = new Set<LocksListener>();

  private constructor(database: SqliteDatabase, options: HostEngineOptions) {
    this.database = database;
    this.usingDefaultRegistry = options.registry === undefined;
    this.registry = options.registry ?? defaultRegistry();
    this.clock = options.clock ?? (() => new Date());
    const snapshotEvery = options.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY;
    if (!Number.isInteger(snapshotEvery) || snapshotEvery < 1) {
      throw new RangeError(`snapshotEvery must be a positive integer, got ${snapshotEvery}.`);
    }
    this.snapshotEvery = snapshotEvery;
    this.workerPool = new LongOpWorkerPool({
      ...(options.workerPoolSize !== undefined ? { size: options.workerPoolSize } : {}),
      ...(options.longOpWorkerDelayMs !== undefined
        ? { debugDelayMs: options.longOpWorkerDelayMs }
        : {}),
    });
    this.workersWarm = options.prewarmWorkers === true ? this.workerPool.warm() : Promise.resolve();

    const existing = loadState(database);
    if (existing === null && options.initialState !== undefined) {
      seedState(database, options.initialState);
    }

    const startupCheck = fastCheckWithStateSync(database, { registry: this.registry });
    if (startupCheck.ok) {
      this._integrity = { ok: true };
      this.cachedState = startupCheck.state;
    } else {
      this._integrity = {
        ok: false,
        stage: startupCheck.stage,
        ...(startupCheck.seq !== undefined ? { seq: startupCheck.seq } : {}),
        reason: startupCheck.reason,
      };
      // Open in blocked mode: tabbing continues against the live tables while sync/publish are blocked.
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

  /** Result of the startup fast check (or a subsequent failed full check). */
  get integrity(): IntegrityCheckResult {
    return this._integrity;
  }

  /** Online sync is allowed only when startup and background integrity checks have passed. */
  canSync(): boolean {
    return this._integrity.ok;
  }

  /** Publishing is allowed only when startup and background integrity checks have passed. */
  canPublish(): boolean {
    return this._integrity.ok;
  }

  /** Enables or disables portal-enforced ballot/feedback deadlines on incoming ops. */
  setPortalEnforcing(enforcing: boolean): void {
    this.portalEnforcing = enforcing;
  }

  /** Whether portal-enforced deadlines are currently active on this host. */
  isPortalEnforcing(): boolean {
    return this.portalEnforcing;
  }

  /** Runs the async fast integrity check (using core's `verifyChain`). */
  async runFastCheck(): Promise<IntegrityCheckResult> {
    const result = await fastCheck(this.database, { registry: this.registry });
    if (!result.ok) {
      this._integrity = result;
    }
    return result;
  }

  /** Runs the full background integrity check from op 1, updating blocked mode on failure. */
  async runFullCheck(): Promise<IntegrityCheckResult> {
    const result = await fullCheck(this.database, { registry: this.registry });
    if (!result.ok) {
      this._integrity = result;
    }
    return result;
  }

  /** Lists currently held long-op locks. */
  locks(): ActiveLock[] {
    return this.lockManager.list();
  }

  /** Lists currently held long-op locks with optional round context. */
  detailedLocks(): DetailedActiveLock[] {
    return this.lockManager.listDetailed();
  }

  /** Subscribes to active lock acquisitions, releases, and cancellations. */
  onLocksChanged(listener: LocksListener): () => void {
    this.lockListeners.add(listener);
    return () => this.lockListeners.delete(listener);
  }

  /** Cancels a running long op. Allowed only for host-owner actors. */
  async cancelLong(lockId: string, actor: Actor): Promise<CancelLongResult> {
    if (!actor.isHostOwner) {
      return {
        ok: false,
        code: "FORBIDDEN",
        errors: ["Only the host owner can cancel a running long operation."],
      };
    }
    const cancelled = await this.lockManager.cancel(lockId);
    if (!cancelled) {
      return {
        ok: false,
        code: "NOT_FOUND",
        errors: [`No active long operation lock found for id "${lockId}".`],
      };
    }
    this.emitLocksChanged();
    return { ok: true, lockId };
  }

  submit<P>(request: OpRequest<P>, actor: Actor): Promise<HostApplyResult<P>> {
    return this.executeRequest(request, actor);
  }

  /** Undoes an op if no later op wrote any of its records. */
  async undo(seq: number, actor: Actor): Promise<UndoResult> {
    const prepared = await this.enqueue<
      { ok: true; inverse: OpRequest<unknown> } | { ok: false; failure: UndoFailure }
    >(() => {
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
          failure: {
            ok: false,
            code: "CANNOT_UNDO",
            errors: undoCheck.blockingSeqs.length > 0
              ? [`Operation ${seq} is blocked by later operations: ${undoCheck.blockingSeqs.join(", ")}.`]
              : [`Operation ${seq} does not exist.`],
            blockingSeqs: undoCheck.blockingSeqs,
          },
        };
      }

      const stored = this.database.prepare("SELECT inverse FROM ops WHERE seq = ?")
        .get(seq) as StoredOpRow | undefined;
      if (stored?.inverse === null || stored === undefined) {
        return {
          ok: false,
          failure: {
            ok: false,
            code: "CANNOT_UNDO",
            errors: [`Operation ${seq} has no inverse.`],
            blockingSeqs: [],
          },
        };
      }
      return { ok: true, inverse: JSON.parse(stored.inverse) as OpRequest<unknown> };
    });

    if (!prepared.ok) {
      return prepared.failure;
    }
    return this.executeRequest(prepared.inverse, actor, seq);
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

  /** Returns write sets and undoability metadata for every committed operation. */
  opUndoInfo(): OpUndoInfo[] {
    const rows = this.database.prepare(
      "SELECT seq, writes, inverse, inverse_of FROM ops ORDER BY seq",
    ).all() as OpUndoInfoRow[];
    const parsed = rows.map((row) => ({
      seq: row.seq,
      writes: JSON.parse(row.writes) as RecordKey[],
      hasInverse: row.inverse !== null,
      inverseOf: row.inverse_of,
    }));
    const log: OpLogEntry[] = parsed.map((item) => ({
      seq: item.seq,
      writes: item.writes,
      ...(item.inverseOf !== null ? { inverseOf: item.inverseOf } : {}),
    }));
    return parsed.map((item) => {
      const check = canUndo(log, item.seq);
      return {
        seq: item.seq,
        writes: item.writes,
        hasInverse: item.hasInverse,
        inverseOf: item.inverseOf,
        undoable: item.hasInverse && check.ok,
        blockingSeqs: check.ok ? [] : check.blockingSeqs,
      };
    });
  }

  /** Resolves once the worker started by `prewarmWorkers` has loaded (immediately when off). */
  workersReady(): Promise<void> {
    return this.workersWarm;
  }

  async close(): Promise<void> {
    await this.queue;
    await this.workerPool.close();
    this.database.close();
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async executeRequest<P>(
    request: OpRequest<P>,
    actor: Actor,
    inverseOf?: number,
  ): Promise<HostApplyResult<P>> {
    const phase1 = await this.enqueue<SubmitPhase1Result<P>>(async () => {
      if (this.cachedState === null) {
        throw new Error("Cannot submit an operation before the tournament database is initialized.");
      }

      const opDef = this.registry.get(request.type) as OpDef<P> | undefined;
      if (opDef !== undefined) {
        const declaredWrites = opDef.writes(this.cachedState, request.payload);
        const conflict = this.lockManager.findConflict(declaredWrites);
        if (conflict !== null) {
          return {
            kind: "done",
            result: {
              ok: false,
              code: "LOCKED",
              lockId: conflict.lockId,
              errors: [
                `Operation "${request.type}" overlaps active lock ${conflict.lockId} (${conflict.opType} by ${conflict.actorRef}).`,
              ],
            },
          };
        }

        if (opDef.lock) {
          const snapshotState = structuredClone(this.cachedState);
          const startSeq = this.head().seq;
          const readKeysList = opDef.reads(this.cachedState, request.payload);
          const readKeys = new Set<RecordKey>(readKeysList);
          const readKinds = new Set<string>(readKeysList.map(recordKindOf));
          const payloadObj =
            request.payload !== null && typeof request.payload === "object"
              ? (request.payload as Record<string, unknown>)
              : null;
          const roundId =
            payloadObj !== null && typeof payloadObj.roundId === "string"
              ? payloadObj.roundId
              : undefined;
          const lock = this.lockManager.acquire(
            request.type,
            actor.ref,
            this.clock().toISOString(),
            declaredWrites,
            roundId,
          );
          let task: RunningWorkerTask<P> | null = null;
          if (this.usingDefaultRegistry) {
            task = this.workerPool.run(snapshotState, request, actor);
            lock.cancelHandler = task.cancel;
          }
          this.emitLocksChanged();
          return {
            kind: "long",
            lock,
            task,
            snapshotState,
            startSeq,
            readKeys,
            readKinds,
          };
        }
      }

      const result = await this.commitImmediate(request, actor, inverseOf);
      return { kind: "done", result };
    });

    if (phase1.kind === "done") {
      return phase1.result;
    }

    const { lock, task, snapshotState, startSeq, readKeys, readKinds } = phase1;
    let computedResult: ApplyResult<P>;
    try {
      if (task !== null) {
        computedResult = await task.promise;
      } else {
        computedResult = applyOp(snapshotState, request, actor, this.registry);
      }
    } catch (error) {
      if (this.lockManager.release(lock.lockId)) {
        this.emitLocksChanged();
      }
      if (error instanceof WorkerCancelledError || lock.cancelled) {
        return {
          ok: false,
          code: "CANCELLED",
          errors: [`Long operation "${request.type}" was cancelled by the host owner.`],
        };
      }
      throw error;
    }

    return this.enqueue(async () => {
      try {
        if (lock.cancelled) {
          return {
            ok: false,
            code: "CANCELLED",
            errors: [`Long operation "${request.type}" was cancelled by the host owner.`],
          };
        }
        if (!computedResult.ok) {
          return computedResult;
        }
        if (this.cachedState === null) {
          throw new Error("Cannot commit an operation before the tournament database is initialized.");
        }

        const currentSeq = this.head().seq;
        let finalState = computedResult.state;
        if (currentSeq !== startSeq) {
          const subsequentRows = this.database.prepare(
            "SELECT writes FROM ops WHERE seq > ? ORDER BY seq ASC",
          ).all(startSeq) as SubsequentWritesRow[];
          const writtenSet = new Set<RecordKey>(computedResult.writes);
          for (const row of subsequentRows) {
            const keys = JSON.parse(row.writes) as RecordKey[];
            for (const key of keys) {
              if (
                writtenSet.has(key) ||
                readKeys.has(key) ||
                readKinds.has(recordKindOf(key))
              ) {
                return {
                  ok: false,
                  code: "VERSION_CONFLICT",
                  errors: [
                    `State record "${key}" changed while long operation "${request.type}" was running.`,
                  ],
                };
              }
            }
          }
          finalState = mergeDisjointWrites(this.cachedState, computedResult.state, computedResult.writes);
        }

        const mergedResult: ApplySuccess<P> = {
          ...computedResult,
          state: finalState,
        };
        return await this.persistSuccess(request, actor, mergedResult, inverseOf);
      } finally {
        if (this.lockManager.release(lock.lockId)) {
          this.emitLocksChanged();
        }
      }
    });
  }

  private emitLocksChanged(): void {
    const snapshot = this.detailedLocks();
    for (const listener of this.lockListeners) {
      try {
        listener(snapshot);
      } catch {
        // Lock listeners cannot reject or interrupt host execution.
      }
    }
  }

  private async commitImmediate<P>(
    request: OpRequest<P>,
    actor: Actor,
    inverseOf?: number,
  ): Promise<HostApplyResult<P>> {
    if (this.cachedState === null) {
      throw new Error("Cannot submit an operation before the tournament database is initialized.");
    }
    const stateWithRuntime: TournamentState = {
      ...this.cachedState,
      runtime: {
        portalEnforcing: this.portalEnforcing,
        now: this.clock().toISOString(),
      },
    };
    const result = applyOp(stateWithRuntime, request, actor, this.registry);
    if (!result.ok) {
      return result;
    }
    return this.persistSuccess(request, actor, result, inverseOf);
  }

  private async persistSuccess<P>(
    request: OpRequest<P>,
    actor: Actor,
    result: ApplySuccess<P>,
    inverseOf?: number,
  ): Promise<ApplySuccess<P>> {
    const operation = this.registry.get(request.type);
    if (operation === undefined) {
      throw new Error(`Operation disappeared from registry during commit: ${request.type}`);
    }
    const nextHead = this.head();
    const seq = nextHead.seq + 1;
    const timestamp = this.clock().toISOString();

    const takingSnapshot = shouldTakeSnapshot(
      seq,
      request.type,
      result.committedPayload,
      this.snapshotEvery,
    );
    const snapshot = takingSnapshot ? encodeSnapshot(result.state) : null;

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
        ...(snapshot !== null ? { stateHash: snapshot.stateHash } : {}),
      },
      nextHead.entryHash,
    );

    const hostNumberRow = this.database.prepare("SELECT value FROM meta WHERE key = 'host_number'")
      .get() as { value: string } | undefined;
    const hostNumber = hostNumberRow === undefined ? 1 : Number(hostNumberRow.value);

    const transaction = this.database.transaction(() => {
      writeChangedRecords(this.database, result.state, result.writes, seq);
      this.database.prepare(
        "INSERT INTO ops(" +
          "seq, ts, actor_ref, actor_type, actor_role_id, actor_role, actor_is_host_owner, " +
          "type, payload, request_payload, request_forced, writes, inverse, inverse_of, host_number" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        seq,
        timestamp,
        actor.ref,
        actor.type,
        actor.role.id,
        JSON.stringify(actor.role),
        actor.isHostOwner ? 1 : 0,
        request.type,
        JSON.stringify(result.committedPayload),
        JSON.stringify(request.payload),
        request.forced === true ? 1 : 0,
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
      if (snapshot !== null) {
        writeSnapshot(this.database, seq, snapshot);
      }
    });
    transaction();

    const nextCachedState: TournamentState = { ...result.state };
    delete nextCachedState.runtime;
    this.cachedState = nextCachedState;
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
