/**
 * Binary layout, constants, error types, and row-addressing helpers for
 * encrypted round bundle buckets (design section 8 and Appendix E).
 *
 * Binary layout (little-endian):
 *   Header (9 bytes):
 *     "STRB" (4 bytes) | u8 version=1 | u16 roundSeq | u16 rowCount (multiple of 8)
 *   Rows (rowCount * 556 bytes, sorted ascending by unsigned 16-byte rowId):
 *     rowId[16] | nonce[12] | ciphertext[528 = 512 plaintext + 16 GCM tag]
 *
 * Security notes:
 * - Every row plaintext is zero-padded to exactly 512 bytes so row ciphertexts
 *   are identical in length regardless of panel size or name length.
 * - Each of the 32 buckets (`rowId[0] >> 3`) is padded with indistinguishable
 *   dummy rows to a multiple of 8 (at least 8) so bucket sizes leak neither
 *   exact participant counts nor empty buckets.
 * - AES-256-GCM binds `magic || version || roundSeq || rowId` as AAD so a
 *   malicious CDN cannot splice a row's ciphertext from one round or slot into
 *   another.
 */

import { hmacSha256 } from "@/crypto/keys";
import { concatBytes, utf8Encode } from "@/crypto/encoding";

export const BUNDLE_MAGIC = new Uint8Array([0x53, 0x54, 0x52, 0x42]); // "STRB"
export const BUNDLE_VERSION = 1;
export const BUNDLE_HEADER_BYTE_LENGTH = 9;

export const BUNDLE_BUCKET_COUNT = 32;
export const BUNDLE_ROW_MULTIPLE = 8;

export const ROW_ID_BYTE_LENGTH = 16;
export const ROW_NONCE_BYTE_LENGTH = 12;
export const ROW_PLAINTEXT_BYTE_LENGTH = 512;
export const ROW_GCM_TAG_BYTE_LENGTH = 16;
export const ROW_CIPHERTEXT_BYTE_LENGTH =
  ROW_PLAINTEXT_BYTE_LENGTH + ROW_GCM_TAG_BYTE_LENGTH; // 528
export const ROW_RECORD_BYTE_LENGTH =
  ROW_ID_BYTE_LENGTH + ROW_NONCE_BYTE_LENGTH + ROW_CIPHERTEXT_BYTE_LENGTH; // 556

export const MAX_U16 = 0xffff;

export interface RoundBundlePanelMember {
  name: string;
  role: string;
}

export interface RoundBundleRow {
  room: string;
  side?: string;
  teammates?: string[];
  panel?: RoundBundlePanelMember[];
  forms: string[];
  venue: string;
}

export interface BundleBucketHeader {
  version: number;
  roundSeq: number;
  rowCount: number;
}

export class RowTooLargeError extends Error {
  readonly lookupId: string;
  readonly byteLength: number;
  readonly maxByteLength: number;

  constructor(
    lookupId: string,
    byteLength: number,
    maxByteLength: number = ROW_PLAINTEXT_BYTE_LENGTH,
  ) {
    super(
      `Round bundle row for "${lookupId}" is ${byteLength} bytes, exceeding the ${maxByteLength}-byte limit.`,
    );
    this.name = "RowTooLargeError";
    this.lookupId = lookupId;
    this.byteLength = byteLength;
    this.maxByteLength = maxByteLength;
  }
}

export type BundleFormatErrorCode =
  | "TRUNCATED_HEADER"
  | "INVALID_MAGIC"
  | "UNSUPPORTED_VERSION"
  | "INVALID_ROW_COUNT"
  | "INVALID_LENGTH"
  | "INVALID_ROUND_SEQ"
  | "INVALID_ROUND_ID"
  | "INVALID_KEY"
  | "DUPLICATE_ROW_ID"
  | "DECRYPTION_FAILED"
  | "INVALID_ROW_PAYLOAD";

export class BundleFormatError extends Error {
  readonly code: BundleFormatErrorCode;

  constructor(code: BundleFormatErrorCode, message: string) {
    super(message);
    this.name = "BundleFormatError";
    this.code = code;
  }
}

/**
 * Computes the 16-byte per-round lookup identifier for a participant:
 *   rowId = HMAC-SHA-256(lookupKey, UTF-8(roundId))[0..16]
 */
export async function computeRowId(
  lookupKey: Uint8Array,
  roundId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!(lookupKey instanceof Uint8Array) || lookupKey.byteLength !== 32) {
    throw new BundleFormatError("INVALID_KEY", "lookupKey must be 32 bytes.");
  }
  if (typeof roundId !== "string" || roundId.length === 0) {
    throw new BundleFormatError(
      "INVALID_ROUND_ID",
      "roundId must be a non-empty string.",
    );
  }
  const mac = await hmacSha256(lookupKey, utf8Encode(roundId));
  return mac.slice(0, ROW_ID_BYTE_LENGTH);
}

/**
 * Maps a 16-byte rowId to its bucket index (0..31) via the top 5 bits.
 */
export function bucketForRowId(rowId: Uint8Array): number {
  if (rowId.byteLength !== ROW_ID_BYTE_LENGTH) {
    throw new BundleFormatError(
      "INVALID_LENGTH",
      `rowId must be ${ROW_ID_BYTE_LENGTH} bytes.`,
    );
  }
  return rowId[0]! >> 3;
}

/**
 * Lexicographic unsigned byte comparison for sorting and binary-searching rowIds.
 */
export function compareRowIds(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < len; i++) {
    const diff = a[i]! - b[i]!;
    if (diff !== 0) return diff;
  }
  return a.byteLength - b.byteLength;
}

/**
 * Builds the 23-byte AES-256-GCM AAD binding each ciphertext to the bundle
 * magic, version, roundSeq, and its exact rowId.
 */
export function buildRowAad(
  roundSeq: number,
  rowId: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const prefix = new Uint8Array(new ArrayBuffer(7));
  prefix.set(BUNDLE_MAGIC, 0);
  prefix[4] = BUNDLE_VERSION;
  const view = new DataView(prefix.buffer);
  view.setUint16(5, roundSeq, true);
  return concatBytes(prefix, rowId);
}

/**
 * Serializes the 9-byte little-endian bucket header.
 */
export function encodeBucketHeader(
  roundSeq: number,
  rowCount: number,
): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(roundSeq) || roundSeq < 0 || roundSeq > MAX_U16) {
    throw new BundleFormatError(
      "INVALID_ROUND_SEQ",
      `roundSeq must be an integer in 0..${MAX_U16}.`,
    );
  }
  if (
    !Number.isInteger(rowCount) ||
    rowCount < 0 ||
    rowCount > MAX_U16 ||
    rowCount % BUNDLE_ROW_MULTIPLE !== 0
  ) {
    throw new BundleFormatError(
      "INVALID_ROW_COUNT",
      `rowCount must be a multiple of ${BUNDLE_ROW_MULTIPLE} in 0..${MAX_U16}.`,
    );
  }

  const header = new Uint8Array(new ArrayBuffer(BUNDLE_HEADER_BYTE_LENGTH));
  header.set(BUNDLE_MAGIC, 0);
  header[4] = BUNDLE_VERSION;
  const view = new DataView(header.buffer);
  view.setUint16(5, roundSeq, true);
  view.setUint16(7, rowCount, true);
  return header;
}

/**
 * Parses and strictly validates the header and total byte length of a bucket.
 */
export function parseBucketHeader(bytes: Uint8Array): BundleBucketHeader {
  if (bytes.byteLength < BUNDLE_HEADER_BYTE_LENGTH) {
    throw new BundleFormatError(
      "TRUNCATED_HEADER",
      `Bucket is ${bytes.byteLength} bytes, smaller than the ${BUNDLE_HEADER_BYTE_LENGTH}-byte header.`,
    );
  }

  for (let i = 0; i < BUNDLE_MAGIC.byteLength; i++) {
    if (bytes[i] !== BUNDLE_MAGIC[i]) {
      throw new BundleFormatError(
        "INVALID_MAGIC",
        "Bucket does not start with 'STRB' magic bytes.",
      );
    }
  }

  const version = bytes[4]!;
  if (version !== BUNDLE_VERSION) {
    throw new BundleFormatError(
      "UNSUPPORTED_VERSION",
      `Unsupported bundle version ${version} (expected ${BUNDLE_VERSION}).`,
    );
  }

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    BUNDLE_HEADER_BYTE_LENGTH,
  );
  const roundSeq = view.getUint16(5, true);
  const rowCount = view.getUint16(7, true);

  if (rowCount % BUNDLE_ROW_MULTIPLE !== 0) {
    throw new BundleFormatError(
      "INVALID_ROW_COUNT",
      `Bucket rowCount (${rowCount}) is not a multiple of ${BUNDLE_ROW_MULTIPLE}.`,
    );
  }

  const expectedLength =
    BUNDLE_HEADER_BYTE_LENGTH + rowCount * ROW_RECORD_BYTE_LENGTH;
  if (bytes.byteLength !== expectedLength) {
    throw new BundleFormatError(
      "INVALID_LENGTH",
      `Bucket byte length (${bytes.byteLength}) does not match expected length (${expectedLength}) for ${rowCount} rows.`,
    );
  }

  return { version, roundSeq, rowCount };
}
