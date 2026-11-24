import type { PublicChainItem } from "@simpletab/core/changelog";
import type {
  LateSubmissionRecord,
  OpBallotSubmission,
  OpRequest,
  OpRound,
  OpTournament,
  RecordKey,
} from "@simpletab/core/ops";
import type { Permission } from "@simpletab/core/permissions";
import type { ProjectableState } from "@simpletab/core/projection";
import type { BallotIntakeRecord } from "@simpletab/core/types";
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

export type HostIntegrityStage =
  | "changelog"
  | "snapshot"
  | "replay"
  | "live_state";

export interface HostIntegrityCheckResult {
  ok: boolean;
  stage?: HostIntegrityStage;
  seq?: number;
  reason?: string;
  checkedAt?: string;
}

export type BallotCollectionMode = "online" | "online_qr" | "qr_only";

export type SyncPausedReason =
  | "OFF"
  | "QR_ONLY"
  | "INTEGRITY_FAILED"
  | "NO_KEY"
  | "HOST_STALE"
  | "KEY_REVOKED"
  | "QUOTA_EXHAUSTED"
  | "OFFLINE";

export interface SyncStatus {
  enabled: boolean;
  active: boolean;
  pausedReason?: SyncPausedReason;
  pausedDetail?: string;
  storedHostNumber?: number;
  hostNumber: number;
  ackedThrough: number;
  lastPushAt?: string;
  lastPullAt?: string;
  lastAckAt?: string;
  lastPublishAt?: string;
  shareLeft?: number;
  clockSkewMs?: number;
  clockSkewWarning?: boolean;
  consecutiveFailures: number;
  nextPollAt?: string;
}

export interface OnlineSettings {
  ballotPortal: boolean;
  livePublicSite: boolean;
  githubArchive: boolean;
  onlineRegistration: boolean;
  ballotCollection: BallotCollectionMode;
  trustSignedBallots: boolean;
  keyRequestedAt?: string;
  cdnHost?: string;
  ballotsOrigin?: string;
  /** Cloudflare account id for the tournament's Pages project (not secret; M4). */
  cloudflareAccountId?: string;
  /** Cloudflare Pages project name, e.g. "wudc2027" for wudc2027.pages.dev (not secret; M4). */
  pagesProject?: string;
}

export const DEFAULT_ONLINE_SETTINGS: Readonly<OnlineSettings> = {
  ballotPortal: false,
  livePublicSite: false,
  githubArchive: false,
  onlineRegistration: false,
  ballotCollection: "online",
  trustSignedBallots: false,
};

export type PublishState =
  | "idle"
  | "building"
  | "uploading"
  | "anchoring"
  | "confirming"
  | "done"
  | "failed"
  | "not_configured";

/** Status of the public results site publisher (design section 10). */
export interface PublishStatus {
  state: PublishState;
  /** When this status was recorded (ISO 8601 UTC). */
  at?: string;
  /** Public site URL after a successful publish. */
  url?: string;
  /** Plain-language reason for `failed` / `not_configured`; never contains secrets. */
  reason?: string;
  /** When a failed publish will be retried automatically. */
  nextRetryAt?: string;
}

export interface HostStatus {
  open: boolean;
  slug?: string;
  workspaceDir?: string;
  headSeq?: number;
  integrityOk?: boolean;
  canSync?: boolean;
  locks: HostLockInfo[];
  fastCheck?: HostIntegrityCheckResult;
  fullCheck?: HostIntegrityCheckResult;
  hostNumber?: number;
  queuedOps?: number;
  onlineSettings?: OnlineSettings;
  syncStatus?: SyncStatus;
}

export interface CreateDemoResult {
  dbPath: string;
  workspaceDir: string;
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
  tournament: OpTournament;
  rounds: OpRound[];
  ballots: OpBallotSubmission[];
  seq: number;
  roleId: string;
  permissions?: readonly Permission[];
  lateSubmissions?: LateSubmissionRecord[];
  ballotIntake?: BallotIntakeRecord[];
  versions: Record<RecordKey, number>;
}

export interface CreateTournamentResult {
  dbPath: string;
  workspaceDir: string;
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

export interface OpUndoInfo {
  seq: number;
  writes: RecordKey[];
  hasInverse: boolean;
  inverseOf: number | null;
  undoable: boolean;
  blockingSeqs: number[];
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
  getDisplayState(): Promise<ProjectedState | null>;
  runFullCheck(): Promise<HostIntegrityCheckResult>;
  getOnlineSettings(): Promise<OnlineSettings>;
  updateOnlineSettings(patch: Partial<OnlineSettings>): Promise<OnlineSettings>;
  getSyncStatus(): Promise<SyncStatus>;
  pullNow(): Promise<SyncStatus>;
  publishNow(): Promise<PublishStatus>;
  getPublishStatus(): Promise<PublishStatus>;
  getChangelog(afterSeq?: number, limit?: number): Promise<PublicChainItem[]>;
  getOpUndoInfo(): Promise<OpUndoInfo[]>;
}
