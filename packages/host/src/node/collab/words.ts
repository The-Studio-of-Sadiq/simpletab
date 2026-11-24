import { createHash } from "node:crypto";
import type { CertFingerprint } from "../../common/collab-protocol";
import bip39Words from "./bip39-english.json" with { type: "json" };

/**
 * Six-word BIP39 pairing verification fingerprint (design section 4, amendment 7).
 */

export const BIP39_ENGLISH_WORDS: readonly string[] = bip39Words;

if (BIP39_ENGLISH_WORDS.length !== 2048) {
  throw new Error(`Expected 2048 BIP39 words, found ${BIP39_ENGLISH_WORDS.length}.`);
}

const FINGERPRINT_HEX_RE = /^[0-9a-f]{64}$/;
const WORD_COUNT = 6;
const BITS_PER_WORD = 11;

function parseFingerprint(fp: CertFingerprint, label: string): Buffer {
  if (!FINGERPRINT_HEX_RE.test(fp)) {
    throw new Error(`${label} must be 64 lowercase hexadecimal characters.`);
  }
  return Buffer.from(fp, "hex");
}

/**
 * Computes six BIP39 English words from the host fingerprint, device fingerprint, and pairing code.
 * Both sides compute the exact same list independently to detect a man-in-the-middle.
 */
export function pairingWords(
  hostFingerprint: CertFingerprint,
  deviceFingerprint: CertFingerprint,
  code: string,
): string[] {
  const hostBytes = parseFingerprint(hostFingerprint, "Host certificate fingerprint");
  const deviceBytes = parseFingerprint(deviceFingerprint, "Device certificate fingerprint");

  const digest = createHash("sha256")
    .update(hostBytes)
    .update(deviceBytes)
    .update(code, "utf8")
    .digest();

  const words: string[] = [];
  for (let wordIdx = 0; wordIdx < WORD_COUNT; wordIdx++) {
    const startBit = wordIdx * BITS_PER_WORD;
    let index = 0;
    for (let bitOffset = 0; bitOffset < BITS_PER_WORD; bitOffset++) {
      const bitPos = startBit + bitOffset;
      const byteVal = digest[bitPos >>> 3]!;
      const bit = (byteVal >>> (7 - (bitPos & 7))) & 1;
      index = (index << 1) | bit;
    }
    words.push(BIP39_ENGLISH_WORDS[index]!);
  }
  return words;
}
