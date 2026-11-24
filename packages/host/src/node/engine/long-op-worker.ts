import { parentPort } from "node:worker_threads";
import {
  applyOp,
  defaultRegistry,
  type Actor,
  type ApplyResult,
  type OpRequest,
  type TournamentState,
} from "@simpletab/core/ops";

export interface LongOpWorkerRequest {
  id: number;
  state: TournamentState;
  request: OpRequest<unknown>;
  actor: Actor;
  debugDelayMs?: number;
}

export type LongOpWorkerResponse =
  | { id: number; ok: true; result: ApplyResult<unknown> }
  | { id: number; ok: false; error: string };

const registry = defaultRegistry();

function spinWait(ms: number): void {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    // Intentional synchronous CPU spin for deterministic worker-thread tests.
  }
}

if (parentPort !== null) {
  const port = parentPort;
  // Tells the pool this worker has finished loading (see LongOpWorkerPool.warm). The message has no
  // request id, so task listeners ignore it.
  port.postMessage({ ready: true });
  port.on("message", (message: LongOpWorkerRequest) => {
    try {
      if (message.debugDelayMs !== undefined && message.debugDelayMs > 0) {
        spinWait(message.debugDelayMs);
      }
      const result = applyOp(message.state, message.request, message.actor, registry);
      const response: LongOpWorkerResponse = {
        id: message.id,
        ok: true,
        result,
      };
      port.postMessage(response);
    } catch (error) {
      const response: LongOpWorkerResponse = {
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      port.postMessage(response);
    }
  });
}
