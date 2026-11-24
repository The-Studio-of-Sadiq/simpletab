export const CREDENTIALS_SERVICE_PATH = "/services/simpletab-credentials";

export const CredentialsService = Symbol("CredentialsService");

export type CredentialName =
  | "tournamentKey"
  | "cdnToken"
  | "smtp"
  | "ownWorkerToken"
  | "githubToken";

export const CREDENTIAL_NAMES: readonly CredentialName[] = [
  "tournamentKey",
  "cdnToken",
  "smtp",
  "ownWorkerToken",
  "githubToken",
];

export interface CredentialStatusEntry {
  name: CredentialName;
  set: boolean;
  testedAt?: string;
  ok?: boolean;
  error?: string;
}

export interface SmtpCredentialPayload {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

export interface CredentialTestResult {
  ok: boolean;
  error?: string;
}

export interface CredentialsService {
  status(): Promise<CredentialStatusEntry[]>;
  set(name: CredentialName, value: string): Promise<void>;
  clear(name: CredentialName): Promise<void>;
  test(name: CredentialName): Promise<CredentialTestResult>;
}

export type CredentialsFetchName = "tournamentKey";

export type CredentialsFetchMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface CredentialsFetchHostHeaders {
  hostNumber: number;
  hostId: string;
  hostRank: number;
  requestId?: string;
}

export interface CredentialsFetchRequest {
  method: CredentialsFetchMethod;
  path: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  body?: string;
  hostHeaders?: CredentialsFetchHostHeaders;
  authenticated?: boolean;
  timeoutMs?: number;
}

export interface CredentialsFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface CredentialsFetchClient {
  fetch(
    name: CredentialsFetchName,
    req: CredentialsFetchRequest,
  ): Promise<CredentialsFetchResponse>;
}

export type CredentialsFetchErrorCode =
  | "CREDENTIAL_NOT_SET"
  | "ENCRYPTION_UNAVAILABLE"
  | "DECRYPT_FAILED"
  | "INVALID_REQUEST"
  | "NETWORK_ERROR"
  | "IPC_UNAVAILABLE"
  | "IPC_TIMEOUT";

export class CredentialsFetchError extends Error {
  readonly code: CredentialsFetchErrorCode;

  constructor(code: CredentialsFetchErrorCode, message: string) {
    super(message);
    this.name = "CredentialsFetchError";
    this.code = code;
  }
}
