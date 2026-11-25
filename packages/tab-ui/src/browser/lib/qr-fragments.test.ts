import { encodeQrBallot } from "@simpletab/core/crypto";
import { describe, expect, it } from "vitest";
import { QrFragmentCollector } from "./qr-fragments";

function makeFragment(
  sid: string,
  index: number,
  total: number,
  totalLength: number,
  hashTag: string,
  data: string,
): string {
  return `ST1F.${sid}.${index}.${total}.${totalLength}.${hashTag}.${data}`;
}

describe("QrFragmentCollector", () => {
  it("ignores non-SimpleTab QR payloads", () => {
    const collector = new QrFragmentCollector({ now: () => 1_000 });
    expect(collector.add("")).toEqual({ kind: "ignored", reason: "not_simpletab" });
    expect(collector.add("   \n\t ")).toEqual({ kind: "ignored", reason: "not_simpletab" });
    expect(collector.add("https://example.com/ballot")).toEqual({
      kind: "ignored",
      reason: "not_simpletab",
    });
    expect(collector.add("ST2.body.tag")).toEqual({
      kind: "ignored",
      reason: "not_simpletab",
    });
    expect(collector.add("ST1")).toEqual({
      kind: "ignored",
      reason: "not_simpletab",
    });
    expect(collector.add("ST1F")).toEqual({
      kind: "ignored",
      reason: "not_simpletab",
    });
  });

  it("handles single ST1 codes with whitespace trimming and duplicate suppression", () => {
    let time = 10_000;
    const collector = new QrFragmentCollector({
      now: () => time,
      staleMs: 120_000,
    });

    expect(collector.add("  ST1.abcBody.xyzTag \n")).toEqual({
      kind: "complete",
      codes: ["ST1.abcBody.xyzTag"],
    });

    // Duplicate immediately and right at the staleMs boundary.
    expect(collector.add("ST1.abcBody.xyzTag")).toEqual({
      kind: "ignored",
      reason: "duplicate",
    });
    time += 120_000;
    expect(collector.add("ST1.abcBody.xyzTag")).toEqual({
      kind: "ignored",
      reason: "duplicate",
    });

    // Different single code completes immediately.
    expect(collector.add("ST1.otherBody.otherTag")).toEqual({
      kind: "complete",
      codes: ["ST1.otherBody.otherTag"],
    });

    // After staleMs, the original single code is accepted again.
    time += 1;
    expect(collector.add("ST1.abcBody.xyzTag")).toEqual({
      kind: "complete",
      codes: ["ST1.abcBody.xyzTag"],
    });
  });

  it("rejects malformed ST1 single codes", () => {
    const collector = new QrFragmentCollector({ now: () => 1_000 });
    expect(collector.add("ST1.onlybody")).toEqual({
      kind: "ignored",
      reason: "malformed",
    });
    expect(collector.add("ST1..tag")).toEqual({
      kind: "ignored",
      reason: "malformed",
    });
    expect(collector.add("ST1.body.")).toEqual({
      kind: "ignored",
      reason: "malformed",
    });
    expect(collector.add("ST1.a.b.c")).toEqual({
      kind: "ignored",
      reason: "malformed",
    });
    expect(collector.add("ST1.body with space.tag")).toEqual({
      kind: "ignored",
      reason: "malformed",
    });
  });

  it("collects multi-part ST1F fragments in any order and emits sorted codes", () => {
    let time = 1_000;
    const collector = new QrFragmentCollector({
      now: () => time,
      staleMs: 120_000,
    });

    const f1 = makeFragment("sub1", 1, 3, 2500, "hashTag1234567890123456", "ST1.part1.");
    const f2 = makeFragment("sub1", 2, 3, 2500, "hashTag1234567890123456", "part2.with.dots.");
    const f3 = makeFragment("sub1", 3, 3, 2500, "hashTag1234567890123456", "part3.mac");

    expect(collector.add(f3)).toEqual({
      kind: "partial",
      sid: "sub1",
      have: 1,
      of: 3,
    });
    // Repeated frame for the same fragment is ignored as duplicate.
    expect(collector.add(` ${f3} `)).toEqual({
      kind: "ignored",
      reason: "duplicate",
    });

    expect(collector.add(f1)).toEqual({
      kind: "partial",
      sid: "sub1",
      have: 2,
      of: 3,
    });
    expect(collector.add(f2)).toEqual({
      kind: "complete",
      codes: [f1, f2, f3],
    });

    // Re-scanning any fragment of the just-completed sid within staleMs is duplicate.
    expect(collector.add(f2)).toEqual({
      kind: "ignored",
      reason: "duplicate",
    });

    // Once staleMs elapses, the same sid can be scanned again cleanly.
    time += 120_001;
    expect(collector.add(f1)).toEqual({
      kind: "partial",
      sid: "sub1",
      have: 1,
      of: 3,
    });
  });

  it("tracks multiple interleaved sids independently", () => {
    const collector = new QrFragmentCollector({ now: () => 1_000 });
    const a1 = makeFragment("sidA", 1, 2, 1900, "hashA", "chunkA1");
    const a2 = makeFragment("sidA", 2, 2, 1900, "hashA", "chunkA2");
    const b1 = makeFragment("sidB", 1, 2, 1900, "hashB", "chunkB1");
    const b2 = makeFragment("sidB", 2, 2, 1900, "hashB", "chunkB2");

    expect(collector.add(a2)).toEqual({ kind: "partial", sid: "sidA", have: 1, of: 2 });
    expect(collector.add(b1)).toEqual({ kind: "partial", sid: "sidB", have: 1, of: 2 });
    expect(collector.add(a1)).toEqual({ kind: "complete", codes: [a1, a2] });
    expect(collector.add(b2)).toEqual({ kind: "complete", codes: [b1, b2] });
  });

  it("rejects malformed fragment headers and header inconsistencies without corrupting valid partials", () => {
    const collector = new QrFragmentCollector({ now: () => 1_000 });

    // Structural / bounds errors
    expect(collector.add("ST1F.sid.1.2.100.hash")).toEqual({
      kind: "ignored",
      reason: "malformed",
    });
    expect(collector.add(makeFragment("s", 1, 1, 100, "h", "d"))).toEqual({
      kind: "ignored",
      reason: "malformed",
    });
    expect(collector.add(makeFragment("s", 1, 5, 100, "h", "d"))).toEqual({
      kind: "ignored",
      reason: "malformed",
    });
    expect(collector.add(makeFragment("s", 3, 2, 100, "h", "d"))).toEqual({
      kind: "ignored",
      reason: "malformed",
    });
    expect(collector.add("ST1F.sid.0.2.100.hash.data")).toEqual({
      kind: "ignored",
      reason: "malformed",
    });
    expect(collector.add("ST1F..1.2.100.hash.data")).toEqual({
      kind: "ignored",
      reason: "malformed",
    });
    expect(collector.add("ST1F.sid.1.2.0.hash.data")).toEqual({
      kind: "ignored",
      reason: "malformed",
    });
    expect(collector.add("ST1F.sid.1.2.100..data")).toEqual({
      kind: "ignored",
      reason: "malformed",
    });
    expect(collector.add("ST1F.sid.1.2.100.hash.")).toEqual({
      kind: "ignored",
      reason: "malformed",
    });

    // Valid partial followed by inconsistent metadata or conflicting payload
    const f1 = makeFragment("sid1", 1, 3, 2000, "hash1", "data1");
    const wrongN = makeFragment("sid1", 2, 4, 2000, "hash1", "data2");
    const wrongLen = makeFragment("sid1", 2, 3, 2001, "hash1", "data2");
    const wrongHash = makeFragment("sid1", 2, 3, 2000, "hash2", "data2");
    const conflictingData = makeFragment("sid1", 1, 3, 2000, "hash1", "tampered1");
    const f2 = makeFragment("sid1", 2, 3, 2000, "hash1", "data2");
    const f3 = makeFragment("sid1", 3, 3, 2000, "hash1", "data3");

    expect(collector.add(f1)).toEqual({ kind: "partial", sid: "sid1", have: 1, of: 3 });
    expect(collector.add(wrongN)).toEqual({ kind: "ignored", reason: "malformed" });
    expect(collector.add(wrongLen)).toEqual({ kind: "ignored", reason: "malformed" });
    expect(collector.add(wrongHash)).toEqual({ kind: "ignored", reason: "malformed" });
    expect(collector.add(conflictingData)).toEqual({ kind: "ignored", reason: "malformed" });

    expect(collector.add(f2)).toEqual({ kind: "partial", sid: "sid1", have: 2, of: 3 });
    expect(collector.add(f3)).toEqual({ kind: "complete", codes: [f1, f2, f3] });
  });

  it("drops stale partial fragment groups and supports reset()", () => {
    let time = 0;
    const collector = new QrFragmentCollector({
      now: () => time,
      staleMs: 5_000,
    });

    const f1 = makeFragment("staleSid", 1, 2, 1900, "hash", "part1");
    const f2 = makeFragment("staleSid", 2, 2, 1900, "hash", "part2");

    expect(collector.add(f1)).toEqual({
      kind: "partial",
      sid: "staleSid",
      have: 1,
      of: 2,
    });

    // Duplicate does NOT refresh updatedAt.
    time = 3_000;
    expect(collector.add(f1)).toEqual({ kind: "ignored", reason: "duplicate" });

    // > staleMs since f1 was added (time 5001 > 5000): f1 is pruned before adding f2.
    time = 5_001;
    expect(collector.add(f2)).toEqual({
      kind: "partial",
      sid: "staleSid",
      have: 1,
      of: 2,
    });

    collector.reset();
    // After reset, f2 is accepted again as a fresh 1/2 partial.
    expect(collector.add(f2)).toEqual({
      kind: "partial",
      sid: "staleSid",
      have: 1,
      of: 2,
    });
  });

  it("interoperates with encodeQrBallot single and multi-fragment wire codes", async () => {
    const key = new Uint8Array(32).fill(7);
    const smallCodes = await encodeQrBallot(key, {
      sid: "sSmall",
      slug: "open-2026",
      lid: "link1",
      rnd: "r1",
      type: "ballot",
      payload: { scores: [75, 76] },
    });
    expect(smallCodes).toHaveLength(1);

    const collector = new QrFragmentCollector({ now: () => 1_000 });
    expect(collector.add(smallCodes[0]!)).toEqual({
      kind: "complete",
      codes: smallCodes,
    });

    // Build an uncompressible high-entropy payload so encodeQrBallot splits into ST1F fragments.
    const randomChunks: string[] = [];
    let seed = 0x12345678;
    for (let i = 0; i < 320; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      randomChunks.push(seed.toString(36));
    }
    const largeCodes = await encodeQrBallot(key, {
      sid: "sLarge",
      slug: "open-2026",
      lid: "link1",
      rnd: "r1",
      type: "ballot",
      payload: { notes: randomChunks.join("-") },
    });
    expect(largeCodes.length).toBeGreaterThanOrEqual(2);

    const reversed = [...largeCodes].reverse();
    for (let i = 0; i < reversed.length - 1; i++) {
      expect(collector.add(reversed[i]!)).toEqual({
        kind: "partial",
        sid: "sLarge",
        have: i + 1,
        of: largeCodes.length,
      });
    }
    expect(collector.add(reversed[reversed.length - 1]!)).toEqual({
      kind: "complete",
      codes: largeCodes,
    });
  });
});
