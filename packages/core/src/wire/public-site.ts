import { err, ok, type Result } from "./result";

/**
 * Public results site contract (M4, design section 10).
 *
 * The host publishes the public projection as content-hashed JSON files next to `manifest.json`,
 * and lists them in `manifest.site` ({@link PublicSiteIndex}). The `simpletab-public` app reads
 * `manifest.json` first, then only the files it needs. Every file is already filtered by the
 * release gates on the host: the site never hides anything itself, it only shows what it is given.
 *
 * File contents, by chunk name (types from `@simpletab/core/lib/publicView/projection`):
 * - `tournament`  -> `PublicProjection["tournament"]`
 * - `rounds`, `teams`, `adjudicators`, `venues`, `motions`, `breakCategories`, `debates`,
 *   `ballots`, `institutions` -> `PublicProjection["collections"][name]` (an array of records)
 * - `tabs`        -> `PublicTabs` (absent while no tab is released)
 * - `derived`     -> `PublicDerived`
 * - `chainFile`   -> `PublicChainItem[]` from `@simpletab/core/changelog`, oldest first
 *
 * Paths are relative to the site root (no leading slash), so the same files work at a domain root
 * (Cloudflare Pages) and under `/<repo>/` (GitHub Pages archive, section 10.1).
 */

export const PUBLIC_SITE_SCHEMA = 1;

export const PUBLIC_DATA_CHUNKS = [
  "tournament",
  "rounds",
  "teams",
  "adjudicators",
  "venues",
  "motions",
  "breakCategories",
  "debates",
  "ballots",
  "institutions",
  "tabs",
  "derived",
] as const;

export type PublicDataChunk = (typeof PUBLIC_DATA_CHUNKS)[number];

/** Chunks every publish carries; the others appear once there is something public in them. */
export const REQUIRED_PUBLIC_DATA_CHUNKS: readonly PublicDataChunk[] = ["tournament", "derived"];

export interface PublicSiteIndex {
  schema: number;
  /** Chunk name -> relative path, `data/<chunk>.<hash>.json`. */
  data: Partial<Record<PublicDataChunk, string>>;
  /** Relative path of the public changelog chain, `data/chain.<hash>.json`. */
  chainFile: string;
  /** Sequence number and entry hash of the last chain entry (the head sent to the service). */
  headSeq: number;
  headHash: string;
  /**
   * Absolute HTTPS URL that returns the service's recorded heads for this tournament
   * (`GET /v1/heads/<slug>`). The Verify page calls it only when someone presses Verify.
   * Absent when the tournament does not use the service (for example a GitHub archive made
   * after the service is gone).
   */
  headsUrl?: string;
}

/** Response of the service's `GET /v1/heads/<slug>`: every head the host has sent, oldest first. */
export interface PublicHeadsResponse {
  schema: number;
  slug: string;
  heads: Array<{ seq: number; headHash: string; publishedAt: string }>;
}

const DATA_PATH_RE = /^data\/[A-Za-z]+\.[0-9a-f]{8,64}\.json$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** True for a relative, content-hashed data path that cannot escape the site root. */
export function isPublicDataPath(value: unknown): value is string {
  return typeof value === "string" && DATA_PATH_RE.test(value);
}

/** Validates the `site` section of a published `manifest.json`. */
export function parsePublicSiteIndex(input: unknown, path = "site"): Result<PublicSiteIndex> {
  if (!isPlainObject(input)) {
    return err(`${path}: must be a JSON object`);
  }
  const errors: string[] = [];
  if (input.schema !== PUBLIC_SITE_SCHEMA) {
    errors.push(`${path}.schema: unsupported public site schema`);
  }

  const data: Partial<Record<PublicDataChunk, string>> = {};
  if (!isPlainObject(input.data)) {
    errors.push(`${path}.data: must be an object`);
  } else {
    const known = new Set<string>(PUBLIC_DATA_CHUNKS);
    for (const [name, value] of Object.entries(input.data)) {
      if (!known.has(name)) {
        // Newer hosts may add chunks; older sites ignore what they do not know.
        continue;
      }
      if (!isPublicDataPath(value)) {
        errors.push(`${path}.data.${name}: must be a relative data/<name>.<hash>.json path`);
        continue;
      }
      data[name as PublicDataChunk] = value;
    }
    for (const required of REQUIRED_PUBLIC_DATA_CHUNKS) {
      if (data[required] === undefined && !errors.some((e) => e.startsWith(`${path}.data.${required}`))) {
        errors.push(`${path}.data.${required}: is required`);
      }
    }
  }

  if (!isPublicDataPath(input.chainFile)) {
    errors.push(`${path}.chainFile: must be a relative data/chain.<hash>.json path`);
  }
  if (!isNonNegInt(input.headSeq)) {
    errors.push(`${path}.headSeq: must be a non-negative integer`);
  }
  if (typeof input.headHash !== "string" || !HEX64_RE.test(input.headHash)) {
    errors.push(`${path}.headHash: must be 64 lowercase hex characters`);
  }
  if (input.headsUrl !== undefined) {
    if (typeof input.headsUrl !== "string" || !input.headsUrl.startsWith("https://")) {
      errors.push(`${path}.headsUrl: must be an https:// URL`);
    }
  }

  if (errors.length > 0) {
    return err(errors);
  }
  return ok({
    schema: PUBLIC_SITE_SCHEMA,
    data,
    chainFile: input.chainFile as string,
    headSeq: input.headSeq as number,
    headHash: input.headHash as string,
    ...(typeof input.headsUrl === "string" ? { headsUrl: input.headsUrl } : {}),
  });
}

/** Validates the service's `GET /v1/heads/<slug>` response. */
export function parsePublicHeadsResponse(input: unknown): Result<PublicHeadsResponse> {
  if (!isPlainObject(input)) {
    return err("$: must be a JSON object");
  }
  const errors: string[] = [];
  if (!isNonNegInt(input.schema) || input.schema < 1) {
    errors.push("schema: must be a positive integer");
  }
  if (typeof input.slug !== "string" || input.slug.length === 0) {
    errors.push("slug: must be a non-empty string");
  }
  const heads: PublicHeadsResponse["heads"] = [];
  if (!Array.isArray(input.heads)) {
    errors.push("heads: must be an array");
  } else {
    input.heads.forEach((head: unknown, i) => {
      if (
        !isPlainObject(head) ||
        !isNonNegInt(head.seq) ||
        typeof head.headHash !== "string" ||
        !HEX64_RE.test(head.headHash) ||
        typeof head.publishedAt !== "string"
      ) {
        errors.push(`heads[${i}]: must be { seq, headHash (64 hex), publishedAt }`);
        return;
      }
      heads.push({ seq: head.seq, headHash: head.headHash, publishedAt: head.publishedAt });
    });
  }
  if (errors.length > 0) {
    return err(errors);
  }
  return ok({ schema: input.schema as number, slug: input.slug as string, heads });
}
