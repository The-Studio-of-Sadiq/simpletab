import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CredentialName, SmtpCredentialPayload } from "../common/credentials-protocol";
import { CredentialsVault, validateCredentialFormat } from "./credentials-store";

const mockUserDataState = vi.hoisted(() => ({
  dir: "",
  encryptionAvailable: true,
}));

vi.mock("@theia/electron/shared/electron", () => ({
  app: {
    getPath: (_name: string) => mockUserDataState.dir,
    quit: vi.fn(),
    exit: vi.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: () => mockUserDataState.encryptionAvailable,
    encryptString: (plain: string) =>
      Buffer.from(`ENC:${Buffer.from(plain, "utf8").toString("base64")}`, "utf8"),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString("utf8");
      if (!text.startsWith("ENC:")) {
        throw new Error("Bad ciphertext");
      }
      return Buffer.from(text.slice(4), "base64").toString("utf8");
    },
  },
}));

import { ElectronCredentialsService } from "./credentials";

describe("ElectronCredentialsService & CredentialsVault", () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "simpletab-creds-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    mockUserDataState.encryptionAvailable = true;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("encrypts secrets at rest, reports set/not-set, tests offline format, and never returns secrets on RPC surface", async () => {
    const rootDir = makeTempDir();
    mockUserDataState.dir = rootDir;

    const service = new ElectronCredentialsService();
    const protoMethods = Object.getOwnPropertyNames(
      ElectronCredentialsService.prototype,
    )
      .filter((name) => name !== "constructor")
      .sort();
    expect(protoMethods).toEqual(["clear", "set", "status", "test"]);

    const initialStatus = await service.status();
    expect(initialStatus).toHaveLength(5);
    expect(initialStatus.every((entry) => entry.set === false)).toBe(true);

    const secretToken = "super-secret-cdn-token-987654321";
    await service.set("cdnToken", secretToken);

    const encryptedFile = path.join(rootDir, "credentials", "cdnToken.enc");
    const rawDisk = readFileSync(encryptedFile, "utf8");
    expect(rawDisk).not.toContain(secretToken);

    const afterSetStatus = await service.status();
    expect(afterSetStatus.find((e) => e.name === "cdnToken")?.set).toBe(true);
    expect(JSON.stringify(afterSetStatus)).not.toContain(secretToken);

    const testPass = await service.test("cdnToken");
    expect(testPass).toEqual({ ok: true });
    expect(JSON.stringify(testPass)).not.toContain(secretToken);

    const afterTestStatus = await service.status();
    const cdnStatus = afterTestStatus.find((e) => e.name === "cdnToken");
    expect(cdnStatus?.set).toBe(true);
    expect(cdnStatus?.ok).toBe(true);
    expect(cdnStatus?.testedAt).toBeTruthy();
    expect(JSON.stringify(afterTestStatus)).not.toContain(secretToken);

    // Invalid short token fails test without echoing the secret
    const shortSecret = "bad-secret";
    await service.set("tournamentKey", shortSecret);
    const shortTest = await service.test("tournamentKey");
    expect(shortTest.ok).toBe(false);
    expect(shortTest.error).toBeTruthy();
    expect(JSON.stringify(shortTest)).not.toContain(shortSecret);
    expect(JSON.stringify(await service.status())).not.toContain(shortSecret);

    // Clear removes the secret and resets status
    await service.clear("cdnToken");
    const afterClear = await service.status();
    expect(afterClear.find((e) => e.name === "cdnToken")).toEqual({
      name: "cdnToken",
      set: false,
    });
  });

  it("validates SMTP JSON payloads and GitHub token format offline", async () => {
    const storageDir = path.join(makeTempDir(), "vault");
    const vault = new CredentialsVault({
      getStorageDir: () => storageDir,
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain, "utf8"),
      decryptString: (buf) => buf.toString("utf8"),
    });

    const validSmtp: SmtpCredentialPayload = {
      host: "smtp.example.org",
      port: 587,
      user: "mailer@example.org",
      password: "smtp-secret-password-123",
      from: "SimpleTab <noreply@example.org>",
    };
    await vault.set("smtp", JSON.stringify(validSmtp));
    expect(await vault.test("smtp")).toEqual({ ok: true });

    await vault.set("smtp", JSON.stringify({ ...validSmtp, from: "invalid-email" }));
    const badSmtpResult = await vault.test("smtp");
    expect(badSmtpResult.ok).toBe(false);
    expect(badSmtpResult.error).toContain("From");
    expect(badSmtpResult.error).not.toContain("smtp-secret-password-123");

    const names: CredentialName[] = [
      "tournamentKey",
      "cdnToken",
      "smtp",
      "ownWorkerToken",
      "githubToken",
    ];
    expect(validateCredentialFormat("githubToken", "github_pat_1234567890abcdef")).toEqual({
      ok: true,
    });
    expect(validateCredentialFormat("githubToken", "bad token with space").ok).toBe(
      false,
    );
    expect(names).toHaveLength(5);
  });
});
