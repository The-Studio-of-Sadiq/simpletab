import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostServiceImpl } from "./host-service";

describe("HostServiceImpl", () => {
  const tempDirs: string[] = [];
  const services: HostServiceImpl[] = [];

  function createService(): HostServiceImpl {
    const service = new HostServiceImpl();
    services.push(service);
    return service;
  }

  afterEach(async () => {
    for (const service of services.splice(0)) {
      await service.onStop();
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports closed status initially", async () => {
    const service = createService();
    const status = await service.status();
    expect(status).toEqual({
      open: false,
      locks: [],
    });
  });

  it("creates, seeds, and reopens a demo BP tournament", async () => {
    const service = createService();
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "simpletab-host-svc-"));
    tempDirs.push(tempDir);

    const created = await service.createDemoTournament(tempDir);
    expect(created.dbPath).toBe(path.join(tempDir, "bp-demo.simpletab.db"));
    expect(created.status.open).toBe(true);
    expect(created.status.slug).toBe("bp-demo");
    expect(created.status.headSeq).toBe(5);
    expect(created.status.integrityOk).toBe(true);
    expect(created.status.canSync).toBe(true);
    expect(created.status.locks).toEqual([]);

    const reopened = await service.openTournament(created.dbPath);
    expect(reopened).toEqual(created.status);
  });
});
