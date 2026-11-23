import { describe, expect, it } from "vitest";
import { makeTournament } from "@/test/tournamentFixtures";
import {
  applyOp,
  canUndo,
  createTournamentState,
  defaultRegistry,
  recordKey,
  Registry,
  type OpDef,
  type RecordKey,
} from "./index";
import {
  AI_ACTOR,
  deepFreeze,
  DISPLAY_ACTOR,
  HOST_OWNER_ACTOR,
  PROPOSALS_ONLY_HUMAN_ACTOR,
  TAB_ASSISTANT_ACTOR,
  TAB_DIRECTOR_ACTOR,
} from "./test-helpers";

describe("ops engine-core", () => {
  it("returns UNKNOWN_OP for unregistered operation types", () => {
    const state = deepFreeze(createTournamentState(makeTournament("bp")));
    const result = applyOp(
      state,
      { type: "nonexistent.op", payload: {} },
      HOST_OWNER_ACTOR,
      defaultRegistry(),
    );
    expect(result).toEqual({
      ok: false,
      code: "UNKNOWN_OP",
      errors: ["Unknown operation: nonexistent.op"],
    });
  });

  it("enforces permissions and rejects AI / proposalsOnly actors with 'proposal required'", () => {
    const registry = defaultRegistry();
    const state = deepFreeze(createTournamentState(makeTournament("bp")));

    const aiRes = applyOp(
      state,
      { type: "settings.update", payload: { preferences: { publicDraw: false } } },
      AI_ACTOR,
      registry,
    );
    expect(aiRes).toEqual({
      ok: false,
      code: "FORBIDDEN",
      errors: ["proposal required"],
    });

    const proposalsOnlyRes = applyOp(
      state,
      { type: "settings.update", payload: { preferences: { publicDraw: false } } },
      PROPOSALS_ONLY_HUMAN_ACTOR,
      registry,
    );
    expect(proposalsOnlyRes).toEqual({
      ok: false,
      code: "FORBIDDEN",
      errors: ["proposal required"],
    });

    const assistantRes = applyOp(
      state,
      { type: "settings.update", payload: { preferences: { publicDraw: false } } },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(assistantRes.ok).toBe(false);
    if (!assistantRes.ok) {
      expect(assistantRes.code).toBe("FORBIDDEN");
    }

    const displayRes = applyOp(
      state,
      { type: "venue.create", payload: { venue: { id: "v1", tournamentId: "t-bp", name: "Room 1", priority: 1 } } },
      DISPLAY_ACTOR,
      registry,
    );
    expect(displayRes.ok).toBe(false);
    if (!displayRes.ok) {
      expect(displayRes.code).toBe("FORBIDDEN");
    }
  });

  it("allows AI actors only on ops marked aiAllowed", () => {
    const aiOp: OpDef<{ flag: boolean }> = {
      type: "proposal.ai_test",
      permission: "draw.display",
      category: "proposals",
      visibility: "private",
      lock: false,
      aiAllowed: true,
      reads: (state) => [recordKey("tournament", state.tournament.id)],
      writes: (state) => [recordKey("tournament", state.tournament.id)],
      validate: () => [],
      apply: (state, payload) => ({ state, committedPayload: payload }),
      inverse: () => null,
    };
    const registry = new Registry().register(aiOp);
    const state = deepFreeze(createTournamentState(makeTournament("bp")));

    const res = applyOp(state, { type: "proposal.ai_test", payload: { flag: true } }, AI_ACTOR, registry);
    expect(res.ok).toBe(true);
  });

  it("checks expectedVersions, increments versions from 1, and lets forced host-owner ops override", () => {
    const registry = defaultRegistry();
    const tKey = recordKey("tournament", "t-bp");
    const state0 = deepFreeze(createTournamentState(makeTournament("bp")));

    const first = applyOp(
      state0,
      {
        type: "settings.update",
        payload: { preferences: { welcomeMessage: "Hello" } },
        expectedVersions: { [tKey]: 0 },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.state.versions[tKey]).toBe(1);

    const state1 = deepFreeze(first.state);
    const conflict = applyOp(
      state1,
      {
        type: "settings.update",
        payload: { preferences: { welcomeMessage: "Stale" } },
        expectedVersions: { [tKey]: 0 },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.code).toBe("VERSION_CONFLICT");
      expect(conflict.current).toEqual({ [tKey]: 1 });
    }

    const forced = applyOp(
      state1,
      {
        type: "settings.update",
        payload: { preferences: { welcomeMessage: "Host Override" } },
        expectedVersions: { [tKey]: 0 },
        forced: true,
      },
      HOST_OWNER_ACTOR,
      registry,
    );
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    expect(forced.state.versions[tKey]).toBe(2);
    expect(forced.state.tournament.preferences.welcomeMessage).toBe("Host Override");
  });

  it("never mutates deep-frozen input state", () => {
    const registry = defaultRegistry();
    const state = deepFreeze(createTournamentState(makeTournament("bp")));
    const result = applyOp(
      state,
      {
        type: "institution.create",
        payload: {
          institution: { id: "inst-1", tournamentId: "t-bp", name: "Uni A", code: "UA" },
        },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(result.ok).toBe(true);
    expect(state.institutions).toEqual([]);
    expect(state.versions).toEqual({});
  });

  it("implements section 3 canUndo blocking rule", () => {
    const k1: RecordKey = "team:team-1";
    const k2: RecordKey = "team:team-2";
    const k3: RecordKey = "venue:venue-1";
    const log = [
      { seq: 1, writes: [k1] },
      { seq: 2, writes: [k2, k3] },
      { seq: 3, writes: [k1] },
      { seq: 4, writes: [k3], inverseOf: 2 },
    ];

    expect(canUndo(log, 1)).toEqual({ ok: false, blockingSeqs: [3] });
    expect(canUndo(log, 2)).toEqual({ ok: false, blockingSeqs: [4] });
    expect(canUndo(log, 3)).toEqual({ ok: true });
    expect(canUndo(log, 4)).toEqual({ ok: true });
    expect(canUndo(log, 999)).toEqual({ ok: false, blockingSeqs: [] });
  });

  it("rejects duplicate registrations in Registry and exposes Appendix A metadata in defaultRegistry", () => {
    const registry = defaultRegistry();
    const settingsDef = registry.get("settings.update")!;
    expect(() => registry.register(settingsDef)).toThrow(/Duplicate operation registration/);

    const roundOps = registry.list().filter((op) => op.type.startsWith("round."));
    expect(roundOps.length).toBe(7);
    for (const op of roundOps) {
      expect(op.visibility).toBe("public");
      expect(op.releaseGate).toBeUndefined();
    }

    const nonRoundOps = registry.list().filter((op) => !op.type.startsWith("round."));
    expect(nonRoundOps.length).toBe(21);
    for (const op of nonRoundOps) {
      expect(op.visibility).toBe("private");
    }

    expect(registry.get("settings.resave_ballots")?.lock).toBe(true);
    expect(registry.get("round.delete")?.lock).toBe(true);
    expect(registry.get("round.set_prelim_count")?.lock).toBe(true);
    expect(registry.get("round.create")?.lock).toBe(false);
    expect(registry.get("settings.update")?.lock).toBe(false);
  });
});
