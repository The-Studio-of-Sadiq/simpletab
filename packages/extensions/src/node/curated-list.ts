import listFile from "./curated-extensions.json" with { type: "json" };

/** One extension on SimpleTab's curated list (design section 11, item 6). */
export interface CuratedExtension {
  /** Open VSX id, `publisher.name`. */
  id: string;
  /** The one version SimpleTab allows. */
  version: string;
  /** Where the page downloads it from (Open VSX). */
  url: string;
  /** SHA-256 of the `.vsix` file, lower-case hex. */
  sha256: string;
  license: string;
  name: string;
  purpose: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9-]*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OPEN_VSX = "https://open-vsx.org/api/";

/** Every problem with a list, so a bad edit to the file fails the tests rather than the app. */
export function curatedListProblems(entries: readonly CuratedExtension[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const where = entry.id || "(no id)";
    if (!ID.test(entry.id)) problems.push(`${where}: the id must be publisher.name`);
    if (seen.has(entry.id.toLowerCase())) problems.push(`${where}: listed twice`);
    seen.add(entry.id.toLowerCase());
    if (!VERSION.test(entry.version)) problems.push(`${where}: the version must be x.y.z`);
    if (!SHA256.test(entry.sha256)) problems.push(`${where}: sha256 must be 64 lower-case hex digits`);
    if (!entry.url.startsWith(OPEN_VSX) || !entry.url.endsWith(`${entry.version}.vsix`)) {
      problems.push(`${where}: the url must be the Open VSX file for version ${entry.version}`);
    }
    for (const field of ["license", "name", "purpose"] as const) {
      if (entry[field].trim().length === 0) problems.push(`${where}: ${field} is empty`);
    }
  }
  return problems;
}

/** SimpleTab's curated list, as shipped. */
export const CURATED_EXTENSIONS: readonly CuratedExtension[] = listFile.extensions;

/** The file name SimpleTab keeps an installed extension under. */
export function vsixFileName(entry: Pick<CuratedExtension, "id" | "version">): string {
  return `${entry.id}-${entry.version}.vsix`;
}
