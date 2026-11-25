import type { ProposalRecord } from "@simpletab/core/ops";
import type {
  DevicesStatus,
  HostStatus,
  ProjectedState,
} from "@simpletab/host/lib/common/host-protocol";
import { render, waitFor } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import type { ActionResult, ActionRunner } from "./action";
import { ALL_ACTION_IDS } from "./all-actions";
import { DevicesView } from "../components/devices-view";
import { ProposalsView } from "../components/proposals-view";
import { ReleasesView } from "../components/releases-view";

/**
 * M8 inventory: every button on a SimpleTab page is either an action, which is also a command
 * (`data-action="<command id>"`), or a view-only control (`data-view-only`). Pages are converted
 * in steps; the ones still to do are listed below, and the M8 checkpoint (`e2e:commands`)
 * requires the list to be empty.
 */
const PENDING_COMPONENTS: ReadonlySet<string> = new Set([
  "allocation-view.tsx",
  "assistant-view.tsx",
  "ballot-form.tsx",
  "break-view.tsx",
  "changelog-view.tsx",
  "checkin-view.tsx",
  "credentials-view.tsx",
  "csv-import-panel.tsx",
  "device-banner.tsx",
  "draw-view.tsx",
  "feedback-view.tsx",
  "join-host-panel.tsx",
  "links-view.tsx",
  "motions-view.tsx",
  "participants-view.tsx",
  "projector-control-view.tsx",
  "projector-view.tsx",
  "qr-scanner.tsx",
  "results-view.tsx",
  "setup-view.tsx",
  "standings-view.tsx",
  "status-view.tsx",
]);

const COMPONENTS_DIR = path.resolve(__dirname, "../components");

function componentsWithButtons(): string[] {
  return readdirSync(COMPONENTS_DIR)
    .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
    .filter((name) => readFileSync(path.join(COMPONENTS_DIR, name), "utf8").includes("<button"))
    .sort();
}

/** Each `<button ...>...</button>` (or self-closing) element's source text. */
function buttonElements(source: string): string[] {
  const elements: string[] = [];
  let from = source.indexOf("<button");
  while (from !== -1) {
    const close = source.indexOf("</button>", from);
    const selfClose = source.indexOf("/>", from);
    const end = close === -1 ? selfClose : selfClose === -1 ? close : Math.min(close, selfClose);
    elements.push(source.slice(from, end === -1 ? undefined : end));
    from = source.indexOf("<button", from + 1);
  }
  return elements;
}

function expectRegisteredButtons(container: HTMLElement): void {
  const buttons = Array.from(container.querySelectorAll("button"));
  const actions = buttons
    .map((button) => button.getAttribute("data-action"))
    .filter((id) => id !== null);
  expect(actions.length).toBeGreaterThan(0);
  for (const id of actions) expect(ALL_ACTION_IDS.has(id!), id!).toBe(true);
  for (const button of buttons) {
    expect(button.hasAttribute("data-action") || button.hasAttribute("data-view-only")).toBe(true);
  }
}

describe("M8 action inventory", () => {
  it("knows every component with buttons: converted, or still pending", () => {
    for (const name of PENDING_COMPONENTS) {
      expect(componentsWithButtons(), `${name} is listed as pending but has no buttons`).toContain(name);
    }
    expect(componentsWithButtons().length).toBeGreaterThan(PENDING_COMPONENTS.size);
  });

  it("marks every button of a converted component as an action or as view-only", () => {
    for (const name of componentsWithButtons()) {
      if (PENDING_COMPONENTS.has(name)) continue;
      const source = readFileSync(path.join(COMPONENTS_DIR, name), "utf8");
      for (const element of buttonElements(source)) {
        expect(
          /data-action=|data-view-only/.test(element),
          `${name}: a button is neither an action nor view-only:\n${element.slice(0, 300)}`,
        ).toBe(true);
      }
    }
  });

  it("points every rendered action button of the Proposals page at a registered command", () => {
    const state = {
      roleId: "tab_director",
      permissions: ["draw.edit"],
      proposals: [
        {
          id: "p1",
          op: { type: "release.set_gate", payload: {} },
          proposedBy: {
            ref: "device:dev-1",
            type: "ai",
            role: { id: "ai", name: "AI", permissions: [] },
            isHostOwner: false,
          },
          createdAt: "2026-11-25T09:00:00Z",
          status: "pending",
        } as unknown as ProposalRecord,
      ],
    } as unknown as ProjectedState;
    const run = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    const { container } = render(<ProposalsView state={state} run={run as unknown as ActionRunner} />);
    expectRegisteredButtons(container);
  });

  it("points every rendered action button of the Releases page at a registered command", () => {
    const state = {
      roleId: "host_owner",
      permissions: ["releases.manage", "draw.release", "motions.manage", "rounds.manage"],
      versions: {},
      tournament: { id: "t1", preferences: {} },
      rounds: [],
      breakCategories: [],
    } as unknown as ProjectedState;
    const status: HostStatus = {
      open: true,
      locks: [
        {
          lockId: "lock-1",
          opType: "draw.generate",
          actorRef: "device:host-1",
          startedAt: "2026-11-25T09:00:00Z",
        },
      ],
    };
    const run = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    const { container } = render(
      <ReleasesView state={state} status={status} run={run as unknown as ActionRunner} />,
    );
    expectRegisteredButtons(container);
  });

  it("points every rendered action button of the Devices page at a registered command", async () => {
    const devices: DevicesStatus = {
      running: true,
      addresses: [],
      codes: [
        {
          code: "12345678",
          roleId: "tab_director",
          expiresAt: "2026-11-25T10:00:00Z",
        },
      ],
      pendingJoins: [
        {
          joinId: "j1",
          deviceName: "Rafi's laptop",
          roleId: "tab_director",
          words: ["a", "b", "c", "d", "e", "f"],
          deviceFingerprint: "ab".repeat(32),
          expiresAt: "2026-11-25T10:02:00Z",
        },
      ],
      connected: [],
      devices: [
        {
          deviceId: "dev-1",
          name: "Rafi's laptop",
          roleId: "tab_director",
          roleName: "Tab director",
          approvedAt: "2026-11-25T09:00:00Z",
          connected: true,
        },
      ],
      succession: ["dev-1", "dev-2"],
      pairableRoles: [{ id: "tab_director", name: "Tab director" }],
    };
    const run = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    const { container } = render(
      <DevicesView
        open
        canManage
        pollMs={60_000}
        loadStatus={async () => devices}
        run={run as unknown as ActionRunner}
      />,
    );
    await waitFor(() => expectRegisteredButtons(container));
  });
});
