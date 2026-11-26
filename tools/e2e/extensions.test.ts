import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import semver from "semver";
import { afterAll, describe, expect, it } from "vitest";
import { CURATED_EXTENSIONS, vsixFileName } from "../../packages/extensions/src/node/curated-list";
import { scanStore } from "../../packages/extensions/src/node/extension-store";
import { ExtensionsServiceImpl } from "../../packages/extensions/src/node/extensions-service";
import { planStartup } from "../../packages/extensions/src/node/simpletab-deployer-participant";
import { ExtensionsLoadedError, setExtensionsRuntime } from "../../packages/host/src/node/extensions-runtime";
import { HostServiceImpl } from "../../packages/host/src/node/host-service";

/**
 * M9 checkpoint (`npm run e2e:extensions`, design section 11 item 6), using the saved copies of
 * the curated extensions that `npm run fetch:extensions` keeps in `tools/e2e/fixtures/extensions`
 * (out of git). Passes when:
 * - every listed extension installs through the extensions service with a matching SHA-256, both
 *   "from Open VSX" (the service's download step reads the saved copy) and from a chosen file;
 * - each file is the extension the list claims (id and version in its package.json) and needs no
 *   newer VS Code API than Theia 1.77 provides (1.144);
 * - all of them load on a staff laptop and with developer mode on, and none on a laptop that may
 *   host; a laptop with them loaded refuses to open or create a tournament unless developer mode
 *   is on;
 * - a file whose bytes differ from the list is refused, and one dropped in the folder is ignored.
 * Whether each extension works in the app is the manual check `docs/checks/M9.md`.
 */

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/extensions");
const THEIA_VSCODE_API = "1.144.0";
const saved = (id: string, version: string): string => path.join(FIXTURES, `${id}-${version}.vsix`);
const missing = CURATED_EXTENSIONS.filter((entry) => !existsSync(saved(entry.id, entry.version)));

if (missing.length > 0) {
  // `npm test` runs without the network; the checkpoint script fetches the copies first.
  console.warn(
    `e2e:extensions skipped: run "npm run fetch:extensions" (missing ${missing.map((entry) => entry.id).join(", ")}).`,
  );
}

describe.skipIf(missing.length > 0)("M9 curated extensions checkpoint", () => {
  const dirs: string[] = [];
  const hosts: HostServiceImpl[] = [];
  const tempDir = (label: string): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), `simpletab-m9-${label}-`));
    dirs.push(dir);
    return dir;
  };
  afterAll(() => {
    setExtensionsRuntime(undefined);
    for (const host of hosts) host.dispose();
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Windows can hold SQLite files briefly; the OS cleans temp folders.
      }
    }
  });

  const service = (extensionsDir: string, configDir: string, paired = false) =>
    new ExtensionsServiceImpl({
      list: CURATED_EXTENSIONS,
      extensionsDir,
      configDir: async () => configDir,
      pairedAsStaffDevice: () => paired,
      loaded: () => [],
      startupReason: () => null,
      // "From Open VSX": the saved copy of exactly that URL.
      download: async (url) => {
        const entry = CURATED_EXTENSIONS.find((item) => item.url === url);
        if (entry === undefined) throw new Error(`not a listed url: ${url}`);
        return readFileSync(saved(entry.id, entry.version));
      },
    });

  it("each saved file is the listed extension, for a VS Code API Theia 1.77 provides", () => {
    for (const entry of CURATED_EXTENSIONS) {
      const bytes = readFileSync(saved(entry.id, entry.version));
      expect(createHash("sha256").update(bytes).digest("hex"), entry.id).toBe(entry.sha256);
      const files = unzipSync(bytes, { filter: (file) => file.name === "extension/package.json" });
      const manifest = JSON.parse(new TextDecoder().decode(files["extension/package.json"])) as {
        publisher: string;
        name: string;
        version: string;
        engines: { vscode: string };
      };
      expect(`${manifest.publisher}.${manifest.name}`.toLowerCase(), entry.id).toBe(entry.id.toLowerCase());
      expect(manifest.version, entry.id).toBe(entry.version);
      expect(semver.satisfies(THEIA_VSCODE_API, manifest.engines.vscode), `${entry.id} needs ${manifest.engines.vscode}`).toBe(true);
    }
  });

  it("installs every listed extension, from Open VSX and from a file, only with a matching checksum", async () => {
    const fromVsx = service(tempDir("vsx"), tempDir("cfg"));
    for (const entry of CURATED_EXTENSIONS) {
      expect(await fromVsx.install(entry.id), entry.id).toMatchObject({ ok: true });
    }
    const status = await fromVsx.status();
    expect(status.extensions.every((item) => item.installed && item.on)).toBe(true);

    const fileDir = tempDir("file");
    const fromFile = service(fileDir, tempDir("cfg"));
    const picked = tempDir("picked");
    for (const entry of CURATED_EXTENSIONS) {
      // A downloaded file often has another name; the checksum decides.
      const copy = path.join(picked, `download-${entry.version}.vsix`);
      copyFileSync(saved(entry.id, entry.version), copy);
      expect(await fromFile.installFromFile(copy), entry.id).toMatchObject({ ok: true });
    }
    expect(scanStore(fileDir, CURATED_EXTENSIONS).verified).toHaveLength(CURATED_EXTENSIONS.length);
  });

  it("refuses a changed file, and ignores one dropped into the folder", async () => {
    const extensionsDir = tempDir("tamper");
    const svc = service(extensionsDir, tempDir("cfg"), true);
    const entry = CURATED_EXTENSIONS[0]!;
    const bytes = Buffer.from(readFileSync(saved(entry.id, entry.version)));
    bytes[bytes.length - 10] ^= 0xff;
    const changed = path.join(tempDir("changed"), vsixFileName(entry));
    writeFileSync(changed, bytes);
    expect(await svc.installFromFile(changed)).toMatchObject({ ok: false, code: "HASH_MISMATCH" });

    // Copied straight into SimpleTab's folder under the right name: still not loaded.
    mkdirSync(extensionsDir, { recursive: true });
    copyFileSync(changed, path.join(extensionsDir, vsixFileName(entry)));
    const plan = planStartup({ configDir: tempDir("cfg"), extensionsDir, list: CURATED_EXTENSIONS, pairedAsStaffDevice: true });
    expect(plan.entries).toEqual([]);
    expect(plan.rejected).toEqual([{ file: vsixFileName(entry), reason: "hash-mismatch" }]);
  });

  it("loads them on a staff laptop or with developer mode, never on a laptop that may host", async () => {
    const extensionsDir = tempDir("load");
    const svc = service(extensionsDir, tempDir("cfg"));
    for (const entry of CURATED_EXTENSIONS) await svc.install(entry.id);
    // Loaded in the folder's file order, so compared as sets.
    const all = CURATED_EXTENSIONS.map((entry) => `${entry.id}@${entry.version}`).sort();

    const host = planStartup({ configDir: tempDir("cfg"), extensionsDir, list: CURATED_EXTENSIONS, pairedAsStaffDevice: false });
    expect(host.decision.reason).toBe("may-host");
    expect(host.entries).toEqual([]);

    const staff = planStartup({ configDir: tempDir("cfg"), extensionsDir, list: CURATED_EXTENSIONS, pairedAsStaffDevice: true });
    expect([...staff.runtime.loaded].sort()).toEqual(all);
    expect(staff.entries).toHaveLength(all.length);

    const devConfig = tempDir("dev");
    writeFileSync(path.join(devConfig, "settings.json"), '{ "simpletab.developerMode": true }');
    const developer = planStartup({ configDir: devConfig, extensionsDir, list: CURATED_EXTENSIONS, pairedAsStaffDevice: false });
    expect(developer.decision.reason).toBe("developer-mode");
    expect([...developer.runtime.loaded].sort()).toEqual(all);

    // With them loaded, this laptop may host only while developer mode stays on.
    const hostService = new HostServiceImpl();
    hosts.push(hostService);
    setExtensionsRuntime(developer.runtime);
    writeFileSync(path.join(devConfig, "settings.json"), '{ "simpletab.developerMode": false }');
    await expect(hostService.createDemoTournament(tempDir("demo"))).rejects.toBeInstanceOf(ExtensionsLoadedError);
    writeFileSync(path.join(devConfig, "settings.json"), '{ "simpletab.developerMode": true }');
    const created = await hostService.createDemoTournament(tempDir("demo"));
    expect([...(created.status.extensionsLoaded ?? [])].sort()).toEqual(all);
  });
});
