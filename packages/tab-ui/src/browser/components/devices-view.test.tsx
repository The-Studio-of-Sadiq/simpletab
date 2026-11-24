import type { DevicesStatus } from "@simpletab/host/lib/common/host-protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { DevicesView, type DevicesViewProps } from "./devices-view";

const ROLES = [
  { id: "tab_director", name: "Tab director" },
  { id: "equity", name: "Equity" },
];

function status(patch: Partial<DevicesStatus> = {}): DevicesStatus {
  return {
    running: true,
    port: 47820,
    addresses: ["192.168.1.20"],
    hostFingerprint: "ab".repeat(32),
    codes: [],
    pendingJoins: [],
    connected: [],
    devices: [],
    succession: [],
    pairableRoles: ROLES,
    ...patch,
  };
}

function renderView(props: Partial<DevicesViewProps> & { initial: DevicesStatus }) {
  let current = props.initial;
  const handlers = {
    loadStatus: vi.fn(async () => current),
    onSetEnabled: vi.fn(async (on: boolean) => {
      current = { ...current, running: on };
      return current;
    }),
    onIssueCode: vi.fn(async (roleId: string) => {
      const code = { code: "12345678", roleId, expiresAt: "2026-11-25T10:05:00.000Z" };
      current = { ...current, codes: [code] };
      return code;
    }),
    onCancelCode: vi.fn(async () => undefined),
    onApprove: vi.fn(async () => undefined),
    onReject: vi.fn(async () => undefined),
    onRemove: vi.fn(async () => undefined),
  };
  render(<DevicesView open canManage pollMs={60_000} {...handlers} {...props} />);
  return handlers;
}

describe("DevicesView", () => {
  it("turns connections on and shows where devices connect", async () => {
    const h = renderView({ initial: status({ running: false }) });
    const toggle = (await screen.findByRole("checkbox", { name: "Allow devices to connect" })) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("cannot connect");
    fireEvent.click(toggle);
    await waitFor(() => expect(h.onSetEnabled).toHaveBeenCalledWith(true));
    await screen.findByText("192.168.1.20:47820");
  });

  it("creates a code for the chosen role and shows it grouped", async () => {
    const h = renderView({ initial: status() });
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "equity" } });
    fireEvent.click(screen.getByRole("button", { name: "Create a code" }));
    await waitFor(() => expect(h.onIssueCode).toHaveBeenCalledWith("equity"));
    await screen.findByText("1234 5678");
  });

  it("shows a join's six words with a warning and approves or rejects it", async () => {
    const words = ["abandon", "ability", "able", "about", "above", "absent"];
    const h = renderView({
      initial: status({
        pendingJoins: [
          {
            joinId: "j1",
            deviceName: "Rafi's laptop",
            roleId: "tab_director",
            words,
            deviceFingerprint: "cd".repeat(32),
            expiresAt: "2026-11-25T10:02:00.000Z",
          },
        ],
      }),
    });
    const card = await screen.findByLabelText("Join request from Rafi's laptop");
    expect(card.querySelectorAll("li")).toHaveLength(6);
    expect(card.textContent).toContain("absent");
    expect(screen.getByRole("note").textContent).toContain("same six words");
    fireEvent.click(screen.getByRole("button", { name: "The words match: approve" }));
    await waitFor(() => expect(h.onApprove).toHaveBeenCalledWith("j1"));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(h.onReject).toHaveBeenCalledWith("j1"));
  });

  it("removes a paired device only after confirmation", async () => {
    const confirmRemove = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const h = renderView({
      confirmRemove,
      initial: status({
        devices: [
          {
            deviceId: "dev-1",
            name: "Rafi's laptop",
            roleId: "tab_director",
            roleName: "Tab director",
            approvedAt: "2026-11-25T09:00:00.000Z",
            connected: true,
          },
        ],
      }),
    });
    const remove = await screen.findByRole("button", { name: "Remove Rafi's laptop" });
    expect(screen.getByText("Connected")).toBeTruthy();
    fireEvent.click(remove);
    expect(h.onRemove).not.toHaveBeenCalled();
    fireEvent.click(remove);
    await waitFor(() => expect(h.onRemove).toHaveBeenCalledWith("dev-1"));
  });

  it("says plainly when the role cannot manage devices", () => {
    render(
      <DevicesView
        open
        canManage={false}
        loadStatus={vi.fn()}
        onSetEnabled={vi.fn()}
        onIssueCode={vi.fn()}
        onCancelCode={vi.fn()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText(/Only the host owner and tab directors/)).toBeTruthy();
  });
});
