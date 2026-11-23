import { createHash, createHmac, randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonical";
import { deriveKeys } from "./keys";
import {
  QR_MAX_BODY_LENGTH,
  QR_MAX_CODE_LENGTH,
  QR_MAX_DECOMPRESSED_BYTES,
  QR_TAG_LENGTH,
  QrBallotError,
  decodeQrBallot,
  encodeQrBallot,
  type QrBallotEnvelope,
} from "./qr";

function makeIncompressibleString(byteLength: number): string {
  // High-entropy base64url bytes do not compress well under deflate-raw, letting
  // tests reliably target exact compressed body lengths.
  return randomBytes(byteLength).toString("base64url");
}

describe("signed QR ballots (ST1 / ST1F)", () => {
  const secret = Uint8Array.from([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
  ]);

  async function getKeys(passcode?: string) {
    return deriveKeys(secret, "wudc-2027", passcode);
  }

  it("matches independent node:crypto / node:zlib wire format and round-trips single QR", async () => {
    const { qrKey } = await getKeys();
    const ballot: QrBallotEnvelope = {
      sid: "01JDF4Z7N0P9Q8R7S6T5V4W3X2",
      slug: "wudc-2027",
      lid: "abcdefghjkmnp",
      rnd: "round-1",
      type: "ballot",
      payload: {
        room: "R12",
        ranks: [1, 2, 3, 4],
        scores: [79, 78, 77, 76, 75, 74, 73, 72],
        substitution: false,
      },
    };

    const codes = await encodeQrBallot(qrKey, ballot);
    expect(codes.length).toBe(1);
    const code = codes[0]!;
    expect(code.startsWith("ST1.")).toBe(true);
    expect(code.length).toBeLessThanOrEqual(QR_MAX_CODE_LENGTH);

    // Independently verify MAC against node:crypto using the body inside the code.
    const [prefix, body, mac] = code.split(".");
    expect(prefix).toBe("ST1");
    expect(mac?.length).toBe(QR_TAG_LENGTH);

    const expectedMac = createHmac("sha256", qrKey)
      .update(Buffer.from(body!, "utf8"))
      .digest("base64url")
      .slice(0, QR_TAG_LENGTH);
    expect(mac).toBe(expectedMac);

    // Also verify independent node:zlib deflateRaw matches decoded round-trip.
    const nodeBody = deflateRawSync(
      Buffer.from(canonicalize(ballot), "utf8"),
    ).toString("base64url");
    const nodeMac = createHmac("sha256", qrKey)
      .update(Buffer.from(nodeBody, "utf8"))
      .digest("base64url")
      .slice(0, QR_TAG_LENGTH);
    const decodedFromNode = await decodeQrBallot(
      [`ST1.${nodeBody}.${nodeMac}`],
      qrKey,
    );
    expect(decodedFromNode).toEqual(ballot);

    const decoded = await decodeQrBallot(codes, qrKey);
    expect(decoded).toEqual(ballot);
  });

  it("splits large ballots into 2–4 ST1F fragments and decodes shuffled/duplicated scans", async () => {
    const { qrKey } = await getKeys();
    const ballot: QrBallotEnvelope = {
      sid: "01JDF4Z7N0P9Q8R7S6T5V4W3X9",
      slug: "wudc-2027",
      lid: "abcdefghjkmnp",
      rnd: "round-3",
      type: "feedback",
      payload: {
        // ~2,400 incompressible bytes -> ~3,200 base64url chars -> 2 or 3 fragments.
        notes: makeIncompressibleString(2_400),
      },
    };

    const fragments = await encodeQrBallot(qrKey, ballot);
    expect(fragments.length).toBeGreaterThanOrEqual(2);
    expect(fragments.length).toBeLessThanOrEqual(4);

    for (const frag of fragments) {
      expect(frag.startsWith(`ST1F.${ballot.sid}.`)).toBe(true);
      expect(frag.length).toBeLessThanOrEqual(QR_MAX_CODE_LENGTH);
    }

    // Verify fragment header SHA-256 independently.
    const joined = fragments
      .map((f) => f.split(".").slice(6).join("."))
      .join("");
    const headerParts = fragments[0]!.split(".");
    expect(Number(headerParts[4])).toBe(joined.length);
    const expectedHash = createHash("sha256")
      .update(Buffer.from(joined, "utf8"))
      .digest("base64url")
      .slice(0, QR_TAG_LENGTH);
    expect(headerParts[5]).toBe(expectedHash);

    // Shuffled order + exact duplicate fragments must succeed.
    const shuffledWithDupes = [
      ...fragments.slice().reverse(),
      fragments[0]!,
      fragments[fragments.length - 1]!,
    ];
    const decoded = await decodeQrBallot(shuffledWithDupes, qrKey);
    expect(decoded).toEqual(ballot);
  });

  it("rejects forged, altered, or wrong-key QR codes", async () => {
    const { qrKey } = await getKeys("pass-a");
    const { qrKey: wrongKey } = await getKeys("pass-b");
    const ballot: QrBallotEnvelope = {
      sid: "01JDF4Z7N0P9Q8R7S6T5V4W3XA",
      slug: "wudc-2027",
      lid: "abcdefghjkmnp",
      rnd: "round-1",
      type: "ballot",
      payload: { winner: "OG" },
    };

    const [code] = await encodeQrBallot(qrKey, ballot);

    // Wrong key
    await expect(decodeQrBallot([code!], wrongKey)).rejects.toMatchObject({
      code: "INVALID_MAC",
    });

    // Altered MAC character
    const lastChar = code!.slice(-1);
    const flippedMac =
      code!.slice(0, -1) + (lastChar === "A" ? "B" : "A");
    await expect(decodeQrBallot([flippedMac], qrKey)).rejects.toMatchObject({
      code: "INVALID_MAC",
    });

    // Altered body character
    const [prefix, body, mac] = code!.split(".");
    const alteredBody =
      (body![0] === "A" ? "B" : "A") + body!.slice(1);
    await expect(
      decodeQrBallot([`${prefix}.${alteredBody}.${mac}`], qrKey),
    ).rejects.toMatchObject({ code: "INVALID_MAC" });
  });

  it("rejects missing, conflicting, mismatched, and tampered fragments", async () => {
    const { qrKey } = await getKeys();
    const ballot: QrBallotEnvelope = {
      sid: "01JDF4Z7N0P9Q8R7S6T5V4W3XB",
      slug: "wudc-2027",
      lid: "abcdefghjkmnp",
      rnd: "round-2",
      type: "ballot",
      payload: { blob: makeIncompressibleString(2_200) },
    };

    const fragments = await encodeQrBallot(qrKey, ballot);
    expect(fragments.length).toBeGreaterThanOrEqual(2);

    // Missing fragment
    await expect(
      decodeQrBallot(fragments.slice(0, -1), qrKey),
    ).rejects.toMatchObject({ code: "MISSING_FRAGMENTS" });

    // Conflicting duplicate for index 1
    const mutatedFrag0 = `${fragments[0]!.slice(0, -1)}${
      fragments[0]!.endsWith("A") ? "B" : "A"
    }`;
    await expect(
      decodeQrBallot([fragments[0]!, mutatedFrag0, ...fragments.slice(1)], qrKey),
    ).rejects.toMatchObject({ code: "CONFLICTING_FRAGMENT" });

    // Tampered fragment data -> SHA-256 hash mismatch
    await expect(
      decodeQrBallot([mutatedFrag0, ...fragments.slice(1)], qrKey),
    ).rejects.toMatchObject({ code: "HASH_MISMATCH" });

    // Mismatched fragment from another ballot
    const otherBallot: QrBallotEnvelope = {
      ...ballot,
      sid: "01JDF4Z7N0P9Q8R7S6T5V4W3XC",
    };
    const otherFragments = await encodeQrBallot(qrKey, otherBallot);
    await expect(
      decodeQrBallot([fragments[0]!, otherFragments[1]!], qrKey),
    ).rejects.toMatchObject({ code: "MISMATCHED_FRAGMENTS" });

    // Mixed ST1 and ST1F
    const [singleCode] = await encodeQrBallot(qrKey, {
      ...ballot,
      payload: { small: true },
    });
    await expect(
      decodeQrBallot([singleCode!, fragments[0]!], qrKey),
    ).rejects.toMatchObject({ code: "MIXED_FORMATS" });
  });

  it("refuses bodies over 6,000 chars and decompression bombs over 64 KB", async () => {
    const { qrKey } = await getKeys();

    // Compressed body well over 6,000 chars
    const hugeIncompressible: QrBallotEnvelope = {
      sid: "01JDF4Z7N0P9Q8R7S6T5V4W3XD",
      slug: "wudc-2027",
      lid: "abcdefghjkmnp",
      rnd: "round-4",
      type: "ballot",
      payload: { data: makeIncompressibleString(5_200) },
    };
    await expect(
      encodeQrBallot(qrKey, hugeIncompressible),
    ).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });

    // Craft an authenticated decompression bomb: > 64 KB of repeated 'a'
    // compresses down to a few hundred bytes, well under 6,000 chars!
    const bombEnvelope: QrBallotEnvelope = {
      sid: "01JDF4Z7N0P9Q8R7S6T5V4W3XE",
      slug: "wudc-2027",
      lid: "abcdefghjkmnp",
      rnd: "round-4",
      type: "ballot",
      payload: { filler: "a".repeat(QR_MAX_DECOMPRESSED_BYTES + 1_024) },
    };
    // encodeQrBallot itself refuses uncompressed payloads > 64 KB
    await expect(encodeQrBallot(qrKey, bombEnvelope)).rejects.toMatchObject({
      code: "DECOMPRESSED_TOO_LARGE",
    });

    // Directly forge an authenticated ST1 code with a valid MAC whose
    // deflate-raw stream expands beyond 64 KB -> decodeQrBallot must abort!
    const bombBody = deflateRawSync(
      Buffer.from(canonicalize(bombEnvelope), "utf8"),
    ).toString("base64url");
    expect(bombBody.length).toBeLessThan(QR_MAX_BODY_LENGTH);
    const bombMac = createHmac("sha256", qrKey)
      .update(Buffer.from(bombBody, "utf8"))
      .digest("base64url")
      .slice(0, QR_TAG_LENGTH);

    await expect(
      decodeQrBallot([`ST1.${bombBody}.${bombMac}`], qrKey),
    ).rejects.toThrow(QrBallotError);
    await expect(
      decodeQrBallot([`ST1.${bombBody}.${bombMac}`], qrKey),
    ).rejects.toMatchObject({ code: "DECOMPRESSED_TOO_LARGE" });
  });
});
