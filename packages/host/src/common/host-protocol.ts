import type { PublicChainItem } from "@simpletab/core/changelog";
import type { OpRequest, RecordKey } from "@simpletab/core/ops";
import type { ProjectableState } from "@simpletab/core/projection";
import type { RpcServer } from "@theia/core/lib/common/messaging";

export const HOST_SERVICE_PATH = "/services/simpletab-host";

export const HostService = Symbol("HostService");
export const HostServiceClient = Symbol("HostServiceClient");

export interface HostLockInfo {
  lockId: string;
  opType: string;
  actorRef: string;
  startedAt: string;
  roundId?: string;
}

export type CancelLongErrorCode = "NO_TOURNAMENT" | "FORBIDDEN" | "NOT_FOUND";

export type HostCancelLongResult =
  | { ok: true; lockId: string }
  | { ok: false; code: CancelLongErrorCode; errors: string[] };

export interface HostStatus {
  open: boolean;
  slug?: string;
  headSeq?: number;
  integrityOk?: boolean;
  canSync?: boolean;
  locks: HostLockInfo[];
}

export interface CreateDemoResult {
  dbPath: string;
  status: HostStatus;
}

export type SimpleTabFormatChoice = "bp" | "two-team";

export interface CreateTournamentParams {
  name: string;
  slug: string;
  format: SimpleTabFormatChoice;
  presetId: string;
  prelimRounds?: number;
  directory: string;
}

export interface ProjectedState extends ProjectableState {
  seq: number;
  roleId: string;
  versions: Record<RecordKey, number>;
}

export interface CreateTournamentResult {
  dbPath: string;
  status: HostStatus;
  state: ProjectedState;
}

export type SubmitErrorCode =
  | "NO_TOURNAMENT"
  | "FORBIDDEN"
  | "VERSION_CONFLICT"
  | "INVALID"
  | "UNKNOWN_OP"
  | "OVERRIDDEN_BY_HOST"
  | "LOCKED"
  | "CANCELLED"
  | "CANNOT_UNDO";

export interface SubmitSuccessResult {
  ok: true;
  seq: number;
  writes: RecordKey[];
  committedPayload: unknown;
}

export interface SubmitFailureResult {
  ok: false;
  code: SubmitErrorCode;
  errors: string[];
  current?: Record<RecordKey, number>;
  lockId?: string;
  blockingSeqs?: number[];
}

export type SubmitResult = SubmitSuccessResult | SubmitFailureResult;

export interface StateChangedEvent {
  seq: number;
  type: string;
  writes: RecordKey[];
}

export interface HostServiceClient {
  onStateChanged(event: StateChangedEvent): void;
  onLocksChanged?(locks: HostLockInfo[]): void;
}

export interface HostService extends RpcServer<HostServiceClient> {
  status(): Promise<HostStatus>;
  openTournament(dbPath: string): Promise<HostStatus>;
  createDemoTournament(dir: string): Promise<CreateDemoResult>;
  createTournament(params: CreateTournamentParams): Promise<CreateTournamentResult>;
  submit(request: OpRequest): Promise<SubmitResult>;
  undo(seq: number): Promise<SubmitResult>;
  getLocks(): Promise<HostLockInfo[]>;
  cancelLong(lockId: string): Promise<HostCancelLongResult>;
  getState(): Promise<ProjectedState | null>;
  getChangelog(afterSeq?: number, limit?: number): Promise<PublicChainItem[]>;
}
