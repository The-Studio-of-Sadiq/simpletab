import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { vsixFileName, type CuratedExtension } from "./curated-list";

/**
 * The folder where SimpleTab keeps the extensions the organiser installed: one verified `.vsix`
 * per extension, named `<id>-<version>.vsix`, and `state.json` with the ones turned off. Theia's
 * own folders (`~/.theia/deployedPlugins`, `~/.theia/extensions`) are not used for loading.
 */
export function defaultExtensionsDir(): string {
  const override = process.env.SIMPLETAB_EXTENSIONS_DIR;
  return override !== undefined && override.trim().length > 0
    ? override
    : path.join(os.homedir(), ".simpletab", "extensions");
}

const STATE_FILE = "state.json";

export function sha256Of(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** What is in the folder, checked against the list. */
export interface StoreScan {
  /** Listed extensions whose file is present and whose hash matches. */
  verified: CuratedExtension[];
  /** Files that are not a listed id and version, or whose hash does not match. */
  rejected: Array<{ file: string; reason: "not-listed" | "hash-mismatch" }>;
  /** Ids the organiser turned off. */
  off: string[];
}

export function readOffIds(dir: string): string[] {
  const file = path.join(dir, STATE_FILE);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { off?: unknown }).off)) {
      return (parsed as { off: unknown[] }).off.filter((id): id is string => typeof id === "string");
    }
  } catch {
    // A damaged state file turns nothing off; the page shows every installed extension as on.
  }
  return [];
}

export function writeOffIds(dir: string, off: readonly string[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({ off: [...new Set(off)].sort() }, null, 2), "utf8");
}

/** Checks every `.vsix` in the folder against the list, re-hashing each file. */
export function scanStore(dir: string, list: readonly CuratedExtension[]): StoreScan {
  const scan: StoreScan = { verified: [], rejected: [], off: readOffIds(dir) };
  if (!existsSync(dir)) return scan;
  const byFile = new Map(list.map((entry) => [vsixFileName(entry).toLowerCase(), entry]));
  for (const file of readdirSync(dir).sort()) {
    if (!file.toLowerCase().endsWith(".vsix")) continue;
    const entry = byFile.get(file.toLowerCase());
    if (entry === undefined) {
      scan.rejected.push({ file, reason: "not-listed" });
    } else if (sha256Of(path.join(dir, file)) !== entry.sha256) {
      scan.rejected.push({ file, reason: "hash-mismatch" });
    } else {
      scan.verified.push(entry);
    }
  }
  return scan;
}
