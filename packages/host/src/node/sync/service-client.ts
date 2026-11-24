import { randomUUID } from "node:crypto";
import {
  parseErrorBody,
  parseInboxPage,
  parseStatusResponse,
  SCHEMA_VERSION,
  type Ack,
  type ErrorCode,
  type Head,
  type InboxPage,
  type KeyRequest,
  type PermitUpload,
  type StatusResponse,
} from "@simpletab/core/wire";
import {
  CredentialsFetchError,
  type CredentialsFetchClient,
  type CredentialsFetchErrorCode,
  type CredentialsFetchMethod,
  type CredentialsFetchResponse,
} from "../../common/credentials-protocol";
import type { SqliteDatabase } from "../db/database";

export interface HostIdentity {
  hostNumber: number;
  hostId: string;
  hostRank: number;
}

export interface PermitUploadResponse {
  schema: number;
  roundId: string;
  version: number;
  open: boolean;
}

export interface AckResponse {
  schema: number;
  ackedThrough: number;
}

export interface HeadResponse {
  schema: number;
  seq: number;
  headHash: string;
  publishedAt: string;
}

export interface KeyRequestResponse {
  schema: number;
  id: string;
  slug: string;
  status: string;
  requestedAt: string;
}

export type ServiceErrorKind =
  | "HOST_STALE"
  | "KEY_REVOKED"
  | "AUTH_INVALID"
  | "QUOTA_EXHAUSTED"
  | "RATE_LIMITED"
  | "ROUND_CLOSED"
  | "CREDENTIAL_NOT_SET"
  | "IPC_UNAVAILABLE"
  | "IPC_TIMEOUT"
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE"
  | "HTTP_ERROR";

export interface ServiceCallFailure {
  ok: false;
  kind: ServiceErrorKind;
  code?: ErrorCode | CredentialsFetchErrorCode;
  status?: number;
  message: string;
  retryAfterSeconds?: number;
  storedHostNumber?: number;
  clockSkewMs?: number;
  serverDate?: string;
}

export interface ServiceCallSuccess<T> {
  ok: true;
  data: T;
  status: number;
  clockSkewMs?: number;
  serverDate?: string;
}

export type ServiceCallResult<T> = ServiceCallSuccess<T> | ServiceCallFailure;

export interface ServiceClientOptions {
  fetchClient: CredentialsFetchClient;
  getHostIdentity: () => HostIdentity;
  getBaseUrl?: () => string | undefined;
  clock?: () => Date;
  timeoutMs?: number;
}

export function readHostIdentity(database: SqliteDatabase): HostIdentity {
  const rows = database
    .prepare(
      "SELECT key, value FROM meta WHERE key IN ('host_number', 'host_id', 'host_rank')",
    )
    .all() as Array<{ key: string; value: string }>;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const num = Number(map.get("host_number") ?? "1");
  const rank = Number(map.get("host_rank") ?? "1");
  const hostId = map.get("host_id") ?? "host-1";
  return {
    hostNumber: Number.isInteger(num) && num >= 1 ? num : 1,
    hostId: hostId.trim().length > 0 ? hostId.trim() : "host-1",
    hostRank: Number.isInteger(rank) && rank >= 1 ? rank : 1,
  };
}

function parseClockSkew(
  headers: Record<string, string>,
  nowMs: number,
): { clockSkewMs?: number; serverDate?: string } {
  const dateHeader = headers.date;
  if (typeof dateHeader !== "string" || dateHeader.trim().length === 0) {
    return {};
  }
  const serverMs = Date.parse(dateHeader);
  if (!Number.isFinite(serverMs)) {
    return {};
  }
  return {
    clockSkewMs: nowMs - serverMs,
    serverDate: new Date(serverMs).toISOString(),
  };
}

function mapCredentialsError(
  error: CredentialsFetchError,
): ServiceCallFailure {
  let kind: ServiceErrorKind = "NETWORK_ERROR";
  if (error.code === "CREDENTIAL_NOT_SET") {
    kind = "CREDENTIAL_NOT_SET";
  } else if (error.code === "IPC_UNAVAILABLE") {
    kind = "IPC_UNAVAILABLE";
  } else if (error.code === "IPC_TIMEOUT") {
    kind = "IPC_TIMEOUT";
  }
  return {
    ok: false,
    kind,
    code: error.code,
    message: error.message,
  };
}

function mapErrorCodeToKind(code: ErrorCode): ServiceErrorKind {
  switch (code) {
    case "HOST_STALE":
      return "HOST_STALE";
    case "KEY_REVOKED":
      return "KEY_REVOKED";
    case "AUTH_INVALID":
      return "AUTH_INVALID";
    case "QUOTA_EXHAUSTED":
      return "QUOTA_EXHAUSTED";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "ROUND_CLOSED":
      return "ROUND_CLOSED";
    default:
      return "HTTP_ERROR";
  }
}

function mapHttpStatusFallbackKind(status: number): ServiceErrorKind {
  if (status === 401) return "AUTH_INVALID";
  if (status === 403) return "KEY_REVOKED";
  if (status === 429) return "RATE_LIMITED";
  return "HTTP_ERROR";
}

/**
 * Typed HTTP client for the `simpletab-ballots` host routes.
 * Routes every request through `electron-main`'s `credentials.fetch` so the tournament key never
 * enters the backend process, and never throws into tabbing code.
 */
export class ServiceClient {
  private readonly fetchClient: CredentialsFetchClient;
  private readonly getHostIdentity: () => HostIdentity;
  private readonly getBaseUrl: (() => string | undefined) | undefined;
  private readonly clock: () => Date;
  private readonly timeoutMs: number | undefined;

  constructor(options: ServiceClientOptions) {
    this.fetchClient = options.fetchClient;
    this.getHostIdentity = options.getHostIdentity;
    this.getBaseUrl = options.getBaseUrl;
    this.clock = options.clock ?? (() => new Date());
    this.timeoutMs = options.timeoutMs;
  }

  async uploadPermit(
    permit: PermitUpload,
    requestId: string = randomUUID(),
  ): Promise<ServiceCallResult<PermitUploadResponse>> {
    return this.requestJson<PermitUploadResponse>({
      method: "POST",
      path: "/v1/host/permits",
      body: JSON.stringify(permit),
      requestId,
      parse: (raw) => {
        if (
          raw === null ||
          typeof raw !== "object" ||
          typeof (raw as PermitUploadResponse).roundId !== "string" ||
          typeof (raw as PermitUploadResponse).version !== "number" ||
          typeof (raw as PermitUploadResponse).open !== "boolean"
        ) {
          return { ok: false, error: "Invalid permit upload response." };
        }
        return { ok: true, value: raw as PermitUploadResponse };
      },
    });
  }

  async fetchInbox(
    after: number,
    limit: number = 500,
  ): Promise<ServiceCallResult<InboxPage>> {
    const safeAfter = Math.max(0, Math.floor(after));
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    return this.requestJson<InboxPage>({
      method: "GET",
      path: `/v1/host/inbox?after=${safeAfter}&limit=${safeLimit}`,
      parse: (raw) => {
        const parsed = parseInboxPage(raw);
        return parsed.ok
          ? { ok: true, value: parsed.value }
          : { ok: false, error: parsed.errors.join("; ") };
      },
    });
  }

  async ackInbox(
    through: number,
    requestId: string = randomUUID(),
  ): Promise<ServiceCallResult<AckResponse>> {
    const payload: Ack = {
      schema: SCHEMA_VERSION,
      through,
    };
    return this.requestJson<AckResponse>({
      method: "POST",
      path: "/v1/host/ack",
      body: JSON.stringify(payload),
      requestId,
      parse: (raw) => {
        if (
          raw === null ||
          typeof raw !== "object" ||
          typeof (raw as AckResponse).ackedThrough !== "number"
        ) {
          return { ok: false, error: "Invalid ack response." };
        }
        return { ok: true, value: raw as AckResponse };
      },
    });
  }

  async publishHead(
    head: Head,
    requestId: string = randomUUID(),
  ): Promise<ServiceCallResult<HeadResponse>> {
    return this.requestJson<HeadResponse>({
      method: "POST",
      path: "/v1/host/head",
      body: JSON.stringify(head),
      requestId,
      parse: (raw) => {
        if (
          raw === null ||
          typeof raw !== "object" ||
          typeof (raw as HeadResponse).seq !== "number" ||
          typeof (raw as HeadResponse).headHash !== "string" ||
          typeof (raw as HeadResponse).publishedAt !== "string"
        ) {
          return { ok: false, error: "Invalid head response." };
        }
        return { ok: true, value: raw as HeadResponse };
      },
    });
  }

  async requestKey(
    req: KeyRequest,
  ): Promise<ServiceCallResult<KeyRequestResponse>> {
    return this.requestJson<KeyRequestResponse>({
      method: "POST",
      path: "/v1/host/key-request",
      body: JSON.stringify(req),
      authenticated: false,
      parse: (raw) => {
        if (
          raw === null ||
          typeof raw !== "object" ||
          typeof (raw as KeyRequestResponse).id !== "string" ||
          typeof (raw as KeyRequestResponse).requestedAt !== "string"
        ) {
          return { ok: false, error: "Invalid key-request response." };
        }
        return { ok: true, value: raw as KeyRequestResponse };
      },
    });
  }

  async getStatus(slug: string): Promise<ServiceCallResult<StatusResponse>> {
    return this.requestJson<StatusResponse>({
      method: "GET",
      path: `/v1/status?slug=${encodeURIComponent(slug)}`,
      parse: (raw) => {
        const parsed = parseStatusResponse(raw);
        return parsed.ok
          ? { ok: true, value: parsed.value }
          : { ok: false, error: parsed.errors.join("; ") };
      },
    });
  }

  private async requestJson<T>(options: {
    method: CredentialsFetchMethod;
    path: string;
    body?: string;
    requestId?: string;
    authenticated?: boolean;
    parse: (raw: unknown) => { ok: true; value: T } | { ok: false; error: string };
  }): Promise<ServiceCallResult<T>> {
    const baseUrl = this.getBaseUrl?.();
    const host = this.getHostIdentity();
    const headers: Record<string, string> = {};
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let rawResponse: CredentialsFetchResponse;
    try {
      rawResponse = await this.fetchClient.fetch("tournamentKey", {
        method: options.method,
        path: options.path,
        ...(baseUrl !== undefined && baseUrl.trim().length > 0
          ? { baseUrl: baseUrl.trim() }
          : {}),
        headers,
        ...(options.body !== undefined ? { body: options.body } : {}),
        ...(options.authenticated !== false
          ? {
              hostHeaders: {
                hostNumber: host.hostNumber,
                hostId: host.hostId,
                hostRank: host.hostRank,
                requestId: options.requestId ?? randomUUID(),
              },
            }
          : {}),
        authenticated: options.authenticated !== false,
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      });
    } catch (error) {
      if (error instanceof CredentialsFetchError) {
        return mapCredentialsError(error);
      }
      return {
        ok: false,
        kind: "NETWORK_ERROR",
        message:
          error instanceof Error ? error.message : "Service request failed.",
      };
    }

    const skew = parseClockSkew(rawResponse.headers, this.clock().getTime());

    let parsedJson: unknown = null;
    if (rawResponse.body.trim().length > 0) {
      try {
        parsedJson = JSON.parse(rawResponse.body) as unknown;
      } catch {
        return {
          ok: false,
          kind: "INVALID_RESPONSE",
          status: rawResponse.status,
          message: `Invalid JSON response (HTTP ${rawResponse.status}).`,
          ...skew,
        };
      }
    }

    if (rawResponse.status < 200 || rawResponse.status >= 300) {
      const errorParsed = parseErrorBody(parsedJson);
      if (errorParsed.ok) {
        const errBody = errorParsed.value;
        return {
          ok: false,
          kind: mapErrorCodeToKind(errBody.code),
          code: errBody.code,
          status: rawResponse.status,
          message: errBody.message,
          ...(errBody.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: errBody.retryAfterSeconds }
            : {}),
          ...(errBody.storedHostNumber !== undefined
            ? { storedHostNumber: errBody.storedHostNumber }
            : {}),
          ...skew,
        };
      }
      return {
        ok: false,
        kind: mapHttpStatusFallbackKind(rawResponse.status),
        status: rawResponse.status,
        message: `Service returned HTTP ${rawResponse.status}.`,
        ...skew,
      };
    }

    const validated = options.parse(parsedJson);
    if (!validated.ok) {
      return {
        ok: false,
        kind: "INVALID_RESPONSE",
        status: rawResponse.status,
        message: validated.error,
        ...skew,
      };
    }

    return {
      ok: true,
      data: validated.value,
      status: rawResponse.status,
      ...skew,
    };
  }
}
