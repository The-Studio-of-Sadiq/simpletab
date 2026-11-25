import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OpRequest } from "@simpletab/core/ops";
import type {
  HostStatus,
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "react";
import { runnerFor } from "../actions/test-context";
import { CheckinView } from "./checkin-view";

function makeState(overrides: Partial<ProjectedState> = {}): ProjectedState {
  return {
    seq: 5,
    roleId: "host_owner",
    versions: {
      "team:t1": 2,
      "team:t2": 1,
      "team:t3": 1,
      "team:t4": 1,
      "venue:v1": 3,
      "venue:v2": 1,
    },
    tournament: {
      id: "t-bp",
      name: "Demo BP",
      shortName: "Demo",
      slug: "demo-bp",
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
        tournamentId: "t-bp",
        seq: 1,
        name: "Round 1",
        abbreviation: "R1",
        stage: "preliminary",
        drawType: "random",
        drawStatus: "none",
        feedbackWeight: 1,
        silent: false,
        motionsReleased: false,
        resultsReleased: false,
        completed: true,
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      {
        id: "r2",
        tournamentId: "t-bp",
        seq: 2,
        name: "Round 2",
        abbreviation: "R2",
        stage: "preliminary",
        drawType: "power_paired",
        drawStatus: "none",
        feedbackWeight: 1,
        silent: false,
        motionsReleased: false,
        resultsReleased: false,
        completed: false,
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ],
    teams: [
      {
        id: "t1",
        tournamentId: "t-bp",
        name: "Oxford A",
        institutionName: "Oxford",
        speakers: [],
        breakCategories: [],
        speakerCategories: [],
        roundAvailability: { r2: true },
      },
      {
        id: "t2",
        tournamentId: "t-bp",
        name: "Cambridge A",
        institutionName: "Cambridge",
        speakers: [],
        breakCategories: [],
        speakerCategories: [],
        roundAvailability: { r2: false },
      },
      {
        id: "t3",
        tournamentId: "t-bp",
        name: "LSE A",
        institutionName: "LSE",
        speakers: [],
        breakCategories: [],
        speakerCategories: [],
        roundAvailability: { r2: true },
      },
      {
        id: "t4",
        tournamentId: "t-bp",
        name: "Durham A",
        institutionName: "Durham",
        speakers: [],
        breakCategories: [],
        speakerCategories: [],
        roundAvailability: { r2: false },
      },
    ],
    adjudicators: [
      {
        id: "adj1",
        tournamentId: "t-bp",
        name: "Judge Alpha",
        baseScore: 8,
        trainee: false,
        independent: true,
        conflicts: [],
        roundAvailability: { r2: true },
      },
    ],
    institutions: [],
    venues: [
      {
        id: "v1",
        tournamentId: "t-bp",
        name: "Main Hall",
        priority: 10,
        checkedIn: true,
      },
      {
        id: "v2",
        tournamentId: "t-bp",
        name: "Room 204",
        priority: 5,
        checkedIn: false,
      },
    ],
    debates: [],
    motions: [],
    ballots: [],
    feedback: [],
    breakCategories: [],
    ...overrides,
  };
}

const EMPTY_STATUS: HostStatus = {
  open: true,
  slug: "demo-bp",
  headSeq: 5,
  integrityOk: true,
  canSync: true,
  locks: [],
};

describe("CheckinView", () => {
  it("defaults to current round, displays availability counts, and toggles team/venue with expectedVersions", async () => {
    const submitted: OpRequest[] = [];
    const submit = vi.fn(async (req: OpRequest): Promise<SubmitResult> => {
      submitted.push(req);
      return {
        ok: true,
        seq: 6,
        writes: [],
        committedPayload: req.payload,
      };
    });
    const state = makeState();

    render(
      <CheckinView
        state={state}
        status={EMPTY_STATUS}
        run={runnerFor({ state, submit })}
      />,
    );

    const roundSelect = screen.getByLabelText("Round") as HTMLSelectElement;
    expect(roundSelect.value).toBe("r2");
    expect(screen.getByText("2 of 4 teams available")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle availability for Oxford A" }),
    );
    await waitFor(() => {
      expect(submitted).toHaveLength(1);
    });
    expect(submitted[0]).toEqual({
      type: "checkin.set_participant",
      expectedVersions: { "team:t1": 2 },
      payload: {
        entityType: "team",
        entityId: "t1",
        roundId: "r2",
        available: false,
      },
    });

    fireEvent.click(screen.getByRole("tab", { name: "Venues (2)" }));
    expect(screen.getByText("1 of 2 venues checked in")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle availability for Main Hall" }),
    );
    await waitFor(() => {
      expect(submitted).toHaveLength(2);
    });
    expect(submitted[1]).toEqual({
      type: "checkin.set_venue",
      expectedVersions: { "venue:v1": 3 },
      payload: {
        venueId: "v1",
        checkedIn: false,
      },
    });
  });

  it("filters rows by search and status and bulk marks only unavailable filtered items", async () => {
    const submitted: OpRequest[] = [];
    const submit = vi.fn(async (req: OpRequest): Promise<SubmitResult> => {
      submitted.push(req);
      return {
        ok: true,
        seq: 6,
        writes: [],
        committedPayload: req.payload,
      };
    });
    const state = makeState();

    render(
      <CheckinView
        state={state}
        status={EMPTY_STATUS}
        run={runnerFor({ state, submit })}
      />,
    );

    fireEvent.change(screen.getByLabelText("Status filter"), {
      target: { value: "unavailable" },
    });
    fireEvent.change(screen.getByLabelText("Search"), {
      target: { value: "Cambridge" },
    });

    expect(screen.getByText("Cambridge A")).toBeTruthy();
    expect(screen.queryByText("Durham A")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Mark all available" }));
    await waitFor(() => {
      expect(submitted).toHaveLength(1);
    });
    expect(submitted[0]).toMatchObject({
      type: "checkin.set_participant",
      payload: {
        entityType: "team",
        entityId: "t2",
        roundId: "r2",
        available: true,
      },
    });
  });
});
