import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { COLLAB_SCHEMA } from "../../common/collab-protocol";
import type { HostEngine } from "../engine/engine";
import { exportHandover } from "../handover/export";
import { readOpRecordsAfter } from "../handover/format";
import type { DeviceSession } from "./server";

/**
 * Keeps every connected tab director's full copy current (design section 4): on each connection a
 * complete handover file (`replica_init`), then each committed op record (`ops`), in seq order.
 * Only tab-director devices receive it; they are the only ones that can be promoted.
 */

export const REPLICA_ROLE_ID = "tab_director";

interface FeedRecord {
  session: DeviceSession;
  lastSent: number;
  closed: boolean;
  unsubscribe: () => void;
}

export class ReplicaFeed {
  private readonly sessions = new Map<string, FeedRecord>();

  constructor(private readonly engine: HostEngine) {}

  addSession(session: DeviceSession): void {
    if (session.role.id !== REPLICA_ROLE_ID) return;
    this.sessions.get(session.deviceId)?.unsubscribe();
    const record: FeedRecord = { session, lastSent: 0, closed: false, unsubscribe: () => undefined };
    const offClose = session.onClose(() => {
      record.closed = true;
      if (this.sessions.get(session.deviceId) === record) this.sessions.delete(session.deviceId);
    });
    record.unsubscribe = offClose;
    this.sessions.set(session.deviceId, record);
    this.sendInit(record);
  }

  /** Sends op records committed since each director's last one. */
  notifyCommitted(): void {
    for (const record of [...this.sessions.values()]) {
      if (record.closed) continue;
      const records = readOpRecordsAfter(this.engine.database, record.lastSent);
      if (records.length === 0) continue;
      try {
        record.session.send({ schema: COLLAB_SCHEMA, kind: "ops", records });
        record.lastSent = records[records.length - 1]!.seq;
      } catch {
        // A failing socket closes on its own; the next connection starts with a fresh copy.
      }
    }
  }

  dispose(): void {
    for (const record of this.sessions.values()) record.unsubscribe();
    this.sessions.clear();
  }

  private sendInit(record: FeedRecord): void {
    const dir = mkdtempSync(path.join(os.tmpdir(), "simpletab-replica-"));
    try {
      const file = path.join(dir, "copy.simpletab");
      const result = exportHandover(this.engine, file);
      const bytes = readFileSync(file);
      record.session.send({
        schema: COLLAB_SCHEMA,
        kind: "replica_init",
        handover: bytes.toString("base64"),
        lastSeq: result.manifest.lastSeq,
        headHash: result.manifest.headHash,
      });
      record.lastSent = result.manifest.lastSeq;
    } catch (error) {
      console.warn("SimpleTab: could not send a tab director's copy", error instanceof Error ? error.message : error);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
