import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { OpRequest } from "@simpletab/core/ops";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import type {
  HostStatus,
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "react";
import { directRunner, fakeStore } from "../actions/test-context";
import { ReleasesView } from "./releases-view";

const EMPTY_STATUS: HostStatus = {
  open: true,
  slug: "releases-test",
  headSeq: 8,
  integrityOk: true,
  canSync: true,
  locks: [],
};

function makeReleasesState(): ProjectedState {
  return {
    seq: 8,
    roleId: "host_owner",
    permissions: BUILT_IN_ROLES.host_owner.permissions,
    versions: {
      "tournament:t-1": 2,
      "round:r1": 1,
      "breakCategory:bc-open": 1,
    },
    tournament: {
      id: "t-1",
      name: "Releases Test",
      shortName: "RT",
      slug: "releases-test",
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
    rounds: [
      {
        id: "r1",
        tournamentId: "t-1",
        seq: 1,
        name: "Round 1",
        abbreviation: "R1",
        stage: "preliminary",
        drawType: "random",
        drawStatus: "draft",
        feedbackWeight: 1,
        silent: false,
        motionsReleased: false,
        resultsReleased: false,
        completed: false,
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ],
    teams: [],
    adjudicators: [],
    institutions: [],
    venues: [],
    debates: [],
    motions: [],
    ballots: [],
    feedback: [],
    breakCategories: [
      {
        id: "bc-open",
        tournamentId: "t-1",
        name: "Open",
        slug: "open",
        seq: 1,
        breakSize: 8,
        reserveSize: 0,
        isGeneral: true,
        priority: 1,
      },
    ],
  };
}

describe("ReleasesView", () => {
  it("renders grouped Appendix B gates with text state and submits release.set_gate", async () => {
    const state = makeReleasesState();
    const { submitted, store } = fakeStore(state, {
      ok: true,
      seq: 9,
      writes: [],
      committedPayload: null,
    });

    render(
      <ReleasesView
        state={state}
        status={EMPTY_STATUS}
        run={directRunner(store)}
        nowIso="2026-10-01T10:00:00.000Z"
      />,
    );

    expect(screen.getByText("Per-round gates")).toBeTruthy();
    expect(screen.getByText("Tournament tabs")).toBeTruthy();
    expect(screen.getByText("Results and breaks")).toBeTruthy();
    expect(screen.getByText("Participant and adjudicator lists")).toBeTruthy();
    expect(screen.getByText("Ballots")).toBeTruthy();
    expect(screen.getByText("Other public pages")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Release Team tab (tab_team)" }),
    );
    await waitFor(() => {
      expect(submitted).toHaveLength(1);
    });
    expect(submitted[0]).toEqual({
      type: "release.set_gate",
      expectedVersions: { "tournament:t-1": 2 },
      payload: { gate: "tab_team", released: true },
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Release Break published: Open (break_category_published)",
      }),
    );
    await waitFor(() => {
      expect(submitted).toHaveLength(2);
    });
    expect(submitted[1]).toEqual({
      type: "release.set_gate",
      expectedVersions: {
        "tournament:t-1": 2,
        "breakCategory:bc-open": 1,
      },
      payload: {
        gate: "break_category_published",
        released: true,
        categoryId: "bc-open",
      },
    });
  });

  it("opens confirmation dialog listing gates before submitting release.tab_bundle", async () => {
    const state = makeReleasesState();
    const { submitted, store } = fakeStore(state, {
      ok: true,
      seq: 10,
      writes: [],
      committedPayload: null,
    });

    render(
      <ReleasesView state={state} status={EMPTY_STATUS} run={directRunner(store)} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Release final tab" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(
      within(dialog).getByText("The following gates will become public:"),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("All round results (results_all_rounds)"),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Break published: Open (break_category_published)",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Confirm release" }));
    await waitFor(() => {
      expect(submitted).toHaveLength(1);
    });
    expect(submitted[0].type).toBe("release.tab_bundle");
    expect(submitted[0].payload).toEqual({
      breakCategoryIds: ["bc-open"],
    });
  });
});
