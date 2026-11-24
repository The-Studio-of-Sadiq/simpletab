/**
 * Boundary between the backend archiver and electron-main for committing the permanent archive to
 * the tournament's GitHub repository (design section 10.1).
 *
 * The GitHub token never leaves electron-main: the backend only names a directory it has already
 * built, and electron-main commits it to the repository's `gh-pages` branch through GitHub's REST API
 * with the `githubToken` from the credentials vault. The owner and repository name are not secret
 * and travel with the request.
 */

export const GITHUB_ARCHIVE_IPC_CHANNEL = "simpletab.github.archive" as const;

/** The branch GitHub Pages serves the archive from. */
export const GITHUB_ARCHIVE_BRANCH = "gh-pages" as const;

export interface GitHubArchiveRequest {
  /** Absolute path of the fully built archive directory (manifest.json included). */
  dir: string;
  /** Repository owner (user or organisation), e.g. "debate-society". */
  owner: string;
  /** Repository name, e.g. "wudc2027-archive". */
  repo: string;
  /** Commit message, e.g. "Archive: head 412 (3f9a…)". */
  message: string;
}

export type GitHubArchiveErrorKind =
  /** No `githubToken` is stored. */
  | "NO_TOKEN"
  /** The repository is private; GitHub Pages is free only for public repositories. */
  | "NOT_PUBLIC"
  /** The repository has no commits yet, so the Git data API cannot write to it. */
  | "EMPTY_REPO"
  /** `gh-pages` moved while the commit was being built; it is never force-updated. */
  | "CONFLICT"
  | "ARCHIVE_FAILED"
  | "TIMEOUT";

export type GitHubArchiveResult =
  | {
      ok: true;
      /** The new `gh-pages` commit, or the current one when nothing changed. */
      commitSha: string;
      /** True when the tree matched the current `gh-pages` commit, so no commit was made. */
      unchanged: boolean;
      /** Number of blobs uploaded (new or changed files). */
      blobsUploaded: number;
      /** The GitHub Pages address, e.g. "https://debate-society.github.io/wudc2027-archive/". */
      pagesUrl?: string;
      durationMs: number;
    }
  | {
      ok: false;
      /** Plain-language reason, already scrubbed of secrets. */
      error: string;
      kind: GitHubArchiveErrorKind;
    };

/** Implemented in the backend by an IPC client and in tests by a fake. */
export interface GitHubArchiver {
  archive(req: GitHubArchiveRequest): Promise<GitHubArchiveResult>;
}
