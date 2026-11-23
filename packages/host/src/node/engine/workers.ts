import os from "node:os";
import { Worker } from "node:worker_threads";
import type { Actor, ApplyResult, OpRequest, TournamentState } from "@simpletab/core/ops";
import type { LongOpWorkerRequest, LongOpWorkerResponse } from "./long-op-worker";

export interface WorkerPoolOptions {
  /** Defaults to `Math.max(1, os.cpus().length - 1)`. */
  size?: number;
  /** Optional synchronous delay inside the worker thread for deterministic tests. */
  debugDelayMs?: number;
}

export interface RunningWorkerTask<P = unknown> {
  promise: Promise<ApplyResult<P>>;
  cancel: () => Promise<void>;
}

export class WorkerCancelledError extends Error {
  constructor() {
    super("Long operation worker was terminated.");
    this.name = "WorkerCancelledError";
  }
}

interface PoolSlot {
  worker: Worker;
  busy: boolean;
}

interface QueuedTask {
  message: LongOpWorkerRequest;
  resolve: (result: ApplyResult<unknown>) => void;
  reject: (error: Error) => void;
  cancelled: boolean;
  assignedSlot: PoolSlot | null;
}

const WORKER_BOOTSTRAP_URL = new URL("./long-op-worker-bootstrap.mjs", import.meta.url);

export function defaultWorkerPoolSize(): number {
  return Math.max(1, os.cpus().length - 1);
}

/**
 * Pool of `worker_threads` workers sized to `max(1, cpus - 1)` for running long tournament ops
 * (`OpDef.lock === true`) off the main thread. Workers are spawned lazily and terminated on cancel
 * or `close()`.
 */
export class LongOpWorkerPool {
  readonly maxSize: number;
  private readonly debugDelayMs: number;
  private readonly slots = new Set<PoolSlot>();
  private readonly pendingQueue: QueuedTask[] = [];
  private nextRequestId = 1;
  private closed = false;

  constructor(options: WorkerPoolOptions = {}) {
    const resolvedSize = options.size ?? defaultWorkerPoolSize();
    if (!Number.isInteger(resolvedSize) || resolvedSize < 1) {
      throw new RangeError(`Worker pool size must be a positive integer, got ${resolvedSize}.`);
    }
    this.maxSize = resolvedSize;
    this.debugDelayMs = options.debugDelayMs ?? 0;
  }

  /** Submits `applyOp` work to a worker thread and returns a cancellable task handle. */
  run<P>(
    state: TournamentState,
    request: OpRequest<P>,
    actor: Actor,
  ): RunningWorkerTask<P> {
    if (this.closed) {
      return {
        promise: Promise.reject(new Error("Worker pool is closed.")),
        cancel: async () => undefined,
      };
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const message: LongOpWorkerRequest = {
      id,
      state,
      request: request as OpRequest<unknown>,
      actor,
      ...(this.debugDelayMs > 0 ? { debugDelayMs: this.debugDelayMs } : {}),
    };

    let taskRef!: QueuedTask;
    const promise = new Promise<ApplyResult<P>>((resolve, reject) => {
      taskRef = {
        message,
        resolve: resolve as (result: ApplyResult<unknown>) => void,
        reject,
        cancelled: false,
        assignedSlot: null,
      };
      this.pendingQueue.push(taskRef);
      this.drain();
    });

    const cancel = async (): Promise<void> => {
      if (taskRef.cancelled) {
        return;
      }
      taskRef.cancelled = true;
      const queuedIdx = this.pendingQueue.indexOf(taskRef);
      if (queuedIdx >= 0) {
        this.pendingQueue.splice(queuedIdx, 1);
        taskRef.reject(new WorkerCancelledError());
        return;
      }
      const slot = taskRef.assignedSlot;
      if (slot !== null) {
        this.slots.delete(slot);
        taskRef.assignedSlot = null;
        await slot.worker.terminate();
        taskRef.reject(new WorkerCancelledError());
        this.drain();
      }
    };

    return { promise, cancel };
  }

  /** Terminates all active and idle workers and rejects any queued tasks. */
  async close(): Promise<void> {
    this.closed = true;
    while (this.pendingQueue.length > 0) {
      const task = this.pendingQueue.shift()!;
      task.cancelled = true;
      task.reject(new WorkerCancelledError());
    }
    const activeSlots = Array.from(this.slots);
    this.slots.clear();
    await Promise.all(activeSlots.map((slot) => slot.worker.terminate()));
  }

  private drain(): void {
    if (this.closed) {
      return;
    }
    while (this.pendingQueue.length > 0) {
      const slot = this.acquireSlot();
      if (slot === null) {
        return;
      }
      const task = this.pendingQueue.shift()!;
      if (task.cancelled) {
        slot.busy = false;
        continue;
      }
      this.dispatch(slot, task);
    }
  }

  private acquireSlot(): PoolSlot | null {
    for (const slot of this.slots) {
      if (!slot.busy) {
        slot.busy = true;
        return slot;
      }
    }
    if (this.slots.size >= this.maxSize) {
      return null;
    }
    const worker = new Worker(WORKER_BOOTSTRAP_URL);
    const slot: PoolSlot = { worker, busy: true };
    this.slots.add(slot);
    return slot;
  }

  private dispatch(slot: PoolSlot, task: QueuedTask): void {
    task.assignedSlot = slot;
    const { worker } = slot;

    const cleanup = (): void => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };

    const onMessage = (response: LongOpWorkerResponse): void => {
      if (response.id !== task.message.id) {
        return;
      }
      cleanup();
      task.assignedSlot = null;
      slot.busy = false;
      if (task.cancelled) {
        this.drain();
        return;
      }
      if (response.ok) {
        task.resolve(response.result);
      } else {
        task.reject(new Error(response.error));
      }
      this.drain();
    };

    const onError = (error: Error): void => {
      cleanup();
      this.slots.delete(slot);
      task.assignedSlot = null;
      if (!task.cancelled) {
        task.reject(error);
      }
      this.drain();
    };

    const onExit = (code: number): void => {
      cleanup();
      this.slots.delete(slot);
      task.assignedSlot = null;
      if (!task.cancelled) {
        task.reject(new Error(`Long op worker exited unexpectedly with code ${code}.`));
      }
      this.drain();
    };

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    worker.postMessage(task.message);
  }
}
