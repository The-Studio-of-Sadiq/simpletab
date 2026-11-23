/**
 * Round bundle opening: binary-searches a bucket by `rowId`, decrypts and
 * authenticates the matching row with AES-256-GCM, and strips zero padding
 * (design section 8 and Appendix E).
 *
 * Security notes:
 * - Header magic, version, rowCount multiple-of-8 invariant, and exact file
 *   length are strictly validated before accessing any row bytes.
 * - AES-256-GCM verifies both ciphertext integrity and the header+rowId AAD;
 *   any modification to ciphertext, tag, nonce, or roundSeq fails decryption
 *   with a typed `BundleFormatError`.
 * - Canonical JSON encodes U+0000 as `\u0000`, so raw `0x00` bytes appear
 *   only in trailing padding; interior NUL bytes or malformed UTF-8/JSON are
 *   rejected.
 */

import { toBufferSource, utf8Decode } from "@/crypto/encoding";
import {
  BUNDLE_HEADER_BYTE_LENGTH,
  BundleFormatError,
  ROW_CIPHERTEXT_BYTE_LENGTH,
  ROW_ID_BYTE_LENGTH,
  ROW_NONCE_BYTE_LENGTH,
  ROW_PLAINTEXT_BYTE_LENGTH,
  ROW_RECORD_BYTE_LENGTH,
  buildRowAad,
  compareRowIds,
  computeRowId,
  parseBucketHeader,
  type RoundBundleRow,
} from "./format";
import type { RowKeyMaterial } from "./seal";

function findRowRecordOffset(
  bucketBytes: Uint8Array,
  rowCount: number,
  targetRowId: Uint8Array,
): number {
  let low = 0;
  let high = rowCount - 1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const recordOffset = BUNDLE_HEADER_BYTE_LENGTH + mid * ROW_RECORD_BYTE_LENGTH;
    const candidateId = bucketBytes.subarray(
      recordOffset,
      recordOffset + ROW_ID_BYTE_LENGTH,
    );
    const cmp = compareRowIds(candidateId, targetRowId);
    if (cmp === 0) {
      return recordOffset;
    }
    if (cmp < 0) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return -1;
}

/**
 * Opens the participant's row in a round bundle bucket.
 *
 * Returns:
 * - the decrypted row object if `rowId` is present and authenticates;
 * - `null` if `rowId` is not present in this bucket;
 * - throws `BundleFormatError` on invalid header/magic/version/length,
 *   tampered/undecryptable ciphertext for a matching `rowId`, or invalid JSON.
 */
export async function openRow<T extends object = RoundBundleRow>(
  bucketBytes: Uint8Array,
  keys: RowKeyMaterial,
  roundId: string,
): Promise<T | null> {
  if (!(bucketBytes instanceof Uint8Array)) {
    throw new BundleFormatError(
      "INVALID_LENGTH",
      "bucketBytes must be a Uint8Array.",
    );
  }
  if (!(keys.fileKey instanceof Uint8Array) || keys.fileKey.byteLength !== 32) {
    throw new BundleFormatError("INVALID_KEY", "fileKey must be 32 bytes.");
  }

  const header = parseBucketHeader(bucketBytes);
  const rowId = await computeRowId(keys.lookupKey, roundId);

  const recordOffset = findRowRecordOffset(bucketBytes, header.rowCount, rowId);
  if (recordOffset < 0) {
    return null;
  }

  const nonceOffset = recordOffset + ROW_ID_BYTE_LENGTH;
  const ciphertextOffset = nonceOffset + ROW_NONCE_BYTE_LENGTH;

  const nonce = toBufferSource(
    bucketBytes.subarray(nonceOffset, ciphertextOffset),
  );
  const ciphertext = toBufferSource(
    bucketBytes.subarray(
      ciphertextOffset,
      ciphertextOffset + ROW_CIPHERTEXT_BYTE_LENGTH,
    ),
  );

  const aesKey = await globalThis.crypto.subtle.importKey(
    "raw",
    toBufferSource(keys.fileKey),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );

  const aad = buildRowAad(header.roundSeq, rowId);
  let decryptedBuffer: ArrayBuffer;
  try {
    decryptedBuffer = await globalThis.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: aad,
        tagLength: 128,
      },
      aesKey,
      ciphertext,
    );
  } catch {
    throw new BundleFormatError(
      "DECRYPTION_FAILED",
      "Row failed AES-256-GCM authentication.",
    );
  }

  const plaintext = new Uint8Array(decryptedBuffer);
  if (plaintext.byteLength !== ROW_PLAINTEXT_BYTE_LENGTH) {
    throw new BundleFormatError(
      "INVALID_ROW_PAYLOAD",
      `Decrypted row plaintext was ${plaintext.byteLength} bytes (expected ${ROW_PLAINTEXT_BYTE_LENGTH}).`,
    );
  }

  // Strip trailing 0x00 padding bytes.
  let end = plaintext.byteLength;
  while (end > 0 && plaintext[end - 1] === 0) {
    end--;
  }

  if (end === 0) {
    throw new BundleFormatError(
      "INVALID_ROW_PAYLOAD",
      "Decrypted row payload is empty.",
    );
  }

  // Reject any interior NUL byte (canonical JSON never emits raw 0x00).
  for (let i = 0; i < end; i++) {
    if (plaintext[i] === 0) {
      throw new BundleFormatError(
        "INVALID_ROW_PAYLOAD",
        "Decrypted row payload contains an unexpected interior NUL byte.",
      );
    }
  }

  let text: string;
  try {
    text = utf8Decode(plaintext.subarray(0, end));
  } catch {
    throw new BundleFormatError(
      "INVALID_ROW_PAYLOAD",
      "Decrypted row payload is not valid UTF-8.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BundleFormatError(
      "INVALID_ROW_PAYLOAD",
      "Decrypted row payload is not valid JSON.",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BundleFormatError(
      "INVALID_ROW_PAYLOAD",
      "Decrypted row payload must be a JSON object.",
    );
  }

  return parsed as T;
}
