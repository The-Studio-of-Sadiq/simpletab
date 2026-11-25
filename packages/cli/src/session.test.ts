import { describe, expect, it } from "vitest";
import type { ProjectedState } from "../../host/src/common/host-protocol";
import { makeState } from "../../host/src/node/publish/publish-test-fixtures";
import { awaitConnection, type RemoteLike } from "./session";

function stateWith(): ProjectedState {
  return { ...makeState(), seq: 1, roleId: "ai", versions: {}, proposals: [] };
}

function fakeRemote(state: ProjectedState | null, connected: boolean): RemoteLike {
  return {
    start: () => {},
    stop: () => {},
    isConnected: () => connected,
    getState: () => state,
    status: () => {
      throw new Error("Not used by the CLI.");
    },
    submit: async () => {
      throw new Error("Not used by this test.");
    },
  };
}

describe("awaitConnection", () => {
  const state = stateWith();

  it("returns the snapshot once the device is connected", async () => {
    const result = await awaitConnection(fakeRemote(state, true), {
      timeoutMs: 200,
      isRemoved: () => false,
    });
    expect(result).toEqual({ kind: "connected", state });
  });

  it("waits for a snapshot rather than accepting a connected socket alone", async () => {
    const remote = fakeRemote(null, true);
    const result = await awaitConnection(remote, {
      timeoutMs: 20,
      pollMs: 1,
      isRemoved: () => false,
    });
    expect(result).toEqual({ kind: "unreachable" });
  });

  it("reports removal before a connection", async () => {
    const result = await awaitConnection(fakeRemote(state, false), {
      timeoutMs: 200,
      isRemoved: () => true,
    });
    expect(result).toEqual({ kind: "removed" });
  });
});
