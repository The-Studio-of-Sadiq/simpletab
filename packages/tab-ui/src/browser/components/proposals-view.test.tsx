import type { ProposalRecord } from "@simpletab/core/ops";
import type {
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { ProposalsView, type ProposalDecision } from "./proposals-view";

function state(patch: Partial<ProjectedState> = {}): ProjectedState {
  return {
    roleId: "tab_director",
    permissions: ["settings.edit"] as const,
    proposals: [],
    ...patch,
  } as unknown as ProjectedState;
}

function proposal(patch: Partial<ProposalRecord> = {}): ProposalRecord {
  return {
    id: "p1",
    op: { type: "release.set_gate", payload: { gate: "open" } },
    proposedBy: {
      ref: "device:dev-abc",
      type: "ai",
      role: { id: "ai", name: "AI", permissions: [] },
      isHostOwner: false,
    },
    createdAt: "2026-11-25T09:00:00.000Z",
    status: "pending",
    ...patch,
  };
}

function pendingSection(): HTMLElement {
  return screen.getByRole("region", { name: "Waiting for a decision" });
}

function decidedSection(): HTMLElement {
  return screen.getByRole("region", { name: "Decided" });
}

describe("ProposalsView", () => {
  it("says nothing is open when there is no tournament", () => {
    render(<ProposalsView state={null} onDecide={vi.fn()} />);
    expect(screen.getByText("Open a tournament to review proposals.")).toBeTruthy();
  });

  it("lists pending proposals oldest first and decided ones newest first", () => {
    render(
      <ProposalsView
        state={state({
          proposals: [
            proposal({
              id: "new-pending",
              op: { type: "motions.add", payload: { text: "THBT ..." } },
              createdAt: "2026-11-25T10:00:00.000Z",
            }),
            proposal({
              id: "old-pending",
              createdAt: "2026-11-25T08:00:00.000Z",
            }),
            proposal({
              id: "old-decided",
              status: "accepted",
              resolvedAt: "2026-11-25T11:00:00.000Z",
              resolvedBy: "device:host-1",
            }),
            proposal({
              id: "new-decided",
              status: "rejected",
              resolvedAt: "2026-11-25T12:00:00.000Z",
              resolvedBy: "device:host-1",
              reason: "Not this round",
            }),
          ],
        })}
        onDecide={vi.fn()}
      />,
    );

    const pending = within(pendingSection()).getAllByRole("listitem");
    expect(pending).toHaveLength(2);
    expect(pending[0]!.textContent).toContain("release.set_gate");
    expect(pending[1]!.textContent).toContain("motions.add");

    const decided = within(decidedSection()).getAllByRole("listitem");
    expect(decided).toHaveLength(2);
    expect(decided[0]!.textContent).toContain("Rejected");
    expect(decided[1]!.textContent).toContain("Accepted");
    expect(decided[0]!.textContent).toContain("Not this round");
  });

  it("shows who proposed a change, when, and its payload", () => {
    render(
      <ProposalsView
        state={state({ proposals: [proposal()] })}
        onDecide={vi.fn()}
      />,
    );
    const card = within(pendingSection()).getByRole("listitem");
    expect(card.textContent).toContain("AI");
    expect(card.textContent).toContain("device:dev-abc");
    fireEvent.click(within(card).getByText("Change details"));
    expect(card.querySelector("pre")?.textContent).toContain('"gate": "open"');
  });

  it("accepts a proposal through onDecide", async () => {
    const onDecide = vi.fn(async (): Promise<SubmitResult> => ({
      ok: true,
      seq: 4,
      writes: [],
      committedPayload: null,
    }));
    render(
      <ProposalsView
        state={state({ proposals: [proposal()] })}
        onDecide={onDecide}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(onDecide).toHaveBeenCalledWith({ kind: "accept", proposalId: "p1" }),
    );
  });

  it("rejects with the trimmed reason, and without a reason key when empty", async () => {
    const onDecide = vi.fn(
      async (_decision: ProposalDecision): Promise<SubmitResult> => ({
        ok: true,
        seq: 5,
        writes: [],
        committedPayload: null,
      }),
    );
    render(
      <ProposalsView
        state={state({ proposals: [proposal()] })}
        onDecide={onDecide}
      />,
    );

    const reason = screen.getByLabelText("Reason for rejection (optional)");
    fireEvent.change(reason, { target: { value: "  Not this round  " } });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(onDecide).toHaveBeenLastCalledWith({
        kind: "reject",
        proposalId: "p1",
        reason: "Not this round",
      }),
    );

    onDecide.mockClear();
    fireEvent.change(reason, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(onDecide).toHaveBeenCalledWith({
        kind: "reject",
        proposalId: "p1",
      }),
    );
    expect(onDecide.mock.calls[0]![0]).not.toHaveProperty("reason");
  });

  it("disables both buttons while a decision is in flight", async () => {
    let settle: (result: SubmitResult) => void = () => undefined;
    const onDecide = vi.fn(
      () =>
        new Promise<SubmitResult>((resolve) => {
          settle = resolve;
        }),
    );
    render(
      <ProposalsView
        state={state({ proposals: [proposal()] })}
        onDecide={onDecide}
      />,
    );

    const accept = screen.getByRole("button", { name: "Accept" });
    const reject = screen.getByRole("button", { name: "Reject" });
    fireEvent.click(accept);
    await waitFor(() => expect((accept as HTMLButtonElement).disabled).toBe(true));
    expect((reject as HTMLButtonElement).disabled).toBe(true);

    settle({ ok: true, seq: 6, writes: [], committedPayload: null });
    await waitFor(() =>
      expect((accept as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("shows the host's refusal for that proposal", async () => {
    const onDecide = vi.fn(
      async (): Promise<SubmitResult> => ({
        ok: false,
        code: "FORBIDDEN",
        errors: ["Only tab directors can decide proposals."],
      }),
    );
    render(
      <ProposalsView
        state={state({ proposals: [proposal()] })}
        onDecide={onDecide}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Only tab directors can decide proposals.");
    expect(alert.textContent).toContain("Permission denied");
  });

  it("offers no decision buttons to the AI or a role without permissions", () => {
    const { rerender } = render(
      <ProposalsView
        state={state({
          roleId: "ai",
          permissions: ["results.enter"] as const,
          proposals: [proposal()],
        })}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.getByText("This role cannot decide proposals.")).toBeTruthy();

    rerender(
      <ProposalsView
        state={state({
          roleId: "display",
          permissions: [] as const,
          proposals: [proposal()],
        })}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.getByText("This role cannot decide proposals.")).toBeTruthy();
  });

  it("explains empty pending and decided lists", () => {
    render(<ProposalsView state={state()} onDecide={vi.fn()} />);
    expect(
      screen.getByText("No proposal is waiting for a decision."),
    ).toBeTruthy();
    expect(screen.getByText("No proposal has been decided yet.")).toBeTruthy();
  });
});
