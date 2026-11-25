import type {
  LateSubmissionRecord,
  OpBallotSubmission,
} from "@simpletab/core/ops";
import type { ProjectedState, SubmitResult } from "@simpletab/host/lib/common/host-protocol";
import { describe, expect, it } from "vitest";
import type { TournamentStoreSnapshot } from "../store/tournament-store";
import {
  acceptLateBallotAction,
  confirmBallotAction,
  discardBallotAction,
  enterBallotAction,
  importQrBallotAction,
  recordBallotIntakeAction,
  RESULTS_ACTIONS,
  RESULTS_PAGE,
} from "./results-actions";
import { fakeStore, scriptedPrompts, testContext } from "./test-context";

const SUBMIT = {
  ok: true,
  seq: 1,
  writes: [],
  committedPayload: null,
} as unknown as SubmitResult;

function ballot(patch: Partial<OpBallotSubmission> = {}): OpBallotSubmission {
  return {
    id: "b1",
    tournamentId: "t-1",
    roundId: "r1",
    debateId: "d1",
    version: 1,
    confirmed: false,
    discarded: false,
    submitterType: "tabroom",
    speakerScores: {},
    teamScores: {},
    timestamp: "2026-11-25T08:00:00.000Z",
    ...patch,
  } as OpBallotSubmission;
}

function lateSubmission(): LateSubmissionRecord {
  return {
    id: "late-1",
    roundId: "r1",
    debateId: "d1",
    receivedAt: "2026-11-25T08:10:00.000Z",
    deadline: "2026-11-25T08:00:00.000Z",
    source: "inbox",
    ballot: ballot({ id: "online-late", submitterType: "judge" }),
  };
}

function resultsState(patch: Partial<ProjectedState> = {}): ProjectedState {
  const sides = ["OG", "OO", "CG", "CO"] as const;
  return {
    seq: 10,
    roleId: "host_owner",
    permissions: [
      "results.enter",
      "results.enter_late",
      "results.confirm_others",
      "ballots.intake",
    ],
    versions: {
      "debate:d1": 3,
      "ballot:b1": 1,
    },
    tournament: {
      id: "t-1",
      format: "bp",
      preferences: {
        teamsInDebate: 4,
        substantiveSpeakers: 2,
        replyScoresEnabled: false,
        minSpeakerScore: 50,
        maxSpeakerScore: 100,
        stepSpeakerScore: 1,
        ballotDoubleEntry: false,
        ballotCheckMode: "review",
      },
    },
    rounds: [
      {
        id: "r1",
        tournamentId: "t-1",
        seq: 1,
        name: "Round 1",
        stage: "preliminary",
        drawStatus: "released",
        simpletab: {},
      },
    ],
    teams: sides.map((side, index) => ({
      id: `t${index + 1}`,
      tournamentId: "t-1",
      name: `Team ${index + 1}`,
      speakers: [
        { id: `s${index * 2 + 1}`, name: `Speaker ${index * 2 + 1}` },
        { id: `s${index * 2 + 2}`, name: `Speaker ${index * 2 + 2}` },
      ],
      breakCategories: [],
      speakerCategories: [],
    })),
    adjudicators: [{ id: "a1", tournamentId: "t-1", name: "Chair", trainee: false }],
    debates: [
      {
        id: "d1",
        tournamentId: "t-1",
        roundId: "r1",
        roundSeq: 1,
        bracket: 0,
        roomRank: 1,
        importance: 10,
        resultStatus: "none",
        sidesConfirmed: true,
        flags: [],
        teams: Object.fromEntries(
          sides.map((side, index) => [
            side,
            { teamId: `t${index + 1}`, teamName: `Team ${index + 1}`, side },
          ]),
        ),
        adjudicators: {
          chairId: "a1",
          chairName: "Chair",
          panellistIds: [],
          panellistNames: [],
          traineeIds: [],
          traineeNames: [],
        },
      },
    ],
    motions: [],
    ballots: [ballot()],
    lateSubmissions: [],
    feedback: [],
    breakCategories: [],
    ...patch,
  } as unknown as ProjectedState;
}

function can(
  action: { isEnabled?: (snapshot: TournamentStoreSnapshot) => boolean },
  state: ProjectedState | null,
): boolean {
  const { store } = fakeStore(state, SUBMIT);
  return action.isEnabled?.(store.getSnapshot()) ?? false;
}

describe("results actions", () => {
  it("registers one command per Results mutation, gated by an open tournament and permissions", () => {
    expect(RESULTS_PAGE).toBe("simpletab-results-widget");
    expect(RESULTS_ACTIONS.map((action) => action.id)).toEqual([
      "simpletab.results.enter-ballot",
      "simpletab.results.confirm-ballot",
      "simpletab.results.discard-ballot",
      "simpletab.results.accept-late",
      "simpletab.results.import-qr",
      "simpletab.results.record-intake",
    ]);
    for (const action of RESULTS_ACTIONS) {
      expect(action.page).toBe(RESULTS_PAGE);
      expect(action.labelKey).toMatch(/^action\.results\./);
      const enabledState =
        action === acceptLateBallotAction
          ? resultsState({ lateSubmissions: [lateSubmission()] })
          : resultsState();
      expect(can(action, enabledState)).toBe(true);
      expect(can(action, null)).toBe(false);
    }
    expect(can(enterBallotAction, resultsState({ rounds: [] }))).toBe(false);
    expect(can(acceptLateBallotAction, resultsState())).toBe(false);
    expect(can(recordBallotIntakeAction, resultsState({ permissions: [] }))).toBe(false);
  });

  it("asks round, debate, motion, confirmation, ranks and scores, then enters a ballot", async () => {
    const state = resultsState();
    const { store, submitted } = fakeStore(state, SUBMIT);
    const prompts = scriptedPrompts([
      "r1",
      "d1",
      "",
      true,
      1,
      "78",
      "77",
      2,
      "76",
      "75",
      3,
      "74",
      "73",
      4,
      "72",
      "71",
    ]);
    const args = await enterBallotAction.prompt(testContext(store, prompts));
    expect(args).toBeDefined();
    expect(args!.roundId).toBe("r1");
    expect(args!.debateId).toBe("d1");
    expect(prompts.asked).toHaveLength(16);

    await enterBallotAction.run(testContext(store, scriptedPrompts([])), args!);
    expect(submitted).toHaveLength(1);
    expect(submitted[0].type).toBe("ballot.enter");
    expect(submitted[0].expectedVersions).toEqual({ "debate:d1": 3 });
    const entered = (submitted[0].payload as { ballot: OpBallotSubmission }).ballot;
    expect(entered.confirmed).toBe(true);
    expect(entered.version).toBe(2);
  });

  it("reports an invalid palette ballot instead of submitting it", async () => {
    const state = resultsState();
    const { store, submitted } = fakeStore(state, SUBMIT);
    const prompts = scriptedPrompts([
      "r1", "d1", "", false,
      1, "", "77",
      2, "76", "75",
      3, "74", "73",
      4, "72", "71",
    ]);
    const args = await enterBallotAction.prompt(testContext(store, prompts));
    expect(args).toBeDefined();
    const result = await enterBallotAction.run(testContext(store, scriptedPrompts([])), args!);
    expect(result.ok).toBe(false);
    expect(submitted).toHaveLength(0);
  });

  it("submits confirm, discard and intake ops with their exact payloads", async () => {
    const { store, submitted } = fakeStore(resultsState(), SUBMIT);
    const ctx = testContext(store, scriptedPrompts([]));

    await confirmBallotAction.run(ctx, {
      ballotId: "b1",
      confirmedAt: "2026-11-25T09:00:00.000Z",
    });
    expect(submitted[0]).toEqual({
      type: "ballot.confirm",
      expectedVersions: { "ballot:b1": 1, "debate:d1": 3 },
      payload: { ballotId: "b1", confirmedAt: "2026-11-25T09:00:00.000Z" },
    });

    await discardBallotAction.run(ctx, {
      ballotId: "b1",
      discardedAt: "2026-11-25T09:05:00.000Z",
    });
    expect(submitted[1]).toEqual({
      type: "ballot.discard",
      expectedVersions: { "ballot:b1": 1, "debate:d1": 3 },
      payload: { ballotId: "b1", discardedAt: "2026-11-25T09:05:00.000Z" },
    });

    await recordBallotIntakeAction.run(ctx, {
      sheetCode: "SHEET-1",
      roundId: "r1",
      receivedAt: "2026-11-25T09:10:00.000Z",
    });
    expect(submitted[2]).toEqual({
      type: "ballot.intake_record",
      payload: { sheetCode: "SHEET-1", roundId: "r1", receivedAt: "2026-11-25T09:10:00.000Z" },
    });
  });

  it("accepts a late item as a late ballot.enter with a fresh ballot version", async () => {
    const lateItem = lateSubmission();
    const state = resultsState({ lateSubmissions: [lateItem] });
    const { store, submitted } = fakeStore(state, SUBMIT);
    const ctx = testContext(store, scriptedPrompts([lateItem.id, true]));

    expect(await acceptLateBallotAction.prompt(ctx)).toEqual({
      lateItemId: "late-1",
      now: expect.any(String),
    });
    await acceptLateBallotAction.run(ctx, {
      lateItemId: "late-1",
      now: "2026-11-25T09:00:00.000Z",
      actorId: "director-1",
    });
    expect(submitted[0].type).toBe("ballot.enter");
    expect(submitted[0].expectedVersions).toEqual({ "debate:d1": 3 });
    const entered = (submitted[0].payload as { ballot: OpBallotSubmission }).ballot;
    expect(entered.late).toBe(true);
    expect(entered.enteredBy).toBe("director-1");
    expect(entered.version).toBe(2);
  });

  it("passes pasted QR fragments to the host and reports failures inline", async () => {
    const { store, calls } = fakeStore(resultsState(), SUBMIT);
    const ok = await importQrBallotAction.run(testContext(store, scriptedPrompts([])), {
      codes: ["ST1.a.1.2", "ST1.b.2.3"],
    });
    expect(ok).toEqual({ ok: true, seq: 1, roundId: "", debateId: "" });
    expect(calls.qrCodes).toEqual([["ST1.a.1.2", "ST1.b.2.3"]]);

    const failing = fakeStore(resultsState(), SUBMIT, {
      receiveQrBallot: async () => ({ ok: false, kind: "needs_links", errors: [] }),
    });
    const result = await importQrBallotAction.run(
      testContext(failing.store, scriptedPrompts([])),
      { codes: ["ST1.a.1.2"] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("needs_links");
    }
    expect(
      await importQrBallotAction.prompt(
        testContext(store, scriptedPrompts(["ST1.a.1.2  ST1.b.2.3"])),
      ),
    ).toEqual({ codes: ["ST1.a.1.2", "ST1.b.2.3"] });
  });

  it("cancels prompts without submitting anything", async () => {
    const { store, submitted } = fakeStore(resultsState(), SUBMIT);
    expect(
      await confirmBallotAction.prompt(testContext(store, scriptedPrompts([undefined]))),
    ).toBeUndefined();
    expect(
      await discardBallotAction.prompt(
        testContext(store, scriptedPrompts(["b1", false])),
      ),
    ).toBeUndefined();
    expect(
      await recordBallotIntakeAction.prompt(
        testContext(store, scriptedPrompts(["r1", undefined])),
      ),
    ).toBeUndefined();
    expect(
      await importQrBallotAction.prompt(testContext(store, scriptedPrompts([undefined]))),
    ).toBeUndefined();
    expect(submitted).toEqual([]);
  });
});
