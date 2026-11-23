import type { OpRequest } from "@simpletab/core/ops";
import type {
  CreateDemoResult,
  CreateTournamentParams,
  CreateTournamentResult,
  HostStatus,
  ProjectedState,
  StateChangedEvent,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import { HostService } from "@simpletab/host/lib/common/host-protocol";
import type { Disposable } from "@theia/core/lib/common";
import { inject, injectable, optional } from "@theia/core/shared/inversify";
import { HostServiceClientDispatcher } from "./host-service-client";

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
  private readonly clientSubscription: Disposable | undefined;
  private refreshCounter = 0;
  private activeRefresh: Promise<TournamentStoreSnapshot> | null = null;

  constructor(
    @inject(HostService) private readonly hostService: HostService,
    @inject(HostServiceClientDispatcher)
    @optional()
    clientDispatcher?: HostServiceClientDispatcher,
  ) {
    if (clientDispatcher !== undefined) {
      this.clientSubscription = clientDispatcher.onDidStateChange((event) => {
        this.snapshot = {
          ...this.snapshot,
          lastEvent: event,
        };
        this.notify();
        void this.refresh();
      });
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
    if (result.ok && this.snapshot.state?.seq !== result.seq) {
      await this.refresh();
    }
    return result;
  }

  async undo(seq: number): Promise<SubmitResult> {
    const result = await this.hostService.undo(seq);
    if (result.ok && this.snapshot.state?.seq !== result.seq) {
      await this.refresh();
    }
    return result;
  }

  async createTournament(
    params: CreateTournamentParams,
  ): Promise<CreateTournamentResult> {
    const result = await this.hostService.createTournament(params);
    this.refreshCounter += 1;
    this.snapshot = {
      ...this.snapshot,
      status: result.status,
      state: result.state,
      loading: false,
      error: null,
    };
    this.notify();
    return result;
  }

  async createDemoTournament(dir = ""): Promise<CreateDemoResult> {
    const result = await this.hostService.createDemoTournament(dir);
    await this.refresh();
    return result;
  }

  async openTournament(dbPath: string): Promise<HostStatus> {
    const status = await this.hostService.openTournament(dbPath);
    await this.refresh();
    return status;
  }

  dispose(): void {
    this.clientSubscription?.dispose();
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }
}
