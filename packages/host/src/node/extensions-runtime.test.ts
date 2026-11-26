import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionsLoadedError, setExtensionsRuntime } from "./extensions-runtime";
import { HostServiceImpl } from "./host-service";

describe("becoming the host while extensions are loaded (design section 11, item 6)", () => {
  const services: HostServiceImpl[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    setExtensionsRuntime(undefined);
    for (const service of services.splice(0)) service.dispose();
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Windows may hold the SQLite files briefly; the OS cleans temp folders.
      }
    }
  });
  const setup = (): { service: HostServiceImpl; dir: string } => {
    const service = new HostServiceImpl();
    services.push(service);
    const dir = mkdtempSync(path.join(os.tmpdir(), "simpletab-ext-host-"));
    dirs.push(dir);
    return { service, dir };
  };

  it("refuses to open, create or seed a tournament while extensions are loaded and developer mode is off", async () => {
    const { service, dir } = setup();
    setExtensionsRuntime({ loaded: ["pub.one@1.0.0"], developerModeNow: () => false });
    await expect(service.createDemoTournament(dir)).rejects.toBeInstanceOf(ExtensionsLoadedError);
    await expect(service.openTournament(path.join(dir, "x.simpletab.db"))).rejects.toThrow(/Restart SimpleTab/);
    await expect(
      service.createTournament({ name: "T", slug: "t", format: "bp", presetId: "bp", prelimRounds: 3, directory: dir }),
    ).rejects.toThrow(/pub\.one@1\.0\.0/);
    expect((await service.status()).open).toBe(false);
  });

  it("allows it with developer mode on, and reports the loaded extensions in the status", async () => {
    const { service, dir } = setup();
    let developerMode = false;
    setExtensionsRuntime({ loaded: ["pub.one@1.0.0"], developerModeNow: () => developerMode });
    developerMode = true;
    const created = await service.createDemoTournament(dir);
    expect(created.status.open).toBe(true);
    expect(created.status.extensionsLoaded).toEqual(["pub.one@1.0.0"]);
  });

  it("changes nothing when no extensions are loaded", async () => {
    const { service, dir } = setup();
    setExtensionsRuntime({ loaded: [], developerModeNow: () => false });
    const created = await service.createDemoTournament(dir);
    expect(created.status.open).toBe(true);
    expect(created.status.extensionsLoaded).toBeUndefined();
  });
});
