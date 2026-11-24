import { isDrawPubliclyReleased } from "@simpletab/core/lib/draw/drawStatus";
import type { TournamentState } from "@simpletab/core/ops";
import type {
  OnlineSettings,
  SyncPausedReason,
  SyncStatus,
} from "../../common/host-protocol";
import type { SqliteDatabase } from "../db/database";
import type { CommittedEvent, HostEngine } from "../engine/engine";
import { processInboxItems } from "./inbox-to-ops";
import { buildPermitUpload, isRoundOpenOnService } from "./permits";
import type { ServiceCallFailure, ServiceClient } from "./service-client";

export const OPEN_ROUND_POLL_MS = 30_000;
export const IDLE_POLL_MS = 300_000;
export const CLOCK_SKEW_WARNING_MS = 120_000;

const META_ACKED_THROUGH = "sync_acked_through";
const META_PROCESSED_SUBMISSIONS = "sync_processed_submissions";
const META_PERMIT_VERSIONS = "sync_permit_versions";
const MAX_PROCESSED_SUBMISSIONS = 10_000;
const INBOX_PAGE_LIMIT = 500;

export interface SyncSchedulerOptions {
  engine: HostEngine;
  client: ServiceClient;
  initialSettings: OnlineSettings;
  hostNumber: number;
  clock?: () => Date;
  onStatusChanged?: (status: SyncStatus) => void;
  onPortalEnforcingChanged?: (enforcing: boolean) => void;
}

function readMetaNumber(db: SqliteDatabase, key: string, fallback: number): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (row === undefined) {
    return fallback;
  }
  const n = Number(row.value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function readMetaStringArray(db: SqliteDatabase, key: string): string[] {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (row === undefined) {
    return [];
  }
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

function readMetaNumberMap(
  db: SqliteDatabase,
  key: string,
): Record<string, number> {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (row === undefined) {
    return {};
  }
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isInteger(v) && v >= 0) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeMetaValue(db: SqliteDatabase, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/**
 * Coordinates background permit uploads and inbox polling for the host without ever blocking
 * tabbing operations. Failures pause sync with a user-visible reason and never make the host
 * read-only.
 */
export class SyncScheduler {
  private readonly engine: HostEngine;
  private readonly client: ServiceClient;
  private readonly clock: () => Date;
  private readonly onStatusChanged: ((status: SyncStatus) => void) | undefined;
  private readonly onPortalEnforcingChanged:
    | ((enforcing: boolean) => void)
    | undefined;

  private settings: OnlineSettings;
  private hostNumber: number;
  private ackedThrough: number;
  private readonly processedIds: Set<string>;
  private readonly permitVersions: Record<string, number>;

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private activeCycle: Promise<SyncStatus> | null = null;
  private pendingPermitRounds = new Set<string>();
  private permitFlushScheduled = false;
  private disposed = false;

  private pausedReason: SyncPausedReason | undefined;
  private pausedDetail: string | undefined;
  private storedHostNumber: number | undefined;
  private lastPushAt: string | undefined;
  private lastPullAt: string | undefined;
  private lastAckAt: string | undefined;
  private lastPublishAt: string | undefined;
  private shareLeft: number | undefined;
  private clockSkewMs: number | undefined;
  private consecutiveFailures = 0;
  private nextPollAt: string | undefined;
  private lastPortalEnforcing: boolean | null = null;

  constructor(options: SyncSchedulerOptions) {
    this.engine = options.engine;
    this.client = options.client;
    this.settings = options.initialSettings;
    this.hostNumber = options.hostNumber;
    this.clock = options.clock ?? (() => new Date());
    this.onStatusChanged = options.onStatusChanged;
    this.onPortalEnforcingChanged = options.onPortalEnforcingChanged;

    const db = this.engine.database;
    this.ackedThrough = readMetaNumber(db, META_ACKED_THROUGH, 0);
    this.processedIds = new Set(readMetaStringArray(db, META_PROCESSED_SUBMISSIONS));
    this.permitVersions = readMetaNumberMap(db, META_PERMIT_VERSIONS);

    this.reconcileStateAndSchedule();
  }

  getSyncStatus(): SyncStatus {
    const enabled = this.isPortalEnabled();
    const active =
      enabled && this.engine.canSync() && this.pausedReason === undefined;
    const clockSkewWarning =
      this.clockSkewMs !== undefined &&
      Math.abs(this.clockSkewMs) > CLOCK_SKEW_WARNING_MS;

    return {
      enabled,
      active,
      ...(this.pausedReason !== undefined
        ? { pausedReason: this.pausedReason }
        : {}),
      ...(this.pausedDetail !== undefined
        ? { pausedDetail: this.pausedDetail }
        : {}),
      ...(this.storedHostNumber !== undefined
        ? { storedHostNumber: this.storedHostNumber }
        : {}),
      hostNumber: this.hostNumber,
      ackedThrough: this.ackedThrough,
      ...(this.lastPushAt !== undefined ? { lastPushAt: this.lastPushAt } : {}),
      ...(this.lastPullAt !== undefined ? { lastPullAt: this.lastPullAt } : {}),
      ...(this.lastAckAt !== undefined ? { lastAckAt: this.lastAckAt } : {}),
      ...(this.lastPublishAt !== undefined
        ? { lastPublishAt: this.lastPublishAt }
        : {}),
      ...(this.shareLeft !== undefined ? { shareLeft: this.shareLeft } : {}),
      ...(this.clockSkewMs !== undefined
        ? { clockSkewMs: this.clockSkewMs }
        : {}),
      ...(clockSkewWarning ? { clockSkewWarning: true } : {}),
      consecutiveFailures: this.consecutiveFailures,
      ...(this.nextPollAt !== undefined ? { nextPollAt: this.nextPollAt } : {}),
    };
  }

  setHostNumber(hostNumber: number): void {
    this.hostNumber = hostNumber;
  }

  recordPublishTime(iso: string = this.clock().toISOString()): void {
    this.lastPublishAt = iso;
    this.emitStatus();
  }

  updateSettings(nextSettings: OnlineSettings): void {
    const wasEnabled = this.isPortalEnabled();
    this.settings = nextSettings;
    const nowEnabled = this.isPortalEnabled();

    if (wasEnabled && !nowEnabled && nextSettings.ballotCollection !== "qr_only") {
      // Spec section 1.1: when the portal is turned off, attempt a final non-blocking pull once.
      this.clearPollTimer();
      this.pausedReason = "OFF";
      this.pausedDetail = undefined;
      this.updatePortalEnforcing();
      void this.pullOnceOnDisable();
      this.emitStatus();
      return;
    }

    if (nowEnabled) {
      this.pausedReason = undefined;
      this.pausedDetail = undefined;
      this.consecutiveFailures = 0;
      const state = this.engine.getState();
      if (state !== null) {
        for (const round of state.rounds) {
          if (isRoundOpenOnService(round)) {
            this.pendingPermitRounds.add(round.id);
          }
        }
      }
    }

    this.reconcileStateAndSchedule();
    if (nowEnabled && this.pendingPermitRounds.size > 0) {
      this.schedulePermitFlush();
    }
    this.emitStatus();
  }

  handleCommitted(event: CommittedEvent): void {
    if (this.disposed) {
      return;
    }
    const state = this.engine.getState();
    if (state === null) {
      return;
    }

    if (!this.isPortalEnabled() || !this.engine.canSync()) {
      this.updatePortalEnforcing();
      return;
    }

    const roundIds = this.roundsAffectedByCommit(event, state);
    if (roundIds.length > 0) {
      for (const roundId of roundIds) {
        this.pendingPermitRounds.add(roundId);
      }
      this.schedulePermitFlush();
    }

    // Switching from idle (5 min) to open round (30 s) or vice versa updates the poll cadence.
    if (
      event.type === "draw.release" ||
      event.type === "draw.unrelease" ||
      event.type === "round.set_completion" ||
      event.type === "round.cancel"
    ) {
      this.scheduleNextPoll();
    }
  }

  async pullNow(): Promise<SyncStatus> {
    if (this.disposed) {
      return this.getSyncStatus();
    }
    if (!this.engine.canSync()) {
      this.pausedReason = "INTEGRITY_FAILED";
      this.updatePortalEnforcing();
      this.emitStatus();
      return this.getSyncStatus();
    }
    if (!this.isPortalEnabled()) {
      this.pausedReason =
        this.settings.ballotCollection === "qr_only" ? "QR_ONLY" : "OFF";
      this.updatePortalEnforcing();
      this.emitStatus();
      return this.getSyncStatus();
    }

    // Clear hard pause on manual "Pull now" so a reissued key or fixed host can resume.
    if (
      this.pausedReason === "HOST_STALE" ||
      this.pausedReason === "KEY_REVOKED" ||
      this.pausedReason === "NO_KEY"
    ) {
      this.pausedReason = undefined;
      this.pausedDetail = undefined;
      this.consecutiveFailures = 0;
    }

    return this.runSyncCycle(true);
  }

  async pushRoundPermitNow(roundId: string): Promise<boolean> {
    if (this.disposed || !this.isPortalEnabled() || !this.engine.canSync()) {
      return false;
    }
    return this.uploadPermitForRound(roundId);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearPollTimer();
    this.pendingPermitRounds.clear();
  }

  private isPortalEnabled(): boolean {
    return (
      this.settings.ballotPortal &&
      this.settings.ballotCollection !== "qr_only"
    );
  }

  private isHardPauseReason(reason: SyncPausedReason | undefined): boolean {
    return (
      reason === "OFF" ||
      reason === "QR_ONLY" ||
      reason === "INTEGRITY_FAILED" ||
      reason === "HOST_STALE" ||
      reason === "KEY_REVOKED" ||
      reason === "NO_KEY"
    );
  }

  private updatePortalEnforcing(): void {
    const enforcing =
      this.isPortalEnabled() &&
      this.engine.canSync() &&
      this.pausedReason === undefined;
    if (this.lastPortalEnforcing !== enforcing) {
      this.lastPortalEnforcing = enforcing;
      this.onPortalEnforcingChanged?.(enforcing);
    }
  }

  private reconcileStateAndSchedule(): void {
    if (this.disposed) {
      return;
    }
    if (!this.engine.canSync()) {
      this.pausedReason = "INTEGRITY_FAILED";
      this.pausedDetail = undefined;
      this.clearPollTimer();
      this.updatePortalEnforcing();
      return;
    }
    if (this.settings.ballotCollection === "qr_only") {
      this.pausedReason = "QR_ONLY";
      this.pausedDetail = undefined;
      this.clearPollTimer();
      this.updatePortalEnforcing();
      return;
    }
    if (!this.settings.ballotPortal) {
      this.pausedReason = "OFF";
      this.pausedDetail = undefined;
      this.clearPollTimer();
      this.updatePortalEnforcing();
      return;
    }
    if (this.pausedReason === "OFF" || this.pausedReason === "QR_ONLY") {
      this.pausedReason = undefined;
      this.pausedDetail = undefined;
    }
    this.updatePortalEnforcing();
    if (!this.isHardPauseReason(this.pausedReason)) {
      this.scheduleNextPoll();
    }
  }

  private basePollIntervalMs(): number {
    const state = this.engine.getState();
    const anyOpen =
      state !== null &&
      state.rounds.some((round) => isRoundOpenOnService(round));
    return anyOpen ? OPEN_ROUND_POLL_MS : IDLE_POLL_MS;
  }

  private scheduleNextPoll(delayOverrideMs?: number): void {
    this.clearPollTimer();
    if (
      this.disposed ||
      !this.isPortalEnabled() ||
      !this.engine.canSync() ||
      this.isHardPauseReason(this.pausedReason)
    ) {
      this.nextPollAt = undefined;
      return;
    }

    const baseMs = this.basePollIntervalMs();
    let delayMs = delayOverrideMs ?? baseMs;
    if (delayOverrideMs === undefined && this.consecutiveFailures > 0) {
      const factor = Math.min(4, this.consecutiveFailures);
      delayMs = Math.min(IDLE_POLL_MS, OPEN_ROUND_POLL_MS * 2 ** (factor - 1));
    }

    this.nextPollAt = new Date(this.clock().getTime() + delayMs).toISOString();
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.runSyncCycle(false);
    }, delayMs);
    if (typeof this.pollTimer.unref === "function") {
      this.pollTimer.unref();
    }
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.nextPollAt = undefined;
  }

  private schedulePermitFlush(): void {
    if (this.permitFlushScheduled || this.disposed) {
      return;
    }
    this.permitFlushScheduled = true;
    queueMicrotask(() => {
      this.permitFlushScheduled = false;
      void this.flushPendingPermits();
    });
  }

  private async flushPendingPermits(): Promise<void> {
    if (
      this.disposed ||
      !this.isPortalEnabled() ||
      !this.engine.canSync() ||
      this.pausedReason === "HOST_STALE" ||
      this.pausedReason === "KEY_REVOKED" ||
      this.pausedReason === "NO_KEY"
    ) {
      this.pendingPermitRounds.clear();
      return;
    }

    const roundIds = [...this.pendingPermitRounds];
    this.pendingPermitRounds.clear();
    for (const roundId of roundIds) {
      if (this.disposed || !this.isPortalEnabled()) {
        break;
      }
      await this.uploadPermitForRound(roundId);
    }
  }

  private async uploadPermitForRound(roundId: string): Promise<boolean> {
    const state = this.engine.getState();
    if (state === null) {
      return false;
    }
    const nextVersion = (this.permitVersions[roundId] ?? 0) + 1;
    let permit;
    try {
      permit = await buildPermitUpload(state, roundId, nextVersion);
    } catch (error) {
      // A permit that fails wire validation is a host bug; keep tabbing going but leave a trace.
      console.warn(
        `SimpleTab sync: could not build the permit for round ${roundId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    if (permit === null) {
      return false;
    }

    const res = await this.client.uploadPermit(permit);
    this.recordSkew(res.clockSkewMs);
    if (!res.ok) {
      this.handleFailure(res);
      return false;
    }

    this.permitVersions[roundId] = nextVersion;
    writeMetaValue(
      this.engine.database,
      META_PERMIT_VERSIONS,
      JSON.stringify(this.permitVersions),
    );
    this.lastPushAt = this.clock().toISOString();
    this.clearTransientPause();
    this.emitStatus();
    return true;
  }

  private async runSyncCycle(isManual: boolean): Promise<SyncStatus> {
    if (this.activeCycle !== null) {
      return this.activeCycle;
    }

    const run = (async (): Promise<SyncStatus> => {
      if (this.disposed || !this.isPortalEnabled() || !this.engine.canSync()) {
        return this.getSyncStatus();
      }

      if (this.pendingPermitRounds.size > 0) {
        await this.flushPendingPermits();
      }

      let cursor = this.ackedThrough;
      let highestAckCandidate = this.ackedThrough;
      let stoppedEarly = false;

      while (!this.disposed && (isManual || this.isPortalEnabled())) {
        const pageRes = await this.client.fetchInbox(cursor, INBOX_PAGE_LIMIT);
        this.recordSkew(pageRes.clockSkewMs);
        if (!pageRes.ok) {
          this.handleFailure(pageRes);
          return this.getSyncStatus();
        }

        const page = pageRes.data;
        if (page.items.length === 0) {
          break;
        }

        const applied = await processInboxItems(
          this.engine,
          page.items,
          this.processedIds,
        );
        if (
          applied.highestProcessedRowId !== null &&
          applied.highestProcessedRowId > highestAckCandidate
        ) {
          highestAckCandidate = applied.highestProcessedRowId;
        }
        this.persistProcessedIds();

        if (applied.stoppedOnError !== undefined) {
          stoppedEarly = true;
          break;
        }

        if (page.next === null || page.next <= cursor) {
          break;
        }
        cursor = page.next;
      }

      this.lastPullAt = this.clock().toISOString();

      if (highestAckCandidate > this.ackedThrough) {
        const ackRes = await this.client.ackInbox(highestAckCandidate);
        this.recordSkew(ackRes.clockSkewMs);
        if (!ackRes.ok) {
          this.handleFailure(ackRes);
          return this.getSyncStatus();
        }
        this.ackedThrough = Math.max(
          this.ackedThrough,
          ackRes.data.ackedThrough,
          highestAckCandidate,
        );
        writeMetaValue(
          this.engine.database,
          META_ACKED_THROUGH,
          String(this.ackedThrough),
        );
        this.lastAckAt = this.clock().toISOString();
      }

      const state = this.engine.getState();
      if (state !== null) {
        const statusRes = await this.client.getStatus(state.tournament.slug);
        this.recordSkew(statusRes.clockSkewMs);
        if (statusRes.ok) {
          if (statusRes.data.shareLeft !== undefined) {
            this.shareLeft = statusRes.data.shareLeft;
          }
        } else if (
          statusRes.kind === "HOST_STALE" ||
          statusRes.kind === "KEY_REVOKED" ||
          statusRes.kind === "AUTH_INVALID" ||
          statusRes.kind === "QUOTA_EXHAUSTED"
        ) {
          this.handleFailure(statusRes);
          return this.getSyncStatus();
        }
      }

      if (!stoppedEarly) {
        this.clearTransientPause();
      }
      this.scheduleNextPoll();
      this.emitStatus();
      return this.getSyncStatus();
    })();

    this.activeCycle = run;
    try {
      return await run;
    } finally {
      this.activeCycle = null;
    }
  }

  private async pullOnceOnDisable(): Promise<void> {
    if (this.disposed || !this.engine.canSync()) {
      return;
    }
    const pageRes = await this.client.fetchInbox(this.ackedThrough, INBOX_PAGE_LIMIT);
    if (!pageRes.ok || pageRes.data.items.length === 0) {
      return;
    }
    const applied = await processInboxItems(
      this.engine,
      pageRes.data.items,
      this.processedIds,
    );
    this.persistProcessedIds();
    this.lastPullAt = this.clock().toISOString();
    if (
      applied.highestProcessedRowId !== null &&
      applied.highestProcessedRowId > this.ackedThrough
    ) {
      const ackRes = await this.client.ackInbox(applied.highestProcessedRowId);
      if (ackRes.ok) {
        this.ackedThrough = Math.max(
          this.ackedThrough,
          ackRes.data.ackedThrough,
          applied.highestProcessedRowId,
        );
        writeMetaValue(
          this.engine.database,
          META_ACKED_THROUGH,
          String(this.ackedThrough),
        );
        this.lastAckAt = this.clock().toISOString();
      }
    }
    this.emitStatus();
  }

  private recordSkew(clockSkewMs: number | undefined): void {
    if (clockSkewMs !== undefined && Number.isFinite(clockSkewMs)) {
      this.clockSkewMs = clockSkewMs;
    }
  }

  private clearTransientPause(): void {
    this.consecutiveFailures = 0;
    if (!this.isHardPauseReason(this.pausedReason)) {
      this.pausedReason = undefined;
      this.pausedDetail = undefined;
    }
    this.updatePortalEnforcing();
  }

  private handleFailure(failure: ServiceCallFailure): void {
    this.consecutiveFailures += 1;

    switch (failure.kind) {
      case "HOST_STALE":
        this.pausedReason = "HOST_STALE";
        this.pausedDetail = failure.message;
        this.storedHostNumber = failure.storedHostNumber;
        this.clearPollTimer();
        break;
      case "KEY_REVOKED":
      case "AUTH_INVALID":
        this.pausedReason = "KEY_REVOKED";
        this.pausedDetail = failure.message;
        this.clearPollTimer();
        break;
      case "CREDENTIAL_NOT_SET":
        this.pausedReason = "NO_KEY";
        this.pausedDetail = failure.message;
        this.clearPollTimer();
        break;
      case "QUOTA_EXHAUSTED": {
        this.pausedReason = "QUOTA_EXHAUSTED";
        this.pausedDetail = failure.message;
        const backoffMs =
          failure.retryAfterSeconds !== undefined
            ? Math.max(OPEN_ROUND_POLL_MS, failure.retryAfterSeconds * 1000)
            : IDLE_POLL_MS;
        this.scheduleNextPoll(backoffMs);
        break;
      }
      default: {
        this.pausedReason = "OFFLINE";
        this.pausedDetail = failure.message;
        const expMs = Math.min(
          IDLE_POLL_MS,
          OPEN_ROUND_POLL_MS * 2 ** Math.min(4, this.consecutiveFailures - 1),
        );
        const retryMs =
          failure.retryAfterSeconds !== undefined
            ? Math.max(expMs, failure.retryAfterSeconds * 1000)
            : expMs;
        this.scheduleNextPoll(retryMs);
        break;
      }
    }

    this.updatePortalEnforcing();
    this.emitStatus();
  }

  private persistProcessedIds(): void {
    if (this.processedIds.size > MAX_PROCESSED_SUBMISSIONS) {
      const trimmed = [...this.processedIds].slice(-MAX_PROCESSED_SUBMISSIONS);
      this.processedIds.clear();
      for (const id of trimmed) {
        this.processedIds.add(id);
      }
    }
    writeMetaValue(
      this.engine.database,
      META_PROCESSED_SUBMISSIONS,
      JSON.stringify([...this.processedIds]),
    );
  }

  private roundsAffectedByCommit(
    event: CommittedEvent,
    state: TournamentState,
  ): string[] {
    const payload =
      event.committedPayload !== null &&
      typeof event.committedPayload === "object" &&
      !Array.isArray(event.committedPayload)
        ? (event.committedPayload as Record<string, unknown>)
        : null;

    if (event.type === "private_urls.regenerate") {
      return state.rounds
        .filter((r) => isDrawPubliclyReleased(r) && !r.cancelled)
        .map((r) => r.id);
    }

    if (
      event.type === "draw.release" ||
      event.type === "draw.unrelease" ||
      event.type === "draw.release_teams" ||
      event.type === "round.set_completion" ||
      event.type === "round.cancel"
    ) {
      const roundId =
        typeof payload?.roundId === "string" ? payload.roundId : undefined;
      return roundId ? [roundId] : [];
    }

    if (event.type === "round.set_ballot_deadline") {
      const roundId =
        typeof payload?.roundId === "string" ? payload.roundId : undefined;
      if (!roundId) return [];
      const round = state.rounds.find((r) => r.id === roundId);
      return round && isDrawPubliclyReleased(round) ? [roundId] : [];
    }

    if (
      event.type.startsWith("allocation.") ||
      event.type === "draw.update_debate" ||
      event.type === "draw.move_team" ||
      event.type === "draw.swap_teams" ||
      event.type === "draw.restore" ||
      event.type === "swing.toggle_round"
    ) {
      const roundIds = new Set<string>();
      if (typeof payload?.roundId === "string") {
        roundIds.add(payload.roundId);
      }
      for (const key of event.writes) {
        if (key.startsWith("debate:")) {
          const debateId = key.slice("debate:".length);
          const debate = state.debates.find((d) => d.id === debateId);
          if (debate) {
            roundIds.add(debate.roundId);
          }
        }
      }
      return [...roundIds].filter((id) => {
        const round = state.rounds.find((r) => r.id === id);
        return round !== undefined && isDrawPubliclyReleased(round);
      });
    }

    return [];
  }

  private emitStatus(): void {
    this.onStatusChanged?.(this.getSyncStatus());
  }
}
