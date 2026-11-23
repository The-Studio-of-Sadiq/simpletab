/**
 * Round bundle sealing: encrypts participant assignment rows into 32
 * fixed-row-size, dummy-padded buckets (design section 8 and Appendix E).
 *
 * Security notes:
 * - Each row uses a fresh 96-bit CSPRNG nonce under the participant's 256-bit
 *   AES-GCM `fileKey`.
 * - Dummy rows share the target bucket's top 5 bits in `rowId[0]` and contain
 *   random 12-byte nonces and 528 random bytes so they are indistinguishable
 *   from real AES-256-GCM records.
 * - Every bucket (0..31) is emitted with a row count that is a non-zero
 *   multiple of 8, hiding both exact counts and which buckets have zero real
 *   participants.
 */

import { canonicalize } from "@/crypto/canonical";
import { bytesToHex, toBufferSource, utf8Encode } from "@/crypto/encoding";
import type { DerivedKeys } from "@/crypto/keys";
import {
  BUNDLE_BUCKET_COUNT,
  BUNDLE_HEADER_BYTE_LENGTH,
  BUNDLE_ROW_MULTIPLE,
  BundleFormatError,
  MAX_U16,
  ROW_CIPHERTEXT_BYTE_LENGTH,
  ROW_ID_BYTE_LENGTH,
  ROW_NONCE_BYTE_LENGTH,
  ROW_PLAINTEXT_BYTE_LENGTH,
  ROW_RECORD_BYTE_LENGTH,
  RowTooLargeError,
  bucketForRowId,
  buildRowAad,
  compareRowIds,
  computeRowId,
  encodeBucketHeader,
  type RoundBundleRow,
} from "./format";

export type RowKeyMaterial = Pick<DerivedKeys, "fileKey" | "lookupKey">;

export interface SealRowInput<T extends object = RoundBundleRow> {
  /** Optional participant lookup ID used to name the offending row in `RowTooLargeError`. */
  lookupId?: string;
  keys: RowKeyMaterial;
  row: T;
}

export interface SealRoundInput<T extends object = RoundBundleRow> {
  roundSeq: number;
  roundId: string;
  rows: readonly SealRowInput<T>[];
}

interface SealedRecord {
  rowId: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>;
}

async function sealSingleRow<T extends object>(
  roundSeq: number,
  roundId: string,
  entry: SealRowInput<T>,
): Promise<{ bucket: number; record: SealedRecord }> {
  const { keys, row } = entry;
  if (!(keys.fileKey instanceof Uint8Array) || keys.fileKey.byteLength !== 32) {
    throw new BundleFormatError("INVALID_KEY", "fileKey must be 32 bytes.");
  }

  const canonical = canonicalize(row);
  const encoded = utf8Encode(canonical);
  if (encoded.byteLength > ROW_PLAINTEXT_BYTE_LENGTH) {
    throw new RowTooLargeError(
      entry.lookupId ?? "unknown",
      encoded.byteLength,
      ROW_PLAINTEXT_BYTE_LENGTH,
    );
  }

  const plaintext = new Uint8Array(new ArrayBuffer(ROW_PLAINTEXT_BYTE_LENGTH));
  plaintext.set(encoded, 0);
  // Remaining bytes are zero-initialized (0x00 padding).

  const rowId = await computeRowId(keys.lookupKey, roundId);
  const bucket = bucketForRowId(rowId);

  const nonce = new Uint8Array(new ArrayBuffer(ROW_NONCE_BYTE_LENGTH));
  globalThis.crypto.getRandomValues(nonce);

  const aesKey = await globalThis.crypto.subtle.importKey(
    "raw",
    toBufferSource(keys.fileKey),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );

  const aad = buildRowAad(roundSeq, rowId);
  const encrypted = await globalThis.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: aad,
      tagLength: 128,
    },
    aesKey,
    plaintext,
  );

  return {
    bucket,
    record: {
      rowId,
      nonce,
      ciphertext: new Uint8Array(encrypted),
    },
  };
}

function createDummyRecord(
  bucket: number,
  existingIds: Set<string>,
): SealedRecord {
  const rowId = new Uint8Array(new ArrayBuffer(ROW_ID_BYTE_LENGTH));
  do {
    globalThis.crypto.getRandomValues(rowId);
    // Keep the top 5 bits consistent with the target bucket so dummy rows are
    // indistinguishable from real rows assigned to this bucket.
    rowId[0] = (bucket << 3) | (rowId[0]! & 0x07);
  } while (existingIds.has(bytesToHex(rowId)));

  existingIds.add(bytesToHex(rowId));

  const nonce = new Uint8Array(new ArrayBuffer(ROW_NONCE_BYTE_LENGTH));
  globalThis.crypto.getRandomValues(nonce);

  const ciphertext = new Uint8Array(new ArrayBuffer(ROW_CIPHERTEXT_BYTE_LENGTH));
  globalThis.crypto.getRandomValues(ciphertext);

  return { rowId, nonce, ciphertext };
}

function serializeBucket(
  roundSeq: number,
  records: SealedRecord[],
): Uint8Array<ArrayBuffer> {
  records.sort((a, b) => compareRowIds(a.rowId, b.rowId));

  const header = encodeBucketHeader(roundSeq, records.length);
  const totalBytes =
    BUNDLE_HEADER_BYTE_LENGTH + records.length * ROW_RECORD_BYTE_LENGTH;
  const out = new Uint8Array(new ArrayBuffer(totalBytes));
  out.set(header, 0);

  let offset = BUNDLE_HEADER_BYTE_LENGTH;
  for (const record of records) {
    out.set(record.rowId, offset);
    offset += ROW_ID_BYTE_LENGTH;
    out.set(record.nonce, offset);
    offset += ROW_NONCE_BYTE_LENGTH;
    out.set(record.ciphertext, offset);
    offset += ROW_CIPHERTEXT_BYTE_LENGTH;
  }

  return out;
}

/**
 * Seals all participant rows for a round into 32 encrypted, dummy-padded
 * buckets keyed by bucket number (`0..31`).
 */
export async function sealRound<T extends object = RoundBundleRow>(
  input: SealRoundInput<T>,
): Promise<Map<number, Uint8Array>> {
  const { roundSeq, roundId, rows } = input;

  if (!Number.isInteger(roundSeq) || roundSeq < 0 || roundSeq > MAX_U16) {
    throw new BundleFormatError(
      "INVALID_ROUND_SEQ",
      `roundSeq must be an integer in 0..${MAX_U16}.`,
    );
  }
  if (typeof roundId !== "string" || roundId.length === 0) {
    throw new BundleFormatError(
      "INVALID_ROUND_ID",
      "roundId must be a non-empty string.",
    );
  }

  const buckets: SealedRecord[][] = Array.from(
    { length: BUNDLE_BUCKET_COUNT },
    () => [],
  );
  const seenIdsPerBucket: Set<string>[] = Array.from(
    { length: BUNDLE_BUCKET_COUNT },
    () => new Set<string>(),
  );

  const sealed = await Promise.all(
    rows.map((entry) => sealSingleRow(roundSeq, roundId, entry)),
  );

  for (const { bucket, record } of sealed) {
    const idHex = bytesToHex(record.rowId);
    if (seenIdsPerBucket[bucket]!.has(idHex)) {
      throw new BundleFormatError(
        "DUPLICATE_ROW_ID",
        `Duplicate rowId encountered in bucket ${bucket}.`,
      );
    }
    seenIdsPerBucket[bucket]!.add(idHex);
    buckets[bucket]!.push(record);
  }

  const result = new Map<number, Uint8Array>();

  for (let bucket = 0; bucket < BUNDLE_BUCKET_COUNT; bucket++) {
    const records = buckets[bucket]!;
    const targetCount =
      records.length === 0
        ? BUNDLE_ROW_MULTIPLE
        : Math.ceil(records.length / BUNDLE_ROW_MULTIPLE) * BUNDLE_ROW_MULTIPLE;

    if (targetCount > MAX_U16) {
      throw new BundleFormatError(
        "INVALID_ROW_COUNT",
        `Bucket ${bucket} row count (${targetCount}) exceeds uint16 maximum.`,
      );
    }

    const dummyCount = targetCount - records.length;
    for (let i = 0; i < dummyCount; i++) {
      records.push(createDummyRecord(bucket, seenIdsPerBucket[bucket]!));
    }

    result.set(bucket, serializeBucket(roundSeq, records));
  }

  return result;
}
