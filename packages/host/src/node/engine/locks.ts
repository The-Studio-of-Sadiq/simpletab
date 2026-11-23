import { randomUUID } from "node:crypto";
import type { RecordKey } from "@simpletab/core/ops/types";

export interface ActiveLock {
  lockId: string;
  opType: string;
  actorRef: string;
  startedAt: string;
}

export interface ManagedLock extends ActiveLock {
  writes: ReadonlySet<RecordKey>;
  cancelled: boolean;
  cancelHandler: (() => Promise<void>) | null;
}

/** Tracks active long-op locks and detects overlapping declared writes. */
export class LockManager {
  private readonly active = new Map<string, ManagedLock>();

  list(): ActiveLock[] {
    return Array.from(this.active.values(), (lock) => ({
      lockId: lock.lockId,
      opType: lock.opType,
      actorRef: lock.actorRef,
      startedAt: lock.startedAt,
    }));
  }

  findConflict(candidateWrites: readonly RecordKey[]): ActiveLock | null {
    if (this.active.size === 0 || candidateWrites.length === 0) {
      return null;
    }
    for (const lock of this.active.values()) {
      for (const key of candidateWrites) {
        if (lock.writes.has(key)) {
          return {
            lockId: lock.lockId,
            opType: lock.opType,
            actorRef: lock.actorRef,
            startedAt: lock.startedAt,
          };
        }
      }
    }
    return null;
  }

  acquire(
    opType: string,
    actorRef: string,
    startedAt: string,
    writes: readonly RecordKey[],
  ): ManagedLock {
    const lock: ManagedLock = {
      lockId: randomUUID(),
      opType,
      actorRef,
      startedAt,
      writes: new Set(writes),
      cancelled: false,
      cancelHandler: null,
    };
    this.active.set(lock.lockId, lock);
    return lock;
  }

  get(lockId: string): ManagedLock | undefined {
    return this.active.get(lockId);
  }

  release(lockId: string): boolean {
    return this.active.delete(lockId);
  }

  async cancel(lockId: string): Promise<boolean> {
    const lock = this.active.get(lockId);
    if (lock === undefined) {
      return false;
    }
    lock.cancelled = true;
    this.active.delete(lockId);
    if (lock.cancelHandler !== null) {
      await lock.cancelHandler();
    }
    return true;
  }
}
