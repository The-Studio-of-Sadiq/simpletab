import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionsLoadingReason } from "../common/extensions-protocol";
import { vsixFileName, type CuratedExtension } from "./curated-list";
import { ExtensionsServiceImpl } from "./extensions-service";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "simpletab-ext-svc-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BYTES: Record<string, string> = { "pub.one": "one-bytes", "pub.two": "two-bytes" };

function entry(id: string): CuratedExtension {
  return {
    id,
    version: "1.0.0",
    url: `https://open-vsx.org/api/${id.replace(".", "/")}/1.0.0/file/${id}-1.0.0.vsix`,
    sha256: createHash("sha256").update(BYTES[id]!).digest("hex"),
    license: "MIT",
    name: id.toUpperCase(),
    purpose: "test",
  };
}

function service(options: {
  paired?: boolean;
  developerMode?: boolean;
  loaded?: string[];
  startupReason?: ExtensionsLoadingReason | null;
  download?: (url: string) => Promise<Uint8Array>;
} = {}) {
  const extensionsDir = tempDir();
  const configDir = tempDir();
  if (options.developerMode === true) {
    writeFileSync(path.join(configDir, "settings.json"), '{ "simpletab.developerMode": true }');
  }
  const downloads: string[] = [];
  const impl = new ExtensionsServiceImpl({
    list: [entry("pub.one"), entry("pub.two")],
    extensionsDir,
    configDir: async () => configDir,
    pairedAsStaffDevice: () => options.paired === true,
    loaded: () => options.loaded ?? [],
    startupReason: () => options.startupReason ?? "may-host",
    download:
      options.download ??
      (async (url) => {
        downloads.push(url);
        const id = Object.keys(BYTES).find((key) => url.includes(`${key}-1.0.0`))!;
        return new TextEncoder().encode(BYTES[id]);
      }),
  });
  return { impl, extensionsDir, downloads };
}

describe("the extensions service", () => {
  it("downloads the pinned file and keeps it only when its checksum matches", async () => {
    const { impl, extensionsDir, downloads } = service({ paired: true });
    const result = await impl.install("PUB.ONE");
    expect(result.ok).toBe(true);
    expect(downloads).toEqual([entry("pub.one").url]);
    expect(readdirSync(extensionsDir)).toEqual([vsixFileName(entry("pub.one"))]);
    if (result.ok) {
      expect(result.status.extensions.map((item) => [item.id, item.installed, item.on, item.loaded])).toEqual([
        ["pub.one", true, true, false],
        ["pub.two", false, true, false],
      ]);
      expect(result.status.reason).toBe("staff-device");
      expect(result.status.restartNeeded).toBe(true);
    }
  });

  it("refuses a download whose checksum does not match, and leaves no file", async () => {
    const { impl, extensionsDir } = service({ download: async () => new TextEncoder().encode("tampered") });
    const result = await impl.install("pub.one");
    expect(result).toMatchObject({ ok: false, code: "HASH_MISMATCH" });
    expect(existsSync(extensionsDir) ? readdirSync(extensionsDir) : []).toEqual([]);
  });

  it("reports a failed download and an unlisted id", async () => {
    const { impl } = service({ download: async () => { throw new Error("offline"); } });
    expect(await impl.install("pub.one")).toMatchObject({ ok: false, code: "DOWNLOAD_FAILED" });
    expect(await impl.install("someone.else")).toMatchObject({ ok: false, code: "NOT_LISTED" });
  });

  it("installs a chosen file by its checksum, whatever its name, and refuses any other file", async () => {
    const { impl, extensionsDir } = service();
    const picked = path.join(tempDir(), "download (1).vsix");
    writeFileSync(picked, BYTES["pub.two"]!);
    expect((await impl.installFromFile(picked)).ok).toBe(true);
    expect(readdirSync(extensionsDir)).toEqual([vsixFileName(entry("pub.two"))]);

    const other = path.join(tempDir(), "other.vsix");
    writeFileSync(other, "not listed");
    expect(await impl.installFromFile(other)).toMatchObject({ ok: false, code: "HASH_MISMATCH" });
    expect(await impl.installFromFile(path.join(tempDir(), "missing.vsix"))).toMatchObject({
      ok: false,
      code: "FILE_UNREADABLE",
    });
  });

  it("turns an installed extension off and on, and removes it", async () => {
    const { impl, extensionsDir } = service({
      developerMode: true,
      loaded: ["pub.one@1.0.0"],
      startupReason: "developer-mode",
    });
    await impl.install("pub.one");
    let status = await impl.status();
    expect(status.reason).toBe("developer-mode");
    expect(status.restartNeeded).toBe(false);

    const off = await impl.setOn("pub.one", false);
    expect(off.ok && off.status.extensions[0]!.on).toBe(false);
    expect(off.ok && off.status.restartNeeded).toBe(true);
    const on = await impl.setOn("pub.one", true);
    expect(on.ok && on.status.restartNeeded).toBe(false);

    expect(await impl.setOn("pub.two", true)).toMatchObject({ ok: false, code: "NOT_INSTALLED" });
    await impl.setOn("pub.one", false);
    expect((await impl.remove("pub.one")).ok).toBe(true);
    expect(readdirSync(extensionsDir)).toEqual(["state.json"]);
    status = await impl.status();
    expect(status.extensions[0]).toMatchObject({ installed: false, on: true });
    expect(await impl.remove("pub.one")).toMatchObject({ ok: false, code: "NOT_INSTALLED" });
  });

  it("needs no restart on a laptop that may host: nothing loads either way", async () => {
    const { impl } = service();
    await impl.install("pub.one");
    const status = await impl.status();
    expect(status.reason).toBe("may-host");
    expect(status.restartNeeded).toBe(false);
  });
});
