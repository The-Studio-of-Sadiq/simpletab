import type {
  CredentialsFetchErrorCode,
  CredentialsFetchName,
  CredentialsFetchRequest,
  CredentialsFetchResponse,
} from "./credentials-protocol";

export const CREDENTIALS_IPC_CHANNEL = "simpletab.credentials.fetch" as const;

export interface CredentialsFetchIpcRequest {
  __simpletabIpc: typeof CREDENTIALS_IPC_CHANNEL;
  kind: "request";
  id: string;
  name: CredentialsFetchName;
  req: CredentialsFetchRequest;
}

export interface CredentialsFetchIpcResponse {
  __simpletabIpc: typeof CREDENTIALS_IPC_CHANNEL;
  kind: "response";
  id: string;
  ok: true;
  response: CredentialsFetchResponse;
}

export interface CredentialsFetchIpcErrorResponse {
  __simpletabIpc: typeof CREDENTIALS_IPC_CHANNEL;
  kind: "response";
  id: string;
  ok: false;
  code: CredentialsFetchErrorCode;
  message: string;
}

export type CredentialsFetchIpcMessage =
  | CredentialsFetchIpcRequest
  | CredentialsFetchIpcResponse
  | CredentialsFetchIpcErrorResponse;

export interface IpcMessageEndpoint {
  connected?: boolean;
  send?: (message: CredentialsFetchIpcMessage) => unknown;
  on(event: "message", listener: (message: unknown) => void): unknown;
  off?(event: "message", listener: (message: unknown) => void): unknown;
  removeListener?(event: "message", listener: (message: unknown) => void): unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isCredentialsFetchIpcRequest(
  value: unknown,
): value is CredentialsFetchIpcRequest {
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    value.__simpletabIpc === CREDENTIALS_IPC_CHANNEL &&
    value.kind === "request" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.name === "string" &&
    isPlainRecord(value.req)
  );
}

export function isCredentialsFetchIpcReply(
  value: unknown,
): value is CredentialsFetchIpcResponse | CredentialsFetchIpcErrorResponse {
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    value.__simpletabIpc === CREDENTIALS_IPC_CHANNEL &&
    value.kind === "response" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.ok === "boolean"
  );
}
