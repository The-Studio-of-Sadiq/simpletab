import { describe, expect, it } from "vitest";

import { GENESIS_HASH, makeEntry, type StoredEntry } from "./v2";
import { isPrefixOf, provePrivate, verifyChain, type PublicChainItem } from "./verify";

function fixedSalt(seed: number): Uint8Array {
  return Uint8Array.from({ length: 16 }, (_, idx) => (seed * 31 + idx) & 0xff);
}

async function buildFiveEntryChain(): Promise<{
  stored: StoredEntry[];
  items: PublicChainItem[];
  payloads: unknown[];
}> {
  const specs = [
    {
      actorType: "human" as const,
      actorRef: "director-1",
      opType: "round.create",
      category: "round",
      summary: "Created Round 1",
      visibility: "public" as const,
      payload: { roundId: "r1", name: "Round 1" },
      reveal: true,
    },
    {
      actorType: "human" as const,
      actorRef: "director-1",
      opType: "team.create",
      category: "participants",
      summary: "Added team",
      visibility: "private" as const,
      payload: { teamId: "t1", name: "Alpha" },
      reveal: false,
    },
    {
      actorType: "ai" as const,
      actorRef: "cli-agent-1",
      opType: "draw.generate",
      category: "draw",
      summary: "Generated Round 1 draw",
      visibility: "public" as const,
      payload: { roundId: "r1", seed: 42 },
      reveal: true,
    },
    {
      actorType: "service" as const,
      actorRef: "ballots-worker",
      opType: "ballot.confirm",
      category: "results",
      summary: "Confirmed ballot for room 1",
      visibility: "public" as const,
      payload: { debateId: "d1", winner: "OG" },
      reveal: false,
    },
    {
      actorType: "system" as const,
      actorRef: "host",
      opType: "round.set_completion",
      category: "round",
      summary: "Completed Round 1",
      visibility: "public" as const,
      stateHash: "b".repeat(64),
      payload: { roundId: "r1", completed: true },
      reveal: true,
    },
  ];

  const stored: StoredEntry[] = [];
  const items: PublicChainItem[] = [];
  const payloads: unknown[] = [];
  let prevHash = GENESIS_HASH;

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const entryStored = await makeEntry(
      {
        seq: i + 1,
        ts: `2026-11-23T10:0${i}:00.000Z`,
        actorType: spec.actorType,
        actorRef: spec.actorRef,
        opType: spec.opType,
        category: spec.category,
        summary: spec.summary,
        visibility: spec.visibility,
        stateHash: spec.stateHash,
        payload: spec.payload,
      },
      prevHash,
      fixedSalt(i + 1),
    );
    stored.push(entryStored);
    payloads.push(spec.payload);
    items.push(
      spec.reveal
        ? {
            entry: entryStored.entry,
            entryHash: entryStored.entryHash,
            payload: spec.payload,
            salt: entryStored.salt,
          }
        : {
            entry: entryStored.entry,
            entryHash: entryStored.entryHash,
          },
    );
    prevHash = entryStored.entryHash;
  }

  return { stored, items, payloads };
}

describe("verifyChain, provePrivate, and isPrefixOf", () => {
  it("verifies a 5-entry chain with fixed salts and matching expectedHead", async () => {
    const { items } = await buildFiveEntryChain();
    const head = items[4]!.entryHash;

    const result = await verifyChain(items, { expectedHead: head });
    expect(result).toEqual({ ok: true, head });
  });

  it("verifies an empty chain against GENESIS_HASH", async () => {
    expect(await verifyChain([])).toEqual({ ok: true, head: GENESIS_HASH });
    expect(await verifyChain([], { expectedHead: GENESIS_HASH })).toEqual({
      ok: true,
      head: GENESIS_HASH,
    });
    const bad = await verifyChain([], { expectedHead: "f".repeat(64) });
    expect(bad.ok).toBe(false);
  });

  it("fails at the tampered seq when summary, actorType, or opType is altered", async () => {
    const base = await buildFiveEntryChain();

    const summaryTampered = structuredClone(base.items);
    summaryTampered[1]!.entry.summary = "Tampered summary";
    expect(await verifyChain(summaryTampered)).toMatchObject({ ok: false, seq: 2 });

    const actorTampered = structuredClone(base.items);
    actorTampered[2]!.entry.actorType = "human";
    expect(await verifyChain(actorTampered)).toMatchObject({ ok: false, seq: 3 });

    const opTypeTampered = structuredClone(base.items);
    opTypeTampered[3]!.entry.opType = "ballot.discard";
    expect(await verifyChain(opTypeTampered)).toMatchObject({ ok: false, seq: 4 });
  });

  it("fails at the right seq when entries are swapped or an entry is removed", async () => {
    const base = await buildFiveEntryChain();

    const swapped = [...base.items];
    [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
    expect(await verifyChain(swapped)).toMatchObject({ ok: false, seq: 2 });

    const removedMiddle = base.items.filter((_, idx) => idx !== 2);
    expect(await verifyChain(removedMiddle)).toMatchObject({ ok: false, seq: 3 });

    const removedLast = base.items.slice(0, 4);
    expect(
      await verifyChain(removedLast, { expectedHead: base.items[4]!.entryHash }),
    ).toMatchObject({ ok: false, seq: 4 });
  });

  it("fails at the right seq when a revealed payload is tampered", async () => {
    const base = await buildFiveEntryChain();
    const tampered = structuredClone(base.items);
    tampered[2]!.payload = { roundId: "r1", seed: 999 };

    expect(await verifyChain(tampered)).toMatchObject({ ok: false, seq: 3 });
  });

  it("proves private entries for matching payload and salt and rejects mismatches", async () => {
    const { stored, payloads } = await buildFiveEntryChain();
    const privateEntry = stored[1]!;
    const privatePayload = payloads[1];

    expect(await provePrivate(privateEntry.entry, privatePayload, privateEntry.salt)).toBe(true);
    expect(
      await provePrivate(privateEntry.entry, { teamId: "t1", name: "Beta" }, privateEntry.salt),
    ).toBe(false);
    expect(await provePrivate(privateEntry.entry, privatePayload, stored[0]!.salt)).toBe(false);
    expect(await provePrivate(privateEntry.entry, privatePayload, "not-valid-b64===")).toBe(false);
  });

  it("detects a rewritten chain with isPrefixOf", async () => {
    const original = await buildFiveEntryChain();
    const earlierHead = {
      seq: 3,
      headHash: original.items[2]!.entryHash,
    };

    expect(isPrefixOf(earlierHead, original.items)).toBe(true);

    const rewrittenSeq3 = await makeEntry(
      {
        seq: 3,
        ts: "2026-11-23T10:02:00.000Z",
        actorType: "human",
        actorRef: "director-1",
        opType: "draw.generate",
        category: "draw",
        summary: "Rewritten draw",
        visibility: "public",
        payload: { roundId: "r1", seed: 777 },
      },
      original.items[1]!.entryHash,
      fixedSalt(99),
    );

    const rewrittenChain: PublicChainItem[] = [
      original.items[0]!,
      original.items[1]!,
      {
        entry: rewrittenSeq3.entry,
        entryHash: rewrittenSeq3.entryHash,
        payload: { roundId: "r1", seed: 777 },
        salt: rewrittenSeq3.salt,
      },
    ];

    expect(await verifyChain(rewrittenChain)).toEqual({
      ok: true,
      head: rewrittenSeq3.entryHash,
    });
    expect(isPrefixOf(earlierHead, rewrittenChain)).toBe(false);
  });
});
