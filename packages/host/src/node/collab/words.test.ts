import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BIP39_ENGLISH_WORDS, pairingWords } from "./words";

function referencePairingWords(hostFp: string, deviceFp: string, code: string): string[] {
  const digest = createHash("sha256")
    .update(Buffer.from(hostFp, "hex"))
    .update(Buffer.from(deviceFp, "hex"))
    .update(code, "utf8")
    .digest();
  const bits = Array.from(digest.subarray(0, 9))
    .map((byte) => byte.toString(2).padStart(8, "0"))
    .join("");
  const result: string[] = [];
  for (let i = 0; i < 6; i++) {
    const idx = Number.parseInt(bits.slice(i * 11, (i + 1) * 11), 2);
    result.push(BIP39_ENGLISH_WORDS[idx]!);
  }
  return result;
}

describe("BIP39 pairing words", () => {
  const hostFp = "0123456789abcdef".repeat(4);
  const deviceFp = "fedcba9876543210".repeat(4);

  it("loads the 2048-word BIP39 English list", () => {
    expect(BIP39_ENGLISH_WORDS).toHaveLength(2048);
    expect(BIP39_ENGLISH_WORDS[0]).toBe("abandon");
    expect(BIP39_ENGLISH_WORDS[2047]).toBe("zoo");
  });

  it("matches an independent bit-by-bit SHA-256 reference vector", () => {
    const code = "04201984";
    const words = pairingWords(hostFp, deviceFp, code);
    const expected = referencePairingWords(hostFp, deviceFp, code);

    expect(words).toHaveLength(6);
    expect(words).toEqual(expected);
  });

  it("changes when any input changes or fingerprints are swapped", () => {
    const base = pairingWords(hostFp, deviceFp, "12345678");
    const otherHost = pairingWords("ff" + hostFp.slice(2), deviceFp, "12345678");
    const otherDevice = pairingWords(hostFp, "00" + deviceFp.slice(2), "12345678");
    const swapped = pairingWords(deviceFp, hostFp, "12345678");
    const otherCode = pairingWords(hostFp, deviceFp, "12345679");

    expect(otherHost).not.toEqual(base);
    expect(otherDevice).not.toEqual(base);
    expect(swapped).not.toEqual(base);
    expect(otherCode).not.toEqual(base);
  });

  it("validates fingerprint format", () => {
    expect(() => pairingWords(hostFp.toUpperCase(), deviceFp, "12345678")).toThrow();
    expect(() => pairingWords(hostFp.slice(0, 62), deviceFp, "12345678")).toThrow();
    expect(() => pairingWords(hostFp, "g".repeat(64), "12345678")).toThrow();
  });
});
