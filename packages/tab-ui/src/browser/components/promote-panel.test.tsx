import type { DeviceModeStatus, DevicesStatus } from "@simpletab/host/lib/common/host-protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import type { ActionResult, ActionRunner } from "../actions/action";
import {
  promoteToHostAction,
  type PromoteArgs,
  saveDeviceCopyAction,
  type SaveCopyArgs,
  type SaveCopyResult,
  setSuccessionOrderAction,
} from "../actions/devices-actions";
import { DevicesView } from "./devices-view";
import { PromotePanel, ReplacedBanner } from "./promote-panel";

function director(patch: Partial<DeviceModeStatus> = {}): DeviceModeStatus {
  return {
    connection: "reconnecting",
    deviceId: "dev-2",
    hostAddress: "192.168.1.20:47820",
    deviceName: "Mina's laptop",
    roleId: "tab_director",
    roleName: "Tab director",
    queued: [],
    rejected: [],
    presence: [],
    copy: { lastSeq: 412 },
    successionRank: 2,
    betterRanked: ["Rafi's laptop"],
    ...patch,
  };
}

function runnerFor(
  onPromote: (args: PromoteArgs) => Promise<unknown> = async () => undefined,
  onExportCopy: (args: SaveCopyArgs) => Promise<string> = async () => "",
): ActionRunner {
  const run = async (action: { id: string }, args: unknown): Promise<ActionResult | SaveCopyResult> => {
    if (action.id === promoteToHostAction.id) {
      await onPromote(args as PromoteArgs);
      return { ok: true };
    }
    if (action.id === saveDeviceCopyAction.id) {
      return { ok: true, file: await onExportCopy(args as SaveCopyArgs) };
    }
    throw new Error(`Unexpected action: ${action.id}`);
  };
  return run as unknown as ActionRunner;
}

function successionRunner(onSetSuccession: (order: string[]) => Promise<unknown>): ActionRunner {
  const run = async (action: { id: string }, args: unknown): Promise<ActionResult> => {
    if (action.id !== setSuccessionOrderAction.id) {
      throw new Error(`Unexpected action: ${action.id}`);
    }
    await onSetSuccession((args as { order: string[] }).order);
    return { ok: true };
  };
  return run as unknown as ActionRunner;
}

describe("PromotePanel", () => {
  it("names better-ranked laptops and promotes with the chosen folder after confirmation", async () => {
    const onPromote = vi.fn(async () => ({ open: true, locks: [] }));
    render(
      <PromotePanel
        device={director()}
        run={runnerFor(onPromote)}
        confirmPromote={() => true}
      />,
    );
    expect(screen.getByText(/up to number 412/)).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("Rafi's laptop");
    const promote = screen.getByRole("button", { name: "Promote this laptop to host" }) as HTMLButtonElement;
    expect(promote.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Folder for the new host's tournament file"), { target: { value: "C:/tabs" } });
    fireEvent.click(promote);
    await waitFor(() => expect(onPromote).toHaveBeenCalledWith({ directory: "C:/tabs" }));
  });

  it("refuses to promote while the host is reachable, but can still save the copy", async () => {
    const onExportCopy = vi.fn(async () => "C:/tabs/wudc.copy-412.simpletab");
    render(
      <PromotePanel
        device={director({ connection: "connected" })}
        run={runnerFor(async () => undefined, onExportCopy)}
      />,
    );
    expect(screen.getByText(/host is reachable/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Folder for the new host's tournament file"), { target: { value: "C:/tabs" } });
    expect((screen.getByRole("button", { name: "Promote this laptop to host" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save this laptop's copy to the folder" }));
    await screen.findByText("Saved C:/tabs/wudc.copy-412.simpletab.");
  });

  it("shows nothing for roles that cannot be promoted", () => {
    const { container } = render(<PromotePanel device={director({ roleId: "equity" })} run={runnerFor()} />);
    expect(container.textContent).toBe("");
  });
});

describe("ReplacedBanner", () => {
  it("says the tournament is read-only and where the divergent changes are", () => {
    render(
      <ReplacedBanner info={{ hostNumber: 3, hostRank: 1, at: "2026-11-25T10:00:00.000Z", forkSeq: 400, divergentFile: "C:/t/wudc.divergent.simpletab" }} />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Replaced by host 3");
    expect(alert.textContent).toContain("read-only");
    expect(alert.textContent).toContain("wudc.divergent.simpletab");
  });
});

describe("DevicesView succession list", () => {
  it("moves a tab director up", async () => {
    const status: DevicesStatus = {
      running: true,
      port: 47820,
      addresses: [],
      codes: [],
      pendingJoins: [],
      connected: [],
      devices: [
        { deviceId: "a", name: "Rafi", roleId: "tab_director", roleName: "Tab director", approvedAt: "2026-11-25T09:00:00.000Z", connected: true },
        { deviceId: "b", name: "Mina", roleId: "tab_director", roleName: "Tab director", approvedAt: "2026-11-25T09:00:00.000Z", connected: true },
      ],
      succession: ["a", "b"],
      pairableRoles: [],
    };
    const onSetSuccession = vi.fn(async () => undefined);
    render(
      <DevicesView
        open
        canManage
        pollMs={60_000}
        loadStatus={async () => status}
        run={successionRunner(onSetSuccession)}
      />,
    );
    const up = await screen.findByRole("button", { name: "Move Mina up" });
    expect((screen.getByRole("button", { name: "Move Rafi up" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(up);
    await waitFor(() => expect(onSetSuccession).toHaveBeenCalledWith(["b", "a"]));
  });
});
