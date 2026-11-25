import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  applyOp,
  defaultRegistry,
  type Actor,
  type LateSubmissionRecord,
  type OpBallotSubmission,
  type OpRequest,
  type TournamentState,
} from "@simpletab/core/ops";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import { project } from "@simpletab/core/projection";
import type { Debate, TournamentFormat } from "@simpletab/core/types";
import type {
  HostStatus,
  ProjectedState,
  QrReceiveResult,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "react";
import { runnerFor } from "../actions/test-context";
import { ResultsView } from "./results-view";

function makeResultsState(
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
        ...(isBp ? [] : [{ id: "s1b", name: "Amy" }]),
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
        ...(isBp ? [] : [{ id: "s4b", name: "Drew" }]),
      ],
      breakCategories: [],
      speakerCategories: [],
    },
    ...(isBp
      ? [
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
        ]
      : []),
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
    permissions: BUILT_IN_ROLES.host_owner.permissions,
    versions: {
      "round:r1": 2,
      "debate:d1": 3,
    },
    tournament: {
      id: "t-1",
      name: "Results Test",
      shortName: "RT",
      slug: "results-test",
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
        stepReplyScore: 0.5,
        drawRule: "power_paired",
        sideAllocationRule: "balanced",
        ballotDoubleEntry: false,
        ballotCheckMode: "review",
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
        drawStatus: "released",
        feedbackWeight: 1,
        silent: false,
        motionsReleased: false,
        resultsReleased: false,
        completed: false,
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ],
    teams,
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
        teams: (isBp ? bpTeams : twoTeamTeams) as Debate["teams"],
        adjudicators: {
          chairId: "adj-1",
          chairName: "Chair One",
          panellistIds: [],
          panellistNames: [],
          traineeIds: [],
          traineeNames: [],
        },
      },
    ],
    motions: [],
    ballots: [],
    ballotIntake: [],
    lateSubmissions: [],
    feedback: [],
    breakCategories: [],
    ...overrides,
  };
}

function makeBpBallot(
  overrides: Partial<OpBallotSubmission> = {},
): OpBallotSubmission {
  return {
    id: "ballot-d1-v1",
    tournamentId: "t-1",
    roundId: "r1",
    debateId: "d1",
    version: 1,
    confirmed: false,
    discarded: false,
    submitterType: "tabroom",
    submitterId: "assistant-1",
    speakerScores: {
      OG: [
        { speakerId: "s1", speakerName: "Alice", position: 1, score: 78 },
        { speakerId: "s2", speakerName: "Bob", position: 2, score: 77 },
      ],
      OO: [
        { speakerId: "s3", speakerName: "Cara", position: 1, score: 76 },
        { speakerId: "s4", speakerName: "Dan", position: 2, score: 75 },
      ],
      CG: [
        { speakerId: "s5", speakerName: "Eve", position: 1, score: 74 },
        { speakerId: "s6", speakerName: "Frank", position: 2, score: 73 },
      ],
      CO: [
        { speakerId: "s7", speakerName: "Grace", position: 1, score: 72 },
        { speakerId: "s8", speakerName: "Hank", position: 2, score: 71 },
      ],
    } as OpBallotSubmission["speakerScores"],
    teamScores: {
      OG: { side: "OG", teamId: "t1", points: 3, totalSpeakerScore: 155, rank: 1, win: true },
      OO: { side: "OO", teamId: "t2", points: 2, totalSpeakerScore: 151, rank: 2, win: true },
      CG: { side: "CG", teamId: "t3", points: 1, totalSpeakerScore: 147, rank: 3, win: false },
      CO: { side: "CO", teamId: "t4", points: 0, totalSpeakerScore: 143, rank: 4, win: false },
    } as OpBallotSubmission["teamScores"],
    timestamp: "2026-10-01T07:45:00.000Z",
    ...overrides,
  };
}

const EMPTY_STATUS: HostStatus = {
  open: true,
  slug: "results-test",
  headSeq: 10,
  integrityOk: true,
  canSync: true,
  locks: [],
};

function runForState(
  state: ProjectedState,
  submit: (request: OpRequest) => Promise<SubmitResult>,
  receiveQrBallot?: (codes: string[]) => Promise<QrReceiveResult>,
) {
  return runnerFor({ state, submit, receiveQrBallot });
}

describe("ResultsView", () => {
  it("renders BP 4x2 ballot form, blocks submit on duplicate ranks and out-of-range scores, and submits valid ballot", async () => {
    const submitted: OpRequest[] = [];
    const onSubmitOp = vi.fn(async (req: OpRequest): Promise<SubmitResult> => {
      submitted.push(req);
      return {
        ok: true,
        seq: 11,
        writes: ["ballot:b1"],
        committedPayload: req.payload,
      };
    });

    const state = makeResultsState("bp");
    render(
      <ResultsView
        state={state}
        status={EMPTY_STATUS}
        run={runForState(state, onSubmitOp)}
      />,
    );

    expect(screen.getByText("Missing: 1")).toBeTruthy();

    // 4 teams x 2 speakers = 8 speaker score inputs
    const scoreInputs = [
      screen.getByLabelText("OG Speaker 1 score"),
      screen.getByLabelText("OG Speaker 2 score"),
      screen.getByLabelText("OO Speaker 1 score"),
      screen.getByLabelText("OO Speaker 2 score"),
      screen.getByLabelText("CG Speaker 1 score"),
      screen.getByLabelText("CG Speaker 2 score"),
      screen.getByLabelText("CO Speaker 1 score"),
      screen.getByLabelText("CO Speaker 2 score"),
    ];
    expect(scoreInputs).toHaveLength(8);

    const validScores = ["78", "77", "76", "75", "74", "73", "72", "71"];
    scoreInputs.forEach((input, idx) => {
      fireEvent.change(input, { target: { value: validScores[idx] } });
    });

    // Out-of-range score blocks submit
    fireEvent.change(scoreInputs[0], { target: { value: "105" } });
    expect(
      screen.getByText(/Substantive score \(105\) must be between 50 and 100/),
    ).toBeTruthy();
    const saveBtn = screen.getByRole("button", { name: "Save ballot" }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    // Restore valid score, set duplicate rank (OO rank = 1, same as OG)
    fireEvent.change(scoreInputs[0], { target: { value: "78" } });
    fireEvent.change(screen.getByLabelText("OO rank"), {
      target: { value: "1" },
    });
    expect(
      screen.getByText(/Give each team a different rank from 1st to 4th/),
    ).toBeTruthy();
    expect(saveBtn.disabled).toBe(true);

    // Restore OO rank = 2 -> valid, submits ballot.enter
    fireEvent.change(screen.getByLabelText("OO rank"), {
      target: { value: "2" },
    });
    expect(saveBtn.disabled).toBe(false);
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(submitted).toHaveLength(1);
    });
    expect(submitted[0].type).toBe("ballot.enter");
  });

  it("enforces two-team reply speaker rules and reply score range", async () => {
    const submitted: OpRequest[] = [];
    const onSubmitOp = vi.fn(async (req: OpRequest): Promise<SubmitResult> => {
      submitted.push(req);
      return {
        ok: true,
        seq: 11,
        writes: [],
        committedPayload: req.payload,
      };
    });

    const state = makeResultsState("uadc");
    render(
      <ResultsView
        state={state}
        status={EMPTY_STATUS}
        run={runForState(state, onSubmitOp)}
      />,
    );

    const affInputs = [
      screen.getByLabelText("Affirmative Speaker 1 score"),
      screen.getByLabelText("Affirmative Speaker 2 score"),
      screen.getByLabelText("Affirmative Speaker 3 score"),
      screen.getByLabelText("Affirmative Reply score"),
    ];
    const negInputs = [
      screen.getByLabelText("Negative Speaker 1 score"),
      screen.getByLabelText("Negative Speaker 2 score"),
      screen.getByLabelText("Negative Speaker 3 score"),
      screen.getByLabelText("Negative Reply score"),
    ];

    ["75", "76", "74", "38"].forEach((val, idx) => {
      fireEvent.change(affInputs[idx], { target: { value: val } });
    });
    ["73", "74", "72", "36"].forEach((val, idx) => {
      fireEvent.change(negInputs[idx], { target: { value: val } });
    });

    // 3rd substantive speaker (s1b / Amy) cannot give the reply
    fireEvent.change(screen.getByLabelText("Affirmative Reply"), {
      target: { value: "s1b" },
    });
    expect(
      screen.getByText(/reply must be given by one of the first 2 speakers/i),
    ).toBeTruthy();

    // Fix reply speaker to s1 (Alice), test out-of-range reply score
    fireEvent.change(screen.getByLabelText("Affirmative Reply"), {
      target: { value: "s1" },
    });
    fireEvent.change(affInputs[3], { target: { value: "60" } });
    expect(
      screen.getByText(/Reply score \(60\) must be between 25 and 50/),
    ).toBeTruthy();

    // Fix reply score -> valid and submits
    fireEvent.change(affInputs[3], { target: { value: "38" } });
    const saveBtn = screen.getByRole("button", { name: "Save ballot" }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(submitted).toHaveLength(1);
    });
    expect(submitted[0].type).toBe("ballot.enter");
  });

  it("hides first-entry values during blind double entry and flags mismatches", async () => {
    const submitted: OpRequest[] = [];
    const onSubmitOp = vi.fn(async (req: OpRequest): Promise<SubmitResult> => {
      submitted.push(req);
      return {
        ok: true,
        seq: 12,
        writes: [],
        committedPayload: req.payload,
      };
    });

    const firstBallot = makeBpBallot({
      submitterId: "assistant-1",
      confirmed: false,
    });
    const baseState = makeResultsState("bp");
    const blindState = makeResultsState("bp", {
      tournament: {
        ...baseState.tournament,
        preferences: {
          ...baseState.tournament.preferences,
          ballotDoubleEntry: true,
          ballotCheckMode: "blind",
        },
      },
      ballots: [firstBallot],
    });

    render(
      <ResultsView
        state={blindState}
        status={EMPTY_STATUS}
        currentActorId="assistant-2"
        run={runForState(blindState, onSubmitOp)}
      />,
    );

    expect(screen.getByText("Awaiting check: 1")).toBeTruthy();
    expect(screen.getByText("Hidden until blind check")).toBeTruthy();
    // First entry's speaker scores (155 / 78) must not be visible in the form or board
    expect(screen.queryByText(/OG: #1 \(155\)/)).toBeNull();
    expect(
      (screen.getByLabelText("OG Speaker 1 score") as HTMLInputElement).value,
    ).toBe("");

    // Enter disagreeing second entry (OG Speaker 1 = 79 instead of 78)
    const vals = ["79", "77", "76", "75", "74", "73", "72", "71"];
    [
      "OG Speaker 1 score",
      "OG Speaker 2 score",
      "OO Speaker 1 score",
      "OO Speaker 2 score",
      "CG Speaker 1 score",
      "CG Speaker 2 score",
      "CO Speaker 1 score",
      "CO Speaker 2 score",
    ].forEach((label, idx) => {
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: vals[idx] },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Submit blind check" }));

    await waitFor(() => {
      expect(submitted).toHaveLength(1);
    });
    expect(screen.getByText("Blind double-entry mismatch")).toBeTruthy();
    expect(screen.getByText(/OG speech 1/)).toBeTruthy();
    const enteredPayload = submitted[0].payload as { ballot: OpBallotSubmission };
    expect(enteredPayload.ballot.confirmed).toBe(false);
    expect(enteredPayload.ballot.checksVersion).toBe(1);
  });

  it("shows FORBIDDEN inline for tab_assistant after deadline, hides late list for assistant, and allows director to accept late items", async () => {
    const baseState = makeResultsState("bp");
    const lateItem: LateSubmissionRecord = {
      id: "late-1",
      roundId: "r1",
      debateId: "d1",
      receivedAt: "2026-10-01T08:05:00.000Z",
      deadline: "2026-10-01T08:00:00.000Z",
      source: "inbox",
      ballot: makeBpBallot({ id: "online-late-1", submitterType: "judge" }),
    };

    const fullState: TournamentState = {
      tournament: baseState.tournament,
      institutions: [],
      teams: baseState.teams,
      adjudicators: baseState.adjudicators,
      venues: baseState.venues,
      rounds: [
        {
          ...baseState.rounds[0],
          simpletab: {
            ballotDeadline: "2026-10-01T08:00:00.000Z",
            timeZone: "Asia/Dhaka",
          },
        },
      ],
      debates: baseState.debates,
      motions: [],
      ballots: [],
      ballotIntake: [],
      lateSubmissions: [lateItem],
      feedback: [],
      breakCategories: [],
      links: [],
      registrations: [],
      devices: [],
      roles: [],
      proposals: [],
      runtime: {
        portalEnforcing: true,
        now: "2026-10-01T08:05:00.000Z",
      },
      versions: baseState.versions,
    };

    const registry = defaultRegistry();
    const assistantActor: Actor = {
      ref: "assistant-1",
      type: "human",
      role: BUILT_IN_ROLES.tab_assistant,
      isHostOwner: false,
    };
    const directorActor: Actor = {
      ref: "director-1",
      type: "human",
      role: BUILT_IN_ROLES.tab_director,
      isHostOwner: false,
    };

    const assistantProjected: ProjectedState = {
      ...project(fullState, BUILT_IN_ROLES.tab_assistant),
      tournament: fullState.tournament,
      rounds: fullState.rounds,
      ballots: [],
      seq: 10,
      roleId: "tab_assistant",
      permissions: BUILT_IN_ROLES.tab_assistant.permissions,
      versions: fullState.versions,
    };

    const onAssistantSubmit = vi.fn(
      async (req: OpRequest): Promise<SubmitResult> => {
        const res = applyOp(fullState, req, assistantActor, registry);
        if (!res.ok) {
          return { ok: false, code: res.code, errors: res.errors, current: res.current };
        }
        return {
          ok: true,
          seq: 11,
          writes: res.writes,
          committedPayload: res.committedPayload,
        };
      },
    );

    const { rerender } = render(
      <ResultsView
        state={assistantProjected}
        status={EMPTY_STATUS}
        nowIso="2026-10-01T08:05:00.000Z"
        run={runForState(assistantProjected, onAssistantSubmit)}
      />,
    );

    expect(screen.getByText("Ballots close at 14:00 (Asia/Dhaka)")).toBeTruthy();
    expect(screen.getByText("Deadline passed")).toBeTruthy();
    expect(screen.queryByText(/Late online submissions/)).toBeNull();

    const vals = ["78", "77", "76", "75", "74", "73", "72", "71"];
    [
      "OG Speaker 1 score",
      "OG Speaker 2 score",
      "OO Speaker 1 score",
      "OO Speaker 2 score",
      "CG Speaker 1 score",
      "CG Speaker 2 score",
      "CO Speaker 1 score",
      "CO Speaker 2 score",
    ].forEach((label, idx) => {
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: vals[idx] },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Save ballot" }));

    await waitFor(() => {
      expect(screen.getByText("FORBIDDEN")).toBeTruthy();
    });
    expect(
      screen.getByText(/does not have permission "results\.enter_late"/),
    ).toBeTruthy();

    // Now render as tab_director: Late online submissions visible and Accept submits late ballot.enter
    const directorProjected: ProjectedState = {
      ...project(fullState, BUILT_IN_ROLES.tab_director),
      tournament: fullState.tournament,
      rounds: fullState.rounds,
      ballots: [],
      lateSubmissions: [lateItem],
      seq: 10,
      roleId: "tab_director",
      permissions: BUILT_IN_ROLES.tab_director.permissions,
      versions: fullState.versions,
    };

    const directorSubmitted: OpRequest[] = [];
    const onDirectorSubmit = vi.fn(
      async (req: OpRequest): Promise<SubmitResult> => {
        directorSubmitted.push(req);
        const res = applyOp(fullState, req, directorActor, registry);
        if (!res.ok) {
          return { ok: false, code: res.code, errors: res.errors, current: res.current };
        }
        return {
          ok: true,
          seq: 12,
          writes: res.writes,
          committedPayload: res.committedPayload,
        };
      },
    );

    rerender(
      <ResultsView
        state={directorProjected}
        status={EMPTY_STATUS}
        nowIso="2026-10-01T08:05:00.000Z"
        run={runForState(directorProjected, onDirectorSubmit)}
      />,
    );

    expect(screen.getByText("Late online submissions (1)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() => {
      expect(directorSubmitted).toHaveLength(1);
    });
    const acceptedPayload = directorSubmitted[0].payload as {
      ballot: OpBallotSubmission;
    };
    expect(acceptedPayload.ballot.late).toBe(true);
  });

  it("renders Late badge on late ballots, confirms/discards, and handles QR paste box", async () => {
    const submitted: OpRequest[] = [];
    const onSubmitOp = vi.fn(async (req: OpRequest): Promise<SubmitResult> => {
      submitted.push(req);
      return {
        ok: true,
        seq: 13,
        writes: [],
        committedPayload: req.payload,
      };
    });

    const lateDraft = makeBpBallot({ late: true, enteredBy: "director-1" });
    const stateNoLinks = makeResultsState("bp", {
      ballots: [lateDraft],
    });

    const { rerender } = render(
      <ResultsView
        state={stateNoLinks}
        status={EMPTY_STATUS}
        run={runForState(stateNoLinks, onSubmitOp)}
      />,
    );

    expect(screen.getAllByText("Late").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(submitted.some((op) => op.type === "ballot.confirm")).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => {
      expect(submitted.some((op) => op.type === "ballot.discard")).toBe(true);
    });

    // QR codes go to the host, which checks them; refusals are shown in words.
    const onReceiveQrBallot = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, kind: "needs_links", errors: [] })
      .mockResolvedValueOnce({ ok: true, seq: 14, roundId: "r1", debateId: "d1" });
    rerender(
      <ResultsView
        state={stateNoLinks}
        status={EMPTY_STATUS}
        run={runForState(stateNoLinks, onSubmitOp, onReceiveQrBallot)}
      />,
    );
    const qrBox = screen.getByLabelText("Paste QR ballot code (ST1… or ST1F… fragments)");
    fireEvent.change(qrBox, { target: { value: "ST1F.a.1.2.9.x.y  ST1F.a.2.2.9.x.z" } });
    fireEvent.click(screen.getByRole("button", { name: "Import QR ballot" }));
    await waitFor(() => {
      expect(screen.getByText(/QR import needs private links \(M3\)/)).toBeTruthy();
    });
    expect(onReceiveQrBallot).toHaveBeenCalledWith(["ST1F.a.1.2.9.x.y", "ST1F.a.2.2.9.x.z"]);

    fireEvent.change(qrBox, { target: { value: "ST1.body.tag" } });
    fireEvent.click(screen.getByRole("button", { name: "Import QR ballot" }));
    await waitFor(() => {
      expect(screen.getByText("Imported signed QR ballot.")).toBeTruthy();
    });
  });
});
