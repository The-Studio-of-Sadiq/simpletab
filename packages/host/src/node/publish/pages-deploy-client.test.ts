import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PagesDeployRequest } from "../../common/pages-deploy";
import type { ProcessResult, RunProcess, RunProcessOptions } from "../../electron-main/cloudflare-pages";
import { createTestPagesDeployIpcBridge } from "./pages-deploy-client";

const TOKEN = "cf-test-token-0123456789abcdef0123456789abcdef";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

describe("IpcPagesDeployer over the in-memory bridge", () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function makeSiteDir(): string {
    const dir = makeTempDir("simpletab-publish-site-");
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Site</title>");
    return dir;
  }

  function makeWranglerCli(): string {
    const dir = makeTempDir("simpletab-publish-wrangler-");
    const cli = path.join(dir, "wrangler.js");
    writeFileSync(cli, "// stub\n");
    return cli;
  }

  function makeRequest(dir: string): PagesDeployRequest {
    return { dir, accountId: ACCOUNT_ID, projectName: "wudc2027", branch: "main" };
  }

  function okProcess(stdout: string): ProcessResult {
    return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "" };
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips a deploy request and reply through IPC", async () => {
    let captured: RunProcessOptions | undefined;
    const runProcess: RunProcess = async (options) => {
      captured = options;
      return okProcess("✨ Deployment complete! https://abc123.wudc2027.pages.dev");
    };
    const bridge = createTestPagesDeployIpcBridge({
      getToken: async () => TOKEN,
      resourcesDir: makeTempDir("simpletab-publish-resources-"),
      wranglerCliPath: makeWranglerCli(),
      runProcess,
      timeoutMs: 5000,
    });

    try {
      const result = await bridge.deployer.deploy(makeRequest(makeSiteDir()));

      expect(result).toEqual({
        ok: true,
        deploymentUrl: "https://abc123.wudc2027.pages.dev",
        durationMs: expect.any(Number),
      });
      expect(bridge.sentRequests).toHaveLength(1);
      expect(bridge.sentRequests[0]?.req.projectName).toBe("wudc2027");
      expect(bridge.receivedReplies).toHaveLength(1);
      expect(captured?.env.CLOUDFLARE_API_TOKEN).toBe(TOKEN);
      expect(JSON.stringify(bridge.sentRequests)).not.toContain(TOKEN);
    } finally {
      bridge.dispose();
    }
  });

  it("rejects a second publish while one is already running", async () => {
    let release!: (result: ProcessResult) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runProcess: RunProcess = () =>
      new Promise<ProcessResult>((resolve) => {
        release = resolve;
        markStarted();
      });

    const bridge = createTestPagesDeployIpcBridge({
      getToken: async () => TOKEN,
      resourcesDir: makeTempDir("simpletab-publish-resources-"),
      wranglerCliPath: makeWranglerCli(),
      runProcess,
      timeoutMs: 5000,
    });

    try {
      const siteDir = makeSiteDir();
      const first = bridge.deployer.deploy(makeRequest(siteDir));
      await started;

      const second = await bridge.deployer.deploy(makeRequest(siteDir));
      expect(second).toMatchObject({ ok: false, kind: "DEPLOY_FAILED" });
      if (!second.ok) {
        expect(second.error).toMatch(/already running/i);
      }

      release(okProcess("Deployed to https://abc123.wudc2027.pages.dev"));
      await expect(first).resolves.toMatchObject({ ok: true });
    } finally {
      bridge.dispose();
    }
  });

  it("reports an unavailable IPC channel instead of throwing", async () => {
    const bridge = createTestPagesDeployIpcBridge({
      getToken: async () => TOKEN,
      resourcesDir: makeTempDir("simpletab-publish-resources-"),
      wranglerCliPath: makeWranglerCli(),
      runProcess: async () => okProcess(""),
    });
    bridge.dispose();

    const result = await bridge.deployer.deploy(makeRequest(makeSiteDir()));
    expect(result).toMatchObject({ ok: false, kind: "DEPLOY_FAILED" });
    if (!result.ok) {
      expect(result.error).toMatch(/disposed/i);
    }
  });
});
