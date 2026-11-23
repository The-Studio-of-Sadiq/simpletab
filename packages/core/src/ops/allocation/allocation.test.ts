import { describe, expect, it } from "vitest";
import { createSeededRng } from "@/lib/draw/rng";
import {
  makeAdjudicators,
  makeRound,
  makeTeams,
  makeTournament,
  makeVenues,
} from "@/test/tournamentFixtures";
import type { PreformedPanel } from "@/types";
import {
  applyOp,
  createTournamentState,
  defaultRegistry,
  recordKey,
} from "../index";
import {
  ADJ_CORE_ACTOR,
  deepFreeze,
  EQUITY_ACTOR,
  expectOpRoundTrip,
  expectStaleConflictAndForcedSuccess,
  HOST_OWNER_ACTOR,
  makeFixtureDebateAndBallot,
  TAB_ASSISTANT_ACTOR,
  TAB_DIRECTOR_ACTOR,
} from "../test-helpers";

function makeDrawnBpState(options: { adjudicatorsRevealed?: boolean } = {}) {
  const registry = defaultRegistry();
  const tournament = makeTournament("bp");
  const round1 = makeRound("t-bp", 1, {
    ...(options.adjudicatorsRevealed ? { adjudicatorsRevealed: true } : {}),
  });
  const teams = makeTeams(8, {
    tournamentId: "t-bp",
    institutionCount: 4,
    speakersPerTeam: 2,
  });
  const adjudicators = makeAdjudicators(8, {
    tournamentId: "t-bp",
    institutionCount: 4,
    rng: createSeededRng(42),
    traineeEvery: 4,
  });
  const venues = makeVenues(2, "t-bp");
  const baseState = createTournamentState(tournament, {
    teams,
    adjudicators,
    venues,
    rounds: [round1],
  });
  const drawn = applyOp(
    deepFreeze(baseState),
    { type: "draw.generate", payload: { roundId: round1.id, seed: 101 } },
    TAB_DIRECTOR_ACTOR,
    registry,
  );
  if (!drawn.ok) {
    throw new Error(`Failed setup draw: ${drawn.errors.join("; ")}`);
  }
  const state = options.adjudicatorsRevealed
    ? createTournamentState(tournament, {
        ...drawn.state,
        rounds: [{ ...drawn.state.rounds[0]!, adjudicatorsRevealed: true }],
      })
    : drawn.state;
  return { state, round1, teams, adjudicators, venues };
}

describe("allocation ops", () => {
  const registry = defaultRegistry();

  it("registers Appendix A metadata for all allocation ops", () => {
    const types = [
      "allocation.auto",
      "allocation.restore",
      "allocation.assign_manual",
      "allocation.swap_rooms",
      "allocation.preformed_save",
      "allocation.preformed_autofill",
    ];
    for (const type of types) {
      const def = registry.get(type)!;
      expect(def).toBeDefined();
      expect(def.permission).toBe("allocation.edit");
      expect(def.visibility).toBe("public");
      expect(def.releaseGate).toBe("draw_released");
    }
    expect(registry.get("allocation.auto")?.lock).toBe(true);
    expect(registry.get("allocation.preformed_autofill")?.lock).toBe(true);
    expect(registry.get("allocation.restore")?.lock).toBe(false);
    expect(registry.get("allocation.assign_manual")?.lock).toBe(false);
    expect(registry.get("allocation.swap_rooms")?.lock).toBe(false);
    expect(registry.get("allocation.preformed_save")?.lock).toBe(false);
  });

  describe("allocation.auto & allocation.restore", () => {
    it("allocates adjudicators deterministically, hides revealed adjudicators, and restores via inverse", () => {
      const { state, round1 } = makeDrawnBpState({ adjudicatorsRevealed: true });

      const after = expectOpRoundTrip(
        state,
        {
          type: "allocation.auto",
          payload: { roundId: round1.id, panelSize: 3, seed: 77 },
        },
        ADJ_CORE_ACTOR,
      );
      expect(after.debates[0]!.adjudicators.chairId).toBeDefined();
      expect(after.debates[1]!.adjudicators.chairId).toBeDefined();
      expect(after.rounds[0]!.adjudicatorsRevealed).toBe(false);

      const repeat = applyOp(
        deepFreeze(state),
        {
          type: "allocation.auto",
          payload: { roundId: round1.id, panelSize: 3, seed: 77 },
        },
        ADJ_CORE_ACTOR,
        registry,
      );
      expect(repeat.ok).toBe(true);
      if (!repeat.ok) return;
      expect(repeat.state.debates).toEqual(after.debates);
    });

    it("rejects auto allocation when no adjudicators are available or actor lacks permission", () => {
      const { state, round1 } = makeDrawnBpState();
      const noAdjState = createTournamentState(state.tournament, {
        ...state,
        adjudicators: [],
      });
      const noAdjRes = applyOp(
        deepFreeze(noAdjState),
        {
          type: "allocation.auto",
          payload: { roundId: round1.id, panelSize: 3, seed: 1 },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(noAdjRes.ok).toBe(false);
      if (!noAdjRes.ok) expect(noAdjRes.code).toBe("INVALID");

      const forbiddenRes = applyOp(
        deepFreeze(state),
        {
          type: "allocation.auto",
          payload: { roundId: round1.id, panelSize: 3, seed: 1 },
        },
        EQUITY_ACTOR,
        registry,
      );
      expect(forbiddenRes.ok).toBe(false);
      if (!forbiddenRes.ok) expect(forbiddenRes.code).toBe("FORBIDDEN");

      const forbiddenAssistant = applyOp(
        deepFreeze(state),
        {
          type: "allocation.auto",
          payload: { roundId: round1.id, panelSize: 3, seed: 1 },
        },
        TAB_ASSISTANT_ACTOR,
        registry,
      );
      expect(forbiddenAssistant.ok).toBe(false);
      if (!forbiddenAssistant.ok) expect(forbiddenAssistant.code).toBe("FORBIDDEN");
    });

    it("supports allocation.restore round-trip and rejects unknown debates", () => {
      const { state, round1, adjudicators } = makeDrawnBpState();
      const d1 = state.debates[0]!;
      const afterRestore = expectOpRoundTrip(state, {
        type: "allocation.restore",
        payload: {
          roundId: round1.id,
          panels: [
            {
              debateId: d1.id,
              adjudicators: {
                chairId: adjudicators[0]!.id,
                chairName: adjudicators[0]!.name,
                panellistIds: [adjudicators[1]!.id],
                panellistNames: [adjudicators[1]!.name],
                traineeIds: [],
                traineeNames: [],
              },
            },
          ],
        },
      });
      expect(afterRestore.debates[0]!.adjudicators.chairId).toBe(adjudicators[0]!.id);

      const badRestore = applyOp(
        deepFreeze(state),
        {
          type: "allocation.restore",
          payload: {
            roundId: round1.id,
            panels: [
              {
                debateId: "nonexistent-debate",
                adjudicators: {
                  panellistIds: [],
                  panellistNames: [],
                  traineeIds: [],
                  traineeNames: [],
                },
              },
            ],
          },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(badRestore.ok).toBe(false);
      if (!badRestore.ok) expect(badRestore.code).toBe("INVALID");
    });
  });

  describe("allocation.assign_manual", () => {
    it("assigns a panel manually with inverse round-trip and rejects duplicate/unknown adjudicators", () => {
      const { state, adjudicators } = makeDrawnBpState();
      const debate = state.debates[0]!;

      const after = expectOpRoundTrip(state, {
        type: "allocation.assign_manual",
        payload: {
          debateId: debate.id,
          chairId: adjudicators[0]!.id,
          panellistIds: [adjudicators[1]!.id],
          traineeIds: [adjudicators[3]!.id],
        },
      });
      expect(after.debates[0]!.adjudicators.chairId).toBe(adjudicators[0]!.id);
      expect(after.debates[0]!.adjudicators.panellistIds).toEqual([adjudicators[1]!.id]);

      const dupRes = applyOp(
        deepFreeze(state),
        {
          type: "allocation.assign_manual",
          payload: {
            debateId: debate.id,
            chairId: adjudicators[0]!.id,
            panellistIds: [adjudicators[0]!.id],
            traineeIds: [],
          },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(dupRes.ok).toBe(false);
      if (!dupRes.ok) expect(dupRes.code).toBe("INVALID");

      const forbidden = applyOp(
        deepFreeze(state),
        {
          type: "allocation.assign_manual",
          payload: {
            debateId: debate.id,
            chairId: adjudicators[0]!.id,
            panellistIds: [],
            traineeIds: [],
          },
        },
        EQUITY_ACTOR,
        registry,
      );
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");

      expectStaleConflictAndForcedSuccess(
        state,
        {
          type: "allocation.assign_manual",
          payload: {
            debateId: debate.id,
            chairId: adjudicators[0]!.id,
            panellistIds: [],
            traineeIds: [],
          },
        },
        recordKey("debate", debate.id),
      );
    });
  });

  describe("allocation.swap_rooms", () => {
    it("swaps panels and moves individual adjudicators across rooms with inverse round-trip", () => {
      const { state, round1 } = makeDrawnBpState();
      const allocated = applyOp(
        deepFreeze(state),
        {
          type: "allocation.auto",
          payload: { roundId: round1.id, panelSize: 3, seed: 88 },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(allocated.ok).toBe(true);
      if (!allocated.ok) return;

      const d1 = allocated.state.debates[0]!;
      const d2 = allocated.state.debates[1]!;

      const afterFullSwap = expectOpRoundTrip(allocated.state, {
        type: "allocation.swap_rooms",
        payload: { debateIdA: d1.id, debateIdB: d2.id },
      });
      expect(afterFullSwap.debates[0]!.adjudicators).toEqual(d2.adjudicators);
      expect(afterFullSwap.debates[1]!.adjudicators).toEqual(d1.adjudicators);

      const afterMove = expectOpRoundTrip(allocated.state, {
        type: "allocation.swap_rooms",
        payload: {
          debateIdA: d1.id,
          debateIdB: d2.id,
          moves: [
            {
              adjudicatorId: d1.adjudicators.chairId!,
              fromDebateId: d1.id,
              toDebateId: d2.id,
              toRole: "chair",
            },
            {
              adjudicatorId: d2.adjudicators.chairId!,
              fromDebateId: d2.id,
              toDebateId: d1.id,
              toRole: "chair",
            },
          ],
        },
      });
      expect(afterMove.debates[0]!.adjudicators.chairId).toBe(d2.adjudicators.chairId);
      expect(afterMove.debates[1]!.adjudicators.chairId).toBe(d1.adjudicators.chairId);
    });

    it("bumps both debates' versions and detects stale expectedVersion on either debate", () => {
      const { state, round1 } = makeDrawnBpState();
      const allocated = applyOp(
        deepFreeze(state),
        {
          type: "allocation.auto",
          payload: { roundId: round1.id, panelSize: 3, seed: 88 },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(allocated.ok).toBe(true);
      if (!allocated.ok) return;

      const d1 = allocated.state.debates[0]!;
      const d2 = allocated.state.debates[1]!;
      const keyA = recordKey("debate", d1.id);
      const keyB = recordKey("debate", d2.id);
      const verA = allocated.state.versions[keyA] ?? 0;
      const verB = allocated.state.versions[keyB] ?? 0;

      const staleA = applyOp(
        deepFreeze(allocated.state),
        {
          type: "allocation.swap_rooms",
          payload: { debateIdA: d1.id, debateIdB: d2.id },
          expectedVersions: { [keyA]: verA + 5, [keyB]: verB },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(staleA.ok).toBe(false);
      if (!staleA.ok) expect(staleA.code).toBe("VERSION_CONFLICT");

      const staleB = applyOp(
        deepFreeze(allocated.state),
        {
          type: "allocation.swap_rooms",
          payload: { debateIdA: d1.id, debateIdB: d2.id },
          expectedVersions: { [keyA]: verA, [keyB]: verB + 5 },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(staleB.ok).toBe(false);
      if (!staleB.ok) expect(staleB.code).toBe("VERSION_CONFLICT");

      const swapped = applyOp(
        deepFreeze(allocated.state),
        {
          type: "allocation.swap_rooms",
          payload: { debateIdA: d1.id, debateIdB: d2.id },
          expectedVersions: { [keyA]: verA, [keyB]: verB },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(swapped.ok).toBe(true);
      if (!swapped.ok) return;
      expect(swapped.state.versions[keyA]).toBe(verA + 1);
      expect(swapped.state.versions[keyB]).toBe(verB + 1);

      const forcedOwner = applyOp(
        deepFreeze(allocated.state),
        {
          type: "allocation.swap_rooms",
          payload: { debateIdA: d1.id, debateIdB: d2.id },
          expectedVersions: { [keyA]: verA + 99, [keyB]: verB + 99 },
          forced: true,
        },
        HOST_OWNER_ACTOR,
        registry,
      );
      expect(forcedOwner.ok).toBe(true);
    });

    it("rejects invalid moves, ballot-protected rooms without override, and FORBIDDEN roles", () => {
      const { state: ballotState, debate } = makeFixtureDebateAndBallot();
      const roundId = debate.roundId;
      const d2 = {
        ...debate,
        id: "debate-2",
        roomRank: 2,
        adjudicators: {
          chairId: ballotState.adjudicators[1]!.id,
          chairName: ballotState.adjudicators[1]!.name,
          panellistIds: [],
          panellistNames: [],
          traineeIds: [],
          traineeNames: [],
        },
      };
      const twoDebateState = createTournamentState(ballotState.tournament, {
        ...ballotState,
        debates: [debate, d2],
      });

      const unoverridden = applyOp(
        deepFreeze(twoDebateState),
        {
          type: "allocation.swap_rooms",
          payload: { debateIdA: debate.id, debateIdB: d2.id },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(unoverridden.ok).toBe(false);
      if (!unoverridden.ok) expect(unoverridden.code).toBe("INVALID");

      const { state } = makeDrawnBpState();
      const badMove = applyOp(
        deepFreeze(state),
        {
          type: "allocation.swap_rooms",
          payload: {
            debateIdA: state.debates[0]!.id,
            debateIdB: state.debates[1]!.id,
            moves: [
              {
                adjudicatorId: "missing-adj",
                fromDebateId: state.debates[0]!.id,
                toDebateId: state.debates[1]!.id,
                toRole: "chair",
              },
            ],
          },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(badMove.ok).toBe(false);
      if (!badMove.ok) expect(badMove.code).toBe("INVALID");

      const forbidden = applyOp(
        deepFreeze(state),
        {
          type: "allocation.swap_rooms",
          payload: {
            debateIdA: state.debates[0]!.id,
            debateIdB: state.debates[1]!.id,
          },
        },
        EQUITY_ACTOR,
        registry,
      );
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");
      expect(roundId).toBeDefined();
    });
  });

  describe("allocation.preformed_save & allocation.preformed_autofill", () => {
    it("saves and autofills preformed panels with inverse round-trips", () => {
      const { state, round1, adjudicators } = makeDrawnBpState();
      const initialPanels: PreformedPanel[] = [
        {
          id: "panel-1",
          chairId: adjudicators[0]!.id,
          panellistIds: [],
          traineeIds: [],
          importance: 8,
        },
        {
          id: "panel-2",
          chairId: adjudicators[1]!.id,
          panellistIds: [],
          traineeIds: [],
          importance: 5,
        },
      ];

      const afterSave = expectOpRoundTrip(state, {
        type: "allocation.preformed_save",
        payload: { roundId: round1.id, panels: initialPanels },
      });
      expect(afterSave.rounds[0]!.preformedPanels).toEqual(initialPanels);

      const afterAutofill = expectOpRoundTrip(afterSave, {
        type: "allocation.preformed_autofill",
        payload: { roundId: round1.id },
      });
      expect(afterAutofill.rounds[0]!.preformedPanels).toHaveLength(2);
    });

    it("rejects trainee voters in preformed_save, empty autofill, and FORBIDDEN roles", () => {
      const { state, round1, adjudicators } = makeDrawnBpState();
      const trainee = adjudicators.find((adj) => adj.trainee)!;

      const badSave = applyOp(
        deepFreeze(state),
        {
          type: "allocation.preformed_save",
          payload: {
            roundId: round1.id,
            panels: [
              {
                id: "panel-1",
                chairId: trainee.id,
                panellistIds: [],
                traineeIds: [],
                importance: 5,
              },
            ],
          },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(badSave.ok).toBe(false);
      if (!badSave.ok) expect(badSave.code).toBe("INVALID");

      const emptyAutofill = applyOp(
        deepFreeze(state),
        {
          type: "allocation.preformed_autofill",
          payload: { roundId: round1.id },
        },
        TAB_DIRECTOR_ACTOR,
        registry,
      );
      expect(emptyAutofill.ok).toBe(false);
      if (!emptyAutofill.ok) expect(emptyAutofill.code).toBe("INVALID");

      const forbidden = applyOp(
        deepFreeze(state),
        {
          type: "allocation.preformed_save",
          payload: { roundId: round1.id, panels: [] },
        },
        EQUITY_ACTOR,
        registry,
      );
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");
    });
  });
});
