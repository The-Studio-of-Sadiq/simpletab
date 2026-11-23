import { canonicalize } from "./jcs";

export type ActorType = "human" | "ai" | "system" | "service";

export type Visibility = "public" | "private";

export type ChangelogEntry = {
  v: 2;
  seq: number;
  ts: string;
  actorType: ActorType;
  actorRef: string;
  opType: string;
  category: string;
  summary: string;
  visibility: Visibility;
  payloadCommit: string;
  stateHash?: string;
};

export type StoredEntry = {
  entry: ChangelogEntry;
  salt: string;
  entryHash: string;
};

export type MakeEntryInput = Omit<ChangelogEntry, "v" | "payloadCommit"> & {
  payload: unknown;
};

export const GENESIS_HASH: string = "0".repeat(64);

const ENTRY_DOMAIN_PREFIX = "simpletab-changelog-v2\n";
const ISO_UTC_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_DECODE_MAP = new Map<string, number>(
  Array.from(B64URL_ALPHABET, (char, index) => [char, index]),
);
const UTF8_ENCODER = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const chunk = (b0 << 16) | (b1 << 8) | b2;
    out += B64URL_ALPHABET[(chunk >>> 18) & 63];
    out += B64URL_ALPHABET[(chunk >>> 12) & 63];
    if (i + 1 < bytes.length) {
      out += B64URL_ALPHABET[(chunk >>> 6) & 63];
    }
    if (i + 2 < bytes.length) {
      out += B64URL_ALPHABET[chunk & 63];
    }
  }
  return out;
}

export function fromBase64Url(encoded: string): Uint8Array | null {
  if (encoded.length % 4 === 1) {
    return null;
  }
  const byteLength = Math.floor((encoded.length * 3) / 4);
  const out = new Uint8Array(byteLength);
  let outIdx = 0;

  for (let i = 0; i < encoded.length; i += 4) {
    const c0 = B64URL_DECODE_MAP.get(encoded[i]!);
    const c1 = B64URL_DECODE_MAP.get(encoded[i + 1]!);
    if (c0 === undefined || c1 === undefined) {
      return null;
    }

    const has2 = i + 2 < encoded.length;
    const has3 = i + 3 < encoded.length;
    const c2 = has2 ? B64URL_DECODE_MAP.get(encoded[i + 2]!) : 0;
    const c3 = has3 ? B64URL_DECODE_MAP.get(encoded[i + 3]!) : 0;
    if (c2 === undefined || c3 === undefined) {
      return null;
    }

    if (!has2 && (c1 & 0x0f) !== 0) {
      return null;
    }
    if (has2 && !has3 && (c2 & 0x03) !== 0) {
      return null;
    }

    const chunk = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out[outIdx++] = (chunk >>> 16) & 0xff;
    if (has2) {
      out[outIdx++] = (chunk >>> 8) & 0xff;
    }
    if (has3) {
      out[outIdx++] = chunk & 0xff;
    }
  }

  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

function isValidIsoUtcMs(ts: string): boolean {
  if (!ISO_UTC_MS_RE.test(ts)) {
    return false;
  }
  const parsed = Date.parse(ts);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === ts;
}

export async function computePayloadCommit(salt: Uint8Array, payload: unknown): Promise<string> {
  const payloadBytes = UTF8_ENCODER.encode(canonicalize(payload));
  const preimage = new Uint8Array(salt.length + payloadBytes.length);
  preimage.set(salt, 0);
  preimage.set(payloadBytes, salt.length);
  return toBase64Url(await sha256(preimage));
}

export async function computeEntryHash(prevHash: string, entry: ChangelogEntry): Promise<string> {
  const preimage = `${ENTRY_DOMAIN_PREFIX}${prevHash}\n${canonicalize(entry)}`;
  return toHex(await sha256(UTF8_ENCODER.encode(preimage)));
}

/**
 * Builds and hashes a Changelog v2 entry, computing its salted payload commitment and chain hash.
 */
export async function makeEntry(
  input: MakeEntryInput,
  prevHash: string,
  salt?: Uint8Array,
): Promise<StoredEntry> {
  if (!Number.isSafeInteger(input.seq) || input.seq < 1) {
    throw new RangeError(`Invalid changelog seq: ${String(input.seq)}`);
  }
  if (!isValidIsoUtcMs(input.ts)) {
    throw new RangeError(`Invalid changelog timestamp (expected ISO 8601 UTC with milliseconds): ${input.ts}`);
  }

  const resolvedSalt = salt ?? globalThis.crypto.getRandomValues(new Uint8Array(16));
  const payloadCommit = await computePayloadCommit(resolvedSalt, input.payload);

  const entry: ChangelogEntry = {
    v: 2,
    seq: input.seq,
    ts: input.ts,
    actorType: input.actorType,
    actorRef: input.actorRef,
    opType: input.opType,
    category: input.category,
    summary: input.summary,
    visibility: input.visibility,
    payloadCommit,
    ...(input.stateHash !== undefined ? { stateHash: input.stateHash } : {}),
  };

  const entryHash = await computeEntryHash(prevHash, entry);
  return {
    entry,
    salt: toBase64Url(resolvedSalt),
    entryHash,
  };
}
