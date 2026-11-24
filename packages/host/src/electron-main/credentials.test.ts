import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CredentialName, SmtpCredentialPayload } from "../common/credentials-protocol";
import { createTestCredentialsIpcBridge } from "../node/sync/credentials-ipc-client";
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
    expect(protoMethods).toEqual(["clear", "fetch", "set", "status", "test"]);

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

  it("injects Bearer key and host headers in electron-main fetch without exposing the secret over IPC", async () => {
    const storageDir = path.join(makeTempDir(), "vault-fetch");
    const secretKey = "tk_live_ultra_secret_key_99887766";
    const capturedFetches: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }> = [];

    const vault = new CredentialsVault({
      getStorageDir: () => storageDir,
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain, "utf8"),
      decryptString: (buf) => buf.toString("utf8"),
      defaultServiceBaseUrl: "https://ballots.example.org",
      fetchImpl: async (input, init) => {
        const hdrs: Record<string, string> = {};
        if (init?.headers && typeof init.headers === "object") {
          for (const [k, v] of Object.entries(
            init.headers as Record<string, string>,
          )) {
            hdrs[k] = v;
          }
        }
        capturedFetches.push({
          url: String(input),
          method: init?.method ?? "GET",
          headers: hdrs,
          ...(typeof init?.body === "string" ? { body: init.body } : {}),
        });
        return new Response(JSON.stringify({ schema: 1, ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            Date: "Tue, 24 Nov 2026 10:00:00 GMT",
          },
        });
      },
    });

    await vault.set("tournamentKey", secretKey);
    const bridge = createTestCredentialsIpcBridge(vault);
    try {
      const res = await bridge.client.fetch("tournamentKey", {
        method: "POST",
        path: "/v1/host/permits",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer spoofed-by-backend",
        },
        hostHeaders: {
          hostNumber: 3,
          hostId: "host-abc",
          hostRank: 1,
          requestId: "req-123",
        },
        body: JSON.stringify({ hello: "world" }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.date).toBe("Tue, 24 Nov 2026 10:00:00 GMT");
      expect(JSON.stringify(res)).not.toContain(secretKey);

      // Verify backend-side IPC message never carried or received Authorization or secretKey
      expect(bridge.sentRequests).toHaveLength(1);
      const sentReq = bridge.sentRequests[0]!;
      expect(sentReq.req.headers?.Authorization).toBeUndefined();
      expect(sentReq.req.headers?.authorization).toBeUndefined();
      expect(JSON.stringify(bridge.sentRequests)).not.toContain(secretKey);
      expect(JSON.stringify(bridge.receivedReplies)).not.toContain(secretKey);

      // Verify electron-main outgoing HTTP fetch had the real Bearer token and host headers
      expect(capturedFetches).toHaveLength(1);
      expect(capturedFetches[0]!.url).toBe(
        "https://ballots.example.org/v1/host/permits",
      );
      expect(capturedFetches[0]!.headers.Authorization).toBe(
        `Bearer ${secretKey}`,
      );
      expect(capturedFetches[0]!.headers["X-Host-Number"]).toBe("3");
      expect(capturedFetches[0]!.headers["X-Host-Id"]).toBe("host-abc");
      expect(capturedFetches[0]!.headers["X-Host-Rank"]).toBe("1");
      expect(capturedFetches[0]!.headers["X-Request-Id"]).toBe("req-123");
    } finally {
      bridge.dispose();
    }
  });
});
