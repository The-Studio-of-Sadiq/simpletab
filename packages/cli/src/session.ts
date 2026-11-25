import type {
  DeviceModeStatus,
  ProjectedState,
  SubmitResult,
} from "../../host/src/common/host-protocol";
import type { OpRequest } from "@simpletab/core/ops";

/**
 * The part of `RemoteHost` the CLI uses. Keeping it narrow lets tests drive every command with a
 * fake, without opening a socket.
 */
export interface RemoteLike {
  start(): void;
  stop(): void;
  isConnected(): boolean;
  getState(): ProjectedState | null;
  status(): DeviceModeStatus;
  submit(op: OpRequest): Promise<SubmitResult>;
}

export interface RemoteHooks {
  onChange?(reason: "state" | "locks" | "presence" | "connection" | "outbox"): void;
  onRemoved?(): void;
}

export type ConnectionOutcome =
  | { kind: "connected"; state: ProjectedState }
  | { kind: "unreachable" }
  | { kind: "removed" };

export interface WaitOptions {
  timeoutMs: number;
  /** True once the host has told this device it was removed. */
  isRemoved(): boolean;
  pollMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits until the remote host is connected *and* the first snapshot has arrived. Submitting before
 * that would queue the change only in memory, and the CLI exits at once, so it would be lost.
 */
export async function awaitConnection(
  remote: RemoteLike,
  options: WaitOptions,
): Promise<ConnectionOutcome> {
  const pollMs = options.pollMs ?? 50;
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
    if (options.isRemoved()) return { kind: "removed" };
    if (remote.isConnected()) {
      const state = remote.getState();
      if (state !== null) return { kind: "connected", state };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { kind: "unreachable" };
    await delay(Math.min(pollMs, remaining));
  }
}
