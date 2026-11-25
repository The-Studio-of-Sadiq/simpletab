import type {
  DeviceModeStatus,
  JoinHostParams,
  JoinProgress,
} from "@simpletab/host/lib/common/host-protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import type { ActionRunner } from "../actions/action";
import {
  dismissRejectedEditsAction,
  joinHostAction,
  leaveHostAction,
} from "../actions/device-mode-actions";
import { DeviceBanner } from "./device-banner";
import { JoinHostPanel } from "./join-host-panel";
import { PresenceChips } from "./presence-chips";

const WORDS = ["abandon", "ability", "able", "about", "above", "absent"];

interface RunCall {
  id: string;
  args: unknown;
}

function makeRunner(
  joinHandler?: (params: JoinHostParams) => Promise<{ ok: true; progress: JoinProgress } | { ok: false; errors: string[] }>,
): { run: ActionRunner; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run = vi.fn(async (action: { id: string }, args: unknown) => {
    calls.push({ id: action.id, args });
    if (action.id === joinHostAction.id) {
      return (
        joinHandler?.(args as JoinHostParams) ?? {
          ok: true,
          progress: { state: "idle" },
        }
      );
    }
    return { ok: true };
  });
  return { run: run as unknown as ActionRunner, calls };
}

function device(patch: Partial<DeviceModeStatus> = {}): DeviceModeStatus {
  return {
    connection: "connected",
    deviceId: "dev-1",
    hostAddress: "192.168.1.20:47820",
    deviceName: "Rafi's laptop",
    roleId: "tab_director",
    roleName: "Tab director",
    queued: [],
    rejected: [],
    presence: [],
    ...patch,
  };
}

describe("JoinHostPanel", () => {
  it("sends the address, code and name, then shows the six words while waiting", async () => {
    let progress: JoinProgress = { state: "connecting" };
    const { run, calls } = makeRunner(async () => ({ ok: true, progress }));
    const loadProgress = vi.fn(async () => progress);
    render(<JoinHostPanel run={run} loadProgress={loadProgress} pollMs={10} />);

    fireEvent.change(screen.getByLabelText("Host address"), { target: { value: "192.168.1.20" } });
    fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "1234 5678" } });
    fireEvent.change(screen.getByLabelText("Name of this laptop"), { target: { value: "Rafi's laptop" } });
    fireEvent.click(screen.getByRole("button", { name: "Join" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        id: joinHostAction.id,
        args: { address: "192.168.1.20", code: "1234 5678", deviceName: "Rafi's laptop" },
      }),
    );
    expect((screen.getByRole("button", { name: "Joining…" }) as HTMLButtonElement).disabled).toBe(true);

    progress = { state: "waiting", words: WORDS };
    const words = await screen.findByLabelText("Words to compare with the host");
    expect(words.querySelectorAll("li")).toHaveLength(6);
    expect(screen.getByRole("status").textContent).toContain("Waiting for the host to approve");
  });

  it("shows a refusal in words", async () => {
    const { run } = makeRunner(async () => ({
      ok: false,
      errors: ["The host did not approve this laptop."],
    }));
    render(<JoinHostPanel run={run} loadProgress={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    expect((await screen.findByRole("alert")).textContent).toContain("did not approve");
  });

  it("shows an input error from the backend", async () => {
    const { run } = makeRunner(async () => {
      throw new Error("The code has 8 digits, as shown on the host's Devices page.");
    });
    render(<JoinHostPanel run={run} loadProgress={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    expect((await screen.findByRole("alert")).textContent).toContain("8 digits");
  });
});

describe("DeviceBanner", () => {
  it("says it is connected, with the host and role", () => {
    const { run } = makeRunner();
    render(<DeviceBanner device={device()} run={run} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Connected to the host.");
    expect(status.textContent).toContain("192.168.1.20:47820");
    expect(status.textContent).toContain("Tab director");
  });

  it("lists waiting and refused edits and clears the refused list", async () => {
    const { run, calls } = makeRunner();
    render(
      <DeviceBanner
        device={device({
          connection: "reconnecting",
          queued: [{ id: "q1", opType: "allocation.swap_rooms", queuedAt: "2026-11-25T10:00:00.000Z" }],
          rejected: [
            {
              id: "q0",
              opType: "ballot.enter",
              queuedAt: "2026-11-25T09:58:00.000Z",
              at: "2026-11-25T10:01:00.000Z",
              errors: ["Someone else changed this ballot first."],
            },
          ],
        })}
        run={run}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Reconnecting");
    expect(screen.getByText(/1 change is waiting/)).toBeTruthy();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("ballot.enter");
    expect(alert.textContent).toContain("Someone else changed this ballot first.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear this list" }));
    });
    expect(calls).toContainEqual({
      id: dismissRejectedEditsAction.id,
      args: {},
    });
  });

  it("leaves only after confirmation", async () => {
    const { run, calls } = makeRunner();
    const confirmLeave = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<DeviceBanner device={device()} run={run} confirmLeave={confirmLeave} />);
    const button = screen.getByRole("button", { name: "Leave the host" });
    fireEvent.click(button);
    expect(calls).toEqual([]);
    fireEvent.click(button);
    expect(calls).toEqual([{ id: leaveHostAction.id, args: {} }]);
  });
});

describe("PresenceChips", () => {
  const entries = [
    { deviceId: "host", name: "Host", roleId: "host_owner", since: "x", view: "allocation" },
    { deviceId: "dev-1", name: "Rafi", roleId: "tab_director", since: "x", view: "allocation", debateId: "d1" },
    { deviceId: "dev-2", name: "Mina", roleId: "equity", since: "x", view: "draw" },
  ];

  it("names others on the same view, marks who is editing, and leaves out this laptop", () => {
    render(<PresenceChips entries={entries} view="allocation" selfId="host" />);
    expect(screen.getByText("Rafi (editing)")).toBeTruthy();
    expect(screen.queryByText("Host")).toBeNull();
    expect(screen.queryByText("Mina")).toBeNull();
  });

  it("renders nothing when nobody else is there", () => {
    const { container } = render(<PresenceChips entries={entries} view="results" selfId="host" />);
    expect(container.textContent).toBe("");
  });
});
