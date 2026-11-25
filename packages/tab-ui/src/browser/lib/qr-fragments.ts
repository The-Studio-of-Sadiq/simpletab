import {
  QR_FRAGMENT_PREFIX,
  QR_MAX_FRAGMENTS,
  QR_SINGLE_PREFIX,
} from "@simpletab/core/crypto";

export type QrCollectResult =
  | { kind: "complete"; codes: string[] }
  | { kind: "partial"; sid: string; have: number; of: number }
  | { kind: "ignored"; reason: "not_simpletab" | "duplicate" | "malformed" };

export interface QrFragmentCollectorOptions {
  now?: () => number;
  staleMs?: number;
}

interface PartialGroup {
  total: number;
  totalLength: number;
  hashTag: string;
  fragments: Map<number, string>;
  updatedAt: number;
}

const DEFAULT_STALE_MS = 120_000;
const STRICT_POSITIVE_INT_REGEX = /^[1-9][0-9]*$/;
const WHITESPACE_REGEX = /\s/;

/**
 * Collects scanned SimpleTab QR payloads (`ST1.` single codes and `ST1F.`
 * multi-part fragments), deduplicating repeated webcam frames and dropping
 * stale partial/completed state after `staleMs`.
 */
export class QrFragmentCollector {
  private readonly now: () => number;
  private readonly staleMs: number;
  private readonly partials = new Map<string, PartialGroup>();
  private readonly recentSingles = new Map<string, number>();
  private readonly recentCompletedSids = new Map<string, number>();

  constructor(options?: QrFragmentCollectorOptions) {
    this.now = options?.now ?? (() => Date.now());
    this.staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  }

  add(text: string): QrCollectResult {
    const now = this.now();
    this.pruneStale(now);

    const trimmed = text.trim();
    if (trimmed.startsWith(`${QR_SINGLE_PREFIX}.`)) {
      return this.handleSingle(trimmed, now);
    }
    if (trimmed.startsWith(`${QR_FRAGMENT_PREFIX}.`)) {
      return this.handleFragment(trimmed, now);
    }
    return { kind: "ignored", reason: "not_simpletab" };
  }

  reset(): void {
    this.partials.clear();
    this.recentSingles.clear();
    this.recentCompletedSids.clear();
  }

  private pruneStale(now: number): void {
    for (const [sid, group] of this.partials) {
      if (now - group.updatedAt > this.staleMs) {
        this.partials.delete(sid);
      }
    }
    for (const [code, ts] of this.recentSingles) {
      if (now - ts > this.staleMs) {
        this.recentSingles.delete(code);
      }
    }
    for (const [sid, ts] of this.recentCompletedSids) {
      if (now - ts > this.staleMs) {
        this.recentCompletedSids.delete(sid);
      }
    }
  }

  private handleSingle(trimmed: string, now: number): QrCollectResult {
    if (WHITESPACE_REGEX.test(trimmed)) {
      return { kind: "ignored", reason: "malformed" };
    }
    const parts = trimmed.split(".");
    if (
      parts.length !== 3 ||
      parts[0] !== QR_SINGLE_PREFIX ||
      parts[1]!.length === 0 ||
      parts[2]!.length === 0
    ) {
      return { kind: "ignored", reason: "malformed" };
    }
    if (this.recentSingles.has(trimmed)) {
      return { kind: "ignored", reason: "duplicate" };
    }
    this.recentSingles.set(trimmed, now);
    return { kind: "complete", codes: [trimmed] };
  }

  private handleFragment(trimmed: string, now: number): QrCollectResult {
    // Fragment format: ST1F.<sid>.<index>.<n>.<totalLength>.<hashTag>.<fragmentData>
    // fragmentData may contain "." from ST1.<body>.<mac>, so split only the first 6 dots.
    const parts: string[] = [];
    let cursor = 0;
    for (let i = 0; i < 6; i++) {
      const dotIndex = trimmed.indexOf(".", cursor);
      if (dotIndex < 0) {
        return { kind: "ignored", reason: "malformed" };
      }
      parts.push(trimmed.slice(cursor, dotIndex));
      cursor = dotIndex + 1;
    }
    const fragmentData = trimmed.slice(cursor);

    const [prefix, sid, indexStr, totalStr, totalLengthStr, hashTag] = parts;
    if (
      prefix !== QR_FRAGMENT_PREFIX ||
      !sid ||
      WHITESPACE_REGEX.test(sid) ||
      !STRICT_POSITIVE_INT_REGEX.test(indexStr!) ||
      !STRICT_POSITIVE_INT_REGEX.test(totalStr!) ||
      !STRICT_POSITIVE_INT_REGEX.test(totalLengthStr!) ||
      !hashTag ||
      WHITESPACE_REGEX.test(hashTag) ||
      fragmentData.length === 0 ||
      WHITESPACE_REGEX.test(fragmentData)
    ) {
      return { kind: "ignored", reason: "malformed" };
    }

    const index = Number(indexStr);
    const total = Number(totalStr);
    const totalLength = Number(totalLengthStr);
    if (
      total < 2 ||
      total > QR_MAX_FRAGMENTS ||
      index < 1 ||
      index > total ||
      !Number.isSafeInteger(totalLength) ||
      totalLength <= 0
    ) {
      return { kind: "ignored", reason: "malformed" };
    }

    if (this.recentCompletedSids.has(sid)) {
      return { kind: "ignored", reason: "duplicate" };
    }

    let group = this.partials.get(sid);
    if (group !== undefined) {
      if (
        group.total !== total ||
        group.totalLength !== totalLength ||
        group.hashTag !== hashTag
      ) {
        return { kind: "ignored", reason: "malformed" };
      }
      const existingCode = group.fragments.get(index);
      if (existingCode !== undefined) {
        if (existingCode === trimmed) {
          return { kind: "ignored", reason: "duplicate" };
        }
        return { kind: "ignored", reason: "malformed" };
      }
      group.fragments.set(index, trimmed);
      group.updatedAt = now;
    } else {
      group = {
        total,
        totalLength,
        hashTag,
        fragments: new Map([[index, trimmed]]),
        updatedAt: now,
      };
      this.partials.set(sid, group);
    }

    if (group.fragments.size === group.total) {
      const codes: string[] = [];
      for (let i = 1; i <= group.total; i++) {
        codes.push(group.fragments.get(i)!);
      }
      this.partials.delete(sid);
      this.recentCompletedSids.set(sid, now);
      return { kind: "complete", codes };
    }

    return {
      kind: "partial",
      sid,
      have: group.fragments.size,
      of: group.total,
    };
  }
}
