import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CURATED_EXTENSIONS, curatedListProblems, vsixFileName, type CuratedExtension } from "./curated-list";
import { readDeveloperMode } from "./developer-mode-setting";
import { readOffIds, scanStore, writeOffIds } from "./extension-store";
import { decideLoading } from "./loading-rule";
import { planStartup } from "./simpletab-deployer-participant";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "simpletab-ext-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function entry(id: string, bytes: string): CuratedExtension {
  const version = "1.0.0";
  return {
    id,
    version,
    url: `https://open-vsx.org/api/${id.replace(".", "/")}/${version}/file/${id}-${version}.vsix`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    license: "MIT",
    name: id,
    purpose: "test",
  };
}

/** A store folder with these files; returns the list entries for the given ids. */
function storeWith(files: Record<string, string>): string {
  const dir = tempDir();
  for (const [name, bytes] of Object.entries(files)) writeFileSync(path.join(dir, name), bytes);
  return dir;
}

describe("the curated list", () => {
  it("ships a valid list: publisher.name ids, pinned versions, SHA-256 and Open VSX urls", () => {
    expect(curatedListProblems(CURATED_EXTENSIONS)).toEqual([]);
    expect(CURATED_EXTENSIONS.map((item) => item.id)).toEqual([
      "mechatroner.rainbow-csv",
      "janisdd.vscode-edit-csv",
      "GrapeCity.gc-excelviewer",
      "vscode.markdown",
      "streetsidesoftware.code-spell-checker",
    ]);
  });

  it("reports every problem in a bad list", () => {
    const good = entry("pub.one", "x");
    const problems = curatedListProblems([
      good,
      { ...good },
      { ...entry("bad id", "y"), sha256: "ABC", version: "1.0", url: "https://example.com/a.vsix", purpose: " " },
    ]);
    expect(problems.join("\n")).toMatch(/listed twice/);
    expect(problems.join("\n")).toMatch(/publisher\.name/);
    expect(problems.join("\n")).toMatch(/x\.y\.z/);
    expect(problems.join("\n")).toMatch(/64 lower-case hex/);
    expect(problems.join("\n")).toMatch(/Open VSX file/);
    expect(problems.join("\n")).toMatch(/purpose is empty/);
  });
});

describe("SimpleTab's extension folder", () => {
  it("accepts only listed files whose hash matches, re-hashing each one", () => {
    const one = entry("pub.one", "one");
    const two = entry("pub.two", "two");
    const dir = storeWith({
      [vsixFileName(one)]: "one",
      [vsixFileName(two)]: "tampered",
      "pub.three-1.0.0.vsix": "three",
      "notes.txt": "ignored",
    });
    const scan = scanStore(dir, [one, two]);
    expect(scan.verified.map((item) => item.id)).toEqual(["pub.one"]);
    expect(scan.rejected).toEqual([
      { file: "pub.three-1.0.0.vsix", reason: "not-listed" },
      { file: vsixFileName(two), reason: "hash-mismatch" },
    ]);
  });

  it("keeps the extensions turned off, and survives a damaged state file", () => {
    const dir = tempDir();
    expect(readOffIds(dir)).toEqual([]);
    writeOffIds(dir, ["pub.two", "pub.one", "pub.two"]);
    expect(readOffIds(dir)).toEqual(["pub.one", "pub.two"]);
    writeFileSync(path.join(dir, "state.json"), "{ not json");
    expect(readOffIds(dir)).toEqual([]);
    expect(scanStore(path.join(dir, "missing"), []).verified).toEqual([]);
  });
});

describe("which extensions load", () => {
  const one = entry("pub.one", "one");
  const two = entry("pub.two", "two");

  it("loads none on a laptop that may host, unless developer mode is on", () => {
    expect(decideLoading({ pairedAsStaffDevice: false, developerMode: false, verified: [one], off: [] })).toEqual({
      reason: "may-host",
      load: [],
    });
    expect(decideLoading({ pairedAsStaffDevice: false, developerMode: true, verified: [one], off: [] })).toEqual({
      reason: "developer-mode",
      load: [one],
    });
  });

  it("loads verified, turned-on extensions on a staff device", () => {
    expect(
      decideLoading({ pairedAsStaffDevice: true, developerMode: false, verified: [one, two], off: ["PUB.TWO"] }),
    ).toEqual({ reason: "staff-device", load: [one] });
  });

  it("reads developer mode from the user's settings file, comments and all", () => {
    const dir = tempDir();
    expect(readDeveloperMode(dir)).toBe(false);
    writeFileSync(path.join(dir, "settings.json"), '{\n  // set from the app\n  "simpletab.developerMode": true,\n}');
    expect(readDeveloperMode(dir)).toBe(true);
    writeFileSync(path.join(dir, "settings.json"), '{ "simpletab.developerMode": "yes" }');
    expect(readDeveloperMode(dir)).toBe(false);
  });

  it("plans start-up: local-file entries for what loads, and a live developer-mode check", () => {
    const configDir = tempDir();
    const extensionsDir = storeWith({ [vsixFileName(one)]: "one", "stray-9.9.9.vsix": "x" });

    const host = planStartup({ configDir, extensionsDir, list: [one], pairedAsStaffDevice: false });
    expect(host.decision.reason).toBe("may-host");
    expect(host.entries).toEqual([]);
    expect(host.runtime.loaded).toEqual([]);
    expect(host.rejected).toEqual([{ file: "stray-9.9.9.vsix", reason: "not-listed" }]);

    const staff = planStartup({ configDir, extensionsDir, list: [one], pairedAsStaffDevice: true });
    expect(staff.runtime.loaded).toEqual(["pub.one@1.0.0"]);
    expect(staff.entries).toHaveLength(1);
    expect(staff.entries[0]).toMatch(/^local-file:.*pub\.one-1\.0\.0\.vsix$/);

    expect(staff.runtime.developerModeNow()).toBe(false);
    writeFileSync(path.join(configDir, "settings.json"), '{ "simpletab.developerMode": true }');
    expect(staff.runtime.developerModeNow()).toBe(true);
  });

  it("refuses to plan with a broken list", () => {
    expect(() =>
      planStartup({ configDir: tempDir(), extensionsDir: tempDir(), list: [{ ...one, sha256: "x" }], pairedAsStaffDevice: true }),
    ).toThrow(/extension list is invalid/);
  });
});
