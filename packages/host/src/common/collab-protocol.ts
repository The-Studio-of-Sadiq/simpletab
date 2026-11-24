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
