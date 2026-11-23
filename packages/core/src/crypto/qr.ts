/**
 * Signed QR ballot encoding, fragmentation, reassembly, and verification
 * (design section 8, section 8.2, and Appendix E).
 *
 * Wire format:
 *   Single code:
 *     "ST1." + body + "." + base64url(HMAC-SHA-256(qrKey, UTF-8(body)))[0..22]
 *   where:
 *     body = base64url(deflateRaw(UTF-8(JCS({sid, slug, lid, rnd, type, payload}))))
 *
 *   Fragmented (when fullCode > 1,800 chars, up to 4 fragments):
 *     "ST1F." + sid + "." + index(1..n) + "." + n + "." + totalLength + "."
 *       + base64url(SHA-256(UTF-8(fullCode)))[0..22] + "." + fragmentData
 *
 * Security notes:
 * - Authenticity uses a 132-bit truncated HMAC-SHA-256 (22 base64url chars)
 *   verified in constant time BEFORE decompressing or trusting the payload.
 *   Checking the MAC before inflating prevents unauthenticated decompression
 *   bombs and parser bugs from reaching untrusted input.
 * - Decompression enforces a streaming 64 KB ceiling so even an authenticated
 *   malformed payload cannot exhaust memory.
 * - Fragment reassembly checks total length, a 132-bit SHA-256 integrity hash
 *   over the reassembled code, and that the fragment header `sid` matches the
 *   signed envelope `sid`.
 */

import { canonicalize } from "./canonical";
import {
  base64UrlDecode,
  base64UrlEncode,
  constantTimeEqualStrings,
  toBufferSource,
  utf8Decode,
  utf8Encode,
} from "./encoding";
import { DERIVED_KEY_BYTE_LENGTH, hmacSha256, sha256 } from "./keys";

export const QR_SINGLE_PREFIX = "ST1";
export const QR_FRAGMENT_PREFIX = "ST1F";
export const QR_MAX_CODE_LENGTH = 1_800;
export const QR_MAX_BODY_LENGTH = 6_000;
export const QR_MAX_FRAGMENTS = 4;
export const QR_MAX_DECOMPRESSED_BYTES = 65_536;
export const QR_TAG_LENGTH = 22;

export interface QrBallotEnvelope {
  sid: string;
  slug: string;
  lid: string;
  rnd: string;
  type: string;
  payload: unknown;
}

export type QrBallotErrorCode =
  | "INVALID_KEY"
  | "INVALID_ENVELOPE"
  | "BODY_TOO_LARGE"
  | "CODE_TOO_LARGE"
  | "EMPTY_CODES"
  | "INVALID_FORMAT"
  | "MIXED_FORMATS"
  | "MISMATCHED_FRAGMENTS"
  | "CONFLICTING_FRAGMENT"
  | "MISSING_FRAGMENTS"
  | "LENGTH_MISMATCH"
  | "HASH_MISMATCH"
  | "INVALID_MAC"
  | "DECOMPRESSED_TOO_LARGE"
  | "DECOMPRESSION_FAILED"
  | "INVALID_PAYLOAD"
  | "SID_MISMATCH";

export class QrBallotError extends Error {
  readonly code: QrBallotErrorCode;

  constructor(code: QrBallotErrorCode, message: string) {
    super(message);
    this.name = "QrBallotError";
    this.code = code;
  }
}

function concatChunks(
  chunks: readonly Uint8Array[],
  totalLength: number,
): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(new ArrayBuffer(totalLength));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function deflateRaw(input: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new CompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  const writePromise = writer
    .write(toBufferSource(input))
    .then(() => writer.close());
  writePromise.catch(() => {
    // Handled via reader/writePromise awaiting below.
  });

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    await writePromise;
  } finally {
    reader.releaseLock();
  }

  return concatChunks(chunks, total);
}

async function inflateRaw(
  input: Uint8Array,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  const writePromise = writer
    .write(toBufferSource(input))
    .then(() => writer.close());
  writePromise.catch(() => {
    // Prevent unhandled rejection if reader cancels early on size/format errors.
  });

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Decompressed size limit exceeded").catch(() => {});
        throw new QrBallotError(
          "DECOMPRESSED_TOO_LARGE",
          `Decompressed QR ballot exceeds ${maxBytes} bytes.`,
        );
      }
      chunks.push(value);
    }
    await writePromise;
  } catch (err) {
    if (err instanceof QrBallotError) throw err;
    throw new QrBallotError(
      "DECOMPRESSION_FAILED",
      "Failed to decompress QR ballot body.",
    );
  } finally {
    reader.releaseLock();
  }

  return concatChunks(chunks, total);
}

function validateQrKey(qrKey: Uint8Array): void {
  if (
    !(qrKey instanceof Uint8Array) ||
    qrKey.byteLength !== DERIVED_KEY_BYTE_LENGTH
  ) {
    throw new QrBallotError(
      "INVALID_KEY",
      `qrKey must be a ${DERIVED_KEY_BYTE_LENGTH}-byte Uint8Array.`,
    );
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateEnvelope(envelope: QrBallotEnvelope): QrBallotEnvelope {
  if (
    !envelope ||
    typeof envelope !== "object" ||
    !isNonEmptyString(envelope.sid) ||
    !isNonEmptyString(envelope.slug) ||
    !isNonEmptyString(envelope.lid) ||
    !isNonEmptyString(envelope.rnd) ||
    !isNonEmptyString(envelope.type) ||
    !("payload" in envelope) ||
    envelope.payload === undefined
  ) {
    throw new QrBallotError(
      "INVALID_ENVELOPE",
      "QR ballot envelope requires non-empty string fields sid, slug, lid, rnd, type and a defined payload.",
    );
  }
  if (envelope.sid.includes(".") || /\s/.test(envelope.sid)) {
    throw new QrBallotError(
      "INVALID_ENVELOPE",
      "QR ballot sid must not contain '.' or whitespace.",
    );
  }
  return {
    sid: envelope.sid,
    slug: envelope.slug,
    lid: envelope.lid,
    rnd: envelope.rnd,
    type: envelope.type,
    payload: envelope.payload,
  };
}

async function computeMacTag(
  qrKey: Uint8Array,
  body: string,
): Promise<string> {
  const mac = await hmacSha256(qrKey, utf8Encode(body));
  return base64UrlEncode(mac).slice(0, QR_TAG_LENGTH);
}

async function computeFullCodeHashTag(fullCode: string): Promise<string> {
  const digest = await sha256(utf8Encode(fullCode));
  return base64UrlEncode(digest).slice(0, QR_TAG_LENGTH);
}

/**
 * Encodes and signs a ballot submission for QR / text transfer.
 * Returns one `"ST1."` code when <= 1,800 chars, or 2–4 `"ST1F."` fragments.
 */
export async function encodeQrBallot(
  qrKey: Uint8Array,
  envelope: QrBallotEnvelope,
): Promise<string[]> {
  validateQrKey(qrKey);
  const normalized = validateEnvelope(envelope);

  const canonical = canonicalize(normalized);
  const uncompressed = utf8Encode(canonical);
  if (uncompressed.byteLength > QR_MAX_DECOMPRESSED_BYTES) {
    throw new QrBallotError(
      "DECOMPRESSED_TOO_LARGE",
      `Uncompressed QR ballot is ${uncompressed.byteLength} bytes (max ${QR_MAX_DECOMPRESSED_BYTES}).`,
    );
  }

  const compressed = await deflateRaw(uncompressed);
  const body = base64UrlEncode(compressed);
  if (body.length > QR_MAX_BODY_LENGTH) {
    throw new QrBallotError(
      "BODY_TOO_LARGE",
      `Compressed QR ballot body is ${body.length} chars (max ${QR_MAX_BODY_LENGTH}).`,
    );
  }

  const macTag = await computeMacTag(qrKey, body);
  const fullCode = `${QR_SINGLE_PREFIX}.${body}.${macTag}`;
  if (fullCode.length <= QR_MAX_CODE_LENGTH) {
    return [fullCode];
  }

  const hashTag = await computeFullCodeHashTag(fullCode);
  const totalLengthStr = String(fullCode.length);

  for (let n = 2; n <= QR_MAX_FRAGMENTS; n++) {
    // Fragment header: ST1F.<sid>.<index>.<n>.<totalLength>.<hashTag>.
    // Since n <= 4, index and n are single ASCII digits.
    const headerPrefixLen =
      QR_FRAGMENT_PREFIX.length +
      1 +
      normalized.sid.length +
      1 +
      1 +
      1 +
      1 +
      1 +
      totalLengthStr.length +
      1 +
      QR_TAG_LENGTH +
      1;
    const maxDataPerFragment = QR_MAX_CODE_LENGTH - headerPrefixLen;
    if (maxDataPerFragment <= 0) {
      throw new QrBallotError(
        "CODE_TOO_LARGE",
        "QR fragment header exceeds maximum QR code length.",
      );
    }

    const chunkSize = Math.ceil(fullCode.length / n);
    if (chunkSize <= maxDataPerFragment) {
      const fragments: string[] = [];
      for (let i = 0; i < n; i++) {
        const start = i * chunkSize;
        const data = fullCode.slice(start, start + chunkSize);
        fragments.push(
          `${QR_FRAGMENT_PREFIX}.${normalized.sid}.${i + 1}.${n}.${totalLengthStr}.${hashTag}.${data}`,
        );
      }
      return fragments;
    }
  }

  throw new QrBallotError(
    "CODE_TOO_LARGE",
    `QR ballot (${fullCode.length} chars) does not fit in ${QR_MAX_FRAGMENTS} fragments of ${QR_MAX_CODE_LENGTH} chars.`,
  );
}

interface ParsedFragment {
  sid: string;
  index: number;
  total: number;
  totalLength: number;
  hashTag: string;
  data: string;
}

const STRICT_POSITIVE_INT_REGEX = /^[1-9][0-9]*$/;
const BASE64URL_TAG_REGEX = /^[A-Za-z0-9_-]{22}$/;

function parseFragment(code: string): ParsedFragment {
  // Format: ST1F.<sid>.<index>.<n>.<totalLength>.<hashTag>.<fragmentData>
  // Note: fragmentData may contain '.' (from the ST1.<body>.<mac> string), so
  // we split only the first 6 '.' delimiters.
  const parts: string[] = [];
  let cursor = 0;
  for (let i = 0; i < 6; i++) {
    const dotIndex = code.indexOf(".", cursor);
    if (dotIndex < 0) {
      throw new QrBallotError(
        "INVALID_FORMAT",
        "Malformed ST1F QR fragment header.",
      );
    }
    parts.push(code.slice(cursor, dotIndex));
    cursor = dotIndex + 1;
  }
  const data = code.slice(cursor);

  const [prefix, sid, indexStr, totalStr, totalLengthStr, hashTag] = parts;
  if (
    prefix !== QR_FRAGMENT_PREFIX ||
    !sid ||
    !STRICT_POSITIVE_INT_REGEX.test(indexStr!) ||
    !STRICT_POSITIVE_INT_REGEX.test(totalStr!) ||
    !STRICT_POSITIVE_INT_REGEX.test(totalLengthStr!) ||
    !BASE64URL_TAG_REGEX.test(hashTag!) ||
    data.length === 0
  ) {
    throw new QrBallotError("INVALID_FORMAT", "Invalid ST1F QR fragment fields.");
  }

  const index = Number(indexStr);
  const total = Number(totalStr);
  const totalLength = Number(totalLengthStr);

  if (
    total < 2 ||
    total > QR_MAX_FRAGMENTS ||
    index < 1 ||
    index > total ||
    totalLength > QR_SINGLE_PREFIX.length + 1 + QR_MAX_BODY_LENGTH + 1 + QR_TAG_LENGTH
  ) {
    throw new QrBallotError(
      "INVALID_FORMAT",
      "ST1F fragment index, count, or total length is out of allowed bounds.",
    );
  }

  return { sid, index, total, totalLength, hashTag: hashTag!, data };
}

function parseEnvelopeObject(parsed: unknown): QrBallotEnvelope {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new QrBallotError(
      "INVALID_PAYLOAD",
      "Decoded QR ballot must be a JSON object.",
    );
  }

  const record = parsed as Record<string, unknown>;
  if (
    !isNonEmptyString(record.sid) ||
    !isNonEmptyString(record.slug) ||
    !isNonEmptyString(record.lid) ||
    !isNonEmptyString(record.rnd) ||
    !isNonEmptyString(record.type) ||
    !("payload" in record)
  ) {
    throw new QrBallotError(
      "INVALID_PAYLOAD",
      "Decoded QR ballot is missing required envelope fields.",
    );
  }

  return {
    sid: record.sid,
    slug: record.slug,
    lid: record.lid,
    rnd: record.rnd,
    type: record.type,
    payload: record.payload,
  };
}

/**
 * Reassembles (if fragmented), verifies the HMAC-SHA-256 signature in constant
 * time, decompresses (bounded to 64 KB), and parses a QR ballot.
 *
 * Exact duplicate fragments are ignored (idempotent scanning); conflicting
 * fragments for the same index or mismatched headers are rejected.
 */
export async function decodeQrBallot(
  codes: readonly string[],
  qrKey: Uint8Array,
): Promise<QrBallotEnvelope> {
  validateQrKey(qrKey);

  if (!Array.isArray(codes) || codes.length === 0) {
    throw new QrBallotError("EMPTY_CODES", "At least one QR code is required.");
  }

  for (const code of codes) {
    if (typeof code !== "string" || code.length === 0) {
      throw new QrBallotError("INVALID_FORMAT", "QR code entries must be non-empty strings.");
    }
    if (code.length > QR_MAX_CODE_LENGTH) {
      throw new QrBallotError(
        "CODE_TOO_LARGE",
        `QR code exceeds maximum length of ${QR_MAX_CODE_LENGTH} characters.`,
      );
    }
  }

  const first = codes[0]!;
  let fullCode: string;
  let expectedFragmentSid: string | null = null;

  if (first.startsWith(`${QR_SINGLE_PREFIX}.`)) {
    // Allow exact duplicates of the single code (e.g. accidental double scan),
    // but reject mixed formats or different codes.
    for (let i = 1; i < codes.length; i++) {
      if (codes[i] !== first) {
        if (codes[i]!.startsWith(`${QR_FRAGMENT_PREFIX}.`)) {
          throw new QrBallotError(
            "MIXED_FORMATS",
            "Cannot mix single ST1 and fragmented ST1F codes.",
          );
        }
        throw new QrBallotError(
          "MISMATCHED_FRAGMENTS",
          "Multiple distinct ST1 QR codes provided.",
        );
      }
    }
    fullCode = first;
  } else if (first.startsWith(`${QR_FRAGMENT_PREFIX}.`)) {
    const firstFrag = parseFragment(first);
    const byIndex = new Map<number, string>();
    byIndex.set(firstFrag.index, firstFrag.data);

    for (let i = 1; i < codes.length; i++) {
      const code = codes[i]!;
      if (code.startsWith(`${QR_SINGLE_PREFIX}.`)) {
        throw new QrBallotError(
          "MIXED_FORMATS",
          "Cannot mix fragmented ST1F and single ST1 codes.",
        );
      }
      const frag = parseFragment(code);
      if (
        frag.sid !== firstFrag.sid ||
        frag.total !== firstFrag.total ||
        frag.totalLength !== firstFrag.totalLength ||
        frag.hashTag !== firstFrag.hashTag
      ) {
        throw new QrBallotError(
          "MISMATCHED_FRAGMENTS",
          "QR fragments do not belong to the same ballot.",
        );
      }

      const existing = byIndex.get(frag.index);
      if (existing !== undefined) {
        if (existing !== frag.data) {
          throw new QrBallotError(
            "CONFLICTING_FRAGMENT",
            `Conflicting duplicate data for QR fragment ${frag.index}/${frag.total}.`,
          );
        }
        // Exact duplicate fragment: ignore.
        continue;
      }

      byIndex.set(frag.index, frag.data);
    }

    if (byIndex.size !== firstFrag.total) {
      throw new QrBallotError(
        "MISSING_FRAGMENTS",
        `Expected ${firstFrag.total} QR fragments, received ${byIndex.size}.`,
      );
    }

    let joined = "";
    for (let idx = 1; idx <= firstFrag.total; idx++) {
      const part = byIndex.get(idx);
      if (part === undefined) {
        throw new QrBallotError(
          "MISSING_FRAGMENTS",
          `Missing QR fragment ${idx}/${firstFrag.total}.`,
        );
      }
      joined += part;
    }

    if (joined.length !== firstFrag.totalLength) {
      throw new QrBallotError(
        "LENGTH_MISMATCH",
        `Reassembled QR code length (${joined.length}) does not match declared totalLength (${firstFrag.totalLength}).`,
      );
    }

    const computedHash = await computeFullCodeHashTag(joined);
    if (!constantTimeEqualStrings(computedHash, firstFrag.hashTag)) {
      throw new QrBallotError(
        "HASH_MISMATCH",
        "Reassembled QR code failed SHA-256 integrity check.",
      );
    }

    fullCode = joined;
    expectedFragmentSid = firstFrag.sid;
  } else {
    throw new QrBallotError(
      "INVALID_FORMAT",
      "QR code must start with 'ST1.' or 'ST1F.'.",
    );
  }

  // Parse ST1.<body>.<mac>
  const parts = fullCode.split(".");
  if (parts.length !== 3 || parts[0] !== QR_SINGLE_PREFIX) {
    throw new QrBallotError(
      "INVALID_FORMAT",
      "QR ballot must have format ST1.<body>.<mac>.",
    );
  }

  const body = parts[1]!;
  const providedMac = parts[2]!;
  if (
    body.length === 0 ||
    body.length > QR_MAX_BODY_LENGTH ||
    !BASE64URL_TAG_REGEX.test(providedMac)
  ) {
    throw new QrBallotError(
      "INVALID_FORMAT",
      "QR ballot body length or MAC tag format is invalid.",
    );
  }

  // Verify HMAC in constant time BEFORE decoding or decompressing.
  const expectedMac = await computeMacTag(qrKey, body);
  if (!constantTimeEqualStrings(expectedMac, providedMac)) {
    throw new QrBallotError("INVALID_MAC", "QR ballot MAC verification failed.");
  }

  const compressed = base64UrlDecode(body);
  if (!compressed || compressed.byteLength === 0) {
    throw new QrBallotError(
      "INVALID_FORMAT",
      "QR ballot body is not valid canonical base64url.",
    );
  }

  const decompressed = await inflateRaw(compressed, QR_MAX_DECOMPRESSED_BYTES);

  let jsonText: string;
  try {
    jsonText = utf8Decode(decompressed);
  } catch {
    throw new QrBallotError(
      "INVALID_PAYLOAD",
      "Decompressed QR ballot is not valid UTF-8.",
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonText);
  } catch {
    throw new QrBallotError(
      "INVALID_PAYLOAD",
      "Decompressed QR ballot is not valid JSON.",
    );
  }

  const envelope = parseEnvelopeObject(parsedJson);
  if (expectedFragmentSid !== null && envelope.sid !== expectedFragmentSid) {
    throw new QrBallotError(
      "SID_MISMATCH",
      "Fragment header sid does not match signed ballot sid.",
    );
  }

  return envelope;
}
