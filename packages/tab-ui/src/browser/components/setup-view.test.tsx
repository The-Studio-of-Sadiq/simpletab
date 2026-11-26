import type { HostStatus } from "@simpletab/host/lib/common/host-protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import type { ActionResult, ActionRunner } from "../actions/action";
import { restartSimpleTabAction } from "../actions/extensions-actions";
import {
  createTournamentAction,
  openTournamentAction,
} from "../actions/setup-actions";
import { t } from "../i18n";
import { SetupView } from "./setup-view";

interface RunCall {
  id: string;
  args: unknown;
}

function runnerFor(result: ActionResult): { run: ActionRunner; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run = (async (action: { id: string }, args: unknown) => {
    calls.push({ id: action.id, args });
    return action.id === restartSimpleTabAction.id ? { ok: true } : result;
  }) as unknown as ActionRunner;
  return { run, calls };
}

const refused = (): ActionResult => ({
  ok: false,
  code: "INVALID",
  errors: [t("extensions.refusedToHost")],
});

describe("SetupView extensions hosting guard", () => {
  it("warns when extensions are loaded on a laptop that becomes the host", async () => {
    const status: HostStatus = {
      open: true,
      locks: [],
      extensionsLoaded: ["Example extension"],
    };
    const { run, calls } = runnerFor({ ok: true });
    render(<SetupView state={null} status={status} run={run} />);
    expect(screen.getByText(t("extensions.hostWarning"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("extensions.restart") }));
    await waitFor(() =>
      expect(calls).toContainEqual({ id: restartSimpleTabAction.id, args: {} }),
    );
  });

  it("shows the translated refusal and a Restart button when creating is refused", async () => {
    const { run, calls } = runnerFor(refused());
    render(
      <SetupView
        state={null}
        status={{ open: false, locks: [] }}
        run={run}
      />,
    );
    fireEvent.change(screen.getByLabelText(t("setup.nameLabel")), {
      target: { value: "Example" },
    });
    fireEvent.click(screen.getByRole("button", { name: t("setup.createButton") }));
    await waitFor(() =>
      expect(calls.some((call) => call.id === createTournamentAction.id)).toBe(true),
    );
    expect(screen.getByText(t("extensions.refusedToHost"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("extensions.restart") }));
    await waitFor(() =>
      expect(calls).toContainEqual({ id: restartSimpleTabAction.id, args: {} }),
    );
  });

  it("shows the translated refusal and a Restart button when opening is refused", async () => {
    const { run, calls } = runnerFor(refused());
    render(
      <SetupView
        state={null}
        status={{ open: false, locks: [] }}
        run={run}
        onPickDbFile={async () => "/tmp/example.db"}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("setup.openExisting") }));
    await waitFor(() =>
      expect(calls.some((call) => call.id === openTournamentAction.id)).toBe(true),
    );
    expect(screen.getByText(t("extensions.refusedToHost"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("extensions.restart") }));
    await waitFor(() =>
      expect(calls).toContainEqual({ id: restartSimpleTabAction.id, args: {} }),
    );
  });
});
