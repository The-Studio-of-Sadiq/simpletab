import type { PublicChainItem } from "@simpletab/core/changelog";
import type { OpRequest } from "@simpletab/core/ops";
import type {
  CreateDemoResult,
  ArchiveStatus,
  CreateTournamentParams,
  DevicesStatus,
  JoinHostParams,
  PromoteParams,
  QrReceiveResult,
  JoinProgress,
  CreateTournamentResult,
  HostCancelLongResult,
  HostIntegrityCheckResult,
  HostLockInfo,
  HostStatus,
  OnlineSettings,
  OpUndoInfo,
  ProjectedState,
  StateChangedEvent,
  SubmitResult,
  PublishStatus,
  SyncStatus,
} from "@simpletab/host/lib/common/host-protocol";
import { HostService } from "@simpletab/host/lib/common/host-protocol";
import type { IssuedPairingCode, PresenceInfo } from "@simpletab/host/lib/common/collab-protocol";
import type { Disposable } from "@theia/core/lib/common";
import { inject, injectable, optional } from "@theia/core/shared/inversify";
import { HostServiceClientDispatcher } from "./host-service-client";

export type TrackedRoundOpType = "draw.generate" | "allocation.auto";

export const TournamentWorkspaceOpener = Symbol("TournamentWorkspaceOpener");

export interface TournamentWorkspaceOpener {
  openTournamentFolder(folderPath: string): Promise<void>;
}

export interface TournamentStoreSnapshot {
  status: HostStatus;
  state: ProjectedState | null;
  loading: boolean;
  error: string | null;
  lastEvent: StateChangedEvent | null;
}

export type TournamentStoreListener = (snapshot: TournamentStoreSnapshot) => void;

@injectable()
export class TournamentStore {
  private snapshot: TournamentStoreSnapshot = {
    status: { open: false, locks: [] },
    state: null,
    loading: false,
    error: null,
    lastEvent: null,
  };
  private readonly listeners = new Set<TournamentStoreListener>();
  private readonly clientSubscriptions: Disposable[] = [];
  private refreshCounter = 0;
  private activeRefresh: Promise<TournamentStoreSnapshot> | null = null;
  private selectedRoundId: string | null = null;
  private readonly lastOpSeqByRound = new Map<string, number>();
  private currentTournamentId: string | null = null;

  constructor(
    @inject(HostService) private readonly hostService: HostService,
    @inject(HostServiceClientDispatcher)
    @optional()
    clientDispatcher?: HostServiceClientDispatcher,
    @inject(TournamentWorkspaceOpener)
    @optional()
    private readonly workspaceOpener?: TournamentWorkspaceOpener,
  ) {
    if (clientDispatcher !== undefined) {
      this.clientSubscriptions.push(
        clientDispatcher.onDidStateChange((event) => {
          this.snapshot = {
            ...this.snapshot,
            lastEvent: event,
          };
          this.notify();
          void this.refresh();
        }),
      );
      this.clientSubscriptions.push(
        clientDispatcher.onDidLocksChange((locks) => {
          this.snapshot = {
            ...this.snapshot,
            status: {
              ...this.snapshot.status,
              locks,
            },
          };
          this.notify();
        }),
      );
    }
  }

  getSnapshot(): TournamentStoreSnapshot {
    return this.snapshot;
  }

  getState(): ProjectedState | null {
    return this.snapshot.state;
  }

  getStatus(): HostStatus {
    return this.snapshot.status;
  }

  getSelectedRoundId(): string | null {
    return this.selectedRoundId;
  }

  setSelectedRoundId(roundId: string): void {
    if (this.selectedRoundId === roundId) {
      return;
    }
    this.selectedRoundId = roundId;
    this.notify();
  }

  getLastRoundOpSeq(
    opType: TrackedRoundOpType,
    roundId: string,
  ): number | undefined {
    return this.lastOpSeqByRound.get(`${opType}:${roundId}`);
  }

  subscribe(listener: TournamentStoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async refresh(): Promise<TournamentStoreSnapshot> {
    const requestId = ++this.refreshCounter;
    const run = (async (): Promise<TournamentStoreSnapshot> => {
      this.snapshot = {
        ...this.snapshot,
        loading: true,
        error: null,
      };
      this.notify();

      try {
        const status = await this.hostService.status();
        const state = status.open ? await this.hostService.getState() : null;
        if (requestId !== this.refreshCounter) {
          return this.activeRefresh ?? this.snapshot;
        }
        this.syncTournamentContext(state);
        this.snapshot = {
          ...this.snapshot,
          status,
          state,
          loading: false,
          error: null,
        };
        this.notify();
        return this.snapshot;
      } catch (error) {
        if (requestId !== this.refreshCounter) {
          return this.activeRefresh ?? this.snapshot;
        }
        this.snapshot = {
          ...this.snapshot,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        };
        this.notify();
        return this.snapshot;
      }
    })();

    this.activeRefresh = run;
    return run;
  }

  async submit(request: OpRequest): Promise<SubmitResult> {
    const result = await this.hostService.submit(request);
    if (result.ok) {
      if (
        request.type === "draw.generate" ||
        request.type === "allocation.auto"
      ) {
        const roundId = this.extractRoundId(request.payload);
        if (roundId !== undefined) {
          this.lastOpSeqByRound.set(`${request.type}:${roundId}`, result.seq);
        }
      }
      if (this.snapshot.state?.seq !== result.seq) {
        await this.refresh();
      }
    } else if (
      result.code === "VERSION_CONFLICT" ||
      result.code === "OVERRIDDEN_BY_HOST"
    ) {
      await this.refresh();
    }
    return result;
  }

  async undo(seq: number): Promise<SubmitResult> {
    const result = await this.hostService.undo(seq);
    if (result.ok) {
      for (const [key, trackedSeq] of this.lastOpSeqByRound.entries()) {
        if (trackedSeq === seq) {
          this.lastOpSeqByRound.delete(key);
        }
      }
      if (this.snapshot.state?.seq !== result.seq) {
        await this.refresh();
      }
    }
    return result;
  }

  async getLocks(): Promise<HostLockInfo[]> {
    const locks = await this.hostService.getLocks();
    this.snapshot = {
      ...this.snapshot,
      status: {
        ...this.snapshot.status,
        locks,
      },
    };
    this.notify();
    return locks;
  }

  async cancelLong(lockId: string): Promise<HostCancelLongResult> {
    const result = await this.hostService.cancelLong(lockId);
    await this.getLocks();
    return result;
  }

  async getChangelog(afterSeq?: number, limit?: number): Promise<PublicChainItem[]> {
    return this.hostService.getChangelog(afterSeq, limit);
  }

  async getOpUndoInfo(): Promise<OpUndoInfo[]> {
    return this.hostService.getOpUndoInfo();
  }

  async runFullCheck(): Promise<HostIntegrityCheckResult> {
    const result = await this.hostService.runFullCheck();
    await this.refresh();
    return result;
  }

  async updateOnlineSettings(
    patch: Partial<OnlineSettings>,
  ): Promise<OnlineSettings> {
    const updated = await this.hostService.updateOnlineSettings(patch);
    await this.refresh();
    return updated;
  }

  async getSyncStatus(): Promise<SyncStatus> {
    return this.hostService.getSyncStatus();
  }

  async pullNow(): Promise<SyncStatus> {
    const result = await this.hostService.pullNow();
    await this.refresh();
    return result;
  }

  async getPublishStatus(): Promise<PublishStatus> {
    return this.hostService.getPublishStatus();
  }

  async startJoin(params: JoinHostParams): Promise<JoinProgress> {
    return this.hostService.startJoin(params);
  }

  async getJoinProgress(): Promise<JoinProgress> {
    const progress = await this.hostService.getJoinProgress();
    if (progress.state === "joined") {
      await this.refresh();
    }
    return progress;
  }

  async leaveHost(): Promise<void> {
    await this.hostService.leaveHost();
    await this.refresh();
  }

  async dismissRejectedEdits(): Promise<void> {
    await this.hostService.dismissRejectedEdits();
    await this.refresh();
  }

  /** Best effort: presence never blocks or fails a screen. */
  async setPresence(info: PresenceInfo): Promise<void> {
    try {
      await this.hostService.setPresence(info);
    } catch {
      // A closed tournament or a lost connection simply shows no presence.
    }
  }

  /** A scanned or pasted QR ballot; the host checks it. */
  async receiveQrBallot(codes: string[]): Promise<QrReceiveResult> {
    const result = await this.hostService.receiveQrBallot(codes);
    if (result.ok) {
      await this.refresh();
    }
    return result;
  }

  async setSuccession(order: string[]): Promise<void> {
    await this.hostService.setSuccession(order);
    await this.refresh();
  }

  async promoteToHost(params: PromoteParams): Promise<HostStatus> {
    const status = await this.hostService.promoteToHost(params);
    await this.refresh();
    return status;
  }

  async exportDeviceCopy(directory: string): Promise<string> {
    return this.hostService.exportDeviceCopy(directory);
  }

  async getDevicesStatus(): Promise<DevicesStatus> {
    return this.hostService.getDevicesStatus();
  }

  async setDevicesEnabled(enabled: boolean, port?: number): Promise<DevicesStatus> {
    return this.hostService.setDevicesEnabled(enabled, port);
  }

  async issuePairingCode(roleId: string): Promise<IssuedPairingCode> {
    return this.hostService.issuePairingCode(roleId);
  }

  async cancelPairingCode(code: string): Promise<void> {
    await this.hostService.cancelPairingCode(code);
  }

  async approveJoin(joinId: string): Promise<void> {
    await this.hostService.approveJoin(joinId);
    await this.refresh();
  }

  async rejectJoin(joinId: string): Promise<void> {
    await this.hostService.rejectJoin(joinId);
  }

  async removeDevice(deviceId: string): Promise<void> {
    await this.hostService.removeDevice(deviceId);
    await this.refresh();
  }

  async getArchiveStatus(): Promise<ArchiveStatus> {
    return this.hostService.getArchiveStatus();
  }

  /** "Archive to GitHub"; returns when the archive has finished or failed. */
  async archiveNow(): Promise<ArchiveStatus> {
    return this.hostService.archiveNow();
  }

  /** Asks the host backend to publish; returns when that publish has finished or failed. */
  async publishNow(): Promise<PublishStatus> {
    const result = await this.hostService.publishNow();
    await this.refresh();
    return result;
  }

  async getDisplayState(): Promise<ProjectedState | null> {
    return this.hostService.getDisplayState();
  }

  async createTournament(
    params: CreateTournamentParams,
  ): Promise<CreateTournamentResult> {
    const result = await this.hostService.createTournament(params);
    this.refreshCounter += 1;
    this.syncTournamentContext(result.state);
    this.snapshot = {
      ...this.snapshot,
      status: result.status,
      state: result.state,
      loading: false,
      error: null,
    };
    this.notify();
    await this.openTournamentWorkspace(
      result.workspaceDir ?? result.status.workspaceDir,
    );
    return result;
  }

  async createDemoTournament(dir = ""): Promise<CreateDemoResult> {
    const result = await this.hostService.createDemoTournament(dir);
    await this.refresh();
    await this.openTournamentWorkspace(
      result.workspaceDir ?? result.status.workspaceDir,
    );
    return result;
  }

  async openTournament(dbPath: string): Promise<HostStatus> {
    const status = await this.hostService.openTournament(dbPath);
    await this.refresh();
    await this.openTournamentWorkspace(status.workspaceDir);
    return status;
  }

  private async openTournamentWorkspace(
    folderPath: string | undefined,
  ): Promise<void> {
    if (
      this.workspaceOpener === undefined ||
      folderPath === undefined ||
      folderPath.trim().length === 0
    ) {
      return;
    }
    try {
      await this.workspaceOpener.openTournamentFolder(folderPath);
    } catch {
      // Opening the workspace folder must never block tournament operations.
    }
  }

  dispose(): void {
    for (const sub of this.clientSubscriptions.splice(0)) {
      sub.dispose();
    }
    this.listeners.clear();
  }

  private syncTournamentContext(state: ProjectedState | null): void {
    const nextTournamentId = state?.tournament.id ?? null;
    if (nextTournamentId !== this.currentTournamentId) {
      this.currentTournamentId = nextTournamentId;
      this.selectedRoundId = null;
      this.lastOpSeqByRound.clear();
    }
  }

  private extractRoundId(payload: unknown): string | undefined {
    if (payload === null || typeof payload !== "object") {
      return undefined;
    }
    const candidate = (payload as Record<string, unknown>).roundId;
    return typeof candidate === "string" && candidate.length > 0
      ? candidate
      : undefined;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }
}
