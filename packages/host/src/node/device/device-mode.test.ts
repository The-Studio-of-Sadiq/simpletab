import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import { parseHostAddress } from "./device-mode";
import { PairingStore, PAIRING_FILE_NAME, type StoredPairing } from "./pairing-store";

describe("parseHostAddress", () => {
  it("accepts what the Devices page shows, with or without a port", () => {
    expect(parseHostAddress("192.168.1.20:47820")).toEqual({ ok: true, url: "wss://192.168.1.20:47820" });
    expect(parseHostAddress(" 192.168.1.20 ")).toEqual({ ok: true, url: "wss://192.168.1.20:47820" });
    expect(parseHostAddress("wss://tab-laptop.local:5000/")).toEqual({ ok: true, url: "wss://tab-laptop.local:5000" });
    expect(parseHostAddress("[fe80::1]:6000")).toEqual({ ok: true, url: "wss://[fe80::1]:6000" });
  });

  it("explains bad input", () => {
    expect(parseHostAddress("")).toMatchObject({ ok: false, error: expect.stringMatching(/Enter the host's address/) });
    expect(parseHostAddress("http://x y")).toMatchObject({ ok: false });
    expect(parseHostAddress("host:99999")).toMatchObject({ ok: false, error: expect.stringMatching(/port/) });
  });
});

describe("PairingStore", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const pairing: StoredPairing = {
    version: 1,
    url: "wss://192.168.1.20:47820",
    deviceId: "dev-1",
    deviceName: "Rafi's laptop",
    role: BUILT_IN_ROLES.tab_director,
    hostFingerprint: "a".repeat(64),
    host: { hostNumber: 1, hostId: "host-1", hostRank: 1, certFingerprint: "a".repeat(64) },
    certificate: { certPem: "CERT", keyPem: "-----BEGIN PRIVATE KEY-----", fingerprint: "b".repeat(64) },
    pairedAt: "2026-11-25T10:00:00.000Z",
  };

  it("saves, loads and clears one pairing, owner-only where the platform allows", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "simpletab-pairing-"));
    dirs.push(dir);
    const store = new PairingStore(dir);
    expect(store.load()).toBeUndefined();
    store.save(pairing);
    expect(store.load()).toEqual(pairing);
    if (process.platform !== "win32") {
      expect(statSync(path.join(dir, PAIRING_FILE_NAME)).mode & 0o077).toBe(0);
    }
    store.clear();
    expect(store.load()).toBeUndefined();
  });

  it("ignores a damaged file instead of trusting it", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "simpletab-pairing-"));
    dirs.push(dir);
    const store = new PairingStore(dir);
    store.save({ ...pairing, url: "http://not-secure" });
    expect(store.load()).toBeUndefined();
  });
});
