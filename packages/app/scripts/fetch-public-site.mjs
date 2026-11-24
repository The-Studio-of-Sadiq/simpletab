// Fetches the pinned `simpletab-public` site into resources/public-site (file plan row 36).
//
// - SIMPLETAB_PUBLIC_SITE_DIR set: copy that directory (local development of the public app).
// - pin url set: download the zip, verify its SHA-256, unzip.
// - otherwise: write a stub index.html, so M1–M3 builds work before the public app is released.
// The script never fails a build; missing network or tooling falls back to the stub.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STUB_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SimpleTab public site</title>
  </head>
  <body>
    <main>
      <h1>Public site not built yet</h1>
      <p>This build does not include the published results site.</p>
    </main>
  </body>
</html>
`;

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resourcesDir = path.join(appDir, "resources");
const pinPath = path.join(resourcesDir, "public-site.pin.json");
const targetDir = path.join(resourcesDir, "public-site");
const markerPath = path.join(targetDir, ".installed.json");

function log(message) {
  console.log(`[fetch-public-site] ${message}`);
}

function warn(message) {
  console.warn(`[fetch-public-site] WARNING: ${message}`);
}

function readPin() {
  if (!existsSync(pinPath)) {
    warn(`Pin file ${pinPath} is missing; using the stub site.`);
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(pinPath, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch (error) {
    warn(`Pin file ${pinPath} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
    return undefined;
  }
}

function readMarker() {
  if (!existsSync(markerPath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeMarker(value) {
  writeFileSync(markerPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeStub(reason) {
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(path.join(targetDir, "index.html"), STUB_HTML, "utf8");
  writeMarker({ kind: "stub", reason, installedAt: new Date().toISOString() });
  log(`Wrote the stub public site to ${targetDir} (${reason}).`);
}

function hasInstalledSite() {
  return existsSync(path.join(targetDir, "index.html"));
}

function copyFromEnvDir(sourceDir) {
  if (!existsSync(sourceDir)) {
    warn(`SIMPLETAB_PUBLIC_SITE_DIR points at ${sourceDir}, which does not exist.`);
    return false;
  }
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true });
  writeMarker({
    kind: "local",
    source: sourceDir,
    installedAt: new Date().toISOString(),
  });
  log(`Copied the local public site from ${sourceDir}.`);
  return true;
}

async function downloadAndExtract(pin) {
  log(`Downloading ${pin.url} ...`);
  const response = await fetch(pin.url);
  if (!response.ok) {
    throw new Error(`download failed with HTTP ${response.status}`);
  }
  const archive = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(archive).digest("hex");
  if (typeof pin.sha256 === "string" && pin.sha256.length > 0 && sha256 !== pin.sha256.toLowerCase()) {
    throw new Error(`SHA-256 mismatch: expected ${pin.sha256}, got ${sha256}`);
  }

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "simpletab-public-site-"));
  const archivePath = path.join(tempRoot, "site.zip");
  const extractDir = path.join(tempRoot, "extract");
  writeFileSync(archivePath, archive);
  mkdirSync(extractDir, { recursive: true });

  try {
    if (process.platform === "win32") {
      const zipPath = archivePath.replaceAll("'", "''");
      const destination = extractDir.replaceAll("'", "''");
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destination}' -Force`,
        ],
        { encoding: "utf8", timeout: 180_000 },
      );
      if (result.error) {
        throw result.error;
      }
      if (result.status !== 0) {
        throw new Error(result.stderr?.trim() || `Expand-Archive exited ${String(result.status)}`);
      }
    } else {
      const result = spawnSync("unzip", ["-q", archivePath, "-d", extractDir], {
        encoding: "utf8",
        timeout: 180_000,
      });
      if (result.error) {
        throw result.error;
      }
      if (result.status !== 0) {
        throw new Error(result.stderr?.trim() || `unzip exited ${String(result.status)}`);
      }
    }

    const entries = readdirSync(extractDir, { withFileTypes: true });
    const singleDir =
      entries.length === 1 && entries[0]?.isDirectory() ? path.join(extractDir, entries[0].name) : undefined;
    const contentDir =
      singleDir !== undefined && !existsSync(path.join(extractDir, "index.html"))
        ? singleDir
        : extractDir;

    rmSync(targetDir, { recursive: true, force: true });
    cpSync(contentDir, targetDir, { recursive: true });
    writeMarker({
      kind: "release",
      version: pin.version,
      sha256,
      installedAt: new Date().toISOString(),
    });
    log(`Installed public site ${String(pin.version)} (SHA-256 ${sha256}).`);
    return true;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const pin = readPin();
  const localSiteDir = process.env.SIMPLETAB_PUBLIC_SITE_DIR?.trim();

  if (localSiteDir !== undefined && localSiteDir.length > 0) {
    if (copyFromEnvDir(path.resolve(localSiteDir))) {
      return;
    }
  }

  const url = typeof pin?.url === "string" ? pin.url.trim() : "";
  if (url.length === 0) {
    if (hasInstalledSite()) {
      log("A public site (or stub) is already in place; skipping.");
      return;
    }
    writeStub("no published release is pinned yet");
    return;
  }

  const marker = readMarker();
  const pinnedSha = typeof pin?.sha256 === "string" ? pin.sha256.toLowerCase() : "";
  if (
    marker?.kind === "release" &&
    marker.version === pin?.version &&
    marker.sha256 === pinnedSha &&
    existsSync(path.join(targetDir, "index.html"))
  ) {
    log(`Public site ${String(pin?.version)} is already installed; skipping.`);
    return;
  }

  try {
    await downloadAndExtract(pin);
  } catch (error) {
    warn(
      `Could not fetch the public site (${error instanceof Error ? error.message : String(error)}).`,
    );
    writeStub("download failed");
  }
}

try {
  await main();
  process.exitCode = 0;
} catch (error) {
  warn(`Unexpected failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  try {
    writeStub("unexpected failure");
  } catch (stubError) {
    warn(`Could not write the stub site (${stubError instanceof Error ? stubError.message : String(stubError)}).`);
  }
  process.exitCode = 0;
}
