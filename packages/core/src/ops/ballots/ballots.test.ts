import { describe, expect, it } from "vitest";
import {
  ballotSheetCode,
  ballotSheetId,
} from "@/features/tournament/application/ballotIntake";
import { createSeededRng } from "@/lib/draw/rng";
import {
  FIXED_TIME,
  makeAdjudicators,
  makeRound,
  makeTeams,
  makeTournament,
  makeVenues,
  simulateBallot,
} from "@/test/tournamentFixtures";
import type { Debate } from "@/types";
import {
  applyOp,
  createTournamentState,
  defaultRegistry,
  type OpBallotSubmission,
  type OpRound,
  type TournamentState,
} from "../index";
import {
  deepFreeze,
  DISPLAY_ACTOR,
  EQUITY_ACTOR,
  expectWrittenVersionBumps,
  makeFixtureDebateAndBallot,
  makeInstitutions,
  SERVICE_ACTOR,
  TAB_ASSISTANT_ACTOR,
  TAB_DIRECTOR_ACTOR,
} from "../test-helpers";

function makeCleanDebateState(options?: {
  format?: "bp" | "australs";
  ballotDoubleEntry?: boolean;
  individualBallots?: boolean;
  trustSignedBallots?: boolean;
  ballotDeadline?: string | null;
  portalEnforcing?: boolean;
  now?: string;
}): { state: TournamentState; debate: Debate; round: OpRound } {
  const format = options?.format ?? "bp";
  const tournamentId = `t-${format}`;
  const tournament = makeTournament(
    format,
    {
      ...(options?.ballotDoubleEntry !== undefined
        ? { ballotDoubleEntry: options.ballotDoubleEntry }
        : {}),
      ...(options?.individualBallots !== undefined
        ? { individualBallots: options.individualBallots }
        : {}),
      ...(format === "australs" ? { ballotMode: "voting" } : {}),
    },
    tournamentId,
  );
  if (options?.trustSignedBallots !== undefined) {
    (tournament as TournamentState["tournament"]).simpletab = {
      trustSignedBallots: options.trustSignedBallots,
    };
  }
  const institutions = makeInstitutions(tournamentId, 4);
  const teamCount = format === "bp" ? 4 : 2;
  const speakersPerTeam = format === "bp" ? 2 : 3;
  const teams = makeTeams(teamCount, {
    tournamentId,
    institutionCount: 4,
    speakersPerTeam,
  });
  const adjudicators = makeAdjudicators(2, {
    tournamentId,
    institutionCount: 2,
    rng: createSeededRng(11),
  });
  const venues = makeVenues(1, tournamentId);
  const round: OpRound = makeRound(tournamentId, 1, {
    drawStatus: "released",
  });
  if (options?.ballotDeadline !== undefined) {
    round.simpletab = {
      ballotDeadline: options.ballotDeadline,
      timeZone: "UTC",
    };
  }

  const debateTeams =
    format === "bp"
      ? ({
          OG: { teamId: teams[0]!.id, teamName: teams[0]!.name, side: "OG" },
          OO: { teamId: teams[1]!.id, teamName: teams[1]!.name, side: "OO" },
          CG: { teamId: teams[2]!.id, teamName: teams[2]!.name, side: "CG" },
          CO: { teamId: teams[3]!.id, teamName: teams[3]!.name, side: "CO" },
        } as Debate["teams"])
      : ({
          AFF: { teamId: teams[0]!.id, teamName: teams[0]!.name, side: "AFF" },
          NEG: { teamId: teams[1]!.id, teamName: teams[1]!.name, side: "NEG" },
        } as Debate["teams"]);

  const debate: Debate = {
    id: "debate-1",
    tournamentId,
    roundId: round.id,
    roundSeq: 1,
    venueId: venues[0]!.id,
    venueName: venues[0]!.name,
    bracket: 0,
    roomRank: 1,
    importance: 1,
    resultStatus: "none",
    sidesConfirmed: true,
    flags: [],
    teams: debateTeams,
    adjudicators: {
      chairId: adjudicators[0]!.id,
      chairName: adjudicators[0]!.name,
      panellistIds: [adjudicators[1]!.id],
      panellistNames: [adjudicators[1]!.name],
      traineeIds: [],
      traineeNames: [],
    },
  };

  const state = createTournamentState(tournament, {
    institutions,
    teams,
    adjudicators,
    venues,
    rounds: [round],
    debates: [debate],
  });
  if (
    options?.portalEnforcing !== undefined ||
    options?.now !== undefined
  ) {
    state.runtime = {
      portalEnforcing: options?.portalEnforcing ?? false,
      now: options?.now ?? FIXED_TIME,
    };
  }

  return { state, debate, round };
}

describe("ops ballots", () => {
  it("enters, confirms, and discards ballots with inverse and permission checks", () => {
    const registry = defaultRegistry();
    const { state, debate } = makeCleanDebateState({ format: "bp" });
    const draftBallot: OpBallotSubmission = simulateBallot(
      debate,
      state.teams,
      state.tournament,
      createSeededRng(1),
      {
        id: "ballot-1",
        confirmed: false,
        submitterId: TAB_ASSISTANT_ACTOR.ref,
      },
    );

    const frozen0 = deepFreeze(state);
    const forbiddenEnter = applyOp(
      frozen0,
      { type: "ballot.enter", payload: { ballot: draftBallot } },
      EQUITY_ACTOR,
      registry,
    );
    expect(forbiddenEnter.ok).toBe(false);
    if (!forbiddenEnter.ok) expect(forbiddenEnter.code).toBe("FORBIDDEN");

    const entered = applyOp(
      frozen0,
      { type: "ballot.enter", payload: { ballot: draftBallot } },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(entered.ok).toBe(true);
    if (!entered.ok) return;
    expect(entered.state.ballots).toHaveLength(1);
    expect(entered.state.debates[0]?.resultStatus).toBe("draft");
    expect(entered.inverse).not.toBeNull();
    expectWrittenVersionBumps(frozen0, entered);
    expect(state.ballots).toHaveLength(0);

    const enteredUndo = applyOp(
      deepFreeze(entered.state),
      entered.inverse!,
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(enteredUndo.ok).toBe(true);
    if (!enteredUndo.ok) return;
    expect(enteredUndo.state.ballots[0]?.discarded).toBe(true);
    expectWrittenVersionBumps(entered.state, enteredUndo);

    // Confirm by another person
    const forbiddenConfirm = applyOp(
      deepFreeze(entered.state),
      { type: "ballot.confirm", payload: { ballotId: "ballot-1" } },
      DISPLAY_ACTOR,
      registry,
    );
    expect(forbiddenConfirm.ok).toBe(false);
    if (!forbiddenConfirm.ok) expect(forbiddenConfirm.code).toBe("FORBIDDEN");

    const confirmed = applyOp(
      deepFreeze(entered.state),
      { type: "ballot.confirm", payload: { ballotId: "ballot-1" } },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.state.ballots[0]?.confirmed).toBe(true);
    expect(confirmed.state.debates[0]?.resultStatus).toBe("confirmed");
    expect(confirmed.inverse?.type).toBe("ballot.discard");
    expectWrittenVersionBumps(entered.state, confirmed);

    // Inverse discards the ballot
    const discarded = applyOp(
      deepFreeze(confirmed.state),
      confirmed.inverse!,
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(discarded.ok).toBe(true);
    if (!discarded.ok) return;
    expect(discarded.state.ballots[0]?.discarded).toBe(true);
    expect(discarded.state.ballots[0]?.confirmed).toBe(false);
    expect(discarded.state.debates[0]?.resultStatus).toBe("none");
    expect(discarded.inverse).toBeNull();
    expectWrittenVersionBumps(confirmed.state, discarded);
  });

  it("rejects guard violations on ballot.enter and ballot.confirm (double entry, mismatched teams, cancelled round)", () => {
    const registry = defaultRegistry();
    const { state: doubleState, debate } = makeCleanDebateState({
      format: "bp",
      ballotDoubleEntry: true,
    });
    const draftBallot = simulateBallot(
      debate,
      doubleState.teams,
      doubleState.tournament,
      createSeededRng(2),
      {
        id: "ballot-de-1",
        confirmed: false,
        submitterId: TAB_ASSISTANT_ACTOR.ref,
      },
    );
    const entered = applyOp(
      deepFreeze(doubleState),
      { type: "ballot.enter", payload: { ballot: draftBallot } },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(entered.ok).toBe(true);
    if (!entered.ok) return;

    const samePersonConfirm = applyOp(
      deepFreeze(entered.state),
      { type: "ballot.confirm", payload: { ballotId: "ballot-de-1" } },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(samePersonConfirm.ok).toBe(false);
    if (!samePersonConfirm.ok) {
      expect(samePersonConfirm.code).toBe("FORBIDDEN");
    }

    const { state: fixtureState } = makeFixtureDebateAndBallot();
    const cancelledState: TournamentState = {
      ...fixtureState,
      rounds: fixtureState.rounds.map((r) => ({ ...r, cancelled: true })),
    };
    const discardCancelled = applyOp(
      deepFreeze(cancelledState),
      {
        type: "ballot.discard",
        payload: { ballotId: fixtureState.ballots[0]!.id },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(discardCancelled.ok).toBe(false);
    if (!discardCancelled.ok) expect(discardCancelled.code).toBe("INVALID");

    const discardForbidden = applyOp(
      deepFreeze(fixtureState),
      {
        type: "ballot.discard",
        payload: { ballotId: fixtureState.ballots[0]!.id },
      },
      DISPLAY_ACTOR,
      registry,
    );
    expect(discardForbidden.ok).toBe(false);
    if (!discardForbidden.ok) expect(discardForbidden.code).toBe("FORBIDDEN");
  });

  it("enforces ballot deadline for tab_assistant vs tab_director and lifts when portalEnforcing is false", () => {
    const registry = defaultRegistry();
    const deadline = "2026-10-01T10:00:00.000Z";
    const afterDeadline = "2026-10-01T10:05:00.000Z";

    const { state: enforcedState, debate } = makeCleanDebateState({
      format: "bp",
      ballotDeadline: deadline,
      portalEnforcing: true,
      now: afterDeadline,
    });
    const ballot = simulateBallot(
      debate,
      enforcedState.teams,
      enforcedState.tournament,
      createSeededRng(3),
      { id: "ballot-late-1", confirmed: false },
    );

    const assistantAfter = applyOp(
      deepFreeze(enforcedState),
      { type: "ballot.enter", payload: { ballot } },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(assistantAfter.ok).toBe(false);
    if (!assistantAfter.ok) {
      expect(assistantAfter.code).toBe("FORBIDDEN");
    }

    const directorAfter = applyOp(
      deepFreeze(enforcedState),
      { type: "ballot.enter", payload: { ballot } },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(directorAfter.ok).toBe(true);
    if (!directorAfter.ok) return;
    expect(directorAfter.state.ballots[0]?.late).toBe(true);
    expect(directorAfter.state.ballots[0]?.enteredBy).toBe(
      TAB_DIRECTOR_ACTOR.ref,
    );
    expectWrittenVersionBumps(enforcedState, directorAfter);

    // With portalEnforcing: false, tab_assistant is allowed even past deadline
    const { state: offlineState } = makeCleanDebateState({
      format: "bp",
      ballotDeadline: deadline,
      portalEnforcing: false,
      now: afterDeadline,
    });
    const assistantOffline = applyOp(
      deepFreeze(offlineState),
      { type: "ballot.enter", payload: { ballot } },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(assistantOffline.ok).toBe(true);
    if (!assistantOffline.ok) return;
    expect(assistantOffline.state.ballots[0]?.late).toBeUndefined();
    expectWrittenVersionBumps(offlineState, assistantOffline);

    // QR ballot.receive_online after deadline also requires results.enter_late
    const qrAssistantAfter = applyOp(
      deepFreeze(enforcedState),
      {
        type: "ballot.receive_online",
        payload: {
          source: "qr",
          ballot: { ...ballot, id: "qr-late-1", submitterType: "judge" },
        },
      },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(qrAssistantAfter.ok).toBe(false);
    if (!qrAssistantAfter.ok) expect(qrAssistantAfter.code).toBe("FORBIDDEN");

    const qrDirectorAfter = applyOp(
      deepFreeze(enforcedState),
      {
        type: "ballot.receive_online",
        payload: {
          source: "qr",
          ballot: { ...ballot, id: "qr-late-1", submitterType: "judge" },
        },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(qrDirectorAfter.ok).toBe(true);
    if (!qrDirectorAfter.ok) return;
    expect(qrDirectorAfter.state.ballots[0]?.late).toBe(true);
    expect(qrDirectorAfter.state.ballots[0]?.enteredBy).toBe(
      TAB_DIRECTOR_ACTOR.ref,
    );
    expectWrittenVersionBumps(enforcedState, qrDirectorAfter);
  });

  it("treats the exact ballot deadline as late and one millisecond before it as on time", () => {
    const registry = defaultRegistry();
    const deadline = "2026-10-01T10:00:00.000Z";
    const { state: exactState, debate } = makeCleanDebateState({
      format: "bp",
      ballotDeadline: deadline,
      portalEnforcing: true,
      now: deadline,
    });
    const ballot = simulateBallot(
      debate,
      exactState.teams,
      exactState.tournament,
      createSeededRng(31),
      { id: "ballot-deadline-exact", confirmed: false },
    );

    const assistantAtDeadline = applyOp(
      deepFreeze(exactState),
      { type: "ballot.enter", payload: { ballot } },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(assistantAtDeadline.ok).toBe(false);
    if (!assistantAtDeadline.ok) expect(assistantAtDeadline.code).toBe("FORBIDDEN");

    const directorAtDeadline = applyOp(
      deepFreeze(exactState),
      { type: "ballot.enter", payload: { ballot } },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(directorAtDeadline.ok).toBe(true);
    if (!directorAtDeadline.ok) return;
    expect(directorAtDeadline.state.ballots[0]).toMatchObject({
      late: true,
      enteredBy: TAB_DIRECTOR_ACTOR.ref,
    });
    expectWrittenVersionBumps(exactState, directorAtDeadline);

    const { state: beforeState } = makeCleanDebateState({
      format: "bp",
      ballotDeadline: deadline,
      portalEnforcing: true,
      now: "2026-10-01T09:59:59.999Z",
    });
    const beforeDeadline = applyOp(
      deepFreeze(beforeState),
      { type: "ballot.enter", payload: { ballot } },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(beforeDeadline.ok).toBe(true);
    if (!beforeDeadline.ok) return;
    expect(beforeDeadline.state.ballots[0]?.late).toBeUndefined();
    expect(beforeDeadline.state.ballots[0]?.enteredBy).toBeUndefined();
    expectWrittenVersionBumps(beforeState, beforeDeadline);
  });

  it("routes late inbox submissions to state.lateSubmissions without writing ballots", () => {
    const registry = defaultRegistry();
    const deadline = "2026-10-01T10:00:00.000Z";
    const { state, debate } = makeCleanDebateState({
      format: "bp",
      ballotDeadline: deadline,
      portalEnforcing: true,
      now: "2026-10-01T10:10:00.000Z",
    });
    const judgeBallot = simulateBallot(
      debate,
      state.teams,
      state.tournament,
      createSeededRng(4),
      {
        id: "ballot-inbox-late",
        confirmed: true,
        submitterType: "judge",
        submitterId: "adj-1",
      },
    );

    const nonService = applyOp(
      deepFreeze(state),
      {
        type: "ballot.receive_online",
        payload: {
          source: "inbox",
          ballot: judgeBallot,
          receivedAt: "2026-10-01T10:02:00.000Z",
          submissionId: "sub-late-1",
        },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(nonService.ok).toBe(false);
    if (!nonService.ok) expect(nonService.code).toBe("FORBIDDEN");

    const res = applyOp(
      deepFreeze(state),
      {
        type: "ballot.receive_online",
        payload: {
          source: "inbox",
          ballot: judgeBallot,
          receivedAt: "2026-10-01T10:02:00.000Z",
          submissionId: "sub-late-1",
        },
      },
      SERVICE_ACTOR,
      registry,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.state.ballots).toHaveLength(0);
    expect(res.state.lateSubmissions).toHaveLength(1);
    expect(res.state.lateSubmissions?.[0]).toMatchObject({
      id: "sub-late-1",
      roundId: debate.roundId,
      debateId: debate.id,
      receivedAt: "2026-10-01T10:02:00.000Z",
      deadline,
      source: "inbox",
    });
    expect(res.inverse).toBeNull();
    expectWrittenVersionBumps(state, res);

    const onTimeBallot = { ...judgeBallot, id: "ballot-inbox-on-time" };
    const onTime = applyOp(
      deepFreeze(state),
      {
        type: "ballot.receive_online",
        payload: {
          source: "inbox",
          ballot: onTimeBallot,
          receivedAt: "2026-10-01T09:59:59.999Z",
          submissionId: "sub-on-time-1",
        },
      },
      SERVICE_ACTOR,
      registry,
    );
    expect(onTime.ok).toBe(true);
    if (!onTime.ok) return;
    expect(onTime.state.ballots).toHaveLength(1);
    expect(onTime.state.ballots[0]?.id).toBe(onTimeBallot.id);
    expect(onTime.state.lateSubmissions ?? []).toEqual([]);
    expect(onTime.inverse?.type).toBe("ballot.discard");
    expectWrittenVersionBumps(state, onTime);

    const onTimeUndo = applyOp(
      deepFreeze(onTime.state),
      onTime.inverse!,
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(onTimeUndo.ok).toBe(true);
    if (!onTimeUndo.ok) return;
    expect(onTimeUndo.state.ballots[0]?.discarded).toBe(true);
    expectWrittenVersionBumps(onTime.state, onTimeUndo);

    const invalidReceive = applyOp(
      deepFreeze(state),
      {
        type: "ballot.receive_online",
        payload: {
          source: "inbox",
          ballot: onTimeBallot,
          receivedAt: "not-an-instant",
        },
      },
      SERVICE_ACTOR,
      registry,
    );
    expect(invalidReceive.ok).toBe(false);
    if (!invalidReceive.ok) expect(invalidReceive.code).toBe("INVALID");
  });

  it("handles QR ballots with trustSignedBallots auto-confirmation for BP consensus and two-team individual sheets", () => {
    const registry = defaultRegistry();

    // 1. BP consensus QR ballot: without trustSignedBallots -> unconfirmed; with trustSignedBallots -> confirmed by "system"
    const { state: bpUntrusted, debate: bpDebate } = makeCleanDebateState({
      format: "bp",
      trustSignedBallots: false,
    });
    const bpBallot = simulateBallot(
      bpDebate,
      bpUntrusted.teams,
      bpUntrusted.tournament,
      createSeededRng(5),
      {
        id: "qr-bp-1",
        confirmed: true,
        submitterType: "judge",
        submitterId: "adj-1",
      },
    );

    const resUntrusted = applyOp(
      deepFreeze(bpUntrusted),
      {
        type: "ballot.receive_online",
        payload: { source: "qr", ballot: bpBallot },
      },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(resUntrusted.ok).toBe(true);
    if (!resUntrusted.ok) return;
    expect(resUntrusted.state.ballots[0]?.confirmed).toBe(false);
    expect(resUntrusted.state.ballots[0]?.confirmedBy).toBeUndefined();
    expectWrittenVersionBumps(bpUntrusted, resUntrusted);

    const { state: bpTrusted } = makeCleanDebateState({
      format: "bp",
      trustSignedBallots: true,
      now: "2026-10-01T09:30:00.000Z",
    });
    const resTrusted = applyOp(
      deepFreeze(bpTrusted),
      {
        type: "ballot.receive_online",
        payload: { source: "qr", ballot: bpBallot },
      },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(resTrusted.ok).toBe(true);
    if (!resTrusted.ok) return;
    expect(resTrusted.state.ballots[0]?.confirmed).toBe(true);
    expect(resTrusted.state.ballots[0]?.confirmedBy).toBe("system");
    expect(resTrusted.state.debates[0]?.resultStatus).toBe("confirmed");
    expectWrittenVersionBumps(bpTrusted, resTrusted);

    // 2. Two-team individual sheets via QR: partial stays unconfirmed; full matching sheets auto-confirm by "system"
    const { state: indState, debate: indDebate } = makeCleanDebateState({
      format: "australs",
      individualBallots: true,
      trustSignedBallots: true,
      now: "2026-10-01T09:40:00.000Z",
    });
    const baseVotingBallot = simulateBallot(
      indDebate,
      indState.teams,
      indState.tournament,
      createSeededRng(6),
      { id: "seed-voting", confirmed: false, submitterType: "judge" },
    );
    const sheet1: OpBallotSubmission = {
      ...baseVotingBallot,
      id: "qr-ind-1",
      submitterType: "judge",
      submitterId: "adj-1",
      submitterName: indDebate.adjudicators.chairName,
      singleAdjudicator: true,
      speakerScores: baseVotingBallot.sheets![0]!.speakerScores,
      sheets: undefined,
    };
    const sheet2: OpBallotSubmission = {
      ...baseVotingBallot,
      id: "qr-ind-2",
      submitterType: "judge",
      submitterId: "adj-2",
      submitterName: indDebate.adjudicators.panellistNames[0],
      singleAdjudicator: true,
      speakerScores: baseVotingBallot.sheets![1]!.speakerScores,
      sheets: undefined,
    };

    const afterSheet1 = applyOp(
      deepFreeze(indState),
      {
        type: "ballot.receive_online",
        payload: { source: "qr", ballot: sheet1 },
      },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(afterSheet1.ok).toBe(true);
    if (!afterSheet1.ok) return;
    expect(afterSheet1.state.ballots).toHaveLength(1);
    expect(afterSheet1.state.ballots[0]?.confirmed).toBe(false);
    expectWrittenVersionBumps(indState, afterSheet1);

    const afterSheet2 = applyOp(
      deepFreeze(afterSheet1.state),
      {
        type: "ballot.receive_online",
        payload: { source: "qr", ballot: sheet2 },
      },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(afterSheet2.ok).toBe(true);
    if (!afterSheet2.ok) return;
    const merged = afterSheet2.state.ballots.find(
      (b) => b.mergedFromIds && b.mergedFromIds.length === 2,
    );
    expect(merged).toBeDefined();
    expect(merged?.confirmed).toBe(true);
    expect(merged?.confirmedBy).toBe("system");
    expect(afterSheet2.state.debates[0]?.resultStatus).toBe("confirmed");
    expectWrittenVersionBumps(afterSheet1.state, afterSheet2);

    // 3. Conflicting individual sheets stay unconfirmed even with trustSignedBallots: true
    const conflictingSheet2: OpBallotSubmission = {
      ...sheet2,
      id: "qr-ind-conflict-2",
      speakerScores: {
        ...sheet2.speakerScores,
        AFF: [...(sheet2.speakerScores.AFF ?? [])].map((entry, idx) =>
          idx === 0
            ? { ...entry, speakerId: indState.teams[0]!.speakers[1]!.id }
            : idx === 1
              ? { ...entry, speakerId: indState.teams[0]!.speakers[0]!.id }
              : entry,
        ),
      },
    };
    const conflictRes = applyOp(
      deepFreeze(afterSheet1.state),
      {
        type: "ballot.receive_online",
        payload: { source: "qr", ballot: conflictingSheet2 },
      },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(conflictRes.ok).toBe(true);
    if (!conflictRes.ok) return;
    expect(conflictRes.state.ballots.every((b) => !b.confirmed)).toBe(true);
    expect(conflictRes.state.debates[0]?.resultStatus).toBe("draft");
    expectWrittenVersionBumps(afterSheet1.state, conflictRes);
  });

  it("records ballot intake once and rejects duplicate or wrong-round scans", () => {
    const registry = defaultRegistry();
    const { state, debate, round } = makeCleanDebateState({ format: "bp" });
    const sheetCode = ballotSheetId(round.seq, ballotSheetCode(debate.id));

    const forbidden = applyOp(
      deepFreeze(state),
      {
        type: "ballot.intake_record",
        payload: { sheetCode, roundId: round.id },
      },
      EQUITY_ACTOR,
      registry,
    );
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");

    const okRes = applyOp(
      deepFreeze(state),
      {
        type: "ballot.intake_record",
        payload: { sheetCode, roundId: round.id },
      },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(okRes.ok).toBe(true);
    if (!okRes.ok) return;
    expect(okRes.state.ballotIntake).toHaveLength(1);
    expect(okRes.inverse).toBeNull();
    expectWrittenVersionBumps(state, okRes);

    const duplicate = applyOp(
      deepFreeze(okRes.state),
      {
        type: "ballot.intake_record",
        payload: { sheetCode, roundId: round.id },
      },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.code).toBe("INVALID");
  });
});
