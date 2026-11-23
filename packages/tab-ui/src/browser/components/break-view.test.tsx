import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OpBallotSubmission, OpRequest, OpRound } from "@simpletab/core/ops";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import type { BreakCategory, Debate, Team } from "@simpletab/core/types";
import type {
  HostStatus,
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "react";
import { BreakView } from "./break-view";

const EMPTY_STATUS: HostStatus = {
  open: true,
  slug: "break-test",
  headSeq: 12,
  integrityOk: true,
  canSync: true,
  locks: [],
};

function makeTwoTeamBreakState(overrides: Partial<ProjectedState> = {}): ProjectedState {
  const teams: Team[] = [
    {
      id: "t1",
      tournamentId: "t-1",
      name: "Oxford 1",
      institutionId: "inst-oxf",
      institutionName: "Oxford",
      speakers: [{ id: "s1", name: "Alice" }],
      breakCategories: ["bc-open"],
      speakerCategories: [],
    },
    {
      id: "t2",
      tournamentId: "t-1",
      name: "Cambridge 1",
      institutionId: "inst-cam",
      institutionName: "Cambridge",
      speakers: [{ id: "s2", name: "Bob" }],
      breakCategories: ["bc-open"],
      speakerCategories: [],
    },
    {
      id: "t3",
      tournamentId: "t-1",
      name: "Oxford 2",
      institutionId: "inst-oxf",
      institutionName: "Oxford",
      speakers: [{ id: "s3", name: "Cara" }],
      breakCategories: ["bc-open"],
      speakerCategories: [],
    },
    {
      id: "t4",
      tournamentId: "t-1",
      name: "LSE 1",
      institutionId: "inst-lse",
      institutionName: "LSE",
      speakers: [{ id: "s4", name: "Dan" }],
      breakCategories: ["bc-open"],
      speakerCategories: [],
    },
  ];

  const rounds: OpRound[] = [
    {
      id: "r1",
      tournamentId: "t-1",
      seq: 1,
      name: "Round 1",
      abbreviation: "R1",
      stage: "preliminary",
      drawType: "random",
      drawStatus: "released",
      feedbackWeight: 1,
      silent: false,
      motionsReleased: false,
      resultsReleased: true,
      completed: true,
      createdAt: "2026-10-01T00:00:00.000Z",
    },
    {
      id: "ef1",
      tournamentId: "t-1",
      seq: 2,
      name: "Grand Final",
      abbreviation: "GF",
      stage: "elimination",
      drawType: "elimination",
      drawStatus: "none",
      feedbackWeight: 1,
      silent: false,
      motionsReleased: false,
      resultsReleased: false,
      completed: false,
      breakCategoryIds: ["bc-open"],
      createdAt: "2026-10-01T00:00:00.000Z",
    },
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
        AFF: { teamId: "t1", teamName: "Oxford 1", side: "AFF" },
        NEG: { teamId: "t4", teamName: "LSE 1", side: "NEG" },
      } as Debate["teams"],
      adjudicators: { panellistIds: [], panellistNames: [], traineeIds: [], traineeNames: [] },
    },
    {
      id: "d2",
      tournamentId: "t-1",
      roundId: "r1",
      roundSeq: 1,
      bracket: 0,
      roomRank: 2,
      importance: 8,
      resultStatus: "confirmed",
      sidesConfirmed: true,
      flags: [],
      teams: {
        AFF: { teamId: "t2", teamName: "Cambridge 1", side: "AFF" },
        NEG: { teamId: "t3", teamName: "Oxford 2", side: "NEG" },
      } as Debate["teams"],
      adjudicators: { panellistIds: [], panellistNames: [], traineeIds: [], traineeNames: [] },
    },
  ];

  // t1: 1 win, 220 speaks; t2: 1 win, 210 speaks; t3: 0 wins, 210 speaks; t4: 0 wins, 210 speaks
  // If breakSize = 2 and t2 & t3 are tied? Let's make t2 and t3 tie on 1 win and 210 speaks (d2 both or t2 & t4)!
  // Let's make d1: t1 (1 win, 220) vs t4 (0 wins, 190); d2: t2 (1 win, 210) vs t3 (0 wins, 200)...
  // Actually for a cutoff tie at breakSize = 2: t1 (1 win, 220), t2 (1 win, 210), t3 (1 win, 210) -> let t3 beat t4!
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
        AFF: [{ speakerId: "s1", speakerName: "Alice", position: 1, score: 80 }],
        NEG: [{ speakerId: "s4", speakerName: "Dan", position: 1, score: 70 }],
      } as OpBallotSubmission["speakerScores"],
      teamScores: {
        AFF: { side: "AFF", teamId: "t1", points: 1, totalSpeakerScore: 220, win: true, margin: 10 },
        NEG: { side: "NEG", teamId: "t4", points: 0, totalSpeakerScore: 210, win: false, margin: -10 },
      } as OpBallotSubmission["teamScores"],
      timestamp: "2026-10-01T08:00:00.000Z",
    },
    {
      id: "b2",
      tournamentId: "t-1",
      roundId: "r1",
      debateId: "d2",
      version: 1,
      confirmed: true,
      discarded: false,
      submitterType: "tabroom",
      speakerScores: {
        AFF: [{ speakerId: "s2", speakerName: "Bob", position: 1, score: 75 }],
        NEG: [{ speakerId: "s3", speakerName: "Cara", position: 1, score: 75 }],
      } as OpBallotSubmission["speakerScores"],
      teamScores: {
        AFF: { side: "AFF", teamId: "t2", points: 1, totalSpeakerScore: 210, win: true, margin: 0 },
        NEG: { side: "NEG", teamId: "t3", points: 1, totalSpeakerScore: 210, win: true, margin: 0 },
      } as OpBallotSubmission["teamScores"],
      timestamp: "2026-10-01T08:00:00.000Z",
    },
  ];

  const categories: BreakCategory[] = [
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
  ];

  return {
    seq: 12,
    roleId: "host_owner",
    permissions: BUILT_IN_ROLES.host_owner.permissions,
    versions: {
      "tournament:t-1": 1,
      "breakCategory:bc-open": 1,
      "team:t2": 1,
      "team:t3": 1,
      "round:ef1": 1,
    },
    tournament: {
      id: "t-1",
      name: "Break Test",
      shortName: "BT",
      slug: "break-test",
      format: "uadc",
      active: true,
      ownerId: "host-owner",
      admins: { "host-owner": true },
      preferences: {
        teamsInDebate: 2,
        substantiveSpeakers: 3,
        replyScoresEnabled: true,
        minSpeakerScore: 70,
        maxSpeakerScore: 80,
        stepSpeakerScore: 1,
        minReplyScore: 35,
        maxReplyScore: 40,
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
        teamStandingsPrecedence: ["wins", "speaks_sum"],
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
    breakCategories: categories,
    ...overrides,
  };
}

describe("BreakView", () => {
  it("shows cutoff tie and submits break.team_override when resolved", async () => {
    const submitted: OpRequest[] = [];
    const onSubmitOp = vi.fn(async (req: OpRequest): Promise<SubmitResult> => {
      submitted.push(req);
      return { ok: true, seq: 13, writes: [], committedPayload: req.payload };
    });

    render(
      <BreakView
        state={makeTwoTeamBreakState()}
        status={EMPTY_STATUS}
        onSubmitOp={onSubmitOp}
        nowIso="2026-10-01T10:00:00.000Z"
      />,
    );

    expect(
      screen.getByText("Cutoff tie at breaking line (rank =2)"),
    ).toBeTruthy();
    expect(
      screen.getByText(/2 teams tied for 1 place\(s\)/),
    ).toBeTruthy();

    // Quick-include first tied team (Cambridge 1)
    const includeButtons = screen.getAllByRole("button", {
      name: "Manually include",
    });
    fireEvent.click(includeButtons[0]);

    await waitFor(() => {
      expect(submitted).toHaveLength(1);
    });
    expect(submitted[0].type).toBe("break.team_override");
    expect(submitted[0].payload).toEqual({
      categoryId: "bc-open",
      teamId: "t2",
      override: "include",
    });
  });

  it("shows excluded remarks, supports break.compute, break.clear, break.categories_save, elimination.advance, and lock cancel", async () => {
    const submitted: OpRequest[] = [];
    const onSubmitOp = vi.fn(async (req: OpRequest): Promise<SubmitResult> => {
      submitted.push(req);
      return { ok: true, seq: 14, writes: [], committedPayload: req.payload };
    });
    const onCancelLock = vi.fn(async (lockId: string) => ({
      ok: true as const,
      lockId,
    }));

    const base = makeTwoTeamBreakState();
    // Give t3 (Oxford 2) higher speaks than t2 (Cambridge 1) so t3 ranks above the cutoff and is marked Capped
    const boostedBallots = base.ballots.map((b) =>
      b.id === "b2"
        ? {
            ...b,
            teamScores: {
              ...b.teamScores,
              NEG: { ...b.teamScores.NEG, totalSpeakerScore: 215 },
            },
          }
        : b,
    );
    // Apply an institution cap of 1 and an ineligible override so remarks appear, plus generatedBreak for Clear
    const state = makeTwoTeamBreakState({
      ballots: boostedBallots,
      breakCategories: [
        {
          ...base.breakCategories[0],
          maxPerInstitution: 1,
          teamOverrides: { t4: "ineligible" },
          generatedBreak: {
            breakingTeamIds: ["t1", "t2"],
            reserveTeamIds: [],
            generatedAt: "2026-10-01T09:30:00.000Z",
          },
        },
      ],
    });
    const statusWithLock: HostStatus = {
      ...EMPTY_STATUS,
      locks: [
        {
          lockId: "lock-brk-1",
          opType: "break.compute",
          actorRef: "host-owner",
          startedAt: "2026-10-01T10:00:00.000Z",
        },
      ],
    };

    render(
      <BreakView
        state={state}
        status={statusWithLock}
        onSubmitOp={onSubmitOp}
        onCancelLock={onCancelLock}
        nowIso="2026-10-01T10:00:00.000Z"
      />,
    );

    // Lock banner & cancel button for host owner
    expect(screen.getByText("Computing break…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(onCancelLock).toHaveBeenCalledWith("lock-brk-1");
    });

    // Excluded remarks rendered as text
    expect(screen.getByText("Capped (institution limit)")).toBeTruthy();
    expect(
      screen.getByText("Ineligible", { selector: "span.simpletab-badge" }),
    ).toBeTruthy();

    // Compute / Recompute break
    fireEvent.click(screen.getByRole("button", { name: "Recompute break" }));
    await waitFor(() => {
      expect(submitted.some((op) => op.type === "break.compute")).toBe(true);
    });

    // Clear break
    fireEvent.click(screen.getByRole("button", { name: "Clear break" }));
    await waitFor(() => {
      expect(submitted.some((op) => op.type === "break.clear")).toBe(true);
    });

    // Elimination advance
    fireEvent.click(screen.getByRole("button", { name: "Advance to next round" }));
    await waitFor(() => {
      expect(submitted.some((op) => op.type === "elimination.advance")).toBe(
        true,
      );
    });

    // Save new break category
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Novice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add category" }));
    await waitFor(() => {
      expect(submitted.some((op) => op.type === "break.categories_save")).toBe(
        true,
      );
    });
  });
});
