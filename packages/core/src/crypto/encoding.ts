/**
 * Binary encoding, decoding, and constant-time comparison primitives for
 * `@simpletab/core`.
 *
 * Security notes:
 * - Both base32 and base64url decoders enforce canonical (non-malleable)
 *   encodings: no padding, no whitespace, strict alphabet checks, and zero
 *   unused trailing bits.
 * - Constant-time comparison avoids timing side channels when checking MACs
 *   and proofs.
 * - Uses only standard ECMAScript / Web APIs (`TextEncoder`, `TextDecoder`) so
 *   the module runs unchanged in Electron, Cloudflare Workers and browsers.
 */

export const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const BASE32_DECODE_TABLE = buildDecodeTable(BASE32_ALPHABET);
const BASE64URL_DECODE_TABLE = buildDecodeTable(BASE64URL_ALPHABET);

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function buildDecodeTable(alphabet: string): Int8Array {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < alphabet.length; i++) {
    table[alphabet.charCodeAt(i)] = i;
  }
  return table;
}

/**
 * Copies a byte slice into a fresh `ArrayBuffer`-backed `Uint8Array` so it
 * satisfies WebCrypto's `BufferSource` type under strict TypeScript and cannot
 * be mutated by callers during async operations.
 */
export function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

/**
 * Encodes a string as UTF-8 bytes in a fresh `ArrayBuffer`.
 */
export function utf8Encode(text: string): Uint8Array<ArrayBuffer> {
  return toBufferSource(utf8Encoder.encode(text));
}

/**
 * Strictly decodes UTF-8 bytes, throwing `TypeError` on invalid byte sequences.
 */
export function utf8Decode(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

/**
 * Concatenates multiple byte arrays into a single `ArrayBuffer`-backed array.
 */
export function concatBytes(
  ...parts: readonly Uint8Array[]
): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const part of parts) {
    total += part.byteLength;
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Encodes bytes as lowercase hexadecimal.
 */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Encodes bytes as RFC 4648 base32 lowercase without padding.
 */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < bytes.byteLength; i++) {
    buffer = (buffer << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >>> bits) & 0x1f]!;
    }
  }

  if (bits > 0) {
    out += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f]!;
  }

  return out;
}

/**
 * Strictly decodes unpadded RFC 4648 base32 lowercase into bytes.
 * Returns `null` if the input contains invalid characters, an invalid length,
 * or non-zero unused trailing bits (preventing malleable representations).
 */
export function base32Decode(encoded: string): Uint8Array<ArrayBuffer> | null {
  const remainder = encoded.length % 8;
  if (remainder === 1 || remainder === 3 || remainder === 6) {
    return null;
  }

  const outLength = Math.floor((encoded.length * 5) / 8);
  const out = new Uint8Array(new ArrayBuffer(outLength));
  let buffer = 0;
  let bits = 0;
  let outIndex = 0;

  for (let i = 0; i < encoded.length; i++) {
    const code = encoded.charCodeAt(i);
    if (code >= 128) return null;
    const value = BASE32_DECODE_TABLE[code]!;
    if (value < 0) return null;

    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (buffer >>> bits) & 0xff;
    }
  }

  if (bits > 0) {
    const trailingMask = (1 << bits) - 1;
    if ((buffer & trailingMask) !== 0) {
      return null;
    }
  }

  return out;
}

/**
 * Encodes bytes as RFC 4648 §5 base64url without padding.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  const len = bytes.byteLength;
  let i = 0;

  for (; i + 2 < len; i += 3) {
    const triplet = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += BASE64URL_ALPHABET[(triplet >>> 18) & 0x3f]!;
    out += BASE64URL_ALPHABET[(triplet >>> 12) & 0x3f]!;
    out += BASE64URL_ALPHABET[(triplet >>> 6) & 0x3f]!;
    out += BASE64URL_ALPHABET[triplet & 0x3f]!;
  }

  const remaining = len - i;
  if (remaining === 1) {
    const b0 = bytes[i]!;
    out += BASE64URL_ALPHABET[(b0 >>> 2) & 0x3f]!;
    out += BASE64URL_ALPHABET[(b0 << 4) & 0x3f]!;
  } else if (remaining === 2) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    out += BASE64URL_ALPHABET[(b0 >>> 2) & 0x3f]!;
    out += BASE64URL_ALPHABET[((b0 << 4) | (b1 >>> 4)) & 0x3f]!;
    out += BASE64URL_ALPHABET[(b1 << 2) & 0x3f]!;
  }

  return out;
}

/**
 * Strictly decodes unpadded RFC 4648 §5 base64url into bytes.
 * Returns `null` on invalid characters, invalid length, or non-zero trailing
 * bits.
 */
export function base64UrlDecode(
  encoded: string,
): Uint8Array<ArrayBuffer> | null {
  const remainder = encoded.length % 4;
  if (remainder === 1) {
    return null;
  }

  const outLength = Math.floor((encoded.length * 3) / 4);
  const out = new Uint8Array(new ArrayBuffer(outLength));
  let buffer = 0;
  let bits = 0;
  let outIndex = 0;

  for (let i = 0; i < encoded.length; i++) {
    const code = encoded.charCodeAt(i);
    if (code >= 128) return null;
    const value = BASE64URL_DECODE_TABLE[code]!;
    if (value < 0) return null;

    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (buffer >>> bits) & 0xff;
    }
  }

  if (bits > 0) {
    const trailingMask = (1 << bits) - 1;
    if ((buffer & trailingMask) !== 0) {
      return null;
    }
  }

  return out;
}

/**
 * Constant-time equality check over two byte arrays.
 * Iterates across the longer length and folds length mismatch into the XOR
 * accumulator so timing does not leak where the first difference occurred.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.byteLength ^ b.byteLength;
  const maxLen = Math.max(a.byteLength, b.byteLength);
  for (let i = 0; i < maxLen; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Constant-time equality check for ASCII/UTF-8 strings such as MACs and hashes.
 */
export function constantTimeEqualStrings(a: string, b: string): boolean {
  return constantTimeEqual(utf8Encode(a), utf8Encode(b));
}
