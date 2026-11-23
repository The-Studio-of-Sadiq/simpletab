import type { ActorType, Visibility } from "@/changelog";
import type { RegistrationSettings, RegistrationSubmission } from "@/lib/registration/types";
import type { CustomPermissionGroup } from "@/lib/staffPermissions";
import type { Permission, Role } from "@/permissions";
import type { LinkRecord } from "@/projection";
import type {
  Adjudicator,
  BallotIntakeRecord,
  BallotSubmission,
  BreakCategory,
  Debate,
  FeedbackSubmission,
  Institution,
  Motion,
  Round,
  Team,
  Tournament,
  Venue,
} from "@/types";

export interface SimpleTabRoundExtension {
  ballotDeadline?: string | null;
  feedbackDeadline?: string | null;
  timeZone?: string;
}

export type OpRound = Round & {
  simpletab?: SimpleTabRoundExtension;
};

export interface SimpleTabTournamentExtension {
  trustSignedBallots?: boolean;
  timeZone?: string;
}

export type OpTournament = Tournament & {
  simpletab?: SimpleTabTournamentExtension;
};

export type OpBallotSubmission = BallotSubmission & {
  late?: boolean;
  enteredBy?: string;
};

export interface OpRuntime {
  portalEnforcing: boolean;
  now: string;
}

export interface LateSubmissionRecord {
  id: string;
  roundId: string;
  debateId: string;
  receivedAt: string;
  deadline: string;
  ballot: OpBallotSubmission;
  source: "inbox";
}

export interface HostRecord {
  number: number;
  id: string;
  rank: number;
}

export type RecordKind =
  | "tournament"
  | "institution"
  | "team"
  | "adjudicator"
  | "venue"
  | "round"
  | "debate"
  | "motion"
  | "ballot"
  | "ballotIntake"
  | "lateSubmission"
  | "feedback"
  | "breakCategory"
  | "link"
  | "registration"
  | "device"
  | "role"
  | "host"
  | "proposal";

export type RecordKey = `${RecordKind}:${string}`;

export function recordKey(kind: RecordKind, id: string): RecordKey {
  return `${kind}:${id}`;
}

export interface Actor {
  ref: string;
  type: ActorType;
  role: Role;
  isHostOwner: boolean;
}

export interface OpRequest<T = unknown> {
  type: string;
  payload: T;
  expectedVersions?: Record<RecordKey, number>;
  forced?: boolean;
}

export interface DeviceRecord {
  id: string;
  name: string;
  role: Role;
  publicKey: string;
  approvedAt: string;
  rank?: number;
}

export interface ProposalRecord {
  id: string;
  op: OpRequest<unknown>;
  proposedBy: Actor;
  createdAt: string;
  status: "pending" | "accepted" | "rejected";
  resolvedBy?: string;
  resolvedAt?: string;
  reason?: string;
}

export interface TournamentState {
  tournament: OpTournament;
  institutions: Institution[];
  teams: Team[];
  adjudicators: Adjudicator[];
  venues: Venue[];
  rounds: OpRound[];
  debates: Debate[];
  motions: Motion[];
  ballots: OpBallotSubmission[];
  ballotIntake?: BallotIntakeRecord[];
  lateSubmissions?: LateSubmissionRecord[];
  feedback: FeedbackSubmission[];
  breakCategories: BreakCategory[];
  links: LinkRecord[];
  registrations: RegistrationSubmission[];
  registrationSettings?: RegistrationSettings;
  devices: DeviceRecord[];
  succession?: string[];
  host?: HostRecord;
  roles: CustomPermissionGroup[];
  proposals: ProposalRecord[];
  runtime?: OpRuntime;
  versions: Record<RecordKey, number>;
}

export type ReleaseGate =
  | "draw_teams_released"
  | "draw_released"
  | "round_motions_info_slides"
  | "round_motions_released"
  | "round_results_released"
  | "round_speaks_released"
  | "round_adjudicators_revealed"
  | "break_category_published";

export type OpPermissionResolution = Permission | "service" | "proposal" | null;

export type OpPermissionSpec<P = unknown> =
  | Permission
  | "service"
  | "proposal"
  | ((state: TournamentState, payload: P, registry?: OpRegistryLookup) => OpPermissionResolution);

export interface OpApplyOutput<P = unknown> {
  state: TournamentState;
  committedPayload: P;
}

export type OpRunner = <R = unknown>(
  state: TournamentState,
  request: OpRequest<R>,
  actor: Actor,
  registry: OpRegistryLookup,
) => ApplyResult<R>;

export interface OpDef<P = unknown> {
  type: string;
  permission: OpPermissionSpec<P>;
  category: string;
  visibility: Visibility;
  releaseGate?: ReleaseGate;
  lock: boolean;
  aiAllowed?: boolean;
  checkActor?: (actor: Actor, state: TournamentState, payload: P) => string | null;
  reads(state: TournamentState, payload: P): RecordKey[];
  writes(state: TournamentState, payload: P): RecordKey[];
  validate(state: TournamentState, payload: P, registry?: OpRegistryLookup): string[];
  apply(state: TournamentState, payload: P, actor?: Actor, registry?: OpRegistryLookup): OpApplyOutput<P>;
  applyWithEngine?: (
    state: TournamentState,
    payload: P,
    actor: Actor,
    registry: OpRegistryLookup,
    runOp: OpRunner,
  ) => ApplyResult<P>;
  inverse(committedPayload: P, stateBefore: TournamentState): OpRequest | null;
}

export type ApplyErrorCode =
  | "FORBIDDEN"
  | "VERSION_CONFLICT"
  | "INVALID"
  | "UNKNOWN_OP"
  | "OVERRIDDEN_BY_HOST";

export interface ApplySuccess<P = unknown> {
  ok: true;
  state: TournamentState;
  writes: RecordKey[];
  committedPayload: P;
  inverse: OpRequest | null;
}

export interface ApplyFailure {
  ok: false;
  code: ApplyErrorCode;
  errors: string[];
  current?: Record<RecordKey, number>;
}

export type ApplyResult<P = unknown> = ApplySuccess<P> | ApplyFailure;

export interface OpLogEntry {
  seq: number;
  writes: RecordKey[];
  inverseOf?: number;
}

export type CanUndoResult =
  | { ok: true }
  | { ok: false; blockingSeqs: number[] };

export interface OpRegistryLookup {
  get(type: string): OpDef<unknown> | undefined;
}
