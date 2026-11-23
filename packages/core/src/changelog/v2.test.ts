import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { canonicalize } from "./jcs";
import { GENESIS_HASH, makeEntry } from "./v2";

describe("Changelog v2 makeEntry", () => {
  it("defines GENESIS_HASH as 64 zeros", () => {
    expect(GENESIS_HASH).toBe("0".repeat(64));
  });

  it("computes deterministic payloadCommit and entryHash matching SHA-256 spec", async () => {
    const salt = new Uint8Array(16).fill(0xab);
    const payload = { roundId: "round-1", debates: [{ id: "d1", room: "Room A" }] };

    const stored = await makeEntry(
      {
        seq: 1,
        ts: "2026-11-23T10:00:00.000Z",
        actorType: "human",
        actorRef: "director-1",
        opType: "draw.generate",
        category: "draw",
        summary: "Generated Round 1 draw",
        visibility: "public",
        payload,
      },
      GENESIS_HASH,
      salt,
    );

    const expectedCommit = createHash("sha256")
      .update(Buffer.concat([Buffer.from(salt), Buffer.from(canonicalize(payload), "utf8")]))
      .digest("base64url");

    const expectedEntryHash = createHash("sha256")
      .update(
        `simpletab-changelog-v2\n${GENESIS_HASH}\n${canonicalize(stored.entry)}`,
        "utf8",
      )
      .digest("hex");

    expect(stored.entry.v).toBe(2);
    expect(stored.entry.payloadCommit).toBe(expectedCommit);
    expect(stored.salt).toBe(Buffer.from(salt).toString("base64url"));
    expect(stored.salt).not.toContain("=");
    expect(stored.entry.payloadCommit).not.toContain("=");
    expect(stored.entryHash).toBe(expectedEntryHash);
    expect(stored.entryHash).toMatch(/^[0-9a-f]{64}$/);
    expect("stateHash" in stored.entry).toBe(false);
  });

  it("includes stateHash when provided and generates a 16-byte random salt by default", async () => {
    const first = await makeEntry(
      {
        seq: 1,
        ts: "2026-11-23T10:05:00.123Z",
        actorType: "system",
        actorRef: "host",
        opType: "round.set_completion",
        category: "round",
        summary: "Completed Round 1",
        visibility: "public",
        stateHash: "a".repeat(64),
        payload: { roundId: "r1", completed: true },
      },
      GENESIS_HASH,
    );

    const second = await makeEntry(
      {
        seq: 1,
        ts: "2026-11-23T10:05:00.123Z",
        actorType: "system",
        actorRef: "host",
        opType: "round.set_completion",
        category: "round",
        summary: "Completed Round 1",
        visibility: "public",
        stateHash: "a".repeat(64),
        payload: { roundId: "r1", completed: true },
      },
      GENESIS_HASH,
    );

    expect(first.entry.stateHash).toBe("a".repeat(64));
    expect(first.salt).toHaveLength(22);
    expect(second.salt).toHaveLength(22);
    expect(first.salt).not.toBe(second.salt);
    expect(first.entry.payloadCommit).not.toBe(second.entry.payloadCommit);
  });

  it("rejects invalid seq or non-UTC/non-millisecond timestamps", async () => {
    const base = {
      seq: 1,
      ts: "2026-11-23T10:00:00.000Z",
      actorType: "human" as const,
      actorRef: "user-1",
      opType: "round.create",
      category: "round",
      summary: "Create round",
      visibility: "public" as const,
      payload: { name: "R1" },
    };

    await expect(makeEntry({ ...base, seq: 0 }, GENESIS_HASH)).rejects.toThrow();
    await expect(makeEntry({ ...base, seq: -1 }, GENESIS_HASH)).rejects.toThrow();
    await expect(makeEntry({ ...base, seq: 1.5 }, GENESIS_HASH)).rejects.toThrow();

    await expect(makeEntry({ ...base, ts: "2026-11-23T10:00:00Z" }, GENESIS_HASH)).rejects.toThrow();
    await expect(makeEntry({ ...base, ts: "2026-11-23T10:00:00.000+00:00" }, GENESIS_HASH)).rejects.toThrow();
    await expect(makeEntry({ ...base, ts: "2026-02-30T10:00:00.000Z" }, GENESIS_HASH)).rejects.toThrow();
    await expect(makeEntry({ ...base, ts: "not-a-timestamp" }, GENESIS_HASH)).rejects.toThrow();
  });
});
