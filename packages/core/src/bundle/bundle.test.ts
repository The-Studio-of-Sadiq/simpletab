import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveKeys, type DerivedKeys } from "@/crypto/keys";
import { newLink } from "@/crypto/links";
import {
  BUNDLE_BUCKET_COUNT,
  BUNDLE_HEADER_BYTE_LENGTH,
  BUNDLE_ROW_MULTIPLE,
  BUNDLE_VERSION,
  BundleFormatError,
  ROW_ID_BYTE_LENGTH,
  ROW_PLAINTEXT_BYTE_LENGTH,
  ROW_RECORD_BYTE_LENGTH,
  RowTooLargeError,
  bucketForRowId,
  compareRowIds,
  computeRowId,
  parseBucketHeader,
  type RoundBundleRow,
} from "./format";
import { openRow } from "./open";
import { sealRound } from "./seal";

interface TestParticipant {
  lookupId: string;
  secret: Uint8Array;
  keys: DerivedKeys;
  row: RoundBundleRow;
}

describe("encrypted round bundles", () => {
  const slug = "wudc-2027";
  const roundId = "round-1";
  const roundSeq = 1;

  async function createParticipants(count: number): Promise<TestParticipant[]> {
    const participants: TestParticipant[] = [];
    for (let i = 0; i < count; i++) {
      const role = i % 3 === 0 ? "adjudicator" : i % 3 === 1 ? "team" : "speaker";
      const link = newLink(
        role,
        "wudc2027.pages.dev",
        "https://ballots.simpletab.org",
        slug,
      );
      const keys = await deriveKeys(link.secret, slug);
      const row: RoundBundleRow = {
        room: `R${(i % 25) + 1}`,
        ...(role === "team" ? { side: "OG", teammates: [`Speaker A${i}`, `Speaker B${i}`] } : {}),
        ...(role === "adjudicator"
          ? {
              panel: [
                { name: `Chair ${i}`, role: "chair" },
                { name: `Wing ${i}`, role: "wing" },
              ],
            }
          : {}),
        forms: role === "adjudicator" ? ["bp-ballot", "checkin"] : ["feedback"],
        venue: `Hall ${(i % 10) + 1}`,
      };
      participants.push({
        lookupId: link.lookupId,
        secret: link.secret,
        keys,
        row,
      });
    }
    return participants;
  }

  it("matches independent node:crypto rowId and bucket calculation", async () => {
    const secret = Uint8Array.from([
      10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160,
    ]);
    const keys = await deriveKeys(secret, slug);
    const rowId = await computeRowId(keys.lookupKey, roundId);
    const expected = new Uint8Array(
      createHmac("sha256", keys.lookupKey)
        .update(Buffer.from(roundId, "utf8"))
        .digest()
        .subarray(0, ROW_ID_BYTE_LENGTH),
    );
    expect(rowId).toEqual(expected);
    expect(bucketForRowId(rowId)).toBe(expected[0]! >> 3);
  });

  it("seals and opens 100 rows across 32 dummy-padded buckets with exact binary layout", async () => {
    const participants = await createParticipants(100);
    const buckets = await sealRound({
      roundSeq,
      roundId,
      rows: participants.map((p) => ({
        lookupId: p.lookupId,
        keys: p.keys,
        row: p.row,
      })),
    });

    expect(buckets.size).toBe(BUNDLE_BUCKET_COUNT);

    // Check binary invariants on all 32 buckets.
    let totalRecords = 0;
    for (let b = 0; b < BUNDLE_BUCKET_COUNT; b++) {
      const bytes = buckets.get(b);
      expect(bytes).toBeDefined();

      const header = parseBucketHeader(bytes!);
      expect(header.version).toBe(BUNDLE_VERSION);
      expect(header.roundSeq).toBe(roundSeq);
      expect(header.rowCount).toBeGreaterThanOrEqual(BUNDLE_ROW_MULTIPLE);
      expect(header.rowCount % BUNDLE_ROW_MULTIPLE).toBe(0);
      expect(bytes!.byteLength).toBe(
        BUNDLE_HEADER_BYTE_LENGTH + header.rowCount * ROW_RECORD_BYTE_LENGTH,
      );
      totalRecords += header.rowCount;

      // Verify strict ascending rowId sort and bucket-prefix consistency for every row (real + dummy).
      let prevId: Uint8Array | null = null;
      for (let i = 0; i < header.rowCount; i++) {
        const offset = BUNDLE_HEADER_BYTE_LENGTH + i * ROW_RECORD_BYTE_LENGTH;
        const id = bytes!.subarray(offset, offset + ROW_ID_BYTE_LENGTH);
        expect(bucketForRowId(id)).toBe(b);
        if (prevId !== null) {
          expect(compareRowIds(prevId, id)).toBeLessThan(0);
        }
        prevId = id;
      }
    }
    expect(totalRecords).toBeGreaterThanOrEqual(100);

    // Verify every participant opens their exact row from their bucket and gets null in another bucket.
    for (const p of participants) {
      const rowId = await computeRowId(p.keys.lookupKey, roundId);
      const bucketIdx = bucketForRowId(rowId);
      const bucketBytes = buckets.get(bucketIdx)!;
      const opened = await openRow(bucketBytes, p.keys, roundId);
      expect(opened).toEqual(p.row);

      const otherBucketIdx = (bucketIdx + 1) % BUNDLE_BUCKET_COUNT;
      const missing = await openRow(
        buckets.get(otherBucketIdx)!,
        p.keys,
        roundId,
      );
      expect(missing).toBeNull();
    }
  });

  it("prevents opening a row with another person's keys or wrong passcode", async () => {
    const [alice, bob] = await createParticipants(2);
    const aliceWithPass = await deriveKeys(alice!.secret, slug, "my-passcode");
    const aliceWrongPass = await deriveKeys(alice!.secret, slug, "wrong-pass");

    const buckets = await sealRound({
      roundSeq,
      roundId,
      rows: [{ lookupId: alice!.lookupId, keys: aliceWithPass, row: alice!.row }],
    });

    const aliceRowId = await computeRowId(aliceWithPass.lookupKey, roundId);
    const bucketBytes = buckets.get(bucketForRowId(aliceRowId))!;

    // Bob's keys cannot find or open Alice's row.
    expect(await openRow(bucketBytes, bob!.keys, roundId)).toBeNull();

    // Wrong passcode derives different lookupKey -> not found.
    expect(await openRow(bucketBytes, aliceWrongPass, roundId)).toBeNull();

    // Even if Bob somehow had Alice's lookupKey, Bob's fileKey cannot decrypt Alice's row.
    await expect(
      openRow(
        bucketBytes,
        { lookupKey: aliceWithPass.lookupKey, fileKey: bob!.keys.fileKey },
        roundId,
      ),
    ).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });
  });

  it("rejects tampered ciphertext, nonce, and header roundSeq", async () => {
    const [alice] = await createParticipants(1);
    const buckets = await sealRound({
      roundSeq: 3,
      roundId,
      rows: [{ lookupId: alice!.lookupId, keys: alice!.keys, row: alice!.row }],
    });

    const rowId = await computeRowId(alice!.keys.lookupKey, roundId);
    const original = buckets.get(bucketForRowId(rowId))!;

    // Locate Alice's record offset in the bucket.
    const header = parseBucketHeader(original);
    let recordOffset = -1;
    for (let i = 0; i < header.rowCount; i++) {
      const off = BUNDLE_HEADER_BYTE_LENGTH + i * ROW_RECORD_BYTE_LENGTH;
      if (compareRowIds(original.subarray(off, off + ROW_ID_BYTE_LENGTH), rowId) === 0) {
        recordOffset = off;
        break;
      }
    }
    expect(recordOffset).toBeGreaterThanOrEqual(BUNDLE_HEADER_BYTE_LENGTH);

    // Flip a byte in ciphertext
    const badCiphertext = new Uint8Array(original);
    badCiphertext[recordOffset + ROW_ID_BYTE_LENGTH + 12 + 10]! ^= 0x01;
    await expect(
      openRow(badCiphertext, alice!.keys, roundId),
    ).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });

    // Flip a byte in GCM tag (last byte of record)
    const badTag = new Uint8Array(original);
    badTag[recordOffset + ROW_RECORD_BYTE_LENGTH - 1]! ^= 0x80;
    await expect(openRow(badTag, alice!.keys, roundId)).rejects.toMatchObject({
      code: "DECRYPTION_FAILED",
    });

    // Flip a byte in nonce
    const badNonce = new Uint8Array(original);
    badNonce[recordOffset + ROW_ID_BYTE_LENGTH]! ^= 0x01;
    await expect(openRow(badNonce, alice!.keys, roundId)).rejects.toMatchObject(
      { code: "DECRYPTION_FAILED" },
    );

    // Mutate roundSeq in header (protected by AES-GCM AAD)
    const badRoundSeq = new Uint8Array(original);
    badRoundSeq[5]! ^= 0x01;
    await expect(
      openRow(badRoundSeq, alice!.keys, roundId),
    ).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });
  });

  it("rejects corrupted magic, version, rowCount, and length with typed BundleFormatError", async () => {
    const [alice] = await createParticipants(1);
    const buckets = await sealRound({
      roundSeq,
      roundId,
      rows: [{ lookupId: alice!.lookupId, keys: alice!.keys, row: alice!.row }],
    });
    const rowId = await computeRowId(alice!.keys.lookupKey, roundId);
    const valid = buckets.get(bucketForRowId(rowId))!;

    // Truncated header
    await expect(
      openRow(valid.subarray(0, 5), alice!.keys, roundId),
    ).rejects.toMatchObject({ code: "TRUNCATED_HEADER" });

    // Wrong magic
    const badMagic = new Uint8Array(valid);
    badMagic[0] = 0x58; // 'X'
    await expect(openRow(badMagic, alice!.keys, roundId)).rejects.toMatchObject({
      code: "INVALID_MAGIC",
    });

    // Wrong version
    const badVersion = new Uint8Array(valid);
    badVersion[4] = 2;
    await expect(
      openRow(badVersion, alice!.keys, roundId),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_VERSION" });

    // rowCount not a multiple of 8
    const badRowCount = new Uint8Array(valid);
    badRowCount[7] = 7;
    badRowCount[8] = 0;
    await expect(
      openRow(badRowCount, alice!.keys, roundId),
    ).rejects.toMatchObject({ code: "INVALID_ROW_COUNT" });

    // Wrong byte length (extra trailing byte)
    const badLength = new Uint8Array(valid.byteLength + 1);
    badLength.set(valid, 0);
    await expect(
      openRow(badLength, alice!.keys, roundId),
    ).rejects.toMatchObject({ code: "INVALID_LENGTH" });
  });

  it("throws RowTooLargeError naming lookupId over 512 bytes, and allows exact 512 bytes", async () => {
    const [alice] = await createParticipants(1);

    const oversizedRow: RoundBundleRow = {
      room: "R1",
      forms: ["bp-ballot"],
      venue: "V".repeat(520),
    };

    try {
      await sealRound({
        roundSeq,
        roundId,
        rows: [
          {
            lookupId: alice!.lookupId,
            keys: alice!.keys,
            row: oversizedRow,
          },
        ],
      });
      expect.unreachable("Expected RowTooLargeError");
    } catch (err) {
      expect(err).toBeInstanceOf(RowTooLargeError);
      const tooLarge = err as RowTooLargeError;
      expect(tooLarge.lookupId).toBe(alice!.lookupId);
      expect(tooLarge.message).toContain(alice!.lookupId);
      expect(tooLarge.byteLength).toBeGreaterThan(ROW_PLAINTEXT_BYTE_LENGTH);
      expect(tooLarge.maxByteLength).toBe(ROW_PLAINTEXT_BYTE_LENGTH);
    }

    // Exact 512-byte canonical JSON row must seal and open cleanly with zero padding bytes.
    const baseRow: RoundBundleRow = {
      room: "R1",
      forms: ["f"],
      venue: "",
    };
    const overhead = new TextEncoder().encode(
      `{"forms":["f"],"room":"R1","venue":""}`,
    ).byteLength;
    const exactRow: RoundBundleRow = {
      ...baseRow,
      venue: "X".repeat(ROW_PLAINTEXT_BYTE_LENGTH - overhead),
    };

    const buckets = await sealRound({
      roundSeq,
      roundId,
      rows: [{ lookupId: alice!.lookupId, keys: alice!.keys, row: exactRow }],
    });
    const rowId = await computeRowId(alice!.keys.lookupKey, roundId);
    const opened = await openRow(
      buckets.get(bucketForRowId(rowId))!,
      alice!.keys,
      roundId,
    );
    expect(opened).toEqual(exactRow);
  });

  it("rejects duplicate rowIds in the same round", async () => {
    const [alice] = await createParticipants(1);
    await expect(
      sealRound({
        roundSeq,
        roundId,
        rows: [
          { lookupId: alice!.lookupId, keys: alice!.keys, row: alice!.row },
          { lookupId: alice!.lookupId, keys: alice!.keys, row: alice!.row },
        ],
      }),
    ).rejects.toThrow(BundleFormatError);
  });
});
