import type { PublicChainItem } from "@simpletab/core/changelog";
import type { ProposalRecord } from "@simpletab/core/ops";
import {
  DEFAULT_ONLINE_SETTINGS,
  type DevicesStatus,
  type HostStatus,
  type ProjectedState,
} from "@simpletab/host/lib/common/host-protocol";
import { DEFAULT_PROJECTOR_CONTROL } from "@simpletab/host/lib/common/projector-protocol";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import type { ActionResult, ActionRunner } from "./action";
import { ALL_ACTION_IDS } from "./all-actions";
import { t } from "../i18n";
import { NAVIGATION_ACTIONS } from "./navigation-actions";
import { runnerFor } from "./test-context";
import { AllocationView } from "../components/allocation-view";
import { AssistantView } from "../components/assistant-view";
import { BreakView } from "../components/break-view";
import { ChangelogView } from "../components/changelog-view";
import { CheckinView } from "../components/checkin-view";
import { CredentialsView } from "../components/credentials-view";
import { CsvImportPanel } from "../components/csv-import-panel";
import { DeviceBanner } from "../components/device-banner";
import { DevicesView } from "../components/devices-view";
import { DrawView } from "../components/draw-view";
import { FeedbackView } from "../components/feedback-view";
import { JoinHostPanel } from "../components/join-host-panel";
import { LinksView } from "../components/links-view";
import { MotionsView } from "../components/motions-view";
import { ParticipantsView } from "../components/participants-view";
import { ProjectorControlView } from "../components/projector-control-view";
import { ProjectorView } from "../components/projector-view";
import { ProposalsView } from "../components/proposals-view";
import { QrScanner } from "../components/qr-scanner";
import { ReleasesView } from "../components/releases-view";
import { ResultsView } from "../components/results-view";
import { SetupView } from "../components/setup-view";
import { StandingsView } from "../components/standings-view";
import { StatusView } from "../components/status-view";

/**
 * M8 inventory: every button on a SimpleTab page is either an action, which is also a command
 * (`data-action="<command id>"`), or a view-only control (`data-view-only`). Pages are converted
 * in steps; the ones still to do are listed below, and the M8 checkpoint (`e2e:commands`)
 * requires the list to be empty.
 */
const PENDING_COMPONENTS: ReadonlySet<string> = new Set();

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

function expectTaggedButtons(
  container: HTMLElement,
  requireAction = true,
  name = "component",
): void {
  const buttons = Array.from(container.querySelectorAll("button"));
  const actions = buttons
    .map((button) => button.getAttribute("data-action"))
    .filter((id) => id !== null);
  if (requireAction) {
    expect(actions.length, `${name}: no action button rendered`).toBeGreaterThan(0);
  }
  for (const id of actions) expect(ALL_ACTION_IDS.has(id!), id!).toBe(true);
  for (const button of buttons) {
    expect(
      button.hasAttribute("data-action") || button.hasAttribute("data-view-only"),
      `${name}: a button is neither an action nor view-only`,
    ).toBe(true);
  }
}

function expectRegisteredButtons(container: HTMLElement): void {
  expectTaggedButtons(container);
}

/** Minimal state that renders action buttons on the converted pages. */
function inventoryState(): ProjectedState {
  return {
    seq: 1,
    roleId: "host_owner",
    permissions: [
      "draw.generate",
      "draw.release",
      "allocation.edit",
      "checkins.edit",
      "motions.manage",
      "rounds.manage",
    ],
    versions: {},
    tournament: {
      id: "t1",
      format: "bp",
      simpletab: { timeZone: "UTC" },
      preferences: { substantiveSpeakers: 2, teamsInDebate: 4 },
    },
    rounds: [
      {
        id: "r1",
        seq: 1,
        name: "Round 1",
        stage: "preliminary",
        drawStatus: "draft",
      },
    ],
    teams: [{ id: "t1", name: "Team One", speakers: [], checkedIn: true }],
    adjudicators: [{ id: "a1", name: "Judge One" }],
    venues: [{ id: "v1", name: "Room One" }],
    debates: [],
    motions: [],
    ballots: [],
    feedback: [],
    institutions: [],
    breakCategories: [],
  } as unknown as ProjectedState;
}

function inventoryRunner(state: ProjectedState): ActionRunner {
  return runnerFor({
    state,
    submit: async () => ({ ok: true, seq: 2, writes: [], committedPayload: null }),
  });
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

  it("points every rendered action button of the Draw page at a registered command", () => {
    const state = inventoryState();
    const status: HostStatus = { open: true, locks: [] };
    const run = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    const { container } = render(
      <DrawView state={state} status={status} run={run as unknown as ActionRunner} />,
    );
    expectRegisteredButtons(container);
  });

  it("points every rendered action button of the Allocation page at a registered command", () => {
    const state = inventoryState();
    const status: HostStatus = { open: true, locks: [] };
    const run = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    const { container } = render(
      <AllocationView state={state} status={status} run={run as unknown as ActionRunner} />,
    );
    expectRegisteredButtons(container);
  });

  it("points every rendered action button of the Check-in page at a registered command", () => {
    const state = inventoryState();
    const status: HostStatus = { open: true, locks: [] };
    const run = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    const { container } = render(
      <CheckinView state={state} status={status} run={run as unknown as ActionRunner} />,
    );
    expectRegisteredButtons(container);
  });

  it("points every rendered action button of the Motions page at a registered command", () => {
    const state = inventoryState();
    const status: HostStatus = { open: true, locks: [] };
    const run = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    const { container } = render(
      <MotionsView state={state} status={status} run={run as unknown as ActionRunner} />,
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

  it("points every rendered action button of the Results page at a registered command", () => {
    const state = inventoryState();
    const { container } = render(
      <ResultsView state={state} status={{ open: true, locks: [] }} run={inventoryRunner(state)} />,
    );
    expectRegisteredButtons(container);
  });

  it("points every rendered action button of the Feedback page at a registered command", () => {
    const base = inventoryState();
    const state = {
      ...base,
      permissions: [...(base.permissions ?? []), "feedback.view", "feedback.enter"],
      rounds: [
        {
          ...base.rounds[0],
          stage: "preliminary",
          drawStatus: "released",
          motionsReleased: true,
        },
      ],
      debates: [
        {
          id: "d1",
          tournamentId: base.tournament.id,
          roundId: "r1",
          roundSeq: 1,
          bracket: 0,
          roomRank: 1,
          importance: 10,
          resultStatus: "none",
          sidesConfirmed: true,
          flags: [],
          teams: {
            OG: { teamId: "t1", teamName: "Team One", side: "OG" },
          },
          adjudicators: {
            chairId: "a1",
            chairName: "Judge One",
            panellistIds: [],
            panellistNames: [],
            traineeIds: [],
            traineeNames: [],
          },
        },
      ],
      feedback: [
        {
          id: "fb-1",
          tournamentId: base.tournament.id,
          roundId: "r1",
          debateId: "d1",
          sourceType: "team",
          sourceId: "t1",
          sourceName: "Team One",
          targetType: "adjudicator",
          targetAdjudicatorId: "a1",
          targetAdjudicatorName: "Judge One",
          score: 5,
          confirmed: false,
          timestamp: "2026-11-25T09:00:00.000Z",
        },
      ],
      tournament: {
        ...base.tournament,
        preferences: {
          ...base.tournament.preferences,
          feedbackEnabled: true,
          feedbackMinScore: 1,
          feedbackMaxScore: 5,
          feedbackPath: "two_way",
          feedbackQuestions: [],
        },
      },
    } as unknown as ProjectedState;
    const { container } = render(
      <FeedbackView state={state} status={{ open: true, locks: [] }} run={inventoryRunner(state)} />,
    );
    expectRegisteredButtons(container);
  });

  it("points every rendered action button of the Break page at a registered command", () => {
    const base = inventoryState();
    const state = {
      ...base,
      permissions: [...(base.permissions ?? []), "break.manage"],
      versions: {
        "breakCategory:bc-open": 1,
        "round:ef1": 1,
      },
      breakCategories: [
        {
          id: "bc-open",
          tournamentId: base.tournament.id,
          name: "Open",
          slug: "open",
          seq: 1,
          breakSize: 4,
          reserveSize: 0,
          priority: 1,
          isGeneral: true,
        },
      ],
      rounds: [
        ...base.rounds,
        {
          id: "ef1",
          tournamentId: base.tournament.id,
          seq: 2,
          name: "Final",
          stage: "elimination",
          drawStatus: "none",
          breakCategoryIds: ["bc-open"],
        },
      ],
    } as unknown as ProjectedState;
    const { container } = render(
      <BreakView
        state={state}
        status={{ open: true, locks: [] }}
        run={inventoryRunner(state)}
        nowIso="2026-11-25T09:00:00.000Z"
      />,
    );
    expectRegisteredButtons(container);
  });

  it("points every rendered action button of the Changelog page at a registered command", async () => {
    const state = inventoryState();
    const chain = [
      {
        entry: {
          seq: 1,
          ts: "2026-11-25T09:00:00.000Z",
          actorType: "human",
          actorRef: "host-owner",
          opType: "tournament.create",
          category: "setup",
          summary: "Created the tournament",
          visibility: "private",
          payload: {},
        },
        entryHash: "hash-1",
      },
    ] as unknown as PublicChainItem[];
    const { container } = render(
      <ChangelogView
        state={state}
        status={{ open: true, locks: [] }}
        onGetChangelog={async () => chain}
        onGetOpUndoInfo={async () => []}
        run={inventoryRunner(state)}
      />,
    );
    await waitFor(() => expectRegisteredButtons(container));
  });

  it("points every rendered action button of the Standings page at a registered command", () => {
    const state = inventoryState();
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
    const { container } = render(
      <StandingsView state={state} status={status} run={inventoryRunner(state)} />,
    );
    expectRegisteredButtons(container);
  });

  it("points every rendered action button of the Participants page at a registered command", () => {
    const state = inventoryState();
    const { container } = render(
      <ParticipantsView state={state} run={inventoryRunner(state)} />,
    );
    expectRegisteredButtons(container);
  });

  it("points every rendered action button of the CSV import panel at a registered command", () => {
    const state = inventoryState();
    const { container } = render(
      <CsvImportPanel kind="teams" state={state} run={inventoryRunner(state)} />,
    );
    fireEvent.change(container.querySelector("textarea")!, {
      target: { value: "name,speaker1\nExample Team,Alice" },
    });
    expectRegisteredButtons(container);
  });

  it("points every rendered action button of the Links page at a registered command", () => {
    const base = inventoryState();
    const state = {
      ...base,
      permissions: [...(base.permissions ?? []), "links.manage"],
    } as unknown as ProjectedState;
    const status: HostStatus = {
      open: true,
      locks: [],
      onlineSettings: { ...DEFAULT_ONLINE_SETTINGS, cdnHost: "example.pages.dev" },
    };
    const { container } = render(
      <LinksView state={state} status={status} run={inventoryRunner(state)} />,
    );
    expectRegisteredButtons(container);
  });

  it("points every rendered action button of the Setup page at a registered command", () => {
    const status: HostStatus = { open: false, locks: [] };
    const run = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    const { container } = render(
      <SetupView state={null} status={status} run={run as unknown as ActionRunner} />,
    );
    expectRegisteredButtons(container);
  });

  it("points every rendered action button of the converted pages at a registered command", () => {
    const run = vi.fn(async (): Promise<ActionResult> => ({ ok: true })) as unknown as ActionRunner;
    const state = {
      ...inventoryState(),
      permissions: [...(inventoryState().permissions ?? []), "credentials.manage"],
    } as unknown as ProjectedState;
    const status: HostStatus = { open: true, locks: [] };

    const cases: Array<{
      name: string;
      element: React.ReactElement;
      requireAction?: boolean;
    }> = [
      {
        name: "assistant",
        element: <AssistantView state={state} canScan run={run} renderScanner={() => null} />,
      },
      {
        name: "credentials",
        element: (
          <CredentialsView
            state={state}
            status={status}
            available
            credentialsStatus={[]}
            run={run}
          />
        ),
      },
      {
        name: "device banner",
        element: (
          <DeviceBanner
            device={{
              connection: "connected",
              deviceId: "dev-1",
              hostAddress: "127.0.0.1:47820",
              deviceName: "Test laptop",
              roleId: "tab_director",
              roleName: "Tab director",
              queued: [],
              rejected: [],
              presence: [],
            }}
            run={run}
            confirmLeave={() => true}
          />
        ),
      },
      {
        name: "join host",
        element: <JoinHostPanel run={run} loadProgress={async () => ({ state: "idle" })} />,
      },
      {
        name: "projector control",
        element: (
          <ProjectorControlView
            state={state}
            available
            control={DEFAULT_PROJECTOR_CONTROL}
            run={run}
          />
        ),
      },
      {
        name: "projector",
        element: <ProjectorView displayState={null} control={DEFAULT_PROJECTOR_CONTROL} />,
        requireAction: false,
      },
      {
        name: "QR scanner",
        requireAction: false,
        element: (
          <QrScanner
            onCodes={() => undefined}
            labels={{
              start: t("assistant.start"),
              stop: t("assistant.stop"),
              starting: t("assistant.starting"),
              scanning: t("assistant.scanning"),
              partial: (have, of) => t("assistant.partial", { have, of }),
              cameraDenied: t("assistant.cameraDenied"),
              noCamera: t("assistant.noCamera"),
              cameraFailed: t("assistant.cameraFailed"),
              videoLabel: t("assistant.videoLabel"),
            }}
          />
        ),
      },
      {
        name: "status",
        element: (
          <StatusView
            status={status}
            state={state}
            loading={false}
            error={null}
            onRefresh={async () => null}
            run={run}
            canPullNow
          />
        ),
      },
    ];

    for (const { name, element, requireAction = true } of cases) {
      const { container, unmount } = render(element);
      expectTaggedButtons(container, requireAction, name);
      unmount();
    }
  });

  it("registers every navigation button command as an action", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../views/simpletab-nav-widget.tsx"),
      "utf8",
    );
    const commands = Array.from(
      source.matchAll(/export const (SIMPLETAB_OPEN_\w+_COMMAND) =\s*"([^"]+)"/g),
    );
    expect(commands).toHaveLength(NAVIGATION_ACTIONS.length);
    for (const [, constant, id] of commands) {
      expect(ALL_ACTION_IDS.has(id!), id!).toBe(true);
      expect(source, `${constant} must have data-action`).toContain(
        `data-action={${constant}}`,
      );
    }
  });
});
