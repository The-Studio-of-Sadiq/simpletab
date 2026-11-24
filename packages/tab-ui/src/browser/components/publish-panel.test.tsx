import { DEFAULT_ONLINE_SETTINGS, type PublishStatus } from "@simpletab/host/lib/common/host-protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { PublishPanel } from "./publish-panel";

const CONFIGURED = {
  ...DEFAULT_ONLINE_SETTINGS,
  livePublicSite: false,
  cdnHost: "wudc2027.pages.dev",
  cloudflareAccountId: "0123456789abcdef0123456789abcdef",
  pagesProject: "wudc2027",
};

describe("PublishPanel", () => {
  it("publishes once per click, disables the button while running and shows the result", async () => {
    let finish: (status: PublishStatus) => void = () => undefined;
    const onPublishNow = vi.fn(
      () =>
        new Promise<PublishStatus>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <PublishPanel
        open
        canManage
        onlineSettings={CONFIGURED}
        loadStatus={async () => ({ state: "idle" })}
        onPublishNow={onPublishNow}
        onSetLive={async () => undefined}
      />,
    );
    await screen.findByText("Not published yet");

    const button = screen.getByRole("button", { name: "Publish now" });
    fireEvent.click(button);
    const running = screen.getByRole("button", { name: "Publishing…" }) as HTMLButtonElement;
    expect(running.disabled).toBe(true);
    fireEvent.click(running);
    expect(onPublishNow).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish({ state: "done", at: "2026-11-24T10:00:00.000Z", url: "https://wudc2027.pages.dev/" });
    });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Published"));
    expect((screen.getByRole("button", { name: "Publish now" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("link", { name: "Open wudc2027.pages.dev" }).getAttribute("href")).toBe(
      "https://wudc2027.pages.dev/",
    );
  });

  it("shows a failure in words, with the next retry, as an alert", async () => {
    render(
      <PublishPanel
        open
        canManage
        onlineSettings={{ ...CONFIGURED, livePublicSite: true }}
        loadStatus={async () => ({
          state: "failed",
          at: "2026-11-24T10:00:00.000Z",
          reason: "Cloudflare rejected the upload.",
          nextRetryAt: "2026-11-24T10:01:00.000Z",
        })}
        onPublishNow={async () => ({ state: "idle" })}
        onSetLive={async () => undefined}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Cloudflare rejected the upload.");
    expect(alert.textContent).toContain("Next automatic try");
    expect(screen.getByText("Publish failed", { exact: false })).toBeTruthy();
  });

  it("toggles the live site and stays read-only without permission", async () => {
    const onSetLive = vi.fn(async () => undefined);
    const { rerender } = render(
      <PublishPanel
        open
        canManage
        onlineSettings={CONFIGURED}
        loadStatus={async () => ({ state: "idle" })}
        onPublishNow={async () => ({ state: "idle" })}
        onSetLive={onSetLive}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(onSetLive).toHaveBeenCalledWith(true));

    rerender(
      <PublishPanel
        open
        canManage={false}
        onlineSettings={CONFIGURED}
        loadStatus={async () => ({ state: "idle" })}
        onPublishNow={async () => ({ state: "idle" })}
        onSetLive={onSetLive}
      />,
    );
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Publish now" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
