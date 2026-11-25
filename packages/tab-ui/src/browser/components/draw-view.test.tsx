import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OpRequest } from "@simpletab/core/ops";
import type { Debate, TournamentFormat } from "@simpletab/core/types";
import type {
  HostStatus,
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "react";
import { runnerFor } from "../actions/test-context";
import { DrawView } from "./draw-view";

function makeDrawState(
  format: TournamentFormat = "bp",
  overrides: Partial<ProjectedState> = {},
): ProjectedState {
  const isBp = format === "bp";
  const teams = [
    {
      id: "t1",
      tournamentId: "t-1",
      name: "Team Alpha",
      speakers: [
        { id: "s1", name: "Alice" },
        { id: "s2", name: "Bob" },
      ],
      breakCategories: [],
      speakerCategories: [],
      checkedIn: true,
    },
    {
      id: "t2",
      tournamentId: "t-1",
      name: "Team Beta",
      speakers: [
        { id: "s3", name: "Cara" },
        { id: "s4", name: "Dan" },
      ],
      breakCategories: [],
      speakerCategories: [],
      checkedIn: true,
    },
    {
      id: "t3",
      tournamentId: "t-1",
      name: "Team Gamma",
      speakers: [
        { id: "s5", name: "Eve" },
        { id: "s6", name: "Frank" },
      ],
      breakCategories: [],
      speakerCategories: [],
      checkedIn: true,
    },
    {
      id: "t4",
      tournamentId: "t-1",
      name: "Team Delta",
      speakers: [
        { id: "s7", name: "Grace" },
        { id: "s8", name: "Hank" },
      ],
      breakCategories: [],
      speakerCategories: [],
      checkedIn: true,
    },
  ];

  const bpTeams = {
    OG: { teamId: "t1", teamName: "Team Alpha", side: "OG" as const },
    OO: { teamId: "t2", teamName: "Team Beta", side: "OO" as const },
    CG: { teamId: "t3", teamName: "Team Gamma", side: "CG" as const },
    CO: { teamId: "t4", teamName: "Team Delta", side: "CO" as const },
  };
  const twoTeamTeams = {
    AFF: { teamId: "t1", teamName: "Team Alpha", side: "AFF" as const },
    NEG: { teamId: "t2", teamName: "Team Beta", side: "NEG" as const },
  };

  return {
    seq: 10,
    roleId: "host_owner",
    versions: {
      "round:r3": 4,
      "debate:d1": 7,
      "debate:d2": 2,
    },
    tournament: {
      id: "t-1",
      name: "Test Tournament",
      shortName: "Test",
      slug: "test-tourney",
      format,
      active: true,
      ownerId: "host-owner",
      admins: { "host-owner": true },
      preferences: {
        teamsInDebate: isBp ? 4 : 2,
        substantiveSpeakers: isBp ? 2 : 3,
        replyScoresEnabled: !isBp,
        minSpeakerScore: 50,
        maxSpeakerScore: 100,
        stepSpeakerScore: 1,
        minReplyScore: 25,
        maxReplyScore: 50,
        drawRule: "power_paired",
        sideAllocationRule: "balanced",
        ...(isBp ? {} : { sideNames: "gov-opp" as const }),
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
        id: "r3",
        tournamentId: "t-1",
        seq: 3,
        name: "Round 3",
        abbreviation: "R3",
        stage: "preliminary",
        drawType: "power_paired",
        drawStatus: "draft",
        drawSeed: 12345,
        feedbackWeight: 1,
        silent: false,
        motionsReleased: false,
        resultsReleased: false,
        completed: false,
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ],
    teams,
    adjudicators: [],
    institutions: [],
    venues: [
      { id: "v1", tournamentId: "t-1", name: "Hall A", priority: 10 },
      { id: "v2", tournamentId: "t-1", name: "Hall B", priority: 9 },
    ],
    debates: [
      {
        id: "d1",
        tournamentId: "t-1",
        roundId: "r3",
        roundSeq: 3,
        venueId: "v1",
        venueName: "Hall A",
        bracket: 6,
        roomRank: 1,
        importance: 10,
        resultStatus: "none",
        sidesConfirmed: true,
        flags: [],
        teams: (isBp ? bpTeams : twoTeamTeams) as Debate["teams"],
        adjudicators: {
          panellistIds: [],
          panellistNames: [],
          traineeIds: [],
          traineeNames: [],
        },
      },
      ...(isBp
        ? []
        : [
            {
              id: "d2",
              tournamentId: "t-1",
              roundId: "r3",
              roundSeq: 3,
              venueId: "v2",
              venueName: "Hall B",
              bracket: 3,
              roomRank: 2,
              importance: 5,
              resultStatus: "none" as const,
              sidesConfirmed: true,
              flags: [],
              teams: {
                AFF: { teamId: "t3", teamName: "Team Gamma", side: "AFF" as const },
                NEG: { teamId: "t4", teamName: "Team Delta", side: "NEG" as const },
              } as Debate["teams"],
              adjudicators: {
                panellistIds: [],
                panellistNames: [],
                traineeIds: [],
                traineeNames: [],
              },
            },
          ]),
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
  slug: "test-tourney",
  headSeq: 10,
  integrityOk: true,
  canSync: true,
  locks: [],
};

describe("DrawView", () => {
  it("renders BP and two-team fixtures with the correct side labels", () => {
    const submit = async (): Promise<SubmitResult> => ({
      ok: true,
      seq: 11,
      writes: [],
      committedPayload: null,
    });

    const { rerender } = render(
      <DrawView
        state={makeDrawState("bp")}
        status={EMPTY_STATUS}
        run={runnerFor({ state: makeDrawState("bp"), submit })}
      />,
    );

    expect(screen.getByRole("columnheader", { name: "OG" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "OO" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "CG" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "CO" })).toBeTruthy();
    expect(screen.getByText("Team Alpha")).toBeTruthy();

    const twoTeamState = makeDrawState("uadc");
    rerender(
      <DrawView
        state={twoTeamState}
        status={EMPTY_STATUS}
        run={runnerFor({ state: twoTeamState, submit })}
      />,
    );

    expect(
      screen.getByRole("columnheader", { name: "Government" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("columnheader", { name: "Opposition" }),
    ).toBeTruthy();
    expect(screen.getByText("Team Gamma")).toBeTruthy();
  });

  it("keyboard move of a team submits draw.move_team with expected versions", async () => {
    const submitted: OpRequest[] = [];
    const state = makeDrawState("bp");
    const submit = vi.fn(async (req: OpRequest): Promise<SubmitResult> => {
      submitted.push(req);
      return {
        ok: true,
        seq: 11,
        writes: ["debate:d1"],
        committedPayload: req.payload,
      };
    });

    render(
      <DrawView
        state={state}
        status={EMPTY_STATUS}
        run={runnerFor({ state, submit })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Select Team Alpha in Hall A (OG) to move" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Place Team Alpha in Hall A (OO), currently Team Beta",
      }),
    );

    await waitFor(() => {
      expect(submitted).toHaveLength(1);
    });
    expect(submitted[0]).toEqual({
      type: "draw.move_team",
      expectedVersions: {
        "debate:d1": 7,
      },
      payload: {
        pick: {
          teamId: "t1",
          teamName: "Team Alpha",
          from: { kind: "slot", debateId: "d1", side: "OG" },
        },
        target: { kind: "slot", debateId: "d1", side: "OO" },
      },
    });
  });

  it("shows lock banner and Cancel button only for host owner", async () => {
    const lockedStatus: HostStatus = {
      ...EMPTY_STATUS,
      locks: [
        {
          lockId: "lock-r3",
          opType: "draw.generate",
          actorRef: "host-owner",
          startedAt: "2026-11-24T00:00:00.000Z",
          roundId: "r3",
        },
      ],
    };
    const cancelLong = vi.fn(async (lockId: string) => ({
      ok: true as const,
      lockId,
    }));
    const submit = async (): Promise<SubmitResult> => ({
      ok: true,
      seq: 11,
      writes: [],
      committedPayload: null,
    });
    const ownerState = makeDrawState("bp", { roleId: "host_owner" });

    const { rerender } = render(
      <DrawView
        state={ownerState}
        status={lockedStatus}
        run={runnerFor({ state: ownerState, submit, cancelLong })}
      />,
    );

    expect(screen.getByText("Generating Round 3…")).toBeTruthy();
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    fireEvent.click(cancelBtn);
    await waitFor(() => {
      expect(cancelLong).toHaveBeenCalledWith("lock-r3");
    });

    const directorState = makeDrawState("bp", { roleId: "tab_director" });
    rerender(
      <DrawView
        state={directorState}
        status={lockedStatus}
        run={runnerFor({ state: directorState, submit, cancelLong })}
      />,
    );

    expect(screen.getByText("Generating Round 3…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("renders inline VERSION_CONFLICT error next to affected room with current value and Retry", async () => {
    const calls: OpRequest[] = [];
    const submit = vi
      .fn<(req: OpRequest) => Promise<SubmitResult>>()
      .mockImplementationOnce(async (req) => {
        calls.push(req);
        return {
          ok: false,
          code: "VERSION_CONFLICT",
          errors: ["Version conflict on debate:d1: expected 7, current is 8."],
          current: { "debate:d1": 8 },
        };
      })
      .mockImplementationOnce(async (req) => {
        calls.push(req);
        return {
          ok: true,
          seq: 12,
          writes: ["debate:d1"],
          committedPayload: req.payload,
        };
      });

    const initial = makeDrawState("uadc");
    let liveState: ProjectedState = initial;
    const run = runnerFor({ state: () => liveState, submit });
    const { rerender } = render(
      <DrawView state={initial} status={EMPTY_STATUS} run={run} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Swap sides in Hall A" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(screen.getByText("Version conflict")).toBeTruthy();
    expect(
      screen.getByText(/Current value: Hall A: Government: Team Alpha/),
    ).toBeTruthy();

    // Simulate store refreshing latest version 8 before Retry is clicked
    liveState = makeDrawState("uadc", {
      versions: { ...initial.versions, "debate:d1": 8 },
    });
    rerender(<DrawView state={liveState} status={EMPTY_STATUS} run={run} />);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    expect(calls[1].expectedVersions).toEqual({ "debate:d1": 8 });
  });

  it("submits stage transitions, restore undo with blockers, and swing team creation", async () => {
    const submitted: OpRequest[] = [];
    const submit = vi.fn(async (req: OpRequest): Promise<SubmitResult> => {
      submitted.push(req);
      return {
        ok: true,
        seq: 15,
        writes: [],
        committedPayload: req.payload,
      };
    });
    const undo = vi.fn(async (): Promise<SubmitResult> => ({
      ok: false,
      code: "CANNOT_UNDO",
      errors: ["Operation 9 is blocked by later operations: 10."],
      blockingSeqs: [10],
    }));
    const state = makeDrawState("bp");

    render(
      <DrawView
        state={state}
        status={EMPTY_STATUS}
        lastGenerateSeq={9}
        run={runnerFor({ state, submit, undo })}
      />,
    );

    expect(screen.getByText("Draft")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Lock draw" }));
    await waitFor(() => {
      expect(submitted[0]).toEqual({
        type: "draw.lock",
        expectedVersions: { "round:r3": 4 },
        payload: { roundId: "r3" },
      });
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Restore previous draw" }),
    );
    await waitFor(() => {
      expect(undo).toHaveBeenCalledWith(9);
      expect(screen.getByText("Cannot undo")).toBeTruthy();
      expect(screen.getByText(/Blocked by later operation\(s\): #10/)).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText("Swing team name"), {
      target: { value: "Swing 1" },
    });
    fireEvent.change(screen.getByLabelText("Speaker 1"), {
      target: { value: "Sam" },
    });
    fireEvent.change(screen.getByLabelText("Speaker 2"), {
      target: { value: "Pat" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create swing team" }));

    await waitFor(() => {
      expect(submitted.some((op) => op.type === "swing.create")).toBe(true);
    });
  });
});
