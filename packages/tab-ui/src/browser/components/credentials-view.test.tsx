import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import {
  CREDENTIAL_NAMES,
  type CredentialStatusEntry,
} from "@simpletab/host/lib/common/credentials-protocol";
import {
  DEFAULT_ONLINE_SETTINGS,
  type HostStatus,
  type OnlineSettings,
  type ProjectedState,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "react";
import { CredentialsView } from "./credentials-view";

function makeState(role: (typeof BUILT_IN_ROLES)[keyof typeof BUILT_IN_ROLES]): ProjectedState {
  return {
    seq: 5,
    roleId: role.id,
    permissions: role.permissions,
    versions: { "tournament:t-1": 1 },
    tournament: {
      id: "t-1",
      name: "Creds Test",
      shortName: "CT",
      slug: "creds-test",
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
    teams: [],
    adjudicators: [],
    institutions: [],
    venues: [],
    debates: [],
    motions: [],
    ballots: [],
    feedback: [],
    breakCategories: [],
  };
}

function makeStatus(onlineSettings: OnlineSettings = { ...DEFAULT_ONLINE_SETTINGS }): HostStatus {
  return {
    open: true,
    slug: "creds-test",
    headSeq: 5,
    integrityOk: true,
    canSync: true,
    locks: [],
    onlineSettings,
  };
}

function initialCredentials(): CredentialStatusEntry[] {
  return CREDENTIAL_NAMES.map((name) => ({ name, set: false }));
}

describe("CredentialsView", () => {
  it("hides credentials, online switches, and checklist for non-host-owner roles", () => {
    for (const role of [
      BUILT_IN_ROLES.tab_director,
      BUILT_IN_ROLES.tab_assistant,
      BUILT_IN_ROLES.display,
    ]) {
      const { unmount } = render(
        <CredentialsView
          state={makeState(role)}
          status={makeStatus()}
          available={true}
          credentialsStatus={initialCredentials()}
          onRefreshCredentials={vi.fn(async () => initialCredentials())}
          onSetCredential={vi.fn(async () => undefined)}
          onClearCredential={vi.fn(async () => undefined)}
          onTestCredential={vi.fn(async () => ({ ok: true }))}
          onUpdateOnlineSettings={vi.fn(async () => ({ ...DEFAULT_ONLINE_SETTINGS }))}
        />,
      );

      expect(screen.getByRole("alert").textContent).toContain("Host owner only");
      expect(screen.queryByText("Tournament key")).toBeNull();
      expect(screen.queryByText("Setup checklist")).toBeNull();
      expect(screen.queryByLabelText("Private ballot portal")).toBeNull();
      unmount();
    }
  });

  it("sends secret once without rendering it, shows set/not-set and Test results, and persists online switches", async () => {
    let creds = initialCredentials();
    let online: OnlineSettings = { ...DEFAULT_ONLINE_SETTINGS };
    const secret = "my-ultra-secret-cdn-token-value-42";

    const Harness: React.FC = () => {
      const [credState, setCredState] = React.useState(creds);
      const [statusState, setStatusState] = React.useState(() => makeStatus(online));

      return (
        <CredentialsView
          state={makeState(BUILT_IN_ROLES.host_owner)}
          status={statusState}
          available={true}
          credentialsStatus={credState}
          onRefreshCredentials={async () => credState}
          onSetCredential={async (name, _value) => {
            creds = credState.map((entry) =>
              entry.name === name ? { name, set: true } : entry,
            );
            setCredState(creds);
          }}
          onClearCredential={async (name) => {
            creds = credState.map((entry) =>
              entry.name === name ? { name, set: false } : entry,
            );
            setCredState(creds);
          }}
          onTestCredential={async (name) => {
            const ok = name === "cdnToken";
            const error = ok ? undefined : "Credential is not set.";
            creds = credState.map((entry) =>
              entry.name === name
                ? {
                    ...entry,
                    testedAt: "2026-11-24T05:00:00.000Z",
                    ok,
                    ...(error ? { error } : {}),
                  }
                : entry,
            );
            setCredState(creds);
            return ok ? { ok: true } : { ok: false, error };
          }}
          onUpdateOnlineSettings={async (patch) => {
            online = { ...online, ...patch };
            setStatusState(makeStatus(online));
            return online;
          }}
        />
      );
    };

    const { container } = render(<Harness />);

    // Initially all 5 credentials report "Not set" and all online switches default OFF
    expect(screen.getAllByText("Not set")).toHaveLength(5);
    const portalCheckbox = screen.getByLabelText(/Private ballot portal/i) as HTMLInputElement;
    const liveSiteCheckbox = screen.getByLabelText(/Live public site/i) as HTMLInputElement;
    const archiveCheckbox = screen.getByLabelText(/GitHub archive/i) as HTMLInputElement;
    const regCheckbox = screen.getByLabelText(/Online registration/i) as HTMLInputElement;
    expect(portalCheckbox.checked).toBe(false);
    expect(liveSiteCheckbox.checked).toBe(false);
    expect(archiveCheckbox.checked).toBe(false);
    expect(regCheckbox.checked).toBe(false);

    // Checklist shows 48h warning & M3 disabled note
    expect(screen.getByText(/at least 48 hours before your event/i)).toBeTruthy();
    expect(screen.getByText(/Online service arrives in M3/i)).toBeTruthy();

    // Set CDN token via masked input; secret must never appear in DOM text
    const setButtons = screen.getAllByRole("button", { name: "Set" });
    fireEvent.click(setButtons[1]!);

    const secretInput = screen.getByLabelText(
      /New secret value for CDN API token/i,
    ) as HTMLInputElement;
    expect(secretInput.type).toBe("password");
    fireEvent.change(secretInput, { target: { value: secret } });
    fireEvent.click(screen.getByRole("button", { name: "Save secret" }));

    await waitFor(() => {
      expect(screen.getAllByText("Set").length).toBeGreaterThanOrEqual(1);
    });
    expect(container.textContent).not.toContain(secret);

    // Run Test on CDN token
    const testButtons = screen.getAllByRole("button", { name: "Test" });
    fireEvent.click(testButtons[1]!);
    await waitFor(() => {
      expect(screen.getByText(/Last tested: 2026-11-24T05:00:00.000Z — Passed/)).toBeTruthy();
    });
    expect(container.textContent).not.toContain(secret);

    // Run Test on unset tournamentKey -> renders failure
    fireEvent.click(testButtons[0]!);
    await waitFor(() => {
      expect(screen.getByText(/Failed: Credential is not set\./)).toBeTruthy();
    });

    // Toggle online switches -> persists
    fireEvent.click(portalCheckbox);
    await waitFor(() => {
      expect(portalCheckbox.checked).toBe(true);
    });
    fireEvent.change(screen.getByLabelText("Ballot collection"), {
      target: { value: "qr_only" },
    });
    await waitFor(() => {
      expect((screen.getByLabelText("Ballot collection") as HTMLSelectElement).value).toBe(
        "qr_only",
      );
    });
  });

  it("renders approval pending timestamp in setup checklist when keyRequestedAt is set", () => {
    render(
      <CredentialsView
        state={makeState(BUILT_IN_ROLES.host_owner)}
        status={makeStatus({
          ...DEFAULT_ONLINE_SETTINGS,
          keyRequestedAt: "2026-11-20T10:00:00.000Z",
        })}
        available={true}
        credentialsStatus={initialCredentials()}
        onRefreshCredentials={vi.fn(async () => initialCredentials())}
        onSetCredential={vi.fn(async () => undefined)}
        onClearCredential={vi.fn(async () => undefined)}
        onTestCredential={vi.fn(async () => ({ ok: true }))}
        onUpdateOnlineSettings={vi.fn(async () => ({ ...DEFAULT_ONLINE_SETTINGS }))}
      />,
    );

    expect(
      screen.getByText("Approval pending since 2026-11-20T10:00:00.000Z"),
    ).toBeTruthy();
  });

  it("saves valid public site host name and rejects URLs with protocol or path", async () => {
    const updateOnlineSettings = vi.fn(async (patch: Partial<OnlineSettings>) => ({
      ...DEFAULT_ONLINE_SETTINGS,
      ...patch,
    }));

    render(
      <CredentialsView
        state={makeState(BUILT_IN_ROLES.host_owner)}
        status={makeStatus({ ...DEFAULT_ONLINE_SETTINGS })}
        available={true}
        credentialsStatus={initialCredentials()}
        onRefreshCredentials={vi.fn(async () => initialCredentials())}
        onSetCredential={vi.fn(async () => undefined)}
        onClearCredential={vi.fn(async () => undefined)}
        onTestCredential={vi.fn(async () => ({ ok: true }))}
        onUpdateOnlineSettings={updateOnlineSettings}
      />,
    );

    const cdnInput = screen.getByLabelText("Public site host name") as HTMLInputElement;
    fireEvent.change(cdnInput, { target: { value: "https://bad.example/path" } });
    fireEvent.click(screen.getByRole("button", { name: "Save host name" }));

    await waitFor(() => {
      expect(screen.getByText(/Enter a valid bare hostname/i)).toBeTruthy();
    });
    expect(updateOnlineSettings).not.toHaveBeenCalled();

    fireEvent.change(cdnInput, { target: { value: "wudc2027.pages.dev" } });
    fireEvent.click(screen.getByRole("button", { name: "Save host name" }));

    await waitFor(() => {
      expect(updateOnlineSettings).toHaveBeenCalledWith({
        cdnHost: "wudc2027.pages.dev",
      });
    });
  });
});
