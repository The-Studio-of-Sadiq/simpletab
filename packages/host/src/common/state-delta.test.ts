import { describe, expect, it } from "vitest";
import type { CollabStateView, StateDelta } from "./collab-protocol";
import {
  applyStateDelta,
  diffProjectedState,
  isEmptyDelta,
  stableEqual,
} from "./state-delta";

function makeView(overrides: Partial<CollabStateView> & Record<string, unknown> = {}): CollabStateView {
  return {
    seq: 1,
    roleId: "tab_director",
    tournament: { id: "t-1", name: "Open", roundCount: 5 },
    teams: [
      { id: "team-1", name: "Alpha", meta: { seed: 1, tags: ["a", "b"] } },
      { id: "team-2", name: "Beta", meta: { seed: 2, tags: ["c"] } },
    ],
    versions: {
      "tournament:t-1": 1,
      "team:team-1": 3,
      "team:team-2": 2,
    },
    ...overrides,
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randomJsonValue(rng: () => number, depth = 0): unknown {
  const kind = depth >= 2 ? randInt(rng, 0, 3) : randInt(rng, 0, 5);
  switch (kind) {
    case 0:
      return randInt(rng, -50, 50);
    case 1:
      return rng() < 0.5;
    case 2:
      return `s-${randInt(rng, 0, 20)}`;
    case 3:
      return null;
    case 4: {
      const len = randInt(rng, 0, 4);
      const arr: unknown[] = [];
      for (let i = 0; i < len; i++) {
        arr.push(randomJsonValue(rng, depth + 1));
      }
      return arr;
    }
    default: {
      const count = randInt(rng, 0, 4);
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < count; i++) {
        obj[`k${randInt(rng, 0, 6)}`] = randomJsonValue(rng, depth + 1);
      }
      return obj;
    }
  }
}

function randomCollection(rng: () => number, prefix: string): Array<Record<string, unknown> & { id: string }> {
  const count = randInt(rng, 0, 6);
  const usedIds = new Set<string>();
  const list: Array<Record<string, unknown> & { id: string }> = [];
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${randInt(rng, 1, 8)}`;
    if (usedIds.has(id)) {
      continue;
    }
    usedIds.add(id);
    list.push({
      id,
      score: randInt(rng, 0, 100),
      active: rng() < 0.5,
      nested: randomJsonValue(rng, 1),
    });
  }
  return list;
}

function randomMap(rng: () => number): Record<string, unknown> {
  const count = randInt(rng, 0, 6);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    const k = `m-${randInt(rng, 1, 8)}`;
    out[k] = rng() < 0.7 ? randInt(rng, 1, 20) : `v-${randInt(rng, 1, 10)}`;
  }
  return out;
}

function randomView(rng: () => number, seq: number): CollabStateView {
  const view: CollabStateView = {
    seq,
    roleId: rng() < 0.5 ? "tab_director" : "equity",
    tournament: {
      id: "t-1",
      name: `Tourney-${randInt(rng, 1, 3)}`,
      settings: randomJsonValue(rng, 1),
    },
    teams: randomCollection(rng, "team"),
    rounds: randomCollection(rng, "round"),
    versions: randomMap(rng),
    permissions: Array.from({ length: randInt(rng, 0, 4) }, (_, idx) => `perm.${randInt(rng, 1, 5)}.${idx}`),
  };

  if (rng() < 0.5) {
    view.optionalFlag = rng() < 0.5;
  }
  if (rng() < 0.4) {
    view.extraMap = randomMap(rng);
  }
  if (rng() < 0.35) {
    view.extraList = randomCollection(rng, "extra");
  }
  if (rng() < 0.15) {
    // Occasionally test duplicate ids inside an array (falls back to replace)
    view.dupList = [
      { id: "dup-1", v: randInt(rng, 1, 5) },
      { id: "dup-1", v: randInt(rng, 1, 5) },
    ];
  }
  if (rng() < 0.2) {
    view.kindFlip = rng() < 0.5 ? randomCollection(rng, "kf") : randomMap(rng);
  }
  return view;
}

describe("state-delta", () => {
  it("stableEqual compares primitives, arrays, and key-order-independent objects", () => {
    expect(stableEqual({ a: 1, b: { c: 2, d: [3, 4] } }, { b: { d: [3, 4], c: 2 }, a: 1 })).toBe(true);
    expect(stableEqual([1, { x: "a", y: "b" }], [1, { y: "b", x: "a" }])).toBe(true);
    expect(stableEqual(NaN, NaN)).toBe(true);
    expect(stableEqual([1, 2], [2, 1])).toBe(false);
    expect(stableEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(stableEqual(null, {})).toBe(false);
  });

  it("isEmptyDelta detects empty and non-empty deltas", () => {
    expect(isEmptyDelta({})).toBe(true);
    expect(isEmptyDelta({ collections: {}, maps: {}, replace: {}, remove: [] })).toBe(true);
    expect(isEmptyDelta({ remove: ["extra"] })).toBe(false);
    expect(isEmptyDelta({ replace: { seq: 2 } })).toBe(false);
    expect(isEmptyDelta({ maps: { versions: { set: { a: 1 }, remove: [] } } })).toBe(false);
    expect(isEmptyDelta({ collections: { teams: { ids: [], upsert: [] } } })).toBe(false);
  });

  it("returns {} for identical views", () => {
    const prev = makeView();
    const next = makeView({
      tournament: { roundCount: 5, name: "Open", id: "t-1" },
      teams: [
        { meta: { tags: ["a", "b"], seed: 1 }, name: "Alpha", id: "team-1" },
        { meta: { tags: ["c"], seed: 2 }, name: "Beta", id: "team-2" },
      ],
    });
    const delta = diffProjectedState(prev, next);
    expect(delta).toEqual({});
    expect(isEmptyDelta(delta)).toBe(true);
  });

  it("emits collection ids only with empty upsert when only order changes", () => {
    const prev = makeView();
    const next = makeView({
      teams: [
        { id: "team-2", name: "Beta", meta: { seed: 2, tags: ["c"] } },
        { id: "team-1", name: "Alpha", meta: { seed: 1, tags: ["a", "b"] } },
      ],
    });

    const delta = diffProjectedState(prev, next);
    expect(delta).toEqual({
      collections: {
        teams: {
          ids: ["team-2", "team-1"],
          upsert: [],
        },
      },
    });

    const applied = applyStateDelta(prev, delta);
    expect(stableEqual(applied, next)).toBe(true);
  });

  it("diffs collection additions, updates, removals, and empty-array transitions", () => {
    const prev = makeView({
      emptyToFilled: [],
      filledToEmpty: [{ id: "x1", v: 1 }],
      emptyToPrimitives: [],
    });
    const next = makeView({
      teams: [
        { id: "team-1", name: "Alpha", meta: { seed: 1, tags: ["a", "b"] } },
        { id: "team-3", name: "Gamma", meta: { seed: 3, tags: [] } },
      ],
      emptyToFilled: [{ id: "e1", v: 10 }],
      filledToEmpty: [],
      emptyToPrimitives: ["non-record"],
    });

    const delta = diffProjectedState(prev, next);
    expect(delta.collections).toEqual({
      teams: {
        ids: ["team-1", "team-3"],
        upsert: [{ id: "team-3", name: "Gamma", meta: { seed: 3, tags: [] } }],
      },
      emptyToFilled: {
        ids: ["e1"],
        upsert: [{ id: "e1", v: 10 }],
      },
      filledToEmpty: {
        ids: [],
        upsert: [],
      },
    });
    expect(delta.replace).toEqual({
      emptyToPrimitives: ["non-record"],
    });

    const applied = applyStateDelta(prev, delta);
    expect(stableEqual(applied, next)).toBe(true);
  });

  it("treats arrays with duplicate ids as opaque replace so nothing is lost", () => {
    const prev = makeView({
      items: [
        { id: "dup", val: 1 },
        { id: "dup", val: 2 },
      ],
    });
    const next = makeView({
      items: [
        { id: "dup", val: 1 },
        { id: "dup", val: 3 },
      ],
    });

    const delta = diffProjectedState(prev, next);
    expect(delta.collections).toBeUndefined();
    expect(delta.replace).toEqual({ items: next.items });

    const applied = applyStateDelta(prev, delta);
    expect(stableEqual(applied, next)).toBe(true);
  });

  it("treats tournament (plain object with string id) and record-valued objects as replace, and versions as maps", () => {
    const prev = makeView({
      emptyMap: {},
      recordBag: { a: { id: "r1", v: 1 } },
    });
    const next = makeView({
      tournament: { id: "t-1", name: "Closed", roundCount: 5 },
      versions: {
        "tournament:t-1": 2,
        "team:team-1": 3,
        "team:team-3": 1,
      },
      emptyMap: { added: 42 },
      recordBag: { a: { id: "r1", v: 2 } },
    });

    const delta = diffProjectedState(prev, next);
    expect(delta.maps).toEqual({
      versions: {
        set: { "tournament:t-1": 2, "team:team-3": 1 },
        remove: ["team:team-2"],
      },
      emptyMap: {
        set: { added: 42 },
        remove: [],
      },
    });
    expect(delta.replace).toEqual({
      tournament: { id: "t-1", name: "Closed", roundCount: 5 },
      recordBag: { a: { id: "r1", v: 2 } },
    });

    const applied = applyStateDelta(prev, delta);
    expect(stableEqual(applied, next)).toBe(true);
  });

  it("handles added and removed top-level keys", () => {
    const prev = makeView({ removedKey: { x: 1 } });
    const next = makeView({ addedKey: "hello" });

    const delta = diffProjectedState(prev, next);
    expect(delta).toEqual({
      replace: { addedKey: "hello" },
      remove: ["removedKey"],
    });

    const applied = applyStateDelta(prev, delta);
    expect(stableEqual(applied, next)).toBe(true);
    expect("removedKey" in applied).toBe(false);
  });

  it("does not mutate inputs and preserves object identity for untouched records and fields", () => {
    const untouchedTeam = { id: "team-1", name: "Alpha", meta: { seed: 1, tags: ["a", "b"] } };
    const changedTeam = { id: "team-2", name: "Beta", meta: { seed: 2, tags: ["c"] } };
    const untouchedTournament = { id: "t-1", name: "Open", roundCount: 5 };
    const prev = makeView({
      tournament: untouchedTournament,
      teams: [untouchedTeam, changedTeam],
    });
    const next = makeView({
      seq: 2,
      tournament: { id: "t-1", name: "Open", roundCount: 5 },
      teams: [
        { id: "team-1", name: "Alpha", meta: { seed: 1, tags: ["a", "b"] } },
        { id: "team-2", name: "Beta Updated", meta: { seed: 2, tags: ["c"] } },
      ],
    });

    Object.freeze(prev);
    Object.freeze(prev.teams);
    const delta: StateDelta = diffProjectedState(prev, next);
    Object.freeze(delta);

    const applied = applyStateDelta(prev, delta);
    expect(applied).not.toBe(prev);
    expect(applied.tournament).toBe(untouchedTournament);
    expect(applied.versions).toBe(prev.versions);
    const appliedTeams = applied.teams as Array<Record<string, unknown> & { id: string }>;
    expect(appliedTeams[0]).toBe(untouchedTeam);
    expect(appliedTeams[1]).not.toBe(changedTeam);
    expect(stableEqual(applied, next)).toBe(true);
  });

  it("round-trips 500 seeded random view pairs and produces empty delta for identical views", () => {
    const rng = mulberry32(0x51a7e123);
    for (let i = 0; i < 500; i++) {
      const prev = randomView(rng, i);
      const next = randomView(rng, i + 1);

      const selfDelta = diffProjectedState(prev, prev);
      expect(selfDelta).toEqual({});
      expect(isEmptyDelta(selfDelta)).toBe(true);

      const nextSelfDelta = diffProjectedState(next, next);
      expect(isEmptyDelta(nextSelfDelta)).toBe(true);

      const delta = diffProjectedState(prev, next);
      const applied = applyStateDelta(prev, delta);
      expect(stableEqual(applied, next)).toBe(true);
    }
  });
});
