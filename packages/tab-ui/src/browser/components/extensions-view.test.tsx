import type { ExtensionsLoadingReason, ExtensionsStatus } from "@simpletab/extensions/lib/common/extensions-protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import type { ActionResult, ActionRunner } from "../actions/action";
import {
  installExtensionAction,
  installExtensionFromFileAction,
  removeExtensionAction,
  restartSimpleTabAction,
  setExtensionOnAction,
} from "../actions/extensions-actions";
import { fakeExtensionEntry, fakeExtensionsStatus } from "../actions/test-context";
import { t } from "../i18n";
import { ExtensionsView } from "./extensions-view";

interface RunCall {
  id: string;
  args: unknown;
}

function recordingRunner(
  result: ActionResult = { ok: true },
  calls: RunCall[] = [],
): { run: ActionRunner; calls: RunCall[] } {
  const run = (async (action: { id: string }, args: unknown) => {
    calls.push({ id: action.id, args });
    return result;
  }) as unknown as ActionRunner;
  return { run, calls };
}

function statusFor(reason: ExtensionsLoadingReason, overrides: Partial<ExtensionsStatus> = {}): ExtensionsStatus {
  return fakeExtensionsStatus({ reason, ...overrides });
}

describe("ExtensionsView", () => {
  it("explains each loading rule, with a plain-language warning in developer mode", () => {
    const cases: Array<[ExtensionsLoadingReason, string]> = [
      ["may-host", t("extensions.reasonMayHost")],
      ["staff-device", t("extensions.reasonStaffDevice")],
      ["developer-mode", t("extensions.reasonDeveloperMode")],
    ];
    for (const [reason, text] of cases) {
      const { unmount } = render(
        <ExtensionsView status={statusFor(reason)} available run={recordingRunner().run} />,
      );
      expect(screen.getByText(text)).toBeTruthy();
      if (reason === "developer-mode") {
        expect(screen.getByText(t("extensions.developerWarning"))).toBeTruthy();
      } else {
        expect(screen.queryByText(t("extensions.developerWarning"))).toBeNull();
      }
      unmount();
    }
  });

  it("shows the exact restart notice and runs the restart command", async () => {
    const { run, calls } = recordingRunner();
    render(
      <ExtensionsView
        status={statusFor("staff-device", { restartNeeded: true })}
        available
        run={run}
      />,
    );
    expect(screen.getByText(t("extensions.restartNeeded"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("extensions.restart") }));
    await waitFor(() => expect(calls).toEqual([{ id: restartSimpleTabAction.id, args: {} }]));
  });

  it("shows every entry's details and state, with only the buttons that apply", async () => {
    const notInstalled = fakeExtensionEntry({
      id: "pub.not-installed@1",
      name: "Absent extension",
      version: "1.2.3",
      license: "MIT",
      purpose: "Not installed purpose",
      installed: false,
    });
    const installedOn = fakeExtensionEntry({
      id: "pub.on@1",
      name: "On extension",
      version: "2.0.0",
      license: "Apache-2.0",
      purpose: "On purpose",
      installed: true,
      on: true,
      loaded: false,
    });
    const installedOff = fakeExtensionEntry({
      id: "pub.off@1",
      name: "Off extension",
      version: "3.0.0",
      license: "BSD-3-Clause",
      purpose: "Off purpose",
      installed: true,
      on: false,
      loaded: false,
    });
    const loaded = fakeExtensionEntry({
      id: "pub.loaded@1",
      name: "Loaded extension",
      version: "4.0.0",
      license: "ISC",
      purpose: "Loaded purpose",
      installed: true,
      on: true,
      loaded: true,
    });
    const { run, calls } = recordingRunner();
    const { container } = render(
      <ExtensionsView
        status={fakeExtensionsStatus({ extensions: [notInstalled, installedOn, installedOff, loaded] })}
        available
        run={run}
      />,
    );

    for (const entry of [notInstalled, installedOn, installedOff, loaded]) {
      for (const value of [entry.name, entry.version, entry.license, entry.purpose]) {
        expect(screen.getAllByText(value).length).toBeGreaterThan(0);
      }
    }
    expect(screen.getByText(t("extensions.stateNotInstalled"))).toBeTruthy();
    expect(screen.getByText(t("extensions.stateInstalledOn"))).toBeTruthy();
    expect(screen.getByText(t("extensions.stateInstalledOff"))).toBeTruthy();
    expect(screen.getByText(t("extensions.stateLoadedNow"))).toBeTruthy();
    expect(screen.getAllByRole("button", { name: t("extensions.install") })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: t("extensions.turnOff") })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: t("extensions.turnOn") })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: t("extensions.remove") })).toHaveLength(3);
    expect(container.querySelectorAll("button[data-view-only]")).toHaveLength(0);

    fireEvent.click(screen.getAllByRole("button", { name: t("extensions.install") })[0]!);
    await waitFor(() =>
      expect(calls).toContainEqual({ id: installExtensionAction.id, args: { id: notInstalled.id } }),
    );
    fireEvent.click(screen.getAllByRole("button", { name: t("extensions.turnOn") })[0]!);
    await waitFor(() =>
      expect(calls).toContainEqual({
        id: setExtensionOnAction.id,
        args: { id: installedOff.id, on: true },
      }),
    );
    fireEvent.click(screen.getAllByRole("button", { name: t("extensions.turnOff") })[0]!);
    await waitFor(() =>
      expect(calls).toContainEqual({
        id: setExtensionOnAction.id,
        args: { id: installedOn.id, on: false },
      }),
    );
    fireEvent.click(screen.getAllByRole("button", { name: t("extensions.remove") })[0]!);
    await waitFor(() =>
      expect(calls).toContainEqual({ id: removeExtensionAction.id, args: { id: installedOn.id } }),
    );
  });

  it("names ignored files and why they were ignored", () => {
    render(
      <ExtensionsView
        status={fakeExtensionsStatus({
          ignoredFiles: [
            { file: "stray.vsix", reason: "not-listed" },
            { file: "changed.vsix", reason: "hash-mismatch" },
          ],
        })}
        available
        run={recordingRunner().run}
      />,
    );
    expect(screen.getByText(`${"stray.vsix"}: ${t("extensions.ignoredNotListed")}`)).toBeTruthy();
    expect(
      screen.getByText(`${"changed.vsix"}: ${t("extensions.ignoredHashMismatch")}`),
    ).toBeTruthy();
  });

  it("picks a VSIX file and runs the install-from-file command with its path", async () => {
    const { run, calls } = recordingRunner();
    const onPickVsix = vi.fn(async () => "/tmp/chosen.vsix");
    render(
      <ExtensionsView
        status={fakeExtensionsStatus()}
        available
        onPickVsix={onPickVsix}
        run={run}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("extensions.installFromFile") }));
    await waitFor(() => expect(onPickVsix).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(calls).toEqual([
        { id: installExtensionFromFileAction.id, args: { path: "/tmp/chosen.vsix" } },
      ]),
    );
  });

  it("does not run anything when the file dialog is unavailable or cancelled", async () => {
    const { run, calls } = recordingRunner();
    const { unmount } = render(
      <ExtensionsView status={fakeExtensionsStatus()} available run={run} />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("extensions.installFromFile") }));
    expect(screen.getByRole("alert").textContent).toContain(t("extensions.fileDialogUnavailable"));
    expect(calls).toEqual([]);
    unmount();

    const cancelled = recordingRunner();
    render(
      <ExtensionsView
        status={fakeExtensionsStatus()}
        available
        onPickVsix={async () => undefined}
        run={cancelled.run}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("extensions.installFromFile") }));
    await waitFor(() => expect(cancelled.calls).toEqual([]));
  });

  it("shows a service failure inline and disables action buttons while busy", async () => {
    let release: ((result: ActionResult) => void) | undefined;
    const calls: RunCall[] = [];
    const busyRun = (async (action: { id: string }, args: unknown) => {
      calls.push({ id: action.id, args });
      return new Promise<ActionResult>((resolve) => {
        release = resolve;
      });
    }) as unknown as ActionRunner;
    const { unmount } = render(
      <ExtensionsView
        status={fakeExtensionsStatus({
          extensions: [fakeExtensionEntry({ installed: true })],
        })}
        available
        run={busyRun}
      />,
    );
    const installButton = screen.getAllByRole("button", { name: t("extensions.turnOff") })[0]!;
    fireEvent.click(installButton);
    await waitFor(() => expect(screen.getByText(t("extensions.working"))).toBeTruthy());
    expect((installButton as HTMLButtonElement).disabled).toBe(true);
    release?.({ ok: false, errors: ["Refused."] });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Refused."));
    unmount();

    const { run } = recordingRunner({
      ok: false,
      errors: ["Hash mismatch."],
    } as ActionResult);
    render(
      <ExtensionsView
        status={fakeExtensionsStatus()}
        available
        onPickVsix={async () => "/tmp/hash.vsix"}
        run={run}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("extensions.installFromFile") }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Hash mismatch."),
    );
  });

  it("warns when the extensions service is not available", () => {
    render(<ExtensionsView status={fakeExtensionsStatus()} available={false} run={recordingRunner().run} />);
    expect(screen.getByRole("alert").textContent).toContain(t("extensions.unavailable"));
  });
});
