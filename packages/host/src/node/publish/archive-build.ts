import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PublicChainItem } from "@simpletab/core/changelog";
import {
  createDebateXmlArchive,
  type DebateXmlArchiveInput,
} from "@simpletab/core/features/tournament/application/debateXml";
import { toCsv } from "@simpletab/core/lib/csv/exporters";
import type { PublicTeamTabRow, PublicSpeakerTabRow } from "@simpletab/core/lib/publicView/derived";
import type { PublicProjection } from "@simpletab/core/lib/publicView/projection";
import type { TournamentState } from "@simpletab/core/ops";
import { parseManifest, SCHEMA_VERSION, type TournamentManifest } from "@simpletab/core/wire";
import { buildPublicSiteFiles, type PublicSiteHead } from "./projection-build";

/**
 * Builds the permanent GitHub archive (design section 10.1): the released public site, a
 * `manifest.json` with the public chain, `exports/` (CSVs of the released tabs and results, and a
 * DebateXML file) and a generated README.
 *
 * Everything comes from the public projection, which is a whitelist of released fields: it already
 * applies the release gates, redacts anonymous people and never carries feedback, contact details or
 * link secrets. The phone portal's `rounds/` and `forms/` are never part of an archive; the builder
 * refuses them even if they appear in the site assets.
 */

export interface BuildArchiveFilesOptions {
  /** Directory holding the pinned `simpletab-public` assets. */
  publicSiteAssetsDir: string;
  /** When the archive was built (ISO 8601 UTC). */
  publishedAt: string;
  /** Ballots service origin; adds the optional heads URL to the site index. */
  ballotsOrigin?: string;
  /** Live public site address for the README, e.g. "https://wudc2027.pages.dev/". */
  liveSiteUrl?: string;
}

export interface BuildArchiveFilesResult {
  /** Relative path -> exact bytes. */
  files: Map<string, Uint8Array>;
  manifest: TournamentManifest;
  /** Exports that could not be produced, with a plain reason (shown in the README too). */
  skippedExports: string[];
}

const UTF8 = new TextEncoder();
const FORBIDDEN_PREFIXES = ["rounds/", "forms/"] as const;

/** Throws when a path would put phone-portal files into the public archive. */
export function assertArchivePathsAllowed(paths: Iterable<string>): void {
  for (const relPath of paths) {
    const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    for (const prefix of FORBIDDEN_PREFIXES) {
      if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) {
        throw new Error(
          `The archive must not contain "${normalized}": round bundles and forms are never archived.`,
        );
      }
    }
  }
}

function readTree(dir: string, prefix = "", out = new Map<string, Uint8Array>()): Map<string, Uint8Array> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relPath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      readTree(full, relPath, out);
    } else if (entry.isFile()) {
      out.set(relPath, readFileSync(full));
    }
  }
  return out;
}

function fileSlug(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : fallback;
}

function fixed(value: number | undefined, digits: number): string {
  return value === undefined || !Number.isFinite(value) ? "" : value.toFixed(digits);
}

function teamTabCsv(rows: readonly PublicTeamTabRow[]): string {
  return toCsv(
    ["Rank", "Team", "Institution", "Points", "Wins", "Total Speaker Score", "Average Speaker Score"],
    rows.map((row) => [
      row.rank,
      row.teamName,
      row.institutionCode,
      row.points,
      row.wins,
      fixed(row.totalSpeakerScore, 2),
      fixed(row.averageSpeakerScore, 2),
    ]),
  );
}

function speakerTabCsv(rows: readonly PublicSpeakerTabRow[], reply: boolean): string {
  return toCsv(
    ["Rank", reply ? "Reply Speaker" : "Speaker", "Team", "Speeches", "Total Score", "Average Score"],
    rows.map((row) => [
      row.ineligible === true ? "" : row.rank,
      row.speakerName,
      row.teamName,
      row.speechesCount,
      fixed(row.totalScore, 2),
      fixed(row.averageScore, 2),
    ]),
  );
}

type Rec = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rec(value: unknown): Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
}

function byId(records: readonly Rec[]): Map<string, Rec> {
  return new Map(records.flatMap((r) => (typeof r.id === "string" ? [[r.id, r] as const] : [])));
}

function countedBallots(ballots: readonly Rec[]): Map<string, Rec> {
  const byDebate = new Map<string, Rec>();
  for (const ballot of ballots) {
    const debateId = str(ballot.debateId);
    if (debateId === undefined || ballot.confirmed !== true || ballot.discarded === true) continue;
    byDebate.set(debateId, ballot);
  }
  return byDebate;
}

/** One row per team per debate with a released, confirmed result. */
function resultsCsv(projection: PublicProjection): string | undefined {
  const { collections } = projection;
  const rounds = byId(collections.rounds);
  const teams = byId(collections.teams);
  const venues = byId(collections.venues);
  const ballots = countedBallots(collections.ballots);
  const rows: Array<Array<string | number | boolean | undefined>> = [];
  const debates = [...collections.debates].sort((a, b) => {
    const seqA = num(rounds.get(str(a.roundId) ?? "")?.seq) ?? 0;
    const seqB = num(rounds.get(str(b.roundId) ?? "")?.seq) ?? 0;
    return seqA - seqB || String(a.id).localeCompare(String(b.id));
  });
  for (const debate of debates) {
    const ballot = ballots.get(String(debate.id));
    if (ballot === undefined) continue;
    const round = rounds.get(str(debate.roundId) ?? "");
    const venue = venues.get(str(debate.venueId) ?? "");
    const scores = rec(ballot.teamScores);
    for (const [side, rawSlot] of Object.entries(rec(debate.teams)).sort(([a], [b]) => a.localeCompare(b))) {
      const teamId = str(rec(rawSlot).teamId);
      if (teamId === undefined) continue;
      const score = rec(scores[side]);
      rows.push([
        str(round?.name) ?? "",
        str(venue?.name) ?? "",
        side,
        str(teams.get(teamId)?.name) ?? "",
        num(score.rank),
        num(score.points),
        typeof score.win === "boolean" ? (score.win ? "yes" : "no") : undefined,
        fixed(num(score.totalSpeakerScore), 2),
      ]);
    }
  }
  if (rows.length === 0) return undefined;
  return toCsv(["Round", "Room", "Side", "Team", "Rank", "Points", "Won", "Speaker Total"], rows);
}

/** Winners of each break category's final, when its result is released. */
export function findChampions(projection: PublicProjection): Array<{ category: string; teams: string[] }> {
  const { collections } = projection;
  const teams = byId(collections.teams);
  const categories = byId(collections.breakCategories);
  const ballots = countedBallots(collections.ballots);
  const debatesByRound = new Map<string, Rec[]>();
  for (const debate of collections.debates) {
    const roundId = str(debate.roundId);
    if (roundId === undefined) continue;
    debatesByRound.set(roundId, [...(debatesByRound.get(roundId) ?? []), debate]);
  }
  const finals = new Map<string, Rec>();
  for (const round of collections.rounds) {
    if (round.stage !== "elimination" || round.cancelled === true) continue;
    const categoryIds = Array.isArray(round.breakCategoryIds) ? round.breakCategoryIds : [];
    const key = categoryIds.length === 1 ? String(categoryIds[0]) : "";
    const current = finals.get(key);
    if (current === undefined || (num(round.seq) ?? 0) > (num(current.seq) ?? 0)) finals.set(key, round);
  }
  const champions: Array<{ category: string; teams: string[] }> = [];
  for (const [categoryId, round] of finals) {
    const winners: string[] = [];
    for (const debate of debatesByRound.get(String(round.id)) ?? []) {
      const ballot = ballots.get(String(debate.id));
      if (ballot === undefined) continue;
      for (const [side, rawScore] of Object.entries(rec(ballot.teamScores))) {
        const score = rec(rawScore);
        if (score.win !== true && score.rank !== 1) continue;
        const teamId = str(score.teamId) ?? str(rec(rec(debate.teams)[side]).teamId);
        const name = teamId !== undefined ? str(teams.get(teamId)?.name) : undefined;
        if (name !== undefined) winners.push(name);
      }
    }
    if (winners.length === 0) continue;
    const category = str(categories.get(categoryId)?.name) ?? (categoryId === "" ? "Open" : categoryId);
    champions.push({ category, teams: winners });
  }
  return champions.sort((a, b) => a.category.localeCompare(b.category));
}

function debateXmlInput(projection: PublicProjection): DebateXmlArchiveInput {
  const { collections } = projection;
  // The projection holds only released fields; the exporter's optional fields stay absent.
  const teams = collections.teams.map((team) => ({
    ...team,
    speakers: Array.isArray(team.speakers) ? team.speakers : [],
    breakCategories: Array.isArray(team.breakCategories) ? team.breakCategories : [],
  }));
  const motions = collections.motions.filter((motion) => typeof motion.text === "string" && motion.text.length > 0);
  return {
    tournament: projection.tournament,
    rounds: collections.rounds,
    teams,
    adjudicators: collections.adjudicators.map((adj) => ({ ...adj, conflicts: [] })),
    venues: collections.venues,
    motions,
    breakCategories: collections.breakCategories,
    debates: collections.debates,
    ballots: collections.ballots,
    feedback: [],
    institutions: collections.institutions,
  } as unknown as DebateXmlArchiveInput;
}

function plain(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : "unknown error";
}

function buildExports(projection: PublicProjection, slug: string): { files: Map<string, string>; skipped: string[] } {
  const files = new Map<string, string>();
  const skipped: string[] = [];
  const tabs = projection.tabs;
  if (tabs?.teamTab !== undefined) files.set("exports/team-tab.csv", teamTabCsv(tabs.teamTab));
  if (tabs?.speakerTab !== undefined) files.set("exports/speaker-tab.csv", speakerTabCsv(tabs.speakerTab, false));
  if (tabs?.repliesTab !== undefined) files.set("exports/replies-tab.csv", speakerTabCsv(tabs.repliesTab, true));
  const categoryNames = new Map(
    projection.collections.breakCategories.map((c) => [String(c.id), str(c.name) ?? String(c.id)]),
  );
  for (const [categoryId, rows] of Object.entries(tabs?.breakCategoryTabs ?? {})) {
    const name = categoryNames.get(categoryId) ?? categoryId;
    files.set(`exports/break-${fileSlug(name, "category")}.csv`, teamTabCsv(rows));
  }
  for (const [category, rows] of Object.entries(tabs?.speakerCategoryTabs ?? {})) {
    files.set(`exports/speaker-category-${fileSlug(category, "category")}.csv`, speakerTabCsv(rows, false));
  }
  const results = resultsCsv(projection);
  if (results !== undefined) files.set("exports/results.csv", results);
  try {
    files.set(`exports/${fileSlug(slug, "tournament")}.debatexml.xml`, createDebateXmlArchive(debateXmlInput(projection)));
  } catch (error) {
    skipped.push(`DebateXML: ${plain(error)}`);
  }
  return { files, skipped };
}

const FORMAT_NAMES: Record<string, string> = {
  bp: "British Parliamentary",
  uadc: "UADC",
  wsdc: "World Schools",
  australs: "Australs",
  custom_2team: "Two-team (custom)",
  poly: "Multi-team",
};

function readme(
  projection: PublicProjection,
  exportsList: string[],
  skipped: string[],
  options: BuildArchiveFilesOptions,
  head: PublicSiteHead,
): string {
  const t = projection.tournament;
  const champions = findChampions(projection);
  const lines = [
    `# ${t.name}`,
    "",
    "Permanent results archive, published with SimpleTab.",
    "",
    `- Format: ${FORMAT_NAMES[t.format] ?? t.format}`,
    `- Archived: ${options.publishedAt.slice(0, 10)}`,
    `- Change log head: ${head.seq} (\`${head.entryHash}\`)`,
  ];
  if (options.liveSiteUrl !== undefined) lines.push(`- Live site: ${options.liveSiteUrl}`);
  if (champions.length > 0) {
    lines.push("", "## Champions", "");
    for (const champion of champions) lines.push(`- ${champion.category}: ${champion.teams.join(", ")}`);
  }
  lines.push(
    "",
    "## Pages",
    "",
    "- [Results site](./index.html)",
    "- [Verify this archive](./index.html#/verify)",
    "",
    "## Exports",
    "",
  );
  if (exportsList.length === 0) lines.push("No tab or result has been released yet.");
  for (const file of exportsList) lines.push(`- [${file.replace(/^exports\//, "")}](./${file})`);
  if (skipped.length > 0) {
    lines.push("", "Not included:", "");
    for (const reason of skipped) lines.push(`- ${reason}`);
  }
  lines.push(
    "",
    "## About",
    "",
    "Only released material is here: round bundles, forms, unreleased motions, feedback and contact",
    "details are never archived. `manifest.json` and the change log chain let anyone check that the",
    "results were not altered; each commit on this branch records the head hash of that publish.",
    "",
  );
  return lines.join("\n");
}

export function buildArchiveFiles(
  state: TournamentState,
  chain: readonly PublicChainItem[],
  head: PublicSiteHead,
  options: BuildArchiveFilesOptions,
): BuildArchiveFilesResult {
  const built = buildPublicSiteFiles(state, chain, head, {
    ...(options.ballotsOrigin !== undefined ? { ballotsOrigin: options.ballotsOrigin } : {}),
  });

  const files = readTree(options.publicSiteAssetsDir);
  for (const [relPath, bytes] of built.files) files.set(relPath, bytes);

  const exports = buildExports(built.projection, state.tournament.slug);
  for (const [relPath, text] of exports.files) files.set(relPath, UTF8.encode(text));

  const manifest: TournamentManifest = {
    schema: SCHEMA_VERSION,
    slug: state.tournament.slug,
    tournamentName: state.tournament.name,
    timeZone: state.tournament.simpletab?.timeZone ?? "UTC",
    publishedAt: options.publishedAt,
    // The archive has no phone portal.
    ballotCollectionMode: "qr_only",
    ...(state.tournament.preferences?.publicLanguage
      ? { defaultLanguage: state.tournament.preferences.publicLanguage }
      : {}),
    currentRoundSeq: 0,
    rounds: [],
    headHash: head.entryHash,
    site: built.site,
  };
  const parsed = parseManifest(manifest);
  if (!parsed.ok) {
    throw new Error(`Generated archive manifest failed validation: ${parsed.errors.join("; ")}`);
  }
  files.set("manifest.json", UTF8.encode(JSON.stringify(parsed.value, null, 2)));
  files.set(
    "README.md",
    UTF8.encode(readme(built.projection, [...exports.files.keys()].sort(), exports.skipped, options, head)),
  );
  // GitHub Pages serves files as they are, without Jekyll processing.
  files.set(".nojekyll", new Uint8Array());

  assertArchivePathsAllowed(files.keys());
  return { files, manifest: parsed.value, skippedExports: exports.skipped };
}
