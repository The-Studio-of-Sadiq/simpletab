import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PagesDeployRequest } from "../common/pages-deploy";
import {
  deployToPages,
  parseDeploymentUrl,
  scrubSecrets,
  type ProcessResult,
  type RunProcess,
  type RunProcessOptions,
} from "./cloudflare-pages";

const TOKEN = "cf-test-token-0123456789abcdef0123456789abcdef";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const PROJECT = "wudc2027";

describe("deployToPages", () => {
  const tempDirs: string[] = [];

  function makeSiteDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "simpletab-site-"));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Site</title>");
    return dir;
  }

  function makeWranglerCli(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "simpletab-wrangler-"));
    tempDirs.push(dir);
    const cli = path.join(dir, "wrangler.js");
    writeFileSync(cli, "// stub\n");
    return cli;
  }

  function makeRequest(dir: string, overrides: Partial<PagesDeployRequest> = {}): PagesDeployRequest {
    return {
      dir,
      accountId: ACCOUNT_ID,
      projectName: PROJECT,
      branch: "main",
      ...overrides,
    };
  }

  function okProcess(stdout = ""): ProcessResult {
    return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "" };
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes the token only in a clean child environment, never in argv", async () => {
    const siteDir = makeSiteDir();
    const wranglerCliPath = makeWranglerCli();
    let captured: RunProcessOptions | undefined;

    process.env.CLOUDFLARE_INHERITED_SECRET = "must-not-be-forwarded";
    try {
      const result = await deployToPages(makeRequest(siteDir), {
        getToken: async () => TOKEN,
        wranglerCliPath,
        runProcess: async (options) => {
          captured = options;
          return okProcess(
            "✨ Deployment complete! Take a peek over at https://abc123.wudc2027.pages.dev",
          );
        },
      });

      expect(result).toEqual({
        ok: true,
        deploymentUrl: "https://abc123.wudc2027.pages.dev",
        durationMs: expect.any(Number),
      });
      expect(captured).toBeDefined();
      const options = captured as RunProcessOptions;
      expect(options.args.join(" ")).not.toContain(TOKEN);
      expect(JSON.stringify(options.args)).not.toContain(TOKEN);
      expect(options.command).toBe(process.execPath);
      expect(options.args).toEqual([
        wranglerCliPath,
        "pages",
        "deploy",
        siteDir,
        "--project-name",
        PROJECT,
        "--branch",
        "main",
        "--commit-dirty=true",
      ]);
      expect(options.env.CLOUDFLARE_API_TOKEN).toBe(TOKEN);
      expect(options.env.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT_ID);
      expect(options.env.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(options.env.CLOUDFLARE_INHERITED_SECRET).toBeUndefined();
      expect(
        Object.keys(options.env).filter((key) => key.startsWith("CLOUDFLARE_")).sort(),
      ).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
    } finally {
      delete process.env.CLOUDFLARE_INHERITED_SECRET;
    }
  });

  it("scrubs the token and long token-like strings from failure output", async () => {
    const siteDir = makeSiteDir();
    const fakeSecret = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ";
    const result = await deployToPages(makeRequest(siteDir), {
      getToken: async () => TOKEN,
      wranglerCliPath: makeWranglerCli(),
      runProcess: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: `Using token ${TOKEN}\n`,
        stderr: `Authentication error for ${TOKEN} and ${fakeSecret}\nPlease check your API token.`,
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.kind).toBe("DEPLOY_FAILED");
    expect(result.error).not.toContain(TOKEN);
    expect(result.error).not.toContain(fakeSecret);
    expect(result.error).toContain("[redacted]");
    expect(result.error).toContain("Authentication error");
    expect(result.error).toContain("Please check your API token.");
  });

  it("maps a missing token to NO_TOKEN without running Wrangler", async () => {
    const runProcess = vi.fn<RunProcess>();
    const result = await deployToPages(makeRequest(makeSiteDir()), {
      getToken: async () => undefined,
      wranglerCliPath: makeWranglerCli(),
      runProcess,
    });

    expect(result).toMatchObject({ ok: false, kind: "NO_TOKEN" });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("maps a missing Wrangler CLI to WRANGLER_MISSING", async () => {
    const runProcess = vi.fn<RunProcess>();
    const result = await deployToPages(makeRequest(makeSiteDir()), {
      getToken: async () => TOKEN,
      wranglerCliPath: path.join(os.tmpdir(), "simpletab-missing-wrangler", "wrangler.js"),
      runProcess,
    });

    expect(result).toMatchObject({ ok: false, kind: "WRANGLER_MISSING" });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("maps spawn ENOENT and a non-zero exit code", async () => {
    const siteDir = makeSiteDir();
    const missing = await deployToPages(makeRequest(siteDir), {
      getToken: async () => TOKEN,
      wranglerCliPath: makeWranglerCli(),
      runProcess: async () => ({
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        errorCode: "ENOENT",
        errorMessage: "spawn node ENOENT",
      }),
    });
    expect(missing).toMatchObject({ ok: false, kind: "WRANGLER_MISSING" });

    const failed = await deployToPages(makeRequest(siteDir), {
      getToken: async () => TOKEN,
      wranglerCliPath: makeWranglerCli(),
      runProcess: async () => ({
        exitCode: 2,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "line one\nline two\nProject not found",
      }),
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) {
      throw new Error("expected failure");
    }
    expect(failed.kind).toBe("DEPLOY_FAILED");
    expect(failed.error).toContain("code 2");
    expect(failed.error).toContain("Project not found");
  });

  it("times out and kills a child process that does not finish", async () => {
    const siteDir = makeSiteDir();
    const wranglerDir = mkdtempSync(path.join(os.tmpdir(), "simpletab-wrangler-slow-"));
    tempDirs.push(wranglerDir);
    const slowCli = path.join(wranglerDir, "wrangler.js");
    writeFileSync(slowCli, "setTimeout(() => {}, 60000);\n");

    const startedAt = Date.now();
    const result = await deployToPages(makeRequest(siteDir), {
      getToken: async () => TOKEN,
      wranglerCliPath: slowCli,
      timeoutMs: 300,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result).toMatchObject({ ok: false, kind: "TIMEOUT" });
    expect(elapsedMs).toBeLessThan(5000);
  });

  it("rejects invalid requests before reading the token or running Wrangler", async () => {
    const siteDir = makeSiteDir();
    const getToken = vi.fn(async () => TOKEN);
    const runProcess = vi.fn<RunProcess>();
    const wranglerCliPath = makeWranglerCli();

    const cases = [
      makeRequest("relative/site"),
      makeRequest(siteDir, { projectName: "Not_Valid!" }),
      makeRequest(siteDir, { accountId: "not-hex" }),
      makeRequest(siteDir, { dir: path.join(siteDir, "missing") }),
      makeRequest(siteDir, { branch: "bad branch" }),
    ];

    for (const req of cases) {
      const result = await deployToPages(req, { getToken, wranglerCliPath, runProcess });
      expect(result).toMatchObject({ ok: false, kind: "DEPLOY_FAILED" });
      if (!result.ok) {
        expect(result.error).toContain("Publish request rejected");
      }
    }
    expect(getToken).not.toHaveBeenCalled();
    expect(runProcess).not.toHaveBeenCalled();
  });
});

describe("publish output helpers", () => {
  it("finds the deployment URL in Wrangler output", () => {
    expect(
      parseDeploymentUrl("Deployed to https://abc123.wudc2027.pages.dev\nDone."),
    ).toBe("https://abc123.wudc2027.pages.dev");
    expect(
      parseDeploymentUrl(
        "Branch: main\nhttps://abc123.wudc2027.pages.dev/\nhttps://def456.wudc2027.pages.dev/ (alias)",
      ),
    ).toBe("https://def456.wudc2027.pages.dev");
    expect(parseDeploymentUrl("no url here")).toBeUndefined();
  });

  it("scrubs an exact secret even when it is shorter than a token", () => {
    expect(scrubSecrets("value=short-secret", ["short-secret"])).toBe("value=[redacted]");
  });
});
