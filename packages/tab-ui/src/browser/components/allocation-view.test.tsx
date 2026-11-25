import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OpRequest } from "@simpletab/core/ops";
import type { Debate } from "@simpletab/core/types";
import type {
  HostStatus,
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "react";
import { runnerFor } from "../actions/test-context";
import { AllocationView } from "./allocation-view";

function makeAllocationState(
  overrides: Partial<ProjectedState> = {},
): ProjectedState {
  return {
    seq: 20,
    roleId: "host_owner",
    versions: {
      "round:r2": 3,
      "debate:d1": 5,
      "debate:d2": 6,
    },
    tournament: {
      id: "t-1",
      name: "Alloc Open",
      shortName: "Alloc",
      slug: "alloc-open",
      format: "uadc",
      active: true,
      ownerId: "host-owner",
      admins: { "host-owner": true },
      preferences: {
        teamsInDebate: 2,
        substantiveSpeakers: 3,
        replyScoresEnabled: true,
        minSpeakerScore: 65,
        maxSpeakerScore: 85,
        stepSpeakerScore: 1,
        minReplyScore: 30,
        maxReplyScore: 45,
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
        id: "r2",
        tournamentId: "t-1",
        seq: 2,
        name: "Round 2",
        abbreviation: "R2",
        stage: "preliminary",
        drawType: "power_paired",
        drawStatus: "draft",
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
        id: "team1",
        tournamentId: "t-1",
        name: "Oxford A",
        institutionId: "inst-oxf",
        institutionName: "Oxford",
        speakers: [],
        breakCategories: [],
        speakerCategories: [],
        checkedIn: true,
      },
      {
        id: "team2",
        tournamentId: "t-1",
        name: "Cambridge A",
        institutionId: "inst-cam",
        institutionName: "Cambridge",
        speakers: [],
        breakCategories: [],
        speakerCategories: [],
        checkedIn: true,
      },
      {
        id: "team3",
        tournamentId: "t-1",
        name: "LSE A",
        institutionId: "inst-lse",
        institutionName: "LSE",
        speakers: [],
        breakCategories: [],
        speakerCategories: [],
        checkedIn: true,
      },
      {
        id: "team4",
        tournamentId: "t-1",
        name: "Durham A",
        institutionId: "inst-dur",
        institutionName: "Durham",
        speakers: [],
        breakCategories: [],
        speakerCategories: [],
        checkedIn: true,
      },
    ],
    adjudicators: [
      {
        id: "adj1",
        tournamentId: "t-1",
        name: "Judge Oxford",
        institutionId: "inst-oxf",
        institutionName: "Oxford",
        baseScore: 8.5,
        trainee: false,
        independent: false,
        conflicts: [{ institutionId: "inst-oxf", type: "institution" }],
        checkedIn: true,
      },
      {
        id: "adj2",
        tournamentId: "t-1",
        name: "Judge Free",
        baseScore: 7.5,
        trainee: false,
        independent: true,
        conflicts: [],
        checkedIn: true,
      },
      {
        id: "adj3",
        tournamentId: "t-1",
        name: "Judge Pool",
        baseScore: 6.5,
        trainee: false,
        independent: true,
        conflicts: [],
        checkedIn: true,
      },
    ],
    institutions: [],
    venues: [],
    debates: [
      {
        id: "d1",
        tournamentId: "t-1",
        roundId: "r2",
        roundSeq: 2,
        venueName: "Room 1",
        bracket: 3,
        roomRank: 1,
        importance: 10,
        resultStatus: "none",
        sidesConfirmed: true,
        flags: [],
        teams: {
          AFF: { teamId: "team1", teamName: "Oxford A", side: "AFF" },
          NEG: { teamId: "team2", teamName: "Cambridge A", side: "NEG" },
        } as Debate["teams"],
        adjudicators: {
          chairId: "adj1",
          chairName: "Judge Oxford",
          panellistIds: [],
          panellistNames: [],
          traineeIds: [],
          traineeNames: [],
        },
      },
      {
        id: "d2",
        tournamentId: "t-1",
        roundId: "r2",
        roundSeq: 2,
        venueName: "Room 2",
        bracket: 0,
        roomRank: 2,
        importance: 5,
        resultStatus: "none",
        sidesConfirmed: true,
        flags: [],
        teams: {
          AFF: { teamId: "team3", teamName: "LSE A", side: "AFF" },
          NEG: { teamId: "team4", teamName: "Durham A", side: "NEG" },
        } as Debate["teams"],
        adjudicators: {
          chairId: "adj2",
          chairName: "Judge Free",
          panellistIds: [],
          panellistNames: [],
          traineeIds: [],
          traineeNames: [],
        },
      },
    ],
    motions: [],
    ballots: [],
    feedback: [],
    breakCategories: [],
    ...overrides,
  };
}

const EMPTY_STATUS: HostStatus = {
  open: true,
  slug: "alloc-open",
  headSeq: 20,
  integrityOk: true,
  canSync: true,
  locks: [],
};

describe("AllocationView", () => {
  it("flags adjudicator conflicts with a visible text label and submits swap-rooms as ONE op", async () => {
    const submitted: OpRequest[] = [];
    const submit = vi.fn(async (req: OpRequest): Promise<SubmitResult> => {
      submitted.push(req);
      return {
        ok: true,
        seq: 21,
        writes: ["debate:d1", "debate:d2"],
        committedPayload: req.payload,
      };
    });
    const state = makeAllocationState();

    render(
      <AllocationView
        state={state}
        status={EMPTY_STATUS}
        run={runnerFor({ state, submit })}
      />,
    );

    // Conflict warning has an explicit text label ("Conflict") and reason
    expect(screen.getByText("Conflict")).toBeTruthy();
    expect(
      screen.getByText(/Institutional clash with Oxford A/),
    ).toBeTruthy();
    expect(screen.getByText(/Base 8\.5/)).toBeTruthy();

    // Swap panels between Room 1 and Room 2 -> submits ONE allocation.swap_rooms op
    const swapButtons = screen.getAllByRole("button", { name: "Swap panel" });
    fireEvent.click(swapButtons[0]);
    fireEvent.click(screen.getByRole("button", { name: "Swap with Room 1" }));

    await waitFor(() => {
      expect(submitted).toHaveLength(1);
    });
    expect(submitted[0]).toEqual({
      type: "allocation.swap_rooms",
      expectedVersions: {
        "debate:d1": 5,
        "debate:d2": 6,
      },
      payload: {
        debateIdA: "d1",
        debateIdB: "d2",
      },
    });
  });

  it("renders inline VERSION_CONFLICT error for manual assign with Retry and supports preformed panels", async () => {
    const submitted: OpRequest[] = [];
    const submit = vi
      .fn<(req: OpRequest) => Promise<SubmitResult>>()
      .mockImplementationOnce(async (req) => {
        submitted.push(req);
        return {
          ok: false,
          code: "VERSION_CONFLICT",
          errors: ["Version conflict on debate:d1: expected 5, current is 6."],
          current: { "debate:d1": 6 },
        };
      })
      .mockImplementation(async (req) => {
        submitted.push(req);
        return {
          ok: true,
          seq: 22,
          writes: [],
          committedPayload: req.payload,
        };
      });

    const initial = makeAllocationState();
    let liveState: ProjectedState = initial;
    const run = runnerFor({ state: () => liveState, submit });
    const { rerender } = render(
      <AllocationView state={initial} status={EMPTY_STATUS} run={run} />,
    );

    // Edit Room 1 manually
    const editButtons = screen.getAllByRole("button", { name: "Edit panel" });
    fireEvent.click(editButtons[0]);
    fireEvent.change(screen.getByLabelText("Chair for Room 1"), {
      target: { value: "adj3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save panel" }));

    await waitFor(() => {
      expect(screen.getByText("Version conflict")).toBeTruthy();
    });
    expect(
      screen.getByText(/Current value: Room 1 panel: Chair: Judge Oxford/),
    ).toBeTruthy();

    liveState = makeAllocationState({
      versions: { ...initial.versions, "debate:d1": 6 },
    });
    rerender(
      <AllocationView state={liveState} status={EMPTY_STATUS} run={run} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(submitted).toHaveLength(2);
    });
    expect(submitted[1]).toMatchObject({
      type: "allocation.assign_manual",
      expectedVersions: { "debate:d1": 6 },
      payload: {
        debateId: "d1",
        chairId: "adj3",
      },
    });

    // Preformed panels tab
    fireEvent.click(
      screen.getByRole("tab", { name: "Preformed panels (0)" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add panel" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Save preformed panels" }),
    );

    await waitFor(() => {
      expect(
        submitted.some((op) => op.type === "allocation.preformed_save"),
      ).toBe(true);
    });
  });

  it("submits allocation.auto and shows lock banner with Cancel for host owner only", async () => {
    const submitted: OpRequest[] = [];
    const submit = vi.fn(async (req: OpRequest): Promise<SubmitResult> => {
      submitted.push(req);
      return {
        ok: true,
        seq: 23,
        writes: ["debate:d1", "debate:d2"],
        committedPayload: { warnings: [] },
      };
    });
    const cancelLong = vi.fn(async (lockId: string) => ({
      ok: true as const,
      lockId,
    }));

    const lockedStatus: HostStatus = {
      ...EMPTY_STATUS,
      locks: [
        {
          lockId: "alloc-lock-1",
          opType: "allocation.auto",
          actorRef: "host-owner",
          startedAt: "2026-11-24T00:00:00.000Z",
          roundId: "r2",
        },
      ],
    };

    const state = makeAllocationState();
    render(
      <AllocationView
        state={state}
        status={lockedStatus}
        run={runnerFor({ state, submit, cancelLong })}
      />,
    );

    expect(
      screen.getByText("Allocating adjudicators for Round 2…"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Panel size"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Auto-allocate" }));

    await waitFor(() => {
      expect(submitted).toHaveLength(1);
    });
    expect(submitted[0]).toEqual({
      type: "allocation.auto",
      payload: {
        roundId: "r2",
        panelSize: 3,
      },
    });
  });
});
