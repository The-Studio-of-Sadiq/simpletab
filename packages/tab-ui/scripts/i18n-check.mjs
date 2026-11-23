import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IntlMessageFormat } from "intl-messageformat";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const localesDir = path.resolve(scriptDir, "../src/browser/locales");

function readJsonCatalog(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath}: expected a JSON object`);
  }
  return parsed;
}

function listJsonFiles(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

const problems = [];
const dirs = readdirSync(localesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (!dirs.includes("en")) {
  console.error("i18n:check: missing reference locale directory 'en'");
  process.exit(1);
}
if (!dirs.includes("bn")) {
  problems.push("missing required locale directory 'bn'");
}
if (!dirs.includes("TEMPLATE")) {
  problems.push("missing required 'TEMPLATE' directory");
}

const enDir = path.join(localesDir, "en");
const enFiles = listJsonFiles(enDir);
const enCatalogs = new Map();

for (const file of enFiles) {
  const filePath = path.join(enDir, file);
  const data = readJsonCatalog(filePath);
  enCatalogs.set(file, data);
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      problems.push(`en/${file}: key "${key}" must be a non-empty string`);
      continue;
    }
    try {
      new IntlMessageFormat(value, "en");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      problems.push(`en/${file}: key "${key}" has invalid ICU syntax: ${msg}`);
    }
  }
}

for (const dirName of dirs) {
  if (dirName === "en") {
    continue;
  }
  const dirPath = path.join(localesDir, dirName);
  const files = listJsonFiles(dirPath);

  for (const expectedFile of enFiles) {
    if (!files.includes(expectedFile)) {
      problems.push(`${dirName}: missing file "${expectedFile}"`);
    }
  }
  for (const actualFile of files) {
    if (!enFiles.includes(actualFile)) {
      problems.push(`${dirName}: extra file "${actualFile}" not present in en`);
    }
  }

  for (const file of files) {
    const ref = enCatalogs.get(file);
    if (!ref) {
      continue;
    }
    const data = readJsonCatalog(path.join(dirPath, file));
    const refKeys = Object.keys(ref);
    const actualKeys = Object.keys(data);

    for (const key of refKeys) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) {
        problems.push(`${dirName}/${file}: missing key "${key}"`);
      }
    }
    for (const key of actualKeys) {
      if (!Object.prototype.hasOwnProperty.call(ref, key)) {
        problems.push(`${dirName}/${file}: extra key "${key}"`);
      }
    }

    for (const [key, value] of Object.entries(data)) {
      if (typeof value !== "string") {
        problems.push(`${dirName}/${file}: key "${key}" must be a string`);
        continue;
      }
      if (dirName === "TEMPLATE") {
        if (value !== "") {
          problems.push(`TEMPLATE/${file}: key "${key}" must have an empty string value`);
        }
      } else {
        if (value.trim().length === 0) {
          problems.push(`${dirName}/${file}: key "${key}" must not be empty`);
          continue;
        }
        try {
          new IntlMessageFormat(value, dirName);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          problems.push(`${dirName}/${file}: key "${key}" has invalid ICU syntax: ${msg}`);
        }
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`i18n:check failed (${problems.length} issue(s)):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

const totalKeys = [...enCatalogs.values()].reduce(
  (sum, obj) => sum + Object.keys(obj).length,
  0,
);
console.log(
  `i18n:check OK (${totalKeys} keys across ${enFiles.length} file(s); locales: ${dirs.join(", ")})`,
);
