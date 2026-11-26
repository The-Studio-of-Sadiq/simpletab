// Saves the curated extensions' pinned files for the M9 checkpoint (`npm run e2e:extensions`).
// The files stay out of git (one of them is GPL-licensed, and together they are larger than the
// repository); this script downloads each from Open VSX once and keeps it only if its SHA-256
// matches SimpleTab's list. Files already saved with the right checksum are not downloaded again.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const listFile = path.join(root, "packages/extensions/src/node/curated-extensions.json");
export const FIXTURES_DIR = path.join(root, "tools/e2e/fixtures/extensions");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const { extensions } = JSON.parse(readFileSync(listFile, "utf8"));
mkdirSync(FIXTURES_DIR, { recursive: true });

let failed = 0;
for (const entry of extensions) {
  const target = path.join(FIXTURES_DIR, `${entry.id}-${entry.version}.vsix`);
  if (existsSync(target) && sha256(readFileSync(target)) === entry.sha256) {
    console.log(`kept       ${entry.id} ${entry.version}`);
    continue;
  }
  const response = await fetch(entry.url);
  if (!response.ok) {
    console.error(`FAILED     ${entry.id}: ${entry.url} answered ${response.status}`);
    failed += 1;
    continue;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== entry.sha256) {
    console.error(`MISMATCH   ${entry.id}: the download does not match the listed SHA-256`);
    failed += 1;
    continue;
  }
  writeFileSync(`${target}.partial`, bytes);
  renameSync(`${target}.partial`, target);
  console.log(`downloaded ${entry.id} ${entry.version} (${bytes.length} bytes)`);
}
if (failed > 0) process.exit(1);
