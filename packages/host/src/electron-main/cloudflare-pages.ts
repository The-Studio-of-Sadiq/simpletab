import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { PagesDeployRequest, PagesDeployResult } from "../common/pages-deploy";

/**
 * Runs Wrangler in electron-main to upload an already-built site directory to Cloudflare Pages
 * (design section 10, step 2). The Cloudflare API token is read from the credentials vault by the
 * caller and only ever reaches the child process through its environment; it never appears in
 * argv, captured output used for errors, or logs.
 */

export const DEFAULT_DEPLOY_TIMEOUT_MS = 10 * 60 * 1000;

/** Longer looks like a leak: Wrangler/Cloudflare tokens are well over 40 characters. */
const TOKEN_LIKE_RE = /[A-Za-z0-9_-]{40,}/g;
const DEPLOY_URL_RE = /https:\/\/[A-Za-z0-9._-]+\.pages\.dev(?:\/[^\s"'<>]*)?/gi;
const PROJECT_NAME_RE = /^[a-z0-9-]{1,58}$/;
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,100}$/;
const MAX_CAPTURED_OUTPUT = 256 * 1024;
const MAX_ERROR_LINES = 20;

export interface RunProcessOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Node error code when the process could not be spawned (for example ENOENT). */
  errorCode?: string;
  errorMessage?: string;
}

export type RunProcess = (options: RunProcessOptions) => Promise<ProcessResult>;

export interface DeployToPagesDependencies {
  /** Reads the `cdnToken` credential; never logged. */
  getToken(): Promise<string | undefined>;
  /** Absolute path of `node_modules/wrangler/bin/wrangler.js`. */
  wranglerCliPath: string;
  runProcess?: RunProcess;
  timeoutMs?: number;
  now?: () => number;
}

function appendCapped(existing: string, chunk: string): string {
  const next = existing + chunk;
  return next.length <= MAX_CAPTURED_OUTPUT
    ? next
    : next.slice(next.length - MAX_CAPTURED_OUTPUT);
}

/**
 * Default runner: Electron's own Node binary executes the bundled Wrangler JavaScript entry so no
 * separate Node install is needed (design section 10, step 2).
 */
export function createDefaultRunProcess(): RunProcess {
  return (options) =>
    new Promise<ProcessResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const finish = (result: Omit<ProcessResult, "stdout" | "stderr">): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({ ...result, stdout, stderr });
      };

      let child: ChildProcess;
      try {
        child = spawn(options.command, options.args, {
          env: options.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        finish({
          exitCode: null,
          signal: null,
          timedOut: false,
          errorCode: (error as NodeJS.ErrnoException).code ?? "UNKNOWN",
          errorMessage: error instanceof Error ? error.message : "Failed to spawn Wrangler.",
        });
        return;
      }

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch (error) {
          stderr = appendCapped(
            stderr,
            `\nFailed to terminate timed-out Wrangler process: ${
              error instanceof Error ? error.message : "unknown error"
            }\n`,
          );
        }
      }, options.timeoutMs);

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout = appendCapped(stdout, chunk.toString());
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = appendCapped(stderr, chunk.toString());
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        finish({
          exitCode: null,
          signal: null,
          timedOut,
          errorCode: error.code ?? "UNKNOWN",
          errorMessage: error.message,
        });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        finish({ exitCode: code, signal, timedOut });
      });
    });
}

/** Removes the token and any other long token-like strings from text that may reach an error. */
export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  let scrubbed = text;
  for (const secret of secrets) {
    if (secret.length > 0) {
      scrubbed = scrubbed.split(secret).join("[redacted]");
    }
  }
  return scrubbed.replace(TOKEN_LIKE_RE, "[redacted]");
}

/** Builds the child environment: no inherited CLOUDFLARE_* values, only the token and account id. */
export function buildWranglerEnv(
  inherited: NodeJS.ProcessEnv,
  token: string,
  accountId: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (key.toUpperCase().startsWith("CLOUDFLARE_")) {
      continue;
    }
    env[key] = value;
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  env.CLOUDFLARE_API_TOKEN = token;
  env.CLOUDFLARE_ACCOUNT_ID = accountId;
  // No usage telemetry from a tournament laptop.
  env.WRANGLER_SEND_METRICS = "false";
  return env;
}

export function parseDeploymentUrl(output: string): string | undefined {
  const matches = output.match(DEPLOY_URL_RE);
  const last = matches?.[matches.length - 1];
  return last?.replace(/[/.,;)]+$/, "");
}

function lastUsefulLines(text: string, maxLines = MAX_ERROR_LINES): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-maxLines)
    .join("\n");
}

function validateRequest(req: PagesDeployRequest): string | undefined {
  if (!path.isAbsolute(req.dir)) {
    return "the site directory must be an absolute path";
  }
  if (!existsSync(req.dir)) {
    return "the site directory does not exist";
  }
  try {
    if (!statSync(req.dir).isDirectory()) {
      return "the site path is not a directory";
    }
  } catch (error) {
    return `the site directory cannot be read (${
      error instanceof Error ? error.message : "unknown error"
    })`;
  }
  if (!PROJECT_NAME_RE.test(req.projectName)) {
    return "the project name must be 1-58 characters of a-z, 0-9 or '-'";
  }
  if (!ACCOUNT_ID_RE.test(req.accountId)) {
    return "the account id must be 32 hexadecimal characters";
  }
  if (!BRANCH_RE.test(req.branch)) {
    return "the branch must be 1-100 characters of letters, digits, '.', '_', '/' or '-'";
  }
  return undefined;
}

/** Resolves the Wrangler CLI entry from SIMPLETAB_WRANGLER_CLI or `<resources>/wrangler/cli.json`. */
export function resolveWranglerCliPath(
  resourcesDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.SIMPLETAB_WRANGLER_CLI?.trim();
  if (override !== undefined && override.length > 0) {
    return path.resolve(override);
  }

  const wranglerDir = path.join(resourcesDir, "wrangler");
  const configFile = path.join(wranglerDir, "cli.json");
  if (!existsSync(configFile)) {
    return path.join(wranglerDir, "node_modules", "wrangler", "bin", "wrangler.js");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configFile, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid Wrangler configuration at ${configFile}: ${
        error instanceof Error ? error.message : "not valid JSON"
      }`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid Wrangler configuration at ${configFile}: expected an object.`);
  }
  const cliPath = (parsed as { cliPath?: unknown }).cliPath;
  if (typeof cliPath !== "string" || cliPath.trim().length === 0) {
    throw new Error(`Invalid Wrangler configuration at ${configFile}: missing "cliPath".`);
  }
  return path.resolve(wranglerDir, cliPath.trim());
}

export async function deployToPages(
  req: PagesDeployRequest,
  deps: DeployToPagesDependencies,
): Promise<PagesDeployResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const durationMs = (): number => Math.max(0, now() - startedAt);

  const invalid = validateRequest(req);
  if (invalid !== undefined) {
    return {
      ok: false,
      kind: "DEPLOY_FAILED",
      error: `Publish request rejected: ${invalid}.`,
    };
  }

  let token: string | undefined;
  try {
    token = (await deps.getToken())?.trim();
  } catch (error) {
    return {
      ok: false,
      kind: "DEPLOY_FAILED",
      error: scrubSecrets(
        `Could not read the Cloudflare token from the credentials vault: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      ),
    };
  }
  if (token === undefined || token.length === 0) {
    return {
      ok: false,
      kind: "NO_TOKEN",
      error: "No Cloudflare API token (cdnToken) is stored. Add one on the Credentials page.",
    };
  }

  if (deps.wranglerCliPath.trim().length === 0 || !existsSync(deps.wranglerCliPath)) {
    return {
      ok: false,
      kind: "WRANGLER_MISSING",
      error:
        "Wrangler is not installed. Run `npm run fetch:wrangler` in packages/app, then try again.",
    };
  }

  const timeoutMs = deps.timeoutMs ?? DEFAULT_DEPLOY_TIMEOUT_MS;
  const args = [
    deps.wranglerCliPath,
    "pages",
    "deploy",
    req.dir,
    "--project-name",
    req.projectName,
    "--branch",
    req.branch,
    "--commit-dirty=true",
  ];
  const env = buildWranglerEnv(process.env, token, req.accountId);
  const runProcess = deps.runProcess ?? createDefaultRunProcess();

  let result: ProcessResult;
  try {
    result = await runProcess({
      command: process.execPath,
      args,
      env,
      timeoutMs,
    });
  } catch (error) {
    return {
      ok: false,
      kind: "DEPLOY_FAILED",
      error: scrubSecrets(
        `Wrangler could not be started: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        [token],
      ),
    };
  }

  if (result.timedOut) {
    return {
      ok: false,
      kind: "TIMEOUT",
      error: `Wrangler timed out after ${timeoutMs} ms and was stopped.`,
    };
  }

  if (result.errorCode === "ENOENT") {
    return {
      ok: false,
      kind: "WRANGLER_MISSING",
      error: "Wrangler could not be started because the executable or CLI file is missing.",
    };
  }

  const combinedOutput = [result.stdout, result.stderr, result.errorMessage]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
  const scrubbedOutput = scrubSecrets(combinedOutput, [token]);

  if (result.errorCode !== undefined || result.exitCode !== 0) {
    const code =
      result.exitCode !== null ? `code ${result.exitCode}` : `error ${result.errorCode ?? "unknown"}`;
    const tail = lastUsefulLines(scrubbedOutput);
    return {
      ok: false,
      kind: "DEPLOY_FAILED",
      error:
        tail.length > 0
          ? `Wrangler failed (${code}):\n${tail}`
          : `Wrangler failed (${code}) without output.`,
    };
  }

  const deploymentUrl = parseDeploymentUrl(scrubbedOutput);
  return {
    ok: true,
    ...(deploymentUrl !== undefined ? { deploymentUrl } : {}),
    durationMs: durationMs(),
  };
}
