import type { ProjectedState, QrReceiveResult } from "@simpletab/host/lib/common/host-protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import type { ActionRunner } from "../actions/action";
import {
  openCheckinPageAction,
  openResultsPageAction,
} from "../actions/navigation-actions";
import { importQrBallotAction } from "../actions/results-actions";
import { AssistantView } from "./assistant-view";

const state = {
  debates: [{ id: "d1", venueName: "Room 101" }],
} as unknown as ProjectedState;

interface RunCall {
  id: string;
  args: unknown;
}

function makeRunner(
  qrResults: QrReceiveResult[] = [],
): { run: ActionRunner; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run = vi.fn(async (action: { id: string }, args: unknown) => {
    calls.push({ id: action.id, args });
    if (action.id === importQrBallotAction.id) {
      return (
        qrResults.shift() ??
        ({ ok: true, seq: 0, roundId: "", debateId: "" } as QrReceiveResult)
      );
    }
    return { ok: true };
  });
  return { run: run as unknown as ActionRunner, calls };
}

function renderWith(
  run: ActionRunner,
  canScan = true,
): (codes: string[]) => void {
  let scan: (codes: string[]) => void = () => undefined;
  render(
    <AssistantView
      state={state}
      canScan={canScan}
      run={run}
      renderScanner={(onCodes) => {
        scan = onCodes;
        return <p>fake scanner</p>;
      }}
    />,
  );
  return (codes: string[]) => scan(codes);
}

describe("AssistantView", () => {
  it("sends each scan to the host and lists the outcome in words, newest first", async () => {
    const { run, calls } = makeRunner([
      { ok: true, seq: 9, roundId: "r1", debateId: "d1" },
      { ok: false, kind: "no_matching_key", errors: [] },
    ]);
    const scan = renderWith(run);
    expect(screen.getByText("Nothing scanned yet.")).toBeTruthy();

    scan(["ST1.a.b"]);
    await screen.findByText(/ballot for Room 101 received/);
    scan(["ST1F.s.1.2.9.x.y", "ST1F.s.2.2.9.x.z"]);
    await screen.findByText(/No participant link secret matched/);

    expect(calls[1]).toEqual({
      id: importQrBallotAction.id,
      args: { codes: ["ST1F.s.1.2.9.x.y", "ST1F.s.2.2.9.x.z"] },
    });
    const items = screen.getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("Not accepted");
    expect(items[1]!.textContent).toContain("Accepted");
  });

  it("explains an offline device's refusal", async () => {
    const { run } = makeRunner([
      {
        ok: false,
        kind: "offline",
        errors: ["Scanned ballots need the connection to the host, which checks them."],
      },
    ]);
    renderWith(run)(["ST1.a.b"]);
    await screen.findByText(/need the connection to the host/);
  });

  it("opens ballot entry and check-in, and hides the scanner for roles that cannot enter ballots", async () => {
    const { run, calls } = makeRunner();
    renderWith(run, false);
    expect(screen.queryByText("fake scanner")).toBeNull();
    expect(screen.getByText("This role cannot enter ballots.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Enter a ballot by hand" }));
    fireEvent.click(screen.getByRole("button", { name: "Check-in" }));
    await waitFor(() => {
      expect(calls).toEqual([
        { id: openResultsPageAction.id, args: {} },
        { id: openCheckinPageAction.id, args: {} },
      ]);
    });
  });
});
