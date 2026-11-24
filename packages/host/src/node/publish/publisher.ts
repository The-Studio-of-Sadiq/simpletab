import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PublicChainItem } from "@simpletab/core/changelog";
import type { TournamentState } from "@simpletab/core/ops";
import {
  parseManifest,
  SCHEMA_VERSION,
  type Head,
  type TournamentManifest,
} from "@simpletab/core/wire";
import type { OnlineSettings, PublishStatus } from "../../common/host-protocol";
import type { PagesDeployer } from "../../common/pages-deploy";
import {
  buildPublicSiteFiles,
  fingerprintPublicSiteFiles,
} from "./projection-build";
import { buildRoundFiles } from "./round-files";

/**
 * Publishes the public results site (design section 10): build the projection, copy the pinned site
 * assets and phone-portal files, write `manifest.json` last, upload through the Pages deployer,
 * anchor the head with the service, then read `manifest.json` back from the CDN.
 *
 * Publishes are batched to at most one every 30 s. Failures never throw and never touch the engine:
 * they only change the publish status and schedule a backoff retry while the live site is on.
 */

export const MIN_PUBLISH_INTERVAL_MS = 30_000;
export const MAX_PUBLISH_BACKOFF_MS = 600_000;
export const SITE_DIR_NAME = "site";
const DEFAULT_READ_BACK_DELAYS_MS = [0, 1_000, 3_000];

export interface PublisherEngine {
  getState(): TournamentState | null;
  changelog(): PublicChainItem[];
  head(): { seq: number; entryHash: string };
  /** False after a failed integrity check; publishing is blocked, tabbing is not (section 1.1). */
  canSync(): boolean;
}

/** Whether the phone portal needs its round files on the CDN. */
function portalUsesCdn(settings: OnlineSettings): boolean {
  return settings.ballotPortal && settings.ballotCollection !== "qr_only";
}

/** Whether commits publish by themselves (otherwise only "Publish now" does). */
export function autoPublishEnabled(settings: OnlineSettings): boolean {
  return settings.livePublicSite || portalUsesCdn(settings);
}

/**
 * Whether a publish carries the public results site. With the portal on and the live site off,
 * publishes carry only the portal's round files, so an automatic portal publish never puts up a
 * public site the organisers left off. With the portal off, every publish was asked for.
 */
export function publishIncludesSite(settings: OnlineSettings): boolean {
  return settings.livePublicSite || !portalUsesCdn(settings);
}

export interface PublisherServiceClient {
  publishHead(head: Head): Promise<{ ok: boolean; message?: string }>;
}

export interface PublishFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type PublishFetch = (
  url: string,
  init?: { cache?: "no-store" },
) => Promise<PublishFetchResponse>;

export interface PublisherTimers {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface PublisherDeps {
  engine: PublisherEngine;
  deployer: PagesDeployer;
  /** Optional: records the published head with the ballot service when it is configured. */
  serviceClient?: PublisherServiceClient;
  getSettings(): OnlineSettings;
  /** Directory holding the pinned `simpletab-public` assets. */
  publicSiteAssetsDir: string;
  /** Tournament workspace; the built site lives in `<workspaceDir>/site`. */
  workspaceDir: string;
  /** Used for the read-back check; defaults to the global fetch. */
  fetchImpl?: PublishFetch;
  clock?: () => Date;
  timers?: PublisherTimers;
  /** Delays before each `manifest.json` read-back attempt; defaults to 0, 1 s, 3 s. */
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
  fetch(url, init) as unknown as Promise<PublishFetchResponse>;

interface ReadBackResult {
  ok: boolean;
}

interface QueuedPublish {
  resolve: (status: PublishStatus) => void;
  /** Asked for by a person ("Publish now"): always uploads, even when nothing public changed. */
  manual: boolean;
}

function nowIso(clock: () => Date): string {
  return clock().toISOString();
}

function plainReason(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "The publish failed. Check the CDN settings and try again.";
}

function sleep(timers: PublisherTimers, ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    timers.setTimeout(resolve, ms);
  });
}

function copyTree(
  from: string,
  to: string,
  prefix: string,
  skip: (relPath: string) => boolean,
): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const relPath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(source, target, relPath, skip);
    } else if (entry.isFile() && !skip(relPath)) {
      copyFileSync(source, target);
    }
  }
}

export class Publisher {
  private readonly engine: PublisherEngine;
  private readonly deployer: PagesDeployer;
  private readonly serviceClient: PublisherServiceClient | undefined;
  private readonly getSettings: () => OnlineSettings;
  private readonly publicSiteAssetsDir: string;
  private readonly workspaceDir: string;
  private readonly fetchImpl: PublishFetch;
  private readonly clock: () => Date;
  private readonly timers: PublisherTimers;
  private readonly readBackDelaysMs: readonly number[];

  private status: PublishStatus = { state: "idle" };
  private active: Promise<void> | null = null;
  private queued: QueuedPublish[] = [];
  private lastStartMs: number | undefined;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private lastPublishedFingerprint: string | undefined;
  private disposed = false;

  constructor(deps: PublisherDeps) {
    this.engine = deps.engine;
    this.deployer = deps.deployer;
    this.serviceClient = deps.serviceClient;
    this.getSettings = deps.getSettings;
    this.publicSiteAssetsDir = deps.publicSiteAssetsDir;
    this.workspaceDir = deps.workspaceDir;
    this.fetchImpl = deps.fetchImpl ?? defaultFetch;
    this.clock = deps.clock ?? (() => new Date());
    this.timers = deps.timers ?? defaultTimers;
    this.readBackDelaysMs = deps.readBackDelaysMs ?? DEFAULT_READ_BACK_DELAYS_MS;
  }

  /** Current publish status; reports `not_configured` until the CDN settings are complete. */
  getStatus(): PublishStatus {
    if (this.status.state === "idle" && !this.isConfigured()) {
      return this.notConfiguredStatus();
    }
    return { ...this.status };
  }

  /**
   * Requests a publish now, batching to at most one every 30 s. Never throws; a missing CDN
   * configuration returns `not_configured` without touching the engine.
   */
  publishNow(): Promise<PublishStatus> {
    return this.enqueue(true);
  }

  /**
   * Called for every committed op. Only queues a batched publish (at most one every 30 s); the
   * projection is built once per publish, never on the commit path, and an automatic publish
   * uploads nothing when no public file changed.
   */
  handleCommitted(_event: { type: string }): void {
    if (this.disposed) {
      return;
    }
    const settings = this.getSettings();
    if (!autoPublishEnabled(settings) || !this.isConfigured()) {
      return;
    }
    void this.enqueue(false);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearTimer("batchTimer");
    this.clearRetryTimer();
    const waiters = this.queued.splice(0);
    for (const waiter of waiters) {
      waiter.resolve({ ...this.status });
    }
  }

  private isConfigured(): boolean {
    return this.missingConfiguration().length === 0;
  }

  private missingConfiguration(): string[] {
    const settings = this.getSettings();
    const missing: string[] = [];
    if ((settings.cdnHost ?? "").trim().length === 0) {
      missing.push("public site host (cdnHost)");
    }
    if ((settings.cloudflareAccountId ?? "").trim().length === 0) {
      missing.push("Cloudflare account id");
    }
    if ((settings.pagesProject ?? "").trim().length === 0) {
      missing.push("Cloudflare Pages project");
    }
    return missing;
  }

  private notConfiguredStatus(): PublishStatus {
    return {
      state: "not_configured",
      reason: `Set the ${this.missingConfiguration().join(", ")} in Online settings.`,
    };
  }

  private enqueue(manual: boolean): Promise<PublishStatus> {
    if (this.disposed) {
      return Promise.resolve({ ...this.status });
    }
    if (!this.isConfigured()) {
      this.status = this.notConfiguredStatus();
      return Promise.resolve({ ...this.status });
    }
    return new Promise<PublishStatus>((resolve) => {
      this.queued.push({ resolve, manual });
      this.kick();
    });
  }

  private kick(): void {
    if (this.disposed || this.active !== null || this.queued.length === 0) {
      return;
    }
    const now = this.clock().getTime();
    const earliest = (this.lastStartMs ?? -Infinity) + MIN_PUBLISH_INTERVAL_MS;
    if (now < earliest) {
      if (this.batchTimer === null) {
        this.batchTimer = this.timers.setTimeout(() => {
          this.batchTimer = null;
          this.kick();
        }, earliest - now);
      }
      return;
    }

    const waiters = this.queued.splice(0);
    const manual = waiters.some((waiter) => waiter.manual);
    this.lastStartMs = now;

    const run = this.runPublish(manual)
      .then((status) => {
        for (const waiter of waiters) {
          waiter.resolve(status);
        }
      })
      .catch((error: unknown) => {
        const status = this.recordFailure(error);
        for (const waiter of waiters) {
          waiter.resolve(status);
        }
      })
      .finally(() => {
        this.active = null;
        this.kick();
      });
    this.active = run;
  }

  private async runPublish(manual: boolean): Promise<PublishStatus> {
    try {
      return await this.doPublish(manual);
    } catch (error) {
      return this.recordFailure(error);
    }
  }

  private async doPublish(manual: boolean): Promise<PublishStatus> {
    if (!this.isConfigured()) {
      this.status = this.notConfiguredStatus();
      return { ...this.status };
    }
    if (!this.engine.canSync()) {
      throw new Error(
        "Publishing is paused because the tournament file failed its integrity check. Tabbing carries on.",
      );
    }
    const settings = this.getSettings();
    const state = this.engine.getState();
    if (state === null) {
      throw new Error("No tournament is open, so there is nothing to publish.");
    }

    const previous = this.status;
    this.status = { state: "building", at: nowIso(this.clock) };
    const includeSite = publishIncludesSite(settings);
    const head = this.engine.head();
    const built = includeSite
      ? buildPublicSiteFiles(state, this.engine.changelog(), head, {
          ...(settings.ballotsOrigin !== undefined
            ? { ballotsOrigin: settings.ballotsOrigin }
            : {}),
        })
      : null;

    const roundFiles = await buildRoundFiles({
      state,
      workspaceDir: this.workspaceDir,
      ballotCollection: settings.ballotCollection,
      headHash: head.entryHash,
      nowIso: nowIso(this.clock),
    });

    // What a reader can see: the public data files (not the chain, which grows with every op,
    // private ones included) and the portal's round entries.
    const visible = new Map<string, Uint8Array>();
    if (built !== null) {
      for (const [relPath, bytes] of built.files) {
        if (relPath !== built.site.chainFile) {
          visible.set(relPath, bytes);
        }
      }
    }
    visible.set(
      "rounds.json",
      new TextEncoder().encode(JSON.stringify(roundFiles.manifest.rounds)),
    );
    const fingerprint = `${includeSite ? "site" : "portal"}:${fingerprintPublicSiteFiles(visible)}`;
    if (!manual && fingerprint === this.lastPublishedFingerprint) {
      // Nothing public changed since the last upload; the chain catches up on the next one.
      this.status = previous;
      return { ...this.status };
    }

    const siteDir = path.join(this.workspaceDir, SITE_DIR_NAME);
    this.prepareSiteDir(siteDir);

    if (built !== null) {
      if (!existsSync(this.publicSiteAssetsDir)) {
        throw new Error(
          "The public site assets are missing from the SimpleTab installation.",
        );
      }
      copyTree(this.publicSiteAssetsDir, siteDir, "", () => false);
      for (const [relPath, bytes] of built.files) {
        const target = path.join(siteDir, relPath);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      }
    }
    copyTree(roundFiles.publishDir, siteDir, "", (relPath) => relPath === "manifest.json");

    const merged: TournamentManifest = {
      ...roundFiles.manifest,
      publishedAt: nowIso(this.clock),
      headHash: head.entryHash,
      ...(built !== null ? { site: built.site } : {}),
    };
    const parsedManifest = parseManifest(merged);
    if (!parsedManifest.ok) {
      throw new Error(
        `Generated manifest failed validation: ${parsedManifest.errors.join("; ")}`,
      );
    }
    // Written after every file it references, so a reader never sees half a publish.
    writeFileSync(
      path.join(siteDir, "manifest.json"),
      JSON.stringify(parsedManifest.value, null, 2),
      "utf8",
    );

    this.status = { state: "uploading", at: nowIso(this.clock) };
    const deploy = await this.deployer.deploy({
      dir: siteDir,
      accountId: settings.cloudflareAccountId!.trim(),
      projectName: settings.pagesProject!.trim(),
      branch: "main",
    });
    if (!deploy.ok) {
      throw new Error(deploy.error);
    }

    if (this.serviceClient !== undefined) {
      this.status = { state: "anchoring", at: nowIso(this.clock) };
      const anchored = await this.serviceClient.publishHead({
        schema: SCHEMA_VERSION,
        seq: head.seq,
        headHash: head.entryHash,
      });
      if (!anchored.ok) {
        throw new Error(
          `Published to the CDN, but recording the head failed: ${
            anchored.message ?? "the service did not accept it"
          }`,
        );
      }
    }

    this.status = { state: "confirming", at: nowIso(this.clock) };
    const confirmed = await this.confirmFromCdn(settings.cdnHost!.trim(), head.entryHash);
    if (!confirmed.ok) {
      throw new Error(
        "Uploaded, but the new version is not visible on the CDN yet. It usually appears within a minute.",
      );
    }

    this.consecutiveFailures = 0;
    this.clearRetryTimer();
    this.lastPublishedFingerprint = fingerprint;
    this.status = {
      state: "done",
      at: nowIso(this.clock),
      ...(deploy.deploymentUrl !== undefined
        ? { url: deploy.deploymentUrl }
        : { url: `https://${settings.cdnHost!.trim()}/` }),
    };
    return { ...this.status };
  }

  private prepareSiteDir(siteDir: string): void {
    rmSync(siteDir, { recursive: true, force: true });
    mkdirSync(siteDir, { recursive: true });
  }

  private async confirmFromCdn(
    cdnHost: string,
    headHash: string,
  ): Promise<ReadBackResult> {
    const url = `https://${cdnHost}/manifest.json`;
    for (const delayMs of this.readBackDelaysMs) {
      await sleep(this.timers, delayMs);
      try {
        const response = await this.fetchImpl(url, { cache: "no-store" });
        if (!response.ok) {
          continue;
        }
        const parsed = parseManifest(await response.json());
        if (parsed.ok && parsed.value.site?.headHash === headHash) {
          return { ok: true };
        }
      } catch {
        // A failed read-back attempt is retried; the final status explains it plainly.
      }
    }
    return { ok: false };
  }

  private recordFailure(error: unknown): PublishStatus {
    this.consecutiveFailures += 1;
    this.status = this.failedStatus(error);
    this.scheduleRetry();
    return { ...this.status };
  }

  private failedStatus(error: unknown): PublishStatus {
    return {
      state: "failed",
      at: nowIso(this.clock),
      reason: plainReason(error),
    };
  }

  private scheduleRetry(): void {
    if (this.disposed) {
      return;
    }
    const settings = this.getSettings();
    if (!autoPublishEnabled(settings) || !this.isConfigured()) {
      return;
    }
    const delayMs = Math.min(
      MAX_PUBLISH_BACKOFF_MS,
      MIN_PUBLISH_INTERVAL_MS * 2 ** Math.max(0, this.consecutiveFailures - 1),
    );
    if (this.status.state === "failed") {
      this.status = {
        ...this.status,
        nextRetryAt: new Date(this.clock().getTime() + delayMs).toISOString(),
      };
    }
    this.clearRetryTimer();
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      void this.enqueue(false);
    }, delayMs);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private clearTimer(name: "batchTimer"): void {
    const handle = this[name];
    if (handle !== null) {
      this.timers.clearTimeout(handle);
      this[name] = null;
    }
  }
}
