import {
  CREDENTIALS_IPC_CHANNEL,
  isCredentialsFetchIpcRequest,
  type CredentialsFetchIpcErrorResponse,
  type CredentialsFetchIpcResponse,
  type IpcMessageEndpoint,
} from "../common/credentials-ipc";
import {
  CredentialsFetchError,
  type CredentialsFetchClient,
} from "../common/credentials-protocol";

/**
 * Attaches an electron-main IPC listener to a forked backend child process so the backend can
 * perform authenticated HTTP requests against the ballots service without ever reading secrets.
 */
export function attachCredentialsIpcHandler(
  child: IpcMessageEndpoint,
  credentials: CredentialsFetchClient,
): () => void {
  const onMessage = (raw: unknown): void => {
    if (!isCredentialsFetchIpcRequest(raw)) {
      return;
    }

    const { id, name, req } = raw;
    void credentials.fetch(name, req).then(
      (response) => {
        const reply: CredentialsFetchIpcResponse = {
          __simpletabIpc: CREDENTIALS_IPC_CHANNEL,
          kind: "response",
          id,
          ok: true,
          response,
        };
        if (child.connected !== false) {
          child.send?.(reply);
        }
      },
      (error: unknown) => {
        const code =
          error instanceof CredentialsFetchError ? error.code : "NETWORK_ERROR";
        const message =
          error instanceof Error ? error.message : "Credentials fetch failed.";
        const reply: CredentialsFetchIpcErrorResponse = {
          __simpletabIpc: CREDENTIALS_IPC_CHANNEL,
          kind: "response",
          id,
          ok: false,
          code,
          message,
        };
        if (child.connected !== false) {
          child.send?.(reply);
        }
      },
    );
  };

  child.on("message", onMessage);
  return () => {
    if (typeof child.off === "function") {
      child.off("message", onMessage);
    } else if (typeof child.removeListener === "function") {
      child.removeListener("message", onMessage);
    }
  };
}
