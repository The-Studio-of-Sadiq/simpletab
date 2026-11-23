import type { ActorType, Visibility } from "@/changelog";
import type { RegistrationSubmission } from "@/lib/registration/types";
import type { CustomPermissionGroup } from "@/lib/staffPermissions";
import type { Permission, Role } from "@/permissions";
import type { LinkRecord } from "@/projection";
import type {
  Adjudicator,
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
  | "feedback"
  | "breakCategory"
  | "link"
  | "registration"
  | "device"
  | "role"
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
  tournament: Tournament;
  institutions: Institution[];
  teams: Team[];
  adjudicators: Adjudicator[];
  venues: Venue[];
  rounds: OpRound[];
  debates: Debate[];
  motions: Motion[];
  ballots: BallotSubmission[];
  feedback: FeedbackSubmission[];
  breakCategories: BreakCategory[];
  links: LinkRecord[];
  registrations: RegistrationSubmission[];
  devices: DeviceRecord[];
  roles: CustomPermissionGroup[];
  proposals: ProposalRecord[];
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

export type OpPermissionSpec<P = unknown> =
  | Permission
  | "service"
  | ((state: TournamentState, payload: P) => Permission | "service");

export interface OpApplyOutput<P = unknown> {
  state: TournamentState;
  committedPayload: P;
}

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
  validate(state: TournamentState, payload: P): string[];
  apply(state: TournamentState, payload: P, actor?: Actor): OpApplyOutput<P>;
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
