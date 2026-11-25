import { fireEvent, render, screen } from "@testing-library/react";
import type { OpBallotSubmission, OpRound } from "@simpletab/core/ops";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import type { Debate, Team } from "@simpletab/core/types";
import type {
  HostStatus,
  ProjectedState,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "react";
import { runnerFor } from "../actions/test-context";
import { StandingsView } from "./standings-view";

const EMPTY_STATUS: HostStatus = {
  open: true,
  slug: "standings-test",
  headSeq: 10,
  integrityOk: true,
  canSync: true,
  locks: [],
};

function runner(state: ProjectedState) {
  return runnerFor({
    state,
    submit: async () => ({ ok: true, seq: 11, writes: [], committedPayload: null }),
  });
}

function makeTeam(id: string, name: string, speakers: string[]): Team {
  return {
    id,
    tournamentId: "t-1",
    name,
    speakers: speakers.map((spkName, idx) => ({
      id: `${id}-s${idx + 1}`,
      name: spkName,
    })),
    breakCategories: ["bc-open"],
    speakerCategories: [],
  };
}

function makeBpRound(id: string, seq: number, completed: boolean): OpRound {
  return {
    id,
    tournamentId: "t-1",
    seq,
    name: `Round ${seq}`,
    abbreviation: `R${seq}`,
    stage: "preliminary",
    drawType: "random",
    drawStatus: "released",
    feedbackWeight: 1,
    silent: false,
    motionsReleased: false,
    resultsReleased: completed,
    completed,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

function makeBpStandingsState(
  precedence: ProjectedState["tournament"]["preferences"]["teamStandingsPrecedence"] = [
    "points",
    "speaks_sum",
    "firsts",
  ],
): ProjectedState {
  const teams: Team[] = [
    makeTeam("t1", "Alpha", ["Alice", "Amy"]),
    makeTeam("t2", "Beta", ["Bob", "Ben"]),
    makeTeam("t3", "Gamma", ["Cara", "Cal"]),
    makeTeam("t4", "Delta", ["Dan", "Dee"]),
  ];

  const rounds: OpRound[] = [
    makeBpRound("r1", 1, true),
    makeBpRound("r2", 2, false),
  ];

  const debates: Debate[] = [
    {
      id: "d1",
      tournamentId: "t-1",
      roundId: "r1",
      roundSeq: 1,
      bracket: 0,
      roomRank: 1,
      importance: 10,
      resultStatus: "confirmed",
      sidesConfirmed: true,
      flags: [],
      teams: {
        OG: { teamId: "t1", teamName: "Alpha", side: "OG" },
        OO: { teamId: "t2", teamName: "Beta", side: "OO" },
        CG: { teamId: "t3", teamName: "Gamma", side: "CG" },
        CO: { teamId: "t4", teamName: "Delta", side: "CO" },
      } as Debate["teams"],
      adjudicators: { panellistIds: [], panellistNames: [], traineeIds: [], traineeNames: [] },
    },
    {
      id: "d2",
      tournamentId: "t-1",
      roundId: "r2",
      roundSeq: 2,
      bracket: 0,
      roomRank: 1,
      importance: 10,
      resultStatus: "confirmed",
      sidesConfirmed: true,
      flags: [],
      teams: {
        OG: { teamId: "t4", teamName: "Delta", side: "OG" },
        OO: { teamId: "t3", teamName: "Gamma", side: "OO" },
        CG: { teamId: "t2", teamName: "Beta", side: "CG" },
        CO: { teamId: "t1", teamName: "Alpha", side: "CO" },
      } as Debate["teams"],
      adjudicators: { panellistIds: [], panellistNames: [], traineeIds: [], traineeNames: [] },
    },
  ];

  // Round 1: Alpha 3 (160), Beta 2 (155), Gamma 2? Wait: in BP points are 3,2,1,0.
  // Round 1: Alpha 3 (160), Beta 2 (150), Gamma 1 (150), Delta 0 (140)
  // Round 2: Delta 3 (160), Gamma 2 (150), Beta 1 (150), Alpha 0 (140)
  // Totals after R1+R2:
  // Alpha: 3 pts, 300 speaks, 1 first
  // Beta: 3 pts, 300 speaks, 0 firsts
  // Gamma: 3 pts, 300 speaks, 0 firsts
  // Delta: 3 pts, 300 speaks, 1 first
  // With precedence ["points", "speaks_sum", "firsts"]:
  // Alpha & Delta tie on 3 pts, 300 speaks, 1 first -> rank =1, =1
  // Beta & Gamma tie on 3 pts, 300 speaks, 0 firsts -> rank =3, =3!
  const ballots: OpBallotSubmission[] = [
    {
      id: "b1",
      tournamentId: "t-1",
      roundId: "r1",
      debateId: "d1",
      version: 1,
      confirmed: true,
      discarded: false,
      submitterType: "tabroom",
      speakerScores: {
        OG: [
          { speakerId: "t1-s1", speakerName: "Alice", position: 1, score: 80 },
          { speakerId: "t1-s2", speakerName: "Amy", position: 2, score: 80 },
        ],
        OO: [
          { speakerId: "t2-s1", speakerName: "Bob", position: 1, score: 75 },
          { speakerId: "t2-s2", speakerName: "Ben", position: 2, score: 75 },
        ],
        CG: [
          { speakerId: "t3-s1", speakerName: "Cara", position: 1, score: 75 },
          { speakerId: "t3-s2", speakerName: "Cal", position: 2, score: 75 },
        ],
        CO: [
          { speakerId: "t4-s1", speakerName: "Dan", position: 1, score: 70 },
          { speakerId: "t4-s2", speakerName: "Dee", position: 2, score: 70 },
        ],
      } as OpBallotSubmission["speakerScores"],
      teamScores: {
        OG: { side: "OG", teamId: "t1", points: 3, totalSpeakerScore: 160, rank: 1 },
        OO: { side: "OO", teamId: "t2", points: 2, totalSpeakerScore: 150, rank: 2 },
        CG: { side: "CG", teamId: "t3", points: 1, totalSpeakerScore: 150, rank: 3 },
        CO: { side: "CO", teamId: "t4", points: 0, totalSpeakerScore: 140, rank: 4 },
      } as OpBallotSubmission["teamScores"],
      timestamp: "2026-10-01T08:00:00.000Z",
    },
    {
      id: "b2",
      tournamentId: "t-1",
      roundId: "r2",
      debateId: "d2",
      version: 1,
      confirmed: true,
      discarded: false,
      submitterType: "tabroom",
      speakerScores: {
        OG: [
          { speakerId: "t4-s1", speakerName: "Dan", position: 1, score: 80 },
          { speakerId: "t4-s2", speakerName: "Dee", position: 2, score: 80 },
        ],
        OO: [
          { speakerId: "t3-s1", speakerName: "Cara", position: 1, score: 75 },
          { speakerId: "t3-s2", speakerName: "Cal", position: 2, score: 75 },
        ],
        CG: [
          { speakerId: "t2-s1", speakerName: "Bob", position: 1, score: 75 },
          { speakerId: "t2-s2", speakerName: "Ben", position: 2, score: 75 },
        ],
        CO: [
          { speakerId: "t1-s1", speakerName: "Alice", position: 1, score: 70 },
          { speakerId: "t1-s2", speakerName: "Amy", position: 2, score: 70 },
        ],
      } as OpBallotSubmission["speakerScores"],
      teamScores: {
        OG: { side: "OG", teamId: "t4", points: 3, totalSpeakerScore: 160, rank: 1 },
        OO: { side: "OO", teamId: "t3", points: 2, totalSpeakerScore: 150, rank: 2 },
        CG: { side: "CG", teamId: "t2", points: 1, totalSpeakerScore: 150, rank: 3 },
        CO: { side: "CO", teamId: "t1", points: 0, totalSpeakerScore: 140, rank: 4 },
      } as OpBallotSubmission["teamScores"],
      timestamp: "2026-10-01T09:00:00.000Z",
    },
  ];

  return {
    seq: 10,
    roleId: "host_owner",
    permissions: BUILT_IN_ROLES.host_owner.permissions,
    versions: {},
    tournament: {
      id: "t-1",
      name: "Standings Test",
      shortName: "ST",
      slug: "standings-test",
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
        teamStandingsPrecedence: precedence,
        speakerStandingsPrecedence: ["speaks_avg", "speaks_sum"],
      },
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
    rounds,
    teams,
    adjudicators: [],
    institutions: [],
    venues: [],
    debates,
    motions: [],
    ballots,
    feedback: [],
    breakCategories: [
      {
        id: "bc-open",
        tournamentId: "t-1",
        name: "Open",
        slug: "open",
        seq: 1,
        breakSize: 2,
        reserveSize: 0,
        isGeneral: true,
        priority: 1,
      },
    ],
  };
}

describe("StandingsView", () => {
  it("renders shared ties as '=n', follows precedence column order, supports as-of round, and displays liveness labels as text", () => {
    const state = makeBpStandingsState(["points", "speaks_sum", "firsts"]);
    render(
      <StandingsView
        state={state}
        status={EMPTY_STATUS}
        run={runner(state)}
      />,
    );

    const headers = screen
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent?.trim());
    expect(headers).toEqual([
      "Rank",
      "Team",
      "Points",
      "Total speaker score",
      "1sts",
      "Break liveness",
    ]);

    // Alpha & Delta tie at =1; Beta & Gamma tie at =3
    expect(screen.getAllByText("=1")).toHaveLength(2);
    expect(screen.getAllByText("=3")).toHaveLength(2);

    // Liveness badges rendered as text (before R2, Alpha has 3 pts, Delta has 0 pts)
    expect(
      screen.getAllByText(/Safe|Live|Dead/).length,
    ).toBeGreaterThan(0);

    // Switch "As of round" to Round 1: Alpha 1st (3 pts), Beta 2nd (2 pts), Gamma 3rd (1 pt), Delta 4th (0 pts)
    fireEvent.change(screen.getByLabelText("As of round"), {
      target: { value: "r1" },
    });
    expect(screen.queryByText("=3")).toBeNull();
    const r1Rows = screen.getAllByRole("row").slice(1);
    expect(r1Rows[0].querySelectorAll("td")[0].textContent).toBe("1");
    expect(r1Rows[0].querySelectorAll("td")[1].textContent).toBe("Alpha");
    expect(r1Rows[3].querySelectorAll("td")[0].textContent).toBe("4");
    expect(r1Rows[3].querySelectorAll("td")[1].textContent).toBe("Delta");

    // Switch to Speakers tab and check precedence order (Average score before Total score)
    fireEvent.click(screen.getByRole("tab", { name: "Speakers" }));
    const spkHeaders = screen
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent?.trim());
    expect(spkHeaders).toEqual([
      "Rank",
      "Speaker",
      "Team",
      "Average score",
      "Total score",
    ]);

    // Break category tab is also available
    expect(screen.getByRole("tab", { name: "Break: Open" })).toBeTruthy();
  });

  it("shows Replies tab on two-team tournaments with reply scores enabled", () => {
    const base = makeBpStandingsState(["wins", "speaks_sum"]);
    const twoTeamState: ProjectedState = {
      ...base,
      tournament: {
        ...base.tournament,
        format: "uadc",
        preferences: {
          ...base.tournament.preferences,
          teamsInDebate: 2,
          substantiveSpeakers: 3,
          replyScoresEnabled: true,
        },
      },
      rounds: [makeBpRound("r1", 1, true)],
      teams: [
        makeTeam("t1", "Alpha", ["Alice", "Amy", "Ann"]),
        makeTeam("t2", "Beta", ["Bob", "Ben", "Bill"]),
      ],
      debates: [
        {
          id: "d1",
          tournamentId: "t-1",
          roundId: "r1",
          roundSeq: 1,
          bracket: 0,
          roomRank: 1,
          importance: 10,
          resultStatus: "confirmed",
          sidesConfirmed: true,
          flags: [],
          teams: {
            AFF: { teamId: "t1", teamName: "Alpha", side: "AFF" },
            NEG: { teamId: "t2", teamName: "Beta", side: "NEG" },
          } as Debate["teams"],
          adjudicators: { panellistIds: [], panellistNames: [], traineeIds: [], traineeNames: [] },
        },
      ],
      ballots: [
        {
          id: "b1",
          tournamentId: "t-1",
          roundId: "r1",
          debateId: "d1",
          version: 1,
          confirmed: true,
          discarded: false,
          submitterType: "tabroom",
          speakerScores: {
            AFF: [
              { speakerId: "t1-s1", speakerName: "Alice", position: 1, score: 75 },
              { speakerId: "t1-s2", speakerName: "Amy", position: 2, score: 75 },
              { speakerId: "t1-s3", speakerName: "Ann", position: 3, score: 75 },
              { speakerId: "t1-s1", speakerName: "Alice", position: 4, score: 38 },
            ],
            NEG: [
              { speakerId: "t2-s1", speakerName: "Bob", position: 1, score: 74 },
              { speakerId: "t2-s2", speakerName: "Ben", position: 2, score: 74 },
              { speakerId: "t2-s3", speakerName: "Bill", position: 3, score: 74 },
              { speakerId: "t2-s1", speakerName: "Bob", position: 4, score: 37 },
            ],
          } as OpBallotSubmission["speakerScores"],
          teamScores: {
            AFF: { side: "AFF", teamId: "t1", points: 1, totalSpeakerScore: 263, win: true, margin: 3 },
            NEG: { side: "NEG", teamId: "t2", points: 0, totalSpeakerScore: 259, win: false, margin: -3 },
          } as OpBallotSubmission["teamScores"],
          timestamp: "2026-10-01T08:00:00.000Z",
        },
      ],
      breakCategories: [],
    };

    render(
      <StandingsView state={twoTeamState} status={EMPTY_STATUS} run={runner(twoTeamState)} />,
    );
    const repliesTab = screen.getByRole("tab", { name: "Replies" });
    fireEvent.click(repliesTab);
    expect(screen.getByText("Reply speaker standings")).toBeTruthy();
    expect(screen.getAllByText("38").length).toBeGreaterThan(0);
  });
});
