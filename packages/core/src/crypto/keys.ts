/**
 * HKDF-SHA-256 subkey derivation, permit verifier, and submission proof
 * (design section 8).
 *
 * Security notes:
 * - Domain-separated subkeys (`auth`, `file`, `lookup`, `qr`) ensure that
 *   sending `authKey` to the ballots server never reveals `fileKey`,
 *   `lookupKey`, or `qrKey`.
 * - The HKDF salt binds every derived key to the tournament slug and protocol
 *   version (`simpletab/v1/<slug>`).
 * - Optional passcodes are concatenated directly into the IKM so a wrong
 *   passcode derives completely independent keys without needing an online
 *   passcode oracle.
 * - Proof generation hashes canonical JSON first and separates `submissionId`
 *   from the digest with `.` (rejecting `.` inside `submissionId`) to prevent
 *   concatenation ambiguity.
 */

import { canonicalize } from "./canonical";
import {
  base64UrlEncode,
  bytesToHex,
  concatBytes,
  constantTimeEqualStrings,
  toBufferSource,
  utf8Encode,
} from "./encoding";
import { LINK_SECRET_BYTE_LENGTH } from "./links";

export const DERIVED_KEY_BYTE_LENGTH = 32;
const HKDF_SALT_PREFIX = "simpletab/v1/";

const KEY_INFO_AUTH = utf8Encode("auth");
const KEY_INFO_FILE = utf8Encode("file");
const KEY_INFO_LOOKUP = utf8Encode("lookup");
const KEY_INFO_QR = utf8Encode("qr");

export interface DerivedKeys {
  authKey: Uint8Array;
  fileKey: Uint8Array;
  lookupKey: Uint8Array;
  qrKey: Uint8Array;
}

/**
 * Computes SHA-256 over arbitrary bytes using WebCrypto.
 */
export async function sha256(
  data: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    toBufferSource(data),
  );
  return new Uint8Array(digest);
}

/**
 * Computes HMAC-SHA-256 over arbitrary bytes using WebCrypto.
 */
export async function hmacSha256(
  keyBytes: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    toBufferSource(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    toBufferSource(data),
  );
  return new Uint8Array(signature);
}

async function deriveSubkey(
  baseKey: CryptoKey,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info,
    },
    baseKey,
    DERIVED_KEY_BYTE_LENGTH * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Derives the four 32-byte participant subkeys from a 16-byte link secret,
 * tournament slug, and optional passcode via HKDF-SHA-256.
 */
export async function deriveKeys(
  secret: Uint8Array,
  slug: string,
  passcode?: string,
): Promise<DerivedKeys> {
  if (
    !(secret instanceof Uint8Array) ||
    secret.byteLength !== LINK_SECRET_BYTE_LENGTH
  ) {
    throw new RangeError(
      `Link secret must be ${LINK_SECRET_BYTE_LENGTH} bytes.`,
    );
  }
  if (typeof slug !== "string" || slug.length === 0) {
    throw new RangeError("Tournament slug must be a non-empty string.");
  }

  const passcodeBytes = utf8Encode(passcode ?? "");
  const ikm = concatBytes(secret, passcodeBytes);
  const salt = utf8Encode(`${HKDF_SALT_PREFIX}${slug}`);

  const baseKey = await globalThis.crypto.subtle.importKey(
    "raw",
    ikm,
    "HKDF",
    false,
    ["deriveBits"],
  );

  const [authKey, fileKey, lookupKey, qrKey] = await Promise.all([
    deriveSubkey(baseKey, salt, KEY_INFO_AUTH),
    deriveSubkey(baseKey, salt, KEY_INFO_FILE),
    deriveSubkey(baseKey, salt, KEY_INFO_LOOKUP),
    deriveSubkey(baseKey, salt, KEY_INFO_QR),
  ]);

  return { authKey, fileKey, lookupKey, qrKey };
}

/**
 * Computes the permit verifier stored on the ballots service: lowercase hex
 * SHA-256 of `authKey`. Storing only the hash means a read-only database leak
 * does not expose `authKey`.
 */
export async function verifier(authKey: Uint8Array): Promise<string> {
  if (
    !(authKey instanceof Uint8Array) ||
    authKey.byteLength !== DERIVED_KEY_BYTE_LENGTH
  ) {
    throw new RangeError(`authKey must be ${DERIVED_KEY_BYTE_LENGTH} bytes.`);
  }
  const digest = await sha256(authKey);
  return bytesToHex(digest);
}

/**
 * Computes the submission proof sent with `POST /v1/submit`:
 *   base64url(HMAC-SHA-256(authKey, UTF-8(submissionId + "." + base64url(SHA-256(UTF-8(JCS(payload)))))))
 */
export async function proof(
  authKey: Uint8Array,
  submissionId: string,
  payload: unknown,
): Promise<string> {
  if (
    !(authKey instanceof Uint8Array) ||
    authKey.byteLength !== DERIVED_KEY_BYTE_LENGTH
  ) {
    throw new RangeError(`authKey must be ${DERIVED_KEY_BYTE_LENGTH} bytes.`);
  }
  if (
    typeof submissionId !== "string" ||
    submissionId.length === 0 ||
    submissionId.includes(".")
  ) {
    throw new RangeError(
      "submissionId must be a non-empty string without '.' characters.",
    );
  }

  const canonicalPayload = canonicalize(payload);
  const payloadDigest = await sha256(utf8Encode(canonicalPayload));
  const message = utf8Encode(
    `${submissionId}.${base64UrlEncode(payloadDigest)}`,
  );
  const mac = await hmacSha256(authKey, message);
  return base64UrlEncode(mac);
}

/**
 * Verifies a submission proof using constant-time string comparison.
 */
export async function verifyProof(
  authKey: Uint8Array,
  submissionId: string,
  payload: unknown,
  candidateProof: string,
): Promise<boolean> {
  if (typeof candidateProof !== "string" || candidateProof.length === 0) {
    return false;
  }
  const expected = await proof(authKey, submissionId, payload);
  return constantTimeEqualStrings(expected, candidateProof);
}
