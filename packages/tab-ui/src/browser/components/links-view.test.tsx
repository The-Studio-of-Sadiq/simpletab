import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import {
  DEFAULT_ONLINE_SETTINGS,
  type HostStatus,
  type ProjectedState,
  type SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "react";
import { LinksView } from "./links-view";

function makeLinksState(
  role = BUILT_IN_ROLES.host_owner,
  withLinks: ProjectedState["links"] = [],
): ProjectedState {
  return {
    seq: 8,
    roleId: role.id,
    permissions: role.permissions,
    versions: {},
    tournament: {
      id: "t-1",
      name: "Links Test",
      shortName: "LT",
      slug: "links-test",
      format: "bp",
      active: true,
      ownerId: "host-owner",
      admins: { "host-owner": true },
      preferences: {
        teamsInDebate: 4,
        substantiveSpeakers: 2,
        replyScoresEnabled: false,
        minSpeakerScore: 50,
        maxSpeakerScore: 100,
        stepSpeakerScore: 1,
        minReplyScore: 25,
        maxReplyScore: 50,
        drawRule: "power_paired",
        sideAllocationRule: "balanced",
        ballotDoubleEntry: false,
        publicDraw: true,
        publicResults: true,
        publicStandings: true,
        publicMotions: true,
        feedbackEnabled: false,
        feedbackMinScore: 1,
        feedbackMaxScore: 5,
      },
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
    rounds: [],
    teams: [
      {
        id: "team-1",
        tournamentId: "t-1",
        name: "Oxford A",
        shortName: "OXF A",
        institutionId: "inst-1",
        institutionName: "Oxford",
        isSwing: false,
        breakCategories: [],
        speakerCategories: [],
        checkedIn: true,
        speakers: [
          { id: "spk-1", name: "Alice Smith" },
          { id: "spk-2", name: "Bob Jones" },
        ],
      },
    ],
    adjudicators: [
      {
        id: "adj-1",
        tournamentId: "t-1",
        name: "Judge Carol",
        institutionName: "Cambridge",
        baseScore: 8,
        trainee: false,
        independent: true,
        checkedIn: true,
        conflicts: [],
      },
    ],
    institutions: [],
    venues: [],
    debates: [],
    motions: [],
    ballots: [],
    feedback: [],
    breakCategories: [],
    links: withLinks,
  };
}

function makeStatus(cdnHost?: string): HostStatus {
  return {
    open: true,
    slug: "links-test",
    headSeq: 8,
    integrityOk: true,
    canSync: true,
    locks: [],
    onlineSettings: {
      ...DEFAULT_ONLINE_SETTINGS,
      ...(cdnHost !== undefined ? { cdnHost } : {}),
    },
  };
}

describe("LinksView", () => {
  it("restricts access when user lacks links.manage permission", () => {
    render(
      <LinksView
        state={makeLinksState(BUILT_IN_ROLES.tab_assistant)}
        status={makeStatus("wudc2027.pages.dev")}
        onSubmitOp={vi.fn(async () => ({ ok: true as const, seq: 9, writes: [], committedPayload: null }))}
        onOpenSetup={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("links.manage");
    expect(screen.queryByRole("button", { name: "Generate private links" })).toBeNull();
  });

  it("warns and disables link generation when cdnHost is not configured", () => {
    const openCredentials = vi.fn();
    render(
      <LinksView
        state={makeLinksState()}
        status={makeStatus(undefined)}
        onSubmitOp={vi.fn(async () => ({ ok: true as const, seq: 9, writes: [], committedPayload: null }))}
        onOpenSetup={vi.fn()}
        onOpenCredentials={openCredentials}
      />,
    );

    expect(
      screen.getByText(/Set a Public site host name in Credentials/i),
    ).toBeTruthy();
    const generateBtn = screen.getByRole("button", {
      name: "Generate private links",
    }) as HTMLButtonElement;
    expect(generateBtn.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Open Credentials settings" }));
    expect(openCredentials).toHaveBeenCalledTimes(1);
  });

  it("generates private_urls.regenerate links for all participants and renders printable QR slips", async () => {
    let submittedPayload: {
      scope: string;
      force: boolean;
      links: Array<{ lookupId: string; entityId: string; secret: string }>;
    } | null = null;

    const Harness: React.FC = () => {
      const [state, setState] = React.useState(() => makeLinksState());
      const handleSubmit = async (op: { type: string; payload: unknown }): Promise<SubmitResult> => {
        if (op.type === "private_urls.regenerate") {
          const payload = op.payload as NonNullable<typeof submittedPayload>;
          submittedPayload = payload;
          setState((prev) => ({
            ...prev,
            links: payload.links,
          }));
        }
        return { ok: true, seq: 9, writes: [], committedPayload: null };
      };
      return (
        <LinksView
          state={state}
          status={makeStatus("wudc2027.pages.dev")}
          onSubmitOp={handleSubmit}
          onOpenSetup={vi.fn()}
        />
      );
    };

    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Generate private links" }));

    await waitFor(() => {
      expect(screen.getByText("Generated 4 private link(s).")).toBeTruthy();
    });

    expect(submittedPayload).not.toBeNull();
    expect(submittedPayload!.force).toBe(false);
    expect(submittedPayload!.scope).toBe("all");
    expect(submittedPayload!.links).toHaveLength(4);
    const bodyRows = Array.from(container.querySelectorAll("tbody tr"));
    expect(bodyRows).toHaveLength(4);
    const participantNames = bodyRows.map((row) => row.querySelector("td")?.textContent);
    expect(participantNames).toEqual([
      "Judge Carol",
      "Oxford A",
      "Alice Smith",
      "Bob Jones",
    ]);
    expect(screen.getByText(/https:\/\/ballots\.simpletab\.app\/t\/links-test#wudc2027\.pages\.dev~a/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Printable QR slips" }));
    expect(container.querySelectorAll("svg.simpletab-qr-svg")).toHaveLength(4);
    expect(container.querySelectorAll("svg.simpletab-qr-svg path").length).toBeGreaterThanOrEqual(4);
  });
});
