import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { runScriptedDemo, type ScriptedDemoOptions } from "../../packages/host/src/node/demo/scripted-demo";

// M1 checkpoint: a whole tournament (prelims, break, elimination rounds, final) run through the host.
describe("M1 scripted demo", () => {
  const directories: string[] = [];
  const tempDir = (label: string): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), `simpletab-demo-${label}-`));
    directories.push(dir);
    return dir;
  };
  afterAll(() => {
    // Windows can briefly keep SQLite files locked after close; retry, and never fail the run on cleanup.
    for (const dir of directories) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Temp folders are left for the OS to clean if they are still locked.
      }
    }
  });

  const bp: Omit<ScriptedDemoOptions, "directory"> = {
    teamCount: 24,
    format: "bp",
    presetId: "bp",
    slug: "demo-bp",
    name: "Demo BP",
    seed: 4242,
    clock: new Date("2026-11-24T09:00:00.000Z"),
  };

  it("runs a BP tournament end to end, reproducibly, and survives a handover", async () => {
    const first = await runScriptedDemo({ ...bp, directory: tempDir("bp-1") });
    const second = await runScriptedDemo({ ...bp, directory: tempDir("bp-2") });

    expect(first.eliminationRoundsPlayed).toBeGreaterThan(0);
    // A handover file reproduces the tournament exactly.
    expect(first.stateHash).toBe(first.importedStateHash);
    // Same inputs and seeds give the same tournament. The changelog head is NOT compared: every
    // entry carries a random salt (design section 5), so heads differ between runs by design.
    expect(second.stateHash).toBe(first.stateHash);
  }, 300_000);

  it("runs a two-team (Australs) tournament end to end and survives a handover", async () => {
    const result = await runScriptedDemo({
      teamCount: 16,
      format: "two-team",
      presetId: "australs",
      slug: "demo-australs",
      name: "Demo Australs",
      seed: 4242,
      directory: tempDir("australs"),
      clock: new Date("2026-11-24T09:00:00.000Z"),
    });
    expect(result.eliminationRoundsPlayed).toBeGreaterThan(0);
    expect(result.stateHash).toBe(result.importedStateHash);
  }, 300_000);
});
