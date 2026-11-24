// Fills SimpleTab's Bangla desktop catalog (packages/tab-ui/src/browser/locales/bn) from CrabbyTab's
// existing Bangla catalog wherever the English text is the same.
//
// CrabbyTab's catalogs were ported into core unchanged (packages/core/src/lib/i18n/messages), so this
// reads them from there. Only values whose SimpleTab English source matches a CrabbyTab English string
// exactly (after normalising whitespace) are filled; everything else stays "TODO: ...". Nothing is
// translated here. CrabbyTab marks its Bangla as machine-drafted and not yet reviewed by a fluent
// speaker, so filled values still need that review; the report says so.
//
// Usage: node tools/convert-locales.mjs            (writes bn/*.json and docs/checks/locales-bn-<date>.md)
//        node tools/convert-locales.mjs --dry-run  (reports only)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { IntlMessageFormat } from "intl-messageformat";

const dryRun = process.argv.includes("--dry-run");
const root = path.resolve(".");
const coreSrc = path.join(root, "packages/core/src");
const localesDir = path.join(root, "packages/tab-ui/src/browser/locales");

/** Bundles one of core's TypeScript catalog modules and returns its named export. */
async function loadCatalog(file, exportName) {
  const outfile = path.join(os.tmpdir(), `simpletab-catalog-${exportName}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(coreSrc, file)],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    alias: { "@": coreSrc },
    loader: { ".json": "json" },
    logLevel: "silent",
  });
  try {
    const module = await import(pathToFileURL(outfile).href);
    return module[exportName];
  } finally {
    fs.rmSync(outfile, { force: true });
  }
}

const normalise = (text) => text.replace(/\s+/g, " ").trim();

/** Placeholder names in an ICU message ({name}, {count, plural, ...}); rich-text tags ignored. */
function placeholders(message) {
  const names = new Set();
  const walk = (elements) => {
    for (const element of elements) {
      if (element.value !== undefined && typeof element.value === "string" && element.type !== 0) names.add(element.value);
      if (element.options) for (const option of Object.values(element.options)) walk(option.value);
      if (element.children) walk(element.children);
    }
  };
  walk(new IntlMessageFormat(message, "en").getAst());
  return [...names].sort().join(",");
}

const en = await loadCatalog("lib/i18n/messages/en.ts", "en");
const bn = await loadCatalog("lib/i18n/messages/bn.ts", "bn");
const englishToBangla = new Map();
for (const [key, english] of Object.entries(en)) {
  const bangla = bn[key];
  if (typeof english !== "string" || typeof bangla !== "string" || bangla.trim() === "") continue;
  const normalised = normalise(english);
  if (!englishToBangla.has(normalised)) englishToBangla.set(normalised, bangla);
}

let total = 0;
let filled = 0;
let alreadyDone = 0;
const stillTodo = new Map();
const examples = [];
for (const file of fs.readdirSync(path.join(localesDir, "en")).filter((name) => name.endsWith(".json")).sort()) {
  const enMessages = JSON.parse(fs.readFileSync(path.join(localesDir, "en", file), "utf8"));
  const bnPath = path.join(localesDir, "bn", file);
  const bnMessages = JSON.parse(fs.readFileSync(bnPath, "utf8"));
  for (const [key, english] of Object.entries(enMessages)) {
    total += 1;
    const current = bnMessages[key];
    if (typeof current === "string" && !current.startsWith("TODO:")) {
      alreadyDone += 1;
      continue;
    }
    const candidate = englishToBangla.get(normalise(english));
    let accepted = false;
    if (candidate !== undefined) {
      try {
        // Same placeholders as the English string, and valid ICU, or it is not used.
        accepted = placeholders(candidate) === placeholders(english);
      } catch {
        accepted = false;
      }
    }
    if (accepted) {
      bnMessages[key] = candidate;
      filled += 1;
      if (examples.length < 10) examples.push([english, candidate]);
    } else {
      if (!stillTodo.has(file)) stillTodo.set(file, []);
      stillTodo.get(file).push(key);
    }
  }
  if (!dryRun) fs.writeFileSync(bnPath, `${JSON.stringify(bnMessages, null, 2)}\n`);
}

const todoCount = [...stillTodo.values()].reduce((sum, keys) => sum + keys.length, 0);
const date = new Date().toISOString().slice(0, 10);
const report = [
  `# Bangla desktop catalog: ${date}`,
  "",
  "Filled from CrabbyTab's Bangla catalog where the English text matches exactly. CrabbyTab marks that",
  "catalog as **machine-drafted and not yet reviewed by a fluent speaker**, so the filled values need the",
  "same review. Values still starting with `TODO:` need a translator.",
  "",
  `| Keys | Filled from CrabbyTab | Already translated | Still TODO |`,
  `|---:|---:|---:|---:|`,
  `| ${total} | ${filled} | ${alreadyDone} | ${todoCount} |`,
  "",
  "## Examples",
  "",
  ...examples.map(([english, bangla]) => `- ${english} → ${bangla}`),
  "",
  "## Still TODO, by file",
  "",
  ...[...stillTodo.entries()].flatMap(([file, keys]) => [`### ${file} (${keys.length})`, "", ...keys.map((key) => `- \`${key}\``), ""]),
].join("\n");
if (!dryRun) {
  fs.mkdirSync(path.join(root, "docs/checks"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/checks", `locales-bn-${date}.md`), report);
}
console.log(`convert-locales: ${total} keys, ${filled} filled from CrabbyTab, ${alreadyDone} already translated, ${todoCount} still TODO${dryRun ? " (dry run)" : ""}`);
for (const [english, bangla] of examples) console.log(`  ${english} → ${bangla}`);
