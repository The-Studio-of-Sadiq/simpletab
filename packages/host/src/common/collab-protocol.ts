/**
 * Live collaboration wire protocol between the host and staff devices (design section 4,
 * amendment 7). JSON text frames over `wss`, every message carrying `schema: 1`.
 *
 * Transport: TLS with a self-signed P-256 certificate on each side. The host asks for the client
 * certificate but does not let TLS judge it; it compares the certificate's SHA-256 fingerprint with
 * the one stored when the device was approved. A device pins the host's certificate fingerprint at
 * pairing and refuses any other host certificate afterwards.
 *
 * Step a (this file's first part) covers pairing and authenticated reconnects. The projection stream,
 * submissions and presence (step b) and promotion (step c) extend the unions below.
 */

import type { Role } from "@simpletab/core/permissions";

export const COLLAB_SCHEMA = 1 as const;

/** Default TCP port of the host's collaboration server (configurable). */
export const COLLAB_DEFAULT_PORT = 47820;

/** Pairing codes: 8 digits, valid 5 minutes, single use, all cancelled after 5 wrong attempts. */
export const PAIRING_CODE_DIGITS = 8;
export const PAIRING_CODE_TTL_MS = 5 * 60_000;
export const PAIRING_MAX_WRONG_ATTEMPTS = 5;

/** A connection must send `pair_request` or `hello` within this time, or it is closed. */
export const COLLAB_FIRST_MESSAGE_TIMEOUT_MS = 10_000;
/** The host user has this long to approve a join before it is refused. */
export const PAIRING_APPROVAL_TIMEOUT_MS = 2 * 60_000;
export const COLLAB_HEARTBEAT_MS = 15_000;

/** WebSocket close codes used by the collaboration server. */
export const COLLAB_CLOSE = {
  /** No client certificate was presented. */
  NO_CLIENT_CERT: 4401,
  /** The first message did not arrive in time, or was not `pair_request` / `hello`. */
  PROTOCOL: 4400,
  /** The connection was refused (see the preceding `refused` / `pair_result` message). */
  REFUSED: 4403,
} as const;

/** Lowercase hex SHA-256 of the certificate's DER bytes (64 characters). */
export type CertFingerprint = string;

export interface HostIdentity {
  hostNumber: number;
  hostId: string;
  /** Rank in the succession list; lower wins on equal host numbers. */
  hostRank: number;
  certFingerprint: CertFingerprint;
  /** For a promoted host: the last seq it shares with the host it replaced (the fork point). */
  promotedFromSeq?: number;
}

// ---- device -> host -------------------------------------------------------------------------

export interface PairRequestMessage {
  schema: 1;
  kind: "pair_request";
  /** The 8-digit code shown on the host's Devices page. */
  code: string;
  /** Shown to the host user, e.g. "Rafi's laptop". 1–60 characters. */
  deviceName: string;
}

export interface HelloMessage {
  schema: 1;
  kind: "hello";
  deviceId: string;
  /** Last committed seq the device holds (0 when it holds nothing). */
  lastSeq: number;
  /** The best host this device knows of, so a stale host learns it was replaced (step c). */
  knownHost?: HostIdentity;
}

export interface PingMessage {
  schema: 1;
  kind: "ping";
  t: number;
}

export type DeviceToHostMessage = PairRequestMessage | HelloMessage | PingMessage;

// ---- host -> device -------------------------------------------------------------------------

export interface PairPendingMessage {
  schema: 1;
  kind: "pair_pending";
  /** The six BIP39 words; the device computes its own copy and shows both should match. */
  words: string[];
}

export type PairRefusalReason =
  /** Wrong, expired or already used code. */
  | "BAD_CODE"
  /** Too many wrong attempts; every active code was cancelled. */
  | "LOCKED_OUT"
  /** The host user rejected the join, or did not answer in time. */
  | "REJECTED"
  | "TIMEOUT";

export type PairResultMessage =
  | {
      schema: 1;
      kind: "pair_result";
      ok: true;
      deviceId: string;
      role: Role;
      host: HostIdentity;
    }
  | {
      schema: 1;
      kind: "pair_result";
      ok: false;
      reason: PairRefusalReason;
    };

export interface WelcomeMessage {
  schema: 1;
  kind: "welcome";
  deviceId: string;
  role: Role;
  host: HostIdentity;
}

export type HelloRefusalReason =
  /** No approved device has this id. */
  | "UNKNOWN_DEVICE"
  /** The device was removed; it must wipe its local copy. */
  | "REMOVED"
  /** The client certificate does not match the key stored at pairing. */
  | "KEY_MISMATCH";

export interface RefusedMessage {
  schema: 1;
  kind: "refused";
  reason: HelloRefusalReason;
}

export interface PongMessage {
  schema: 1;
  kind: "pong";
  t: number;
}

export type HostToDeviceMessage =
  | PairPendingMessage
  | PairResultMessage
  | WelcomeMessage
  | RefusedMessage
  | PongMessage;

// ---- host-side UI events ------------------------------------------------------------------------

/** A join waiting for the host user to compare the words and approve or reject it. */
export interface PendingJoin {
  joinId: string;
  deviceName: string;
  roleId: string;
  words: string[];
  deviceFingerprint: CertFingerprint;
  /** When the join is refused automatically (ISO 8601 UTC). */
  expiresAt: string;
}

export interface IssuedPairingCode {
  code: string;
  roleId: string;
  expiresAt: string;
}

export interface ConnectedDeviceInfo {
  deviceId: string;
  name: string;
  roleId: string;
  connectedAt: string;
  remoteAddress?: string;
}

// ---- step b: live data, requests, locks and presence ---------------------------------------------
//
// After `welcome` / `pair_result ok`, the host sends one `snapshot` of the device's role view, then a
// `delta` after each batch of commits (at most every COLLAB_DELTA_BATCH_MS). Deltas are computed by
// diffing the role's previous and next view (`diffProjectedState`), never by filtering single ops,
// because a release can reveal records it did not write. Every delta carries the seq it starts from;
// a device that sees a gap asks for a fresh snapshot with `resync`.

/** Commits are batched into one delta per role at most this often. */
export const COLLAB_DELTA_BATCH_MS = 100;
/** Presence updates are forwarded at most this often per device. */
export const COLLAB_PRESENCE_THROTTLE_MS = 250;

/** The role view as `HostService.getState` returns it (structurally `ProjectedState`). */
export type CollabStateView = Record<string, unknown> & { seq: number; roleId: string };

/**
 * Changes between two views of the same role.
 *
 * - `collections`: for each top-level array of records with string `id`s: `ids` is the full new
 *   order, `upsert` the records that are new or changed (deep-equal compare), and every id missing
 *   from `ids` is gone.
 * - `maps`: for each top-level plain-object map whose values are not records (for example
 *   `versions`): keys to set and keys to remove.
 * - `replace`: any other top-level key whose value changed, replaced whole.
 * - `remove`: top-level keys that disappeared.
 */
export interface StateDelta {
  collections?: Record<string, { ids: string[]; upsert: Array<Record<string, unknown> & { id: string }> }>;
  maps?: Record<string, { set: Record<string, unknown>; remove: string[] }>;
  replace?: Record<string, unknown>;
  remove?: string[];
}

export interface SnapshotMessage {
  schema: 1;
  kind: "snapshot";
  state: CollabStateView;
  locks: CollabLock[];
}

export interface DeltaMessage {
  schema: 1;
  kind: "delta";
  /** The view's seq before this delta; the device must hold exactly this seq. */
  fromSeq: number;
  toSeq: number;
  delta: StateDelta;
  /** Committed op types in this batch (for the UI's change notices), in order. */
  opTypes: string[];
}

export interface CollabLock {
  lockId: string;
  opType: string;
  actorRef: string;
  startedAt: string;
  roundId?: string;
}

export interface LocksMessage {
  schema: 1;
  kind: "locks";
  locks: CollabLock[];
}

/** What a person is doing, so others see "Rafi is editing Round 3 allocation". */
export interface PresenceInfo {
  /** Widget or page, e.g. "allocation". */
  view?: string;
  roundId?: string;
  /** A debate being dragged or edited ("holding" in the allocation screen). */
  debateId?: string;
}

export interface PresenceEntry extends PresenceInfo {
  deviceId: string;
  name: string;
  roleId: string;
  since: string;
}

export interface PresenceMessage {
  schema: 1;
  kind: "presence";
  /** Every connected device plus the host itself (deviceId "host"). */
  entries: PresenceEntry[];
}

export interface SetPresenceMessage extends PresenceInfo {
  schema: 1;
  kind: "set_presence";
}

export interface ResyncMessage {
  schema: 1;
  kind: "resync";
}

/** Host methods a device may call; each runs as the device's own actor and role. */
export type CollabRequestMethod = "submit" | "undo" | "cancelLong" | "getChangelog" | "getOpUndoInfo";

export interface RequestMessage {
  schema: 1;
  kind: "request";
  /** Unique per device connection; echoed in the response. */
  requestId: string;
  method: CollabRequestMethod;
  /** submit: [OpRequest]; undo: [seq]; cancelLong: [lockId]; getChangelog: [afterSeq?, limit?]; getOpUndoInfo: []. */
  params: unknown[];
}

export type ResponseMessage =
  | { schema: 1; kind: "response"; requestId: string; ok: true; value: unknown }
  | { schema: 1; kind: "response"; requestId: string; ok: false; error: string };

/** Device actors are named `device:<deviceId>` in the op log and changelog. */
export function deviceActorRef(deviceId: string): string {
  return `device:${deviceId}`;
}

// ---- step c: tab-director copies, succession and promotion -------------------------------------
//
// Tab-director devices keep a full copy so one of them can become host (design section 4). On every
// connection the host sends `replica_init` (a complete handover file: snapshot, every op record with
// its changelog entry, links) and then `ops` with each new committed op record, in seq order. The
// device verifies the chain before replacing its copy.

export interface ReplicaInitMessage {
  schema: 1;
  kind: "replica_init";
  /** Base64 of a `.simpletab` handover zip (design Appendix E). */
  handover: string;
  lastSeq: number;
  headHash: string;
}

export interface ReplicaOpsMessage {
  schema: 1;
  kind: "ops";
  /** Handover op records (`HandoverOpRecord`), contiguous and in seq order. */
  records: unknown[];
}

/**
 * Sent by a device that knows a host which beats this one (host number, then lower rank). The host
 * becomes read-only and writes its ops after the fork point to `<slug>.divergent.simpletab`.
 */
export interface SupersededMessage {
  schema: 1;
  kind: "superseded";
  winner: HostIdentity;
}

/** True when `a` beats `b`: a higher host number, or the same number and a lower (better) rank. */
export function hostBeats(a: HostIdentity, b: HostIdentity): boolean {
  if (a.hostNumber !== b.hostNumber) return a.hostNumber > b.hostNumber;
  return a.hostRank < b.hostRank;
}
