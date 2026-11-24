import { createHash } from "node:crypto";
import type { PublicChainItem } from "@simpletab/core/changelog";
import { stableStringify } from "@simpletab/core/lib/publicView/hash";
import {
  buildPublicProjection,
  needsPublicFeedback,
  PUBLIC_COLLECTION_NAMES,
  type PublicProjection,
  type PublicSourceData,
  type SourceRecord,
} from "@simpletab/core/lib/publicView/projection";
import type { TournamentState } from "@simpletab/core/ops";
import {
  parsePublicSiteIndex,
  PUBLIC_SITE_SCHEMA,
  type PublicDataChunk,
  type PublicSiteIndex,
} from "@simpletab/core/wire";

/**
 * Builds the public results site file set (design section 10, step 1) from the tournament state.
 *
 * Every file is content-hashed and written with a deterministic serialization, so the same state
 * always produces byte-identical files and names. Feedback records are never published: the
 * projection's feedback collection is always empty. Feedback goes into the projection source only
 * when a released page aggregates it (adjudicator tab scores, diversity, feedback progress), as in
 * CrabbyTab's public site; those pages carry counts and averages, never a submission's text.
 */

export interface PublicSiteHead {
  seq: number;
  entryHash: string;
}

export interface BuildPublicSiteFilesOptions {
  /** Ballots service origin; adds the optional `headsUrl` to the site index. */
  ballotsOrigin?: string;
}

export interface BuildPublicSiteFilesResult {
  /** Relative site path -> exact bytes. */
  files: Map<string, Uint8Array>;
  site: PublicSiteIndex;
  /** The released projection the files were built from (the archive's exports reuse it). */
  projection: PublicProjection;
}

const UTF8 = new TextEncoder();

function encodeStable(value: unknown): Uint8Array {
  return UTF8.encode(stableStringify(value));
}

function hash16(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

function dataPath(chunk: string, bytes: Uint8Array): string {
  return `data/${chunk}.${hash16(bytes)}.json`;
}

/** Stable digest of a built file set, used to skip publishes when nothing public changed. */
export function fingerprintPublicSiteFiles(
  files: ReadonlyMap<string, Uint8Array>,
): string {
  const hash = createHash("sha256");
  for (const relPath of [...files.keys()].sort()) {
    hash.update(relPath, "utf8");
    hash.update("\u0000", "utf8");
    hash.update(files.get(relPath)!);
    hash.update("\u0000", "utf8");
  }
  return hash.digest("hex");
}

function toSource(state: TournamentState): PublicSourceData {
  const aggregatesFeedback = needsPublicFeedback(state.tournament.preferences);
  return {
    ...(aggregatesFeedback ? { feedback: state.feedback as unknown as SourceRecord[] } : {}),
    rounds: state.rounds as unknown as SourceRecord[],
    teams: state.teams as unknown as SourceRecord[],
    adjudicators: state.adjudicators as unknown as SourceRecord[],
    debates: state.debates as unknown as SourceRecord[],
    ballots: state.ballots as unknown as SourceRecord[],
    motions: state.motions as unknown as SourceRecord[],
    breakCategories: state.breakCategories as unknown as SourceRecord[],
    institutions: state.institutions as unknown as SourceRecord[],
    venues: state.venues as unknown as SourceRecord[],
  };
}

function resolveHeadsUrl(
  ballotsOrigin: string | undefined,
  slug: string,
): string | undefined {
  const origin = ballotsOrigin?.trim();
  if (origin === undefined || origin.length === 0) {
    return undefined;
  }
  return `${origin.replace(/\/+$/, "")}/v1/heads/${encodeURIComponent(slug)}`;
}

export function buildPublicSiteFiles(
  state: TournamentState,
  chain: readonly PublicChainItem[],
  head: PublicSiteHead,
  options: BuildPublicSiteFilesOptions = {},
): BuildPublicSiteFilesResult {
  const projection = buildPublicProjection(
    state.tournament as unknown as SourceRecord,
    toSource(state),
  );

  const files = new Map<string, Uint8Array>();
  const data: Partial<Record<PublicDataChunk, string>> = {};

  const writeChunk = (chunk: PublicDataChunk, value: unknown): void => {
    const bytes = encodeStable(value);
    const relPath = dataPath(chunk, bytes);
    files.set(relPath, bytes);
    data[chunk] = relPath;
  };

  writeChunk("tournament", projection.tournament);
  for (const name of PUBLIC_COLLECTION_NAMES) {
    writeChunk(name, projection.collections[name]);
  }
  if (projection.tabs !== undefined) {
    writeChunk("tabs", projection.tabs);
  }
  writeChunk("derived", projection.derived);

  const chainBytes = encodeStable([...chain]);
  const chainFile = dataPath("chain", chainBytes);
  files.set(chainFile, chainBytes);

  const headsUrl = resolveHeadsUrl(options.ballotsOrigin, state.tournament.slug);
  const site: PublicSiteIndex = {
    schema: PUBLIC_SITE_SCHEMA,
    data,
    chainFile,
    headSeq: head.seq,
    headHash: head.entryHash,
    ...(headsUrl !== undefined ? { headsUrl } : {}),
  };

  const parsed = parsePublicSiteIndex(site);
  if (!parsed.ok) {
    throw new Error(
      `Generated public site index failed validation: ${parsed.errors.join("; ")}`,
    );
  }

  return { files, site: parsed.value, projection };
}
