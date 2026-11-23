// Copies CrabbyTab's tournament logic into packages/core/src (design Appendix F).
//
// Paths are kept exactly as in CrabbyTab (src/lib/..., src/features/tournament/application/...,
// src/types/...), and the "@/" alias points at packages/core/src, so no import needs rewriting.
// The script copies the import closure of the seed list below, plus each copied module's own
// *.test.ts when every import of that test is also inside the closure.
//
// Usage: node tools/port-from-crabbytab.mjs <path-to-crabbytab> [--dry-run]

import fs from "node:fs";
import path from "node:path";

const crabbyRoot = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!crabbyRoot || !fs.existsSync(path.join(crabbyRoot, "src"))) {
  console.error("Usage: node tools/port-from-crabbytab.mjs <path-to-crabbytab> [--dry-run]");
  process.exit(2);
}
const src = path.join(crabbyRoot, "src");
const dest = path.resolve("packages/core/src");
// The port is a one-time copy: files in core are edited afterwards (for example passcode.ts and
// privateUrls.ts no longer use Node or browser APIs). Refuse to overwrite them unless asked.
if (!dryRun && fs.existsSync(dest) && !process.argv.includes("--force")) {
  console.error("packages/core/src already exists. The port has been done and core has been edited since.\n" +
    "Use --dry-run to compare, or --force to overwrite (this loses those edits).");
  process.exit(2);
}

// Appendix F seed list (relative to CrabbyTab's src/). A trailing "/" means the whole folder.
const SEEDS = [
  "lib/draw/", "lib/adjudicators/", "lib/adjudicators.ts", "lib/ballots/", "lib/scoring/validator.ts",
  "lib/privateIndividualBallots.ts", "lib/privateBallot.ts", "lib/printOptions.ts", "lib/privateSync.ts",
  "lib/feedback/", "lib/standings/", "lib/motionStatistics.ts", "lib/motionBalance.ts",
  "lib/breakqual/", "lib/publicBracket.ts", "lib/csv/",
  "lib/setup/presets.ts", "lib/setup/preferenceValidation.ts", "lib/setup/configTransfer.ts",
  "lib/venues/", "lib/checkins/", "lib/selfCheckIn.ts", "lib/roundAvailability.ts",
  "lib/codeNames.ts", "lib/teamNames.ts", "lib/sideNames.ts", "lib/speakerCategories.ts",
  "lib/teamCategories.ts", "lib/teamSeeds.ts", "lib/compositeTeams.ts", "lib/debateSides.ts",
  "lib/scoreDisplay.ts", "lib/emailAddress.ts", "lib/phone.ts", "lib/privateUrls.ts", "lib/passcode.ts",
  "lib/publicView/projection.ts", "lib/publicView/derived.ts", "lib/publicView/names.ts", "lib/publicView/hash.ts",
  "lib/publicRelease.ts", "lib/publicScoreVisibility.ts", "lib/publicLists.ts", "lib/publicFeatures.ts",
  "lib/publicForms.ts", "lib/privatePortalBallots.ts", "lib/staffPermissions.ts",
  "lib/motions/roundMotions.ts", "lib/motions/infoSlideMedia.ts",
  "lib/markdown/safeUrls.ts", "lib/markdown/youtube.ts", "lib/schedule/events.ts",
  "lib/registration/review.ts", "lib/registration/validation.ts", "lib/registration/types.ts",
  "lib/registration/access.ts", "lib/registration/names.ts",
  ...[
    "stateGuards", "swingTeams", "breaks", "motionRelease", "preformedPanels", "ballotIntake", "rounds",
    "schedule", "draws", "allocation", "settings", "ballotEntry", "feedback", "entities", "privateAccess",
    "registrationApproval",
  ].map((name) => `features/tournament/application/${name}.ts`),
  "types/index.ts",
  "test/tournamentFixtures.ts",
];

// Browser-only files that core must not contain (design Appendix F).
const EXCLUDED = new Set(["lib/csv/download.ts", "lib/checkins/useBarcodeCamera.ts"]);
// Poly-team tests removed because SimpleTab supports BP and two-team only.
const REMOVED_TESTS = new Set([
  "lib/draw/polyDraw.test.ts", "lib/standings/polyStandings.test.ts", "lib/ballots/polyResult.test.ts",
  "lib/privateBallotPoly.test.ts", "lib/setup/polyPresets.test.ts",
  // Tests of Firebase security rules, which SimpleTab does not use.
  "lib/serverOnlyRules.test.ts",
]);

// Ported files edited after copying so they no longer import an excluded file.
// importer.ts: exportStandingsCsv (which saved a file through the DOM) is removed; callers use
// teamStandingsCsv and save the string themselves.
const PATCHED = new Map([
  ["lib/csv/importer.ts", (text) => {
    const withoutImport = text.replace(/^import \{ downloadCsv \} from "@\/lib\/csv\/download";\r?\n/m, "");
    const withoutExport = withoutImport.replace(
      /\/\*\*\r?\n \* Exports team standings to a downloadable CSV file\.[\s\S]*?\r?\n\}\r?\n/,
      "",
    );
    if (withoutImport === text || withoutExport === withoutImport) {
      throw new Error("lib/csv/importer.ts patch no longer matches CrabbyTab's file; update PATCHED");
    }
    return withoutExport;
  }],
  // This case reads Next.js's src/app route folders, which SimpleTab does not have. Skipped,
  // not deleted, so the reason stays visible next to the rest of the preset tests.
  ["lib/setup/presets.test.ts", (text) => {
    const marker = 'it("reserves every top-level app route and the shared-view segments"';
    if (!text.includes(marker)) {
      throw new Error("lib/setup/presets.test.ts patch no longer matches CrabbyTab's file; update PATCHED");
    }
    return text.replace(
      marker,
      "// SimpleTab: skipped because it reads CrabbyTab's Next.js route folders (src/app).\n    " +
        marker.replace(/^it\(/, "it.skip("),
    );
  }],
]);

const toPosix = (p) => p.split(path.sep).join("/");
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );
}
const allFiles = new Set(walk(src).map((f) => toPosix(path.relative(src, f))).filter((f) => /\.(tsx?|json)$/.test(f)));
const isTest = (f) => /\.test\.tsx?$/.test(f);

function resolveImport(from, spec) {
  let base;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  else return null; // package import
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base]) {
    if (allFiles.has(candidate)) return candidate;
  }
  return `UNRESOLVED:${base}`;
}
function importsOf(file) {
  const text = fs.readFileSync(path.join(src, file), "utf8");
  const specs = [];
  for (const match of text.matchAll(/(?:^|\s)(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm)) {
    specs.push(match[1] ?? match[2] ?? match[3]);
  }
  return specs.map((spec) => ({ spec, resolved: resolveImport(file, spec) }));
}

const seedFiles = [...allFiles].filter(
  (f) => !isTest(f) && !EXCLUDED.has(f) && SEEDS.some((s) => (s.endsWith("/") ? f.startsWith(s) : f === s)),
);

const closure = new Set();
const blocked = [];
const queue = [...seedFiles];
while (queue.length > 0) {
  const file = queue.pop();
  if (closure.has(file)) continue;
  closure.add(file);
  if (file.endsWith(".json")) continue;
  for (const { spec, resolved } of importsOf(file)) {
    if (resolved === null) continue;
    if (resolved.startsWith("UNRESOLVED:")) { blocked.push(`${file}: cannot resolve ${spec}`); continue; }
    if (EXCLUDED.has(resolved)) {
      if (!PATCHED.has(file)) blocked.push(`${file}: imports excluded ${resolved}`);
      continue;
    }
    if (!closure.has(resolved)) queue.push(resolved);
  }
}

// Tests next to ported modules, kept only if all their imports are inside the closure.
const tests = [];
const skippedTests = [];
for (const file of allFiles) {
  if (!isTest(file) || REMOVED_TESTS.has(file)) continue;
  const subject = file.replace(/\.test\.tsx?$/, ".ts");
  const dir = path.posix.dirname(file);
  const nearPorted = closure.has(subject) || [...closure].some((f) => path.posix.dirname(f) === dir && !f.startsWith("types/"));
  if (!nearPorted) continue;
  const missing = importsOf(file).filter(({ resolved }) => resolved !== null && !closure.has(resolved));
  if (missing.length === 0) tests.push(file);
  else skippedTests.push(`${file} (needs ${missing.map((m) => m.resolved ?? m.spec).join(", ")})`);
}

// Data files the ported code reads (e.g. golden JSON next to tests).
const dataFiles = [];
for (const file of tests) {
  const text = fs.readFileSync(path.join(src, file), "utf8");
  for (const match of text.matchAll(/["'](\.{1,2}\/[^"']+\.json)["']/g)) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
    if (fs.existsSync(path.join(src, resolved))) dataFiles.push(resolved);
  }
}

const toCopy = [...closure, ...tests, ...new Set(dataFiles)].sort();
if (!dryRun) {
  for (const file of toCopy) {
    const target = path.join(dest, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const patch = PATCHED.get(file);
    if (patch) fs.writeFileSync(target, patch(fs.readFileSync(path.join(src, file), "utf8")));
    else fs.copyFileSync(path.join(src, file), target);
  }
}

console.log(`modules: ${closure.size}  tests: ${tests.length}  data files: ${new Set(dataFiles).size}${dryRun ? "  (dry run)" : ""}`);
if (blocked.length > 0) console.log(`\nimports that block the port (fix by hand):\n  ${blocked.join("\n  ")}`);
if (skippedTests.length > 0) console.log(`\ntests not copied (they import modules outside the port):\n  ${skippedTests.join("\n  ")}`);
