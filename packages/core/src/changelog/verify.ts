import {
  GENESIS_HASH,
  computeEntryHash,
  computePayloadCommit,
  fromBase64Url,
  type ChangelogEntry,
} from "./v2";

export type PublicChainItem = {
  entry: ChangelogEntry;
  entryHash: string;
  payload?: unknown;
  salt?: string;
};

export type VerifyChainResult =
  | { ok: true; head: string }
  | { ok: false; seq: number; reason: string };

export type EarlierHead = {
  seq: number;
  headHash: string;
};

/**
 * Verifies that a revealed payload and base64url salt match an entry's payloadCommit.
 */
export async function provePrivate(
  entry: ChangelogEntry,
  payload: unknown,
  salt: string,
): Promise<boolean> {
  const saltBytes = fromBase64Url(salt);
  if (saltBytes === null) {
    return false;
  }
  try {
    const commit = await computePayloadCommit(saltBytes, payload);
    return commit === entry.payloadCommit;
  } catch {
    return false;
  }
}

/**
 * Verifies a sequential Changelog v2 chain from genesis, checking hashes and revealed payloads.
 */
export async function verifyChain(
  items: PublicChainItem[],
  opts?: { expectedHead?: string },
): Promise<VerifyChainResult> {
  let prevHash = GENESIS_HASH;

  for (let i = 0; i < items.length; i++) {
    const expectedSeq = i + 1;
    const item = items[i]!;
    const { entry } = item;

    if (entry.v !== 2) {
      return { ok: false, seq: expectedSeq, reason: `Unsupported entry version: ${String(entry.v)}` };
    }
    if (entry.seq !== expectedSeq) {
      return { ok: false, seq: expectedSeq, reason: `Expected seq ${expectedSeq}, got ${entry.seq}` };
    }

    const hasPayload = item.payload !== undefined;
    const hasSalt = item.salt !== undefined;
    if (hasPayload !== hasSalt) {
      return {
        ok: false,
        seq: expectedSeq,
        reason: hasPayload ? "Revealed payload is missing salt" : "Salt provided without payload",
      };
    }
    if (hasPayload && hasSalt) {
      const validPayload = await provePrivate(entry, item.payload, item.salt!);
      if (!validPayload) {
        return { ok: false, seq: expectedSeq, reason: "Revealed payload does not match payloadCommit" };
      }
    }

    const expectedEntryHash = await computeEntryHash(prevHash, entry);
    if (item.entryHash !== expectedEntryHash) {
      return { ok: false, seq: expectedSeq, reason: "entryHash mismatch" };
    }

    prevHash = item.entryHash;
  }

  if (opts?.expectedHead !== undefined && prevHash !== opts.expectedHead) {
    return { ok: false, seq: items.length, reason: "Head hash does not match expectedHead" };
  }

  return { ok: true, head: prevHash };
}

/**
 * Returns true when the given chain contains an entry matching the earlier anchored seq and hash.
 */
export function isPrefixOf(earlierHead: EarlierHead, items: PublicChainItem[]): boolean {
  return items.some(
    (item) => item.entry.seq === earlierHead.seq && item.entryHash === earlierHead.headHash,
  );
}
