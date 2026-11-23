import { createHash, createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonical";
import { DERIVED_KEY_BYTE_LENGTH, deriveKeys, proof, verifier, verifyProof } from "./keys";

function nodeHkdf(
  secret: Uint8Array,
  slug: string,
  info: string,
  passcode = "",
): Uint8Array {
  const ikm = Buffer.concat([Buffer.from(secret), Buffer.from(passcode, "utf8")]);
  const salt = Buffer.from(`simpletab/v1/${slug}`, "utf8");
  return new Uint8Array(hkdfSync("sha256", ikm, salt, Buffer.from(info, "utf8"), 32));
}

function nodeVerifier(authKey: Uint8Array): string {
  return createHash("sha256").update(authKey).digest("hex");
}

function nodeProof(
  authKey: Uint8Array,
  submissionId: string,
  payload: unknown,
): string {
  const payloadHash = createHash("sha256")
    .update(Buffer.from(canonicalize(payload), "utf8"))
    .digest("base64url");
  return createHmac("sha256", authKey)
    .update(Buffer.from(`${submissionId}.${payloadHash}`, "utf8"))
    .digest("base64url");
}

describe("HKDF key derivation, verifier, and submission proof", () => {
  const fixedSecret = Uint8Array.from([
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
    0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
  ]);
  const slug = "wudc-2027";

  it("matches independent node:crypto HKDF-SHA-256 known-answer vectors", async () => {
    const keysNoPass = await deriveKeys(fixedSecret, slug);
    expect(keysNoPass.authKey.byteLength).toBe(DERIVED_KEY_BYTE_LENGTH);
    expect(keysNoPass.fileKey.byteLength).toBe(DERIVED_KEY_BYTE_LENGTH);
    expect(keysNoPass.lookupKey.byteLength).toBe(DERIVED_KEY_BYTE_LENGTH);
    expect(keysNoPass.qrKey.byteLength).toBe(DERIVED_KEY_BYTE_LENGTH);

    expect(keysNoPass.authKey).toEqual(nodeHkdf(fixedSecret, slug, "auth"));
    expect(keysNoPass.fileKey).toEqual(nodeHkdf(fixedSecret, slug, "file"));
    expect(keysNoPass.lookupKey).toEqual(nodeHkdf(fixedSecret, slug, "lookup"));
    expect(keysNoPass.qrKey).toEqual(nodeHkdf(fixedSecret, slug, "qr"));

    // Empty string passcode matches omitted passcode.
    const keysEmptyPass = await deriveKeys(fixedSecret, slug, "");
    expect(keysEmptyPass).toEqual(keysNoPass);

    // With Unicode passcode.
    const passcode = "tab-room-🔑-42";
    const keysWithPass = await deriveKeys(fixedSecret, slug, passcode);
    expect(keysWithPass.authKey).toEqual(
      nodeHkdf(fixedSecret, slug, "auth", passcode),
    );
    expect(keysWithPass.fileKey).toEqual(
      nodeHkdf(fixedSecret, slug, "file", passcode),
    );
    expect(keysWithPass.lookupKey).toEqual(
      nodeHkdf(fixedSecret, slug, "lookup", passcode),
    );
    expect(keysWithPass.qrKey).toEqual(
      nodeHkdf(fixedSecret, slug, "qr", passcode),
    );
  });

  it("derives completely different keys for a wrong passcode or different slug", async () => {
    const right = await deriveKeys(fixedSecret, slug, "correct-horse");
    const wrong = await deriveKeys(fixedSecret, slug, "wrong-horse");
    const otherSlug = await deriveKeys(fixedSecret, "other-tourney", "correct-horse");

    expect(wrong.authKey).not.toEqual(right.authKey);
    expect(wrong.fileKey).not.toEqual(right.fileKey);
    expect(wrong.lookupKey).not.toEqual(right.lookupKey);
    expect(wrong.qrKey).not.toEqual(right.qrKey);

    expect(otherSlug.authKey).not.toEqual(right.authKey);
    expect(otherSlug.fileKey).not.toEqual(right.fileKey);
    expect(otherSlug.lookupKey).not.toEqual(right.lookupKey);
    expect(otherSlug.qrKey).not.toEqual(right.qrKey);
  });

  it("computes verifier and submission proof matching independent node:crypto", async () => {
    const keys = await deriveKeys(fixedSecret, slug, "pass123");
    const v = await verifier(keys.authKey);
    expect(v).toBe(nodeVerifier(keys.authKey));
    expect(v).toMatch(/^[0-9a-f]{64}$/);

    const submissionId = "01JDF4Z7N0P9Q8R7S6T5V4W3X2";
    const payloadA = {
      scores: [78, 76, 75, 74],
      room: "R1",
      confirmed: true,
    };
    // Different key insertion order must yield identical proof.
    const payloadB = {
      confirmed: true,
      room: "R1",
      scores: [78, 76, 75, 74],
    };

    const pA = await proof(keys.authKey, submissionId, payloadA);
    const pB = await proof(keys.authKey, submissionId, payloadB);
    expect(pA).toBe(nodeProof(keys.authKey, submissionId, payloadA));
    expect(pA).toBe(pB);

    expect(await verifyProof(keys.authKey, submissionId, payloadA, pA)).toBe(true);
    expect(
      await verifyProof(keys.authKey, submissionId, { ...payloadA, room: "R2" }, pA),
    ).toBe(false);
    expect(
      await verifyProof(keys.authKey, "01JDF4Z7N0P9Q8R7S6T5V4W3X9", payloadA, pA),
    ).toBe(false);
    expect(await verifyProof(keys.fileKey, submissionId, payloadA, pA)).toBe(false);
  });

  it("rejects invalid key lengths and malformed submissionIds", async () => {
    await expect(deriveKeys(new Uint8Array(15), slug)).rejects.toThrow(RangeError);
    await expect(deriveKeys(fixedSecret, "")).rejects.toThrow(RangeError);
    await expect(verifier(new Uint8Array(16))).rejects.toThrow(RangeError);
    await expect(
      proof(new Uint8Array(32), "bad.id", { ok: true }),
    ).rejects.toThrow(RangeError);
  });
});
