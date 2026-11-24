/**
 * Boundary between the backend publisher and electron-main for uploading the public site to the
 * tournament's Cloudflare Pages project (design section 10, step 2).
 *
 * The Cloudflare API token never leaves electron-main: the backend only names a directory it has
 * already built, and electron-main runs Wrangler with the token from the credentials vault in the
 * child process's environment. Non-secret settings (account id, project name) travel with the
 * request so electron-main does not need to read tournament state.
 */

export const PAGES_DEPLOY_IPC_CHANNEL = "simpletab.pages.deploy" as const;

export interface PagesDeployRequest {
  /** Absolute path of the fully built site directory (manifest.json written last). */
  dir: string;
  /** Cloudflare account id (not secret). */
  accountId: string;
  /** Cloudflare Pages project name (not secret), e.g. "wudc2027". */
  projectName: string;
  /** Branch to deploy; "main" is the production branch. */
  branch: string;
}

export type PagesDeployResult =
  | { ok: true; deploymentUrl?: string; durationMs: number }
  | {
      ok: false;
      /** Plain-language reason, already scrubbed of secrets. */
      error: string;
      kind: "NO_TOKEN" | "WRANGLER_MISSING" | "DEPLOY_FAILED" | "TIMEOUT";
    };

/** Implemented in the backend by an IPC client and in tests by a fake. */
export interface PagesDeployer {
  deploy(req: PagesDeployRequest): Promise<PagesDeployResult>;
}
