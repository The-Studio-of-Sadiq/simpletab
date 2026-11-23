import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OpRequest } from "@simpletab/core/ops";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import type { Debate } from "@simpletab/core/types";
import type {
  HostStatus,
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "react";
import { FeedbackView } from "./feedback-view";

function makeFeedbackState(
  overrides: Partial<ProjectedState> = {},
): ProjectedState {
  return {
    seq: 4,
    roleId: "host_owner",
    permissions: BUILT_IN_ROLES.host_owner.permissions,
    versions: {
      "feedback:fb-1": 1,
    },
    tournament: {
      id: "t-1",
      name: "Feedback Test",
      shortName: "FT",
      slug: "feedback-test",
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
        feedbackEnabled: true,
        feedbackMinScore: 1,
        feedbackMaxScore: 5,
        feedbackPath: "two_way",
        feedbackQuestions: [
          {
            id: "q-clarity",
            label: "Explanation clarity",
            type: "text",
            required: true,
          },
        ],
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
        drawStatus: "released",
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
        tournamentId: "t-1",
        name: "Team Alpha",
        speakers: [
          { id: "s1", name: "Alice" },
          { id: "s2", name: "Bob" },
        ],
        breakCategories: [],
        speakerCategories: [],
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
      },
    ],
    adjudicators: [
      {
        id: "adj-1",
        tournamentId: "t-1",
        name: "Chair One",
        baseScore: 8,
        trainee: false,
        independent: true,
        conflicts: [],
      },
      {
        id: "adj-2",
        tournamentId: "t-1",
        name: "Panel Two",
        baseScore: 7,
        trainee: false,
        independent: true,
        conflicts: [],
      },
    ],
    institutions: [],
    venues: [{ id: "v1", tournamentId: "t-1", name: "Hall A", priority: 10 }],
    debates: [
      {
        id: "d1",
        tournamentId: "t-1",
        roundId: "r1",
        roundSeq: 1,
        venueId: "v1",
        venueName: "Hall A",
        bracket: 0,
        roomRank: 1,
        importance: 10,
        resultStatus: "none",
        sidesConfirmed: true,
        flags: [],
        teams: {
          OG: { teamId: "t1", teamName: "Team Alpha", side: "OG" },
          OO: { teamId: "t2", teamName: "Team Beta", side: "OO" },
          CG: { teamId: "t3", teamName: "Team Gamma", side: "CG" },
          CO: { teamId: "t4", teamName: "Team Delta", side: "CO" },
        } as Debate["teams"],
        adjudicators: {
          chairId: "adj-1",
          chairName: "Chair One",
          panellistIds: ["adj-2"],
          panellistNames: ["Panel Two"],
          traineeIds: [],
          traineeNames: [],
        },
      },
    ],
    motions: [],
    ballots: [],
    feedback: [
      {
        id: "fb-1",
        tournamentId: "t-1",
        roundId: "r1",
        debateId: "d1",
        targetType: "adjudicator",
        targetAdjudicatorId: "adj-1",
        targetAdjudicatorName: "Chair One",
        sourceType: "team",
        sourceId: "t1",
        sourceName: "Team Alpha",
        score: 4,
        confirmed: false,
        timestamp: "2026-10-01T08:00:00.000Z",
      },
    ],
    breakCategories: [],
    ...overrides,
  };
}

const EMPTY_STATUS: HostStatus = {
  open: true,
  slug: "feedback-test",
  headSeq: 4,
  integrityOk: true,
  canSync: true,
  locks: [],
};

describe("FeedbackView", () => {
  it("hides feedback screen content when role lacks feedback.view", () => {
    const state = makeFeedbackState({
      roleId: "tab_assistant",
      permissions: BUILT_IN_ROLES.tab_assistant.permissions,
    });

    render(
      <FeedbackView
        state={state}
        status={EMPTY_STATUS}
        onSubmitOp={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/does not have feedback\.view permission/i),
    ).toBeTruthy();
    expect(screen.queryByText("Feedback progress")).toBeNull();
    expect(screen.queryByText(/Feedback submissions/)).toBeNull();
    expect(screen.queryByLabelText("Explanation clarity *")).toBeNull();
  });

  it("shows progress, submits feedback.enter with custom questions, and confirms/ignores via feedback.review", async () => {
    const submitted: OpRequest[] = [];
    const onSubmitOp = vi.fn(async (req: OpRequest): Promise<SubmitResult> => {
      submitted.push(req);
      return {
        ok: true,
        seq: 5,
        writes: [],
        committedPayload: req.payload,
      };
    });

    render(
      <FeedbackView
        state={makeFeedbackState()}
        status={EMPTY_STATUS}
        onSubmitOp={onSubmitOp}
      />,
    );

    expect(screen.getByText("1 of 6 submitted")).toBeTruthy();

    // Missing required question blocks submit
    fireEvent.click(screen.getByRole("button", { name: "Submit feedback" }));
    await waitFor(() => {
      expect(screen.getByText(/Please answer “Explanation clarity”/)).toBeTruthy();
    });
    expect(submitted).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Explanation clarity *"), {
      target: { value: "Very clear comparative." },
    });
    fireEvent.change(screen.getByLabelText("Score (1–5)"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit feedback" }));

    await waitFor(() => {
      expect(submitted.some((op) => op.type === "feedback.enter")).toBe(true);
    });
    const enterOp = submitted.find((op) => op.type === "feedback.enter")!;
    expect(
      (enterOp.payload as { feedback: { answers: Record<string, unknown> } })
        .feedback.answers,
    ).toEqual({ "q-clarity": "Very clear comparative." });

    // Review actions on existing fb-1
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(submitted.some((op) => op.type === "feedback.review")).toBe(true);
    });
    const confirmOp = submitted.find((op) => op.type === "feedback.review")!;
    expect(confirmOp.expectedVersions).toEqual({ "feedback:fb-1": 1 });
    expect(confirmOp.payload).toEqual({
      feedbackId: "fb-1",
      confirmed: true,
      ignored: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));
    await waitFor(() => {
      expect(
        submitted.filter((op) => op.type === "feedback.review"),
      ).toHaveLength(2);
    });
  });
});
