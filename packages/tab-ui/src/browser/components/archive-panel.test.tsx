import { DEFAULT_ONLINE_SETTINGS, type ArchiveStatus } from "@simpletab/host/lib/common/host-protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import type { ActionRunner } from "../actions/action";
import {
  archiveNowAction,
  setArchiveMirrorAction,
  type ArchiveNowResult,
} from "../actions/releases-actions";
import { ArchivePanel } from "./archive-panel";

/** Turns the page's action runs back into the old callbacks, so the tests keep their assertions. */
function runnerFor(
  archive: () => Promise<ArchiveStatus>,
  setMirror: (on: boolean) => Promise<void> = async () => undefined,
): ActionRunner {
  const run = async (
    action: { id: string },
    args: unknown,
  ): Promise<ArchiveNowResult | { ok: true }> => {
    if (action.id === archiveNowAction.id) {
      const status = await archive();
      return status.state === "failed"
        ? { ok: false, errors: [status.reason ?? "failed"], status }
        : { ok: true, status };
    }
    if (action.id === setArchiveMirrorAction.id) {
      await setMirror((args as { on: boolean }).on);
      return { ok: true };
    }
    throw new Error(`Unexpected action ${action.id}`);
  };
  return run as unknown as ActionRunner;
}
import { normalizeGithubRepo } from "./credentials-view";

const CONFIGURED = {
  ...DEFAULT_ONLINE_SETTINGS,
  githubArchive: true,
  githubRepo: "debate-society/pto-archive",
};

describe("ArchivePanel", () => {
  it("says how to turn the archive on while it is off, and asks nothing of the backend", () => {
    const loadStatus = vi.fn(async (): Promise<ArchiveStatus> => ({ state: "idle" }));
    render(
      <ArchivePanel
        open
        canManage
        onlineSettings={DEFAULT_ONLINE_SETTINGS}
        loadStatus={loadStatus}
        run={runnerFor(async () => ({ state: "idle" }))}
      />,
    );
    expect(screen.getByText(/The GitHub archive is off/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(loadStatus).not.toHaveBeenCalled();
  });

  it("archives once per click and shows the commit and the archive link", async () => {
    let finish: (status: ArchiveStatus) => void = () => undefined;
    const onArchiveNow = vi.fn(
      () =>
        new Promise<ArchiveStatus>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <ArchivePanel
        open
        canManage
        onlineSettings={CONFIGURED}
        loadStatus={async () => ({ state: "idle" })}
        run={runnerFor(onArchiveNow)}
      />,
    );
    await screen.findByText("Not archived yet");
    expect(screen.getByText(/debate-society\/pto-archive/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Archive to GitHub" }));
    const running = screen.getByRole("button", { name: "Archiving…" }) as HTMLButtonElement;
    expect(running.disabled).toBe(true);
    fireEvent.click(running);
    expect(onArchiveNow).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish({
        state: "done",
        at: "2026-11-25T10:00:00.000Z",
        commitSha: "c0ffee1234567",
        unchanged: false,
        url: "https://debate-society.github.io/pto-archive/",
      });
    });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Archived"));
    expect(screen.getByRole("status").textContent).toContain("commit c0ffee1");
    expect(screen.getByRole("link", { name: "Open the archive" }).getAttribute("href")).toBe(
      "https://debate-society.github.io/pto-archive/",
    );
  });

  it("shows a failure as an alert and toggles the mirror", async () => {
    const onSetMirror = vi.fn(async () => undefined);
    render(
      <ArchivePanel
        open
        canManage
        onlineSettings={CONFIGURED}
        loadStatus={async () => ({ state: "failed", reason: "The archive repository must be public." })}
        run={runnerFor(async () => ({ state: "idle" }), onSetMirror)}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toContain("must be public");
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onSetMirror).toHaveBeenCalledWith(true);
  });
});

describe("normalizeGithubRepo", () => {
  it("accepts owner/name and github.com addresses, and clears on blank", () => {
    expect(normalizeGithubRepo(" https://github.com/Org/Repo.git ")).toBe("Org/Repo");
    expect(normalizeGithubRepo("a/b")).toBe("a/b");
    expect(normalizeGithubRepo("  ")).toBe("");
    expect(normalizeGithubRepo("a/b/c")).toBeUndefined();
    expect(normalizeGithubRepo("a/..")).toBeUndefined();
  });
});
