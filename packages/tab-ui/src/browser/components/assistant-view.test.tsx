import type { ProjectedState, QrReceiveResult } from "@simpletab/host/lib/common/host-protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { AssistantView } from "./assistant-view";

const state = {
  debates: [{ id: "d1", venueName: "Room 101" }],
} as unknown as ProjectedState;

function renderWith(onReceiveQrBallot: (codes: string[]) => Promise<QrReceiveResult>, canScan = true) {
  let scan: (codes: string[]) => void = () => undefined;
  const onOpenResults = vi.fn();
  const onOpenCheckin = vi.fn();
  render(
    <AssistantView
      state={state}
      canScan={canScan}
      onReceiveQrBallot={onReceiveQrBallot}
      onOpenResults={onOpenResults}
      onOpenCheckin={onOpenCheckin}
      renderScanner={(onCodes) => {
        scan = onCodes;
        return <p>fake scanner</p>;
      }}
    />,
  );
  return { scan: (codes: string[]) => scan(codes), onOpenResults, onOpenCheckin };
}

describe("AssistantView", () => {
  it("sends each scan to the host and lists the outcome in words, newest first", async () => {
    const onReceive = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, seq: 9, roundId: "r1", debateId: "d1" })
      .mockResolvedValueOnce({ ok: false, kind: "no_matching_key", errors: [] });
    const view = renderWith(onReceive);
    expect(screen.getByText("Nothing scanned yet.")).toBeTruthy();

    view.scan(["ST1.a.b"]);
    await screen.findByText(/ballot for Room 101 received/);
    view.scan(["ST1F.s.1.2.9.x.y", "ST1F.s.2.2.9.x.z"]);
    await screen.findByText(/No participant link secret matched/);

    expect(onReceive).toHaveBeenNthCalledWith(2, ["ST1F.s.1.2.9.x.y", "ST1F.s.2.2.9.x.z"]);
    const items = screen.getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("Not accepted");
    expect(items[1]!.textContent).toContain("Accepted");
  });

  it("explains an offline device's refusal", async () => {
    const view = renderWith(async () => ({
      ok: false,
      kind: "offline",
      errors: ["Scanned ballots need the connection to the host, which checks them."],
    }));
    view.scan(["ST1.a.b"]);
    await screen.findByText(/need the connection to the host/);
  });

  it("opens ballot entry and check-in, and hides the scanner for roles that cannot enter ballots", async () => {
    const view = renderWith(vi.fn(), false);
    expect(screen.queryByText("fake scanner")).toBeNull();
    expect(screen.getByText("This role cannot enter ballots.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Enter a ballot by hand" }));
    fireEvent.click(screen.getByRole("button", { name: "Check-in" }));
    await waitFor(() => {
      expect(view.onOpenResults).toHaveBeenCalled();
      expect(view.onOpenCheckin).toHaveBeenCalled();
    });
  });
});
