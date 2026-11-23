// Checks that @simpletab/core is self-contained (design Appendix F):
//  1. every relative or "@/" import in packages/core/src resolves to a file inside core;
//  2. package imports in non-test files are limited to ALLOWED_PACKAGES;
//  3. the browser-only CrabbyTab files that were left out have not come back.
// Exits with code 1 and lists every problem it finds.

import fs from "node:fs";
import path from "node:path";

const coreSrc = path.resolve("packages/core/src");
const ALLOWED_PACKAGES = new Set(["papaparse"]);
const MUST_NOT_EXIST = ["lib/csv/download.ts", "lib/checkins/useBarcodeCamera.ts"];

const toPosix = (p) => p.split(path.sep).join("/");
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );
}
const files = walk(coreSrc).map((f) => toPosix(path.relative(coreSrc, f)));
const fileSet = new Set(files);
const isTest = (f) => /\.test\.tsx?$/.test(f) || f.startsWith("test/");

function resolves(from, spec) {
  const base = spec.startsWith("@/") ? spec.slice(2) : path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base].some((candidate) => fileSet.has(candidate));
}

const problems = [];
for (const file of files.filter((f) => /\.tsx?$/.test(f))) {
  const text = fs.readFileSync(path.join(coreSrc, file), "utf8");
  for (const match of text.matchAll(/(?:^|\s)(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm)) {
    const spec = match[1] ?? match[2];
    if (spec.startsWith("@/") || spec.startsWith(".")) {
      if (!resolves(file, spec)) problems.push(`${file}: import "${spec}" does not resolve inside core`);
    } else if (!isTest(file)) {
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (!ALLOWED_PACKAGES.has(pkg)) problems.push(`${file}: imports package "${spec}", which core does not allow`);
    }
  }
}
for (const file of MUST_NOT_EXIST) {
  if (fileSet.has(file)) problems.push(`${file}: browser-only CrabbyTab file must not be in core`);
}

if (problems.length > 0) {
  console.error(`port-check: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`port-check: OK (${files.length} files in packages/core/src)`);
