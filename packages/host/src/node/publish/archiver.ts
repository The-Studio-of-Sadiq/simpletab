import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseManifest } from "@simpletab/core/wire";
import type { ArchiveStatus, OnlineSettings } from "../../common/host-protocol";
import type { GitHubArchiver } from "../../common/github-archive";
import { buildArchiveFiles } from "./archive-build";
import type {
  PublisherEngine,
  PublisherTimers,
  PublishFetch,
} from "./publisher";

/**
 * Commits the permanent archive to the tournament's GitHub repository (design section 10.1).
 *
 * "Archive to GitHub" runs at once (one archive at a time). The optional mirror follows each
 * successful live publish with an archive commit, batched to at most one every 10 minutes. Failures
 * never throw and never touch the engine; they only change the archive status. A landed commit that
 * GitHub Pages has not served yet is still a success: Pages usually takes a minute or two.
 */

export const MIN_MIRROR_INTERVAL_MS = 600_000;
export const ARCHIVE_DIR_NAME = "archive";
const DEFAULT_READ_BACK_DELAYS_MS = [0, 15_000, 45_000];

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

/** Accepts "owner/repo" or a github.com repository address. */
export function parseGitHubRepo(value: string | undefined): GitHubRepoRef | undefined {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) return undefined;
  const withoutHost = trimmed
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const parts = withoutHost.split("/");
  if (parts.length !== 2) return undefined;
  const [owner, repo] = parts as [string, string];
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo) || repo === "." || repo === "..") return undefined;
  return { owner, repo };
}

export interface ArchiverDeps {
  engine: PublisherEngine;
  archiver: GitHubArchiver;
  getSettings(): OnlineSettings;
  publicSiteAssetsDir: string;
  /** Tournament workspace; the built archive lives in `<workspaceDir>/archive`. */
  workspaceDir: string;
  fetchImpl?: PublishFetch;
  clock?: () => Date;
  timers?: PublisherTimers;
  /** Delays before each `manifest.json` read-back from GitHub Pages; defaults to 0, 15 s, 45 s. */
  readBackDelaysMs?: readonly number[];
}

const defaultTimers: PublisherTimers = {
  setTimeout(callback, ms) {
    return setTimeout(callback, ms);
  },
  clearTimeout(handle) {
    clearTimeout(handle);
  },
};

const defaultFetch: PublishFetch = (url, init) =>
  fetch(url, init) as unknown as Promise<Awaited<ReturnType<PublishFetch>>>;

function plainReason(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Archiving to GitHub failed. Check the repository settings and try again.";
}

export class Archiver {
  private readonly deps: ArchiverDeps;
  private readonly clock: () => Date;
  private readonly timers: PublisherTimers;
  private readonly fetchImpl: PublishFetch;
  private readonly readBackDelaysMs: readonly number[];

  private status: ArchiveStatus = { state: "idle" };
  private active: Promise<ArchiveStatus> | null = null;
  private lastStartMs: number | undefined;
  private mirrorTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(deps: ArchiverDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => new Date());
    this.timers = deps.timers ?? defaultTimers;
    this.fetchImpl = deps.fetchImpl ?? defaultFetch;
    this.readBackDelaysMs = deps.readBackDelaysMs ?? DEFAULT_READ_BACK_DELAYS_MS;
  }

  getStatus(): ArchiveStatus {
    if ((this.status.state === "idle" || this.status.state === "not_configured") && this.missing() !== undefined) {
      return { state: "not_configured", reason: this.missing()! };
    }
    return { ...this.status };
  }

  /** "Archive to GitHub": runs now, or joins the archive already running. Never throws. */
  archiveNow(): Promise<ArchiveStatus> {
    if (this.disposed) return Promise.resolve({ ...this.status });
    const missing = this.missing();
    if (missing !== undefined) {
      this.status = { state: "not_configured", reason: missing };
      return Promise.resolve({ ...this.status });
    }
    if (this.active !== null) return this.active;
    this.clearMirrorTimer();
    this.lastStartMs = this.clock().getTime();
    const run = this.run().finally(() => {
      this.active = null;
    });
    this.active = run;
    return run;
  }

  /** Called after each successful live publish; mirrors it when the switch is on. */
  handlePublished(): void {
    if (this.disposed || this.mirrorTimer !== null) return;
    const settings = this.deps.getSettings();
    if (!settings.githubArchive || settings.githubArchiveMirror !== true || this.missing() !== undefined) return;
    const now = this.clock().getTime();
    const earliest = (this.lastStartMs ?? -Infinity) + MIN_MIRROR_INTERVAL_MS;
    this.mirrorTimer = this.timers.setTimeout(() => {
      this.mirrorTimer = null;
      const current = this.deps.getSettings();
      if (current.githubArchive && current.githubArchiveMirror === true) {
        void this.archiveNow();
      }
    }, Math.max(0, earliest - now));
  }

  dispose(): void {
    this.disposed = true;
    this.clearMirrorTimer();
  }

  private missing(): string | undefined {
    const settings = this.deps.getSettings();
    if (!settings.githubArchive) {
      return "Turn on the GitHub archive in Online settings.";
    }
    if (parseGitHubRepo(settings.githubRepo) === undefined) {
      return "Set the archive repository (owner/name) in Online settings.";
    }
    return undefined;
  }

  private clearMirrorTimer(): void {
    if (this.mirrorTimer !== null) {
      this.timers.clearTimeout(this.mirrorTimer);
      this.mirrorTimer = null;
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private async run(): Promise<ArchiveStatus> {
    try {
      this.status = await this.doArchive();
    } catch (error) {
      this.status = { state: "failed", at: this.now(), reason: plainReason(error) };
    }
    return { ...this.status };
  }

  private async doArchive(): Promise<ArchiveStatus> {
    const { engine } = this.deps;
    if (!engine.canSync()) {
      throw new Error(
        "Archiving is paused because the tournament file failed its integrity check. Tabbing carries on.",
      );
    }
    const state = engine.getState();
    if (state === null) {
      throw new Error("No tournament is open, so there is nothing to archive.");
    }
    const settings = this.deps.getSettings();
    const repo = parseGitHubRepo(settings.githubRepo)!;

    this.status = { state: "building", at: this.now() };
    const head = engine.head();
    const built = buildArchiveFiles(state, engine.changelog(), head, {
      publicSiteAssetsDir: this.deps.publicSiteAssetsDir,
      publishedAt: this.now(),
      ...(settings.ballotsOrigin !== undefined ? { ballotsOrigin: settings.ballotsOrigin } : {}),
      ...(settings.cdnHost !== undefined ? { liveSiteUrl: `https://${settings.cdnHost}/` } : {}),
    });

    const dir = path.join(this.deps.workspaceDir, ARCHIVE_DIR_NAME);
    rmSync(dir, { recursive: true, force: true });
    for (const [relPath, bytes] of built.files) {
      const target = path.join(dir, relPath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }

    this.status = { state: "uploading", at: this.now() };
    const result = await this.deps.archiver.archive({
      dir,
      owner: repo.owner,
      repo: repo.repo,
      message: `Archive: head ${head.seq} (${head.entryHash.slice(0, 12)})`,
    });
    if (!result.ok) {
      throw new Error(result.error);
    }

    const base: ArchiveStatus = {
      state: "done",
      at: this.now(),
      commitSha: result.commitSha,
      unchanged: result.unchanged,
      ...(result.pagesUrl !== undefined ? { url: result.pagesUrl } : {}),
    };
    if (result.pagesUrl === undefined) {
      return {
        ...base,
        reason:
          "Committed to GitHub, but GitHub Pages could not be turned on with this token. Turn it on in the repository's Pages settings (branch gh-pages, folder /).",
      };
    }
    this.status = { state: "confirming", at: this.now() };
    const confirmed = await this.confirm(result.pagesUrl, head.entryHash);
    return confirmed
      ? { ...base, at: this.now() }
      : {
          ...base,
          at: this.now(),
          reason: "Committed to GitHub. GitHub Pages usually shows the new version within a few minutes.",
        };
  }

  private async confirm(pagesUrl: string, headHash: string): Promise<boolean> {
    const url = `${pagesUrl.replace(/\/+$/, "")}/manifest.json`;
    for (const delayMs of this.readBackDelaysMs) {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => {
          this.timers.setTimeout(resolve, delayMs);
        });
      }
      if (this.disposed) return false;
      try {
        const response = await this.fetchImpl(url, { cache: "no-store" });
        if (!response.ok) continue;
        const parsed = parseManifest(await response.json());
        if (parsed.ok && parsed.value.site?.headHash === headHash) return true;
      } catch {
        // Retried; the final status says plainly that Pages may still be catching up.
      }
    }
    return false;
  }
}
