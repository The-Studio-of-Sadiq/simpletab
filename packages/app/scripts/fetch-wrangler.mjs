// Bundles Wrangler for the electron-main publish path (design section 10, step 2; file plan row 37).
//
// Wrangler runs with Electron's own Node (ELECTRON_RUN_AS_NODE=1), so the app ships the Wrangler
// JavaScript package under resources/wrangler. Optional platform binaries (workerd) are skipped.
// This script never fails a build: when it cannot reach npm it warns and leaves the previous
// install (or none) in place, and `pages deploy` reports WRANGLER_MISSING at publish time.
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PINNED_VERSION = "4.165.0";
const CLI_RELATIVE_PATH = "node_modules/wrangler/bin/wrangler.js";
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const useShell = process.platform === "win32";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wranglerDir = path.join(appDir, "resources", "wrangler");
const cliPath = path.join(wranglerDir, ...CLI_RELATIVE_PATH.split("/"));
const cliJsonPath = path.join(wranglerDir, "cli.json");

function log(message) {
  console.log(`[fetch-wrangler] ${message}`);
}

function warn(message) {
  console.warn(`[fetch-wrangler] WARNING: ${message}`);
}

function readInstalledConfig() {
  if (!existsSync(cliJsonPath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(cliJsonPath, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function directorySize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += directorySize(full);
      } else if (entry.isFile()) {
        total += statSync(full).size;
      }
    } catch {
      // A file can vanish while a build script walks the tree; its size does not matter.
    }
  }
  return total;
}

function formatSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function reportInstalled(version) {
  const size = existsSync(wranglerDir) ? directorySize(wranglerDir) : 0;
  log(`Wrangler ${version} installed at ${wranglerDir} (${formatSize(size)}).`);
}

function runNpm(args, options = {}) {
  return spawnSync(npmCmd, args, {
    encoding: "utf8",
    shell: useShell,
    ...options,
  });
}

function npmView(args) {
  const result = runNpm(["view", ...args], { timeout: 120_000 });
  if (result.error || result.status !== 0) {
    return undefined;
  }
  return result.stdout.trim();
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function resolveVersion() {
  const pinned = npmView([`wrangler@${PINNED_VERSION}`, "version"]);
  if (pinned === PINNED_VERSION) {
    return PINNED_VERSION;
  }

  warn(
    `wrangler@${PINNED_VERSION} is not published anymore; looking for the newest 4.x release.`,
  );
  const listed = npmView(["wrangler", "versions", "--json"]);
  if (listed === undefined) {
    return undefined;
  }
  let versions;
  try {
    versions = JSON.parse(listed);
  } catch {
    return undefined;
  }
  if (!Array.isArray(versions)) {
    return undefined;
  }
  const stableFour = versions.filter(
    (version) => typeof version === "string" && /^4\.\d+\.\d+$/.test(version),
  );
  if (stableFour.length === 0) {
    return undefined;
  }
  return stableFour.sort(compareVersions).at(-1);
}

function install(version, { omitOptional }) {
  if (!omitOptional) {
    // npm keeps the lean install's hidden lockfile and would report "up to date" without the
    // optional platform packages, so start from a clean tree for the fallback.
    rmSync(path.join(wranglerDir, "node_modules"), { recursive: true, force: true });
  }
  log(
    `Installing wrangler@${version} into ${wranglerDir}${
      omitOptional ? " (optional dependencies skipped)" : " with platform packages"
    }...`,
  );
  const args = [
    "install",
    "--prefix",
    wranglerDir,
    ...(omitOptional ? ["--omit=optional"] : []),
    "--no-save",
    "--ignore-scripts",
    `wrangler@${version}`,
  ];
  const result = runNpm(args, { stdio: "inherit", timeout: 0 });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`npm install exited with code ${String(result.status)}.`);
  }
}

function verifyCli() {
  const result = spawnSync(process.execPath, [cliPath, "pages", "deploy", "--help"], {
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  if (result.error) {
    warn(`Could not run the Wrangler CLI check: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    warn(
      `Wrangler CLI check failed (exit ${String(result.status)}).\n${
        result.stderr?.trim() || result.stdout?.trim() || ""
      }`,
    );
    return false;
  }
  log("Wrangler CLI check passed: `wrangler pages deploy --help` exited 0.");
  return true;
}

function writeCliConfig(version) {
  writeFileSync(
    cliJsonPath,
    `${JSON.stringify(
      {
        version,
        cliPath: CLI_RELATIVE_PATH,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function main() {
  const installed = readInstalledConfig();
  if (
    installed?.version === PINNED_VERSION &&
    existsSync(cliPath) &&
    (installed.cliPath === undefined || installed.cliPath === CLI_RELATIVE_PATH)
  ) {
    log(`Wrangler ${PINNED_VERSION} is already installed; skipping download.`);
    reportInstalled(PINNED_VERSION);
    return;
  }

  let version;
  try {
    version = resolveVersion();
  } catch (error) {
    warn(
      `Could not check npm for Wrangler (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (version === undefined) {
    warn(
      "Wrangler is unavailable (offline or npm error). Publishing will report WRANGLER_MISSING until it is fetched.",
    );
    return;
  }

  try {
    install(version, { omitOptional: true });
    if (!existsSync(cliPath)) {
      warn(`npm finished but ${cliPath} is missing; not marking Wrangler as installed.`);
      return;
    }
    if (!verifyCli()) {
      // Wrangler 4.x loads miniflare (and so workerd) even for `--help`, so a lean install cannot
      // start. The platform binary is required to run Wrangler at all; reinstall with it.
      warn(
        "The lean install cannot start Wrangler: its CLI eagerly loads workerd/esbuild, whose platform packages are optional dependencies. Reinstalling with platform packages.",
      );
      install(version, { omitOptional: false });
      if (!existsSync(cliPath)) {
        warn(`npm finished but ${cliPath} is missing; not marking Wrangler as installed.`);
        return;
      }
      if (!verifyCli()) {
        warn("Wrangler did not pass its self-check; publishing will retry the install next build.");
        return;
      }
    }
  } catch (error) {
    warn(
      `Could not install Wrangler (${error instanceof Error ? error.message : String(error)}). Publishing will report WRANGLER_MISSING.`,
    );
    return;
  }

  writeCliConfig(version);
  reportInstalled(version);
}

try {
  main();
  process.exitCode = 0;
} catch (error) {
  warn(`Unexpected failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 0;
}
