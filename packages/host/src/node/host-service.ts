import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PublicChainItem } from "@simpletab/core/changelog";
import {
  buildBreakCategories,
  buildRounds,
  defaultPreferences,
  getRulesPreset,
  rulesPresetPreferences,
  validateSlug,
  type PrelimDrawRule,
} from "@simpletab/core/lib/setup/presets";
import {
  createTournamentState,
  type Actor,
  type OpBallotSubmission,
  type OpRequest,
  type OpRound,
  type OpTournament,
} from "@simpletab/core/ops";
import { BUILT_IN_ROLES, hasPermission, type Role } from "@simpletab/core/permissions";
import { project } from "@simpletab/core/projection";
import type { Tournament, TournamentPreferences } from "@simpletab/core/types";
import type { BackendApplicationContribution } from "@theia/core/lib/node";
import { injectable } from "@theia/core/shared/inversify";
import {
  DEFAULT_ONLINE_SETTINGS,
  type ArchiveStatus,
  type BallotCollectionMode,
  type CreateDemoResult,
  type CreateTournamentParams,
  type CreateTournamentResult,
  type HostCancelLongResult,
  type HostIntegrityCheckResult,
  type HostLockInfo,
  type HostServiceClient,
  type HostService as HostServiceContract,
  type HostStatus,
  type OnlineSettings,
  type OpUndoInfo,
  type ProjectedState,
  type PublishStatus,
  type StateChangedEvent,
  type SubmitResult,
  type SyncStatus,
} from "../common/host-protocol";
import type { CredentialsFetchClient } from "../common/credentials-protocol";
import { seedDemoTournament } from "./demo-fixture";
import { HostEngine, type HostApplyResult, type UndoResult } from "./engine/engine";
import type { DetailedActiveLock } from "./engine/locks";
import { readHostNumber } from "./handover/format";
import { Archiver } from "./publish/archiver";
import { IpcGitHubArchiver } from "./publish/github-archive-client";
import { IpcPagesDeployer } from "./publish/pages-deploy-client";
import { Publisher } from "./publish/publisher";
import { buildRoundFiles } from "./publish/round-files";
import { IpcCredentialsFetchClient } from "./sync/credentials-ipc-client";
import { SyncScheduler } from "./sync/scheduler";
import { readHostIdentity, ServiceClient } from "./sync/service-client";

const DEMO_DB_FILENAME = "bp-demo.simpletab.db";
const DEFAULT_PRELIM_ROUNDS = 4;

const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CLOUDFLARE_ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
const PAGES_PROJECT_RE = /^[a-z0-9-]{1,58}$/;

function resolvePublicSiteAssetsDir(): string {
  const explicit = process.env.SIMPLETAB_PUBLIC_SITE_ASSETS?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return path.resolve(explicit);
  }
  const projectPath = process.env.THEIA_APP_PROJECT_PATH?.trim();
  if (projectPath !== undefined && projectPath.length > 0) {
    return path.join(projectPath, "resources", "public-site");
  }
  return path.resolve("packages", "app", "resources", "public-site");
}

function isValidCdnHost(host: string): boolean {
  if (host.length === 0 || host.length > 253 || /[/:?#@\s\\]/.test(host) || host.endsWith(".")) {
    return false;
  }
  const labels = host.split(".");
  if (labels.length < 2) {
    return false;
  }
  return labels.every((label) => DNS_LABEL_RE.test(label));
}

function isPublishRelevantOp(opType: string): boolean {
  return (
    opType.startsWith("draw.") ||
    opType.startsWith("allocation.") ||
    opType.startsWith("motion.") ||
    opType.startsWith("private_urls.") ||
    opType.startsWith("links.") ||
    opType === "round.set_ballot_deadline" ||
    opType === "round.set_completion" ||
    opType === "round.cancel" ||
    opType === "round.update" ||
    opType === "settings.update" ||
    opType.startsWith("swing.") ||
    opType.startsWith("team.") ||
    opType.startsWith("adjudicator.") ||
    opType.startsWith("venue.")
  );
}

const TOURNAMENT_GITIGNORE_ENTRIES = [
  "*.simpletab.db",
  "*.simpletab.db-*",
  "*.simpletab",
] as const;

export function ensureTournamentGitignore(dir: string): void {
  const gitignorePath = path.join(dir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(
      gitignorePath,
      `${TOURNAMENT_GITIGNORE_ENTRIES.join("\n")}\n`,
      "utf8",
    );
    return;
  }
  const existing = readFileSync(gitignorePath, "utf8");
  const existingLines = new Set(
    existing.split(/\r?\n/).map((line) => line.trim()),
  );
  const missing = TOURNAMENT_GITIGNORE_ENTRIES.filter(
    (entry) => !existingLines.has(entry),
  );
  if (missing.length === 0) {
    return;
  }
  const prefix =
    existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(
    gitignorePath,
    `${existing}${prefix}${missing.join("\n")}\n`,
    "utf8",
  );
}

export const HOST_OWNER_ACTOR: Actor = {
  ref: "host-owner",
  type: "human",
  role: BUILT_IN_ROLES.host_owner,
  isHostOwner: true,
};

function removeDbFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

@injectable()
export class HostServiceImpl
  implements HostServiceContract, BackendApplicationContribution
{
  private engine: HostEngine | null = null;
  private openDbPath: string | null = null;
  private unsubscribeCommit: (() => void) | null = null;
  private unsubscribeLocks: (() => void) | null = null;
  private client: HostServiceClient | undefined;
  private localRole: Role = BUILT_IN_ROLES.host_owner;
  private longOpWorkerDelayMs: number | undefined;
  private lastFullCheck: HostIntegrityCheckResult | undefined;
  private smokeHandled = false;
  private smokeTempDir: string | null = null;
  private demoHandled = false;
  private demoTempDir: string | null = null;
  private prewarmWorkers = false;
  private credentialsFetchClient: CredentialsFetchClient = new IpcCredentialsFetchClient();
  private syncScheduler: SyncScheduler | null = null;
  private publisher: Publisher | null = null;
  private pagesDeployer: IpcPagesDeployer | null = null;
  private archiver: Archiver | null = null;
  private githubArchiver: IpcGitHubArchiver | null = null;
  private publishInFlight: Promise<void> | null = null;
  private publishQueued = false;

  /** Start each opened tournament's long-op worker immediately (the desktop app does this). */
  enableWorkerPrewarm(): void {
    this.prewarmWorkers = true;
  }
  private clock: (() => Date) | undefined;

  setClock(clock: (() => Date) | undefined): void {
    this.clock = clock;
  }

  setCredentialsFetchClient(client: CredentialsFetchClient): void {
    this.credentialsFetchClient = client;
  }

  setClient(client: HostServiceClient | undefined): void {
    this.client = client;
  }

  getClient(): HostServiceClient | undefined {
    return this.client;
  }

  setLocalRole(role: Role): void {
    this.localRole = role;
  }

  setLongOpWorkerDelayMs(delayMs: number | undefined): void {
    this.longOpWorkerDelayMs = delayMs;
  }

  dispose(): void {
    this.client = undefined;
  }

  async status(): Promise<HostStatus> {
    if (process.env.SIMPLETAB_DEMO === "1" && !this.demoHandled) {
      this.demoHandled = true;
      await this.runDemoSequence();
    }
    if (process.env.SIMPLETAB_SMOKE === "1" && !this.smokeHandled) {
      this.smokeHandled = true;
      await this.runSmokeSequence();
    }
    return this.buildStatus();
  }

  async openTournament(dbPath: string): Promise<HostStatus> {
    const resolvedPath = path.resolve(dbPath);
    await this.closeCurrentEngine();
    const nextEngine = HostEngine.open(resolvedPath, {
      ...(this.longOpWorkerDelayMs !== undefined ? { longOpWorkerDelayMs: this.longOpWorkerDelayMs } : {}),
      ...(this.clock !== undefined ? { clock: this.clock } : {}),
      prewarmWorkers: this.prewarmWorkers,
    });
    try {
      await nextEngine.runFastCheck();
      this.attachEngine(nextEngine, resolvedPath);
      this.emitStateChanged({
        seq: nextEngine.head().seq,
        type: "tournament.opened",
        writes: [],
      });
      return this.buildStatus();
    } catch (error) {
      await nextEngine.close();
      throw error;
    }
  }

  async createDemoTournament(dir: string): Promise<CreateDemoResult> {
    const targetDir =
      dir.trim().length > 0
        ? path.resolve(dir)
        : path.join(os.homedir(), ".simpletab", "demo");
    mkdirSync(targetDir, { recursive: true });
    const dbPath = path.join(targetDir, DEMO_DB_FILENAME);

    await this.closeCurrentEngine();
    removeDbFiles(dbPath);

    const nextEngine = await seedDemoTournament(dbPath);
    ensureTournamentGitignore(targetDir);
    this.attachEngine(nextEngine, dbPath);
    this.emitStateChanged({
      seq: nextEngine.head().seq,
      type: "tournament.created",
      writes: [],
    });
    return {
      dbPath,
      workspaceDir: targetDir,
      status: this.buildStatus(),
    };
  }

  async createTournament(
    params: CreateTournamentParams,
  ): Promise<CreateTournamentResult> {
    const trimmedName = params.name.trim();
    if (trimmedName.length === 0) {
      throw new Error("Tournament name must not be empty.");
    }

    const slug = params.slug.trim();
    const slugError = validateSlug(slug);
    if (slugError.length > 0) {
      throw new Error(slugError);
    }

    if (params.format !== "bp" && params.format !== "two-team") {
      throw new Error("Only BP and two-team formats are supported.");
    }

    const preset = getRulesPreset(params.presetId);
    if (preset === undefined) {
      throw new Error(`Unknown preset "${params.presetId}".`);
    }
    if (preset.format === "poly") {
      throw new Error(`Preset "${preset.id}" uses an unsupported format.`);
    }
    const isPresetBp = preset.format === "bp";
    if ((params.format === "bp") !== isPresetBp) {
      throw new Error(
        `Preset "${preset.id}" does not match selected format "${params.format}".`,
      );
    }

    const prelimRounds = params.prelimRounds ?? DEFAULT_PRELIM_ROUNDS;
    if (!Number.isInteger(prelimRounds) || prelimRounds < 0 || prelimRounds > 20) {
      throw new Error(
        "Preliminary round count must be a whole number between 0 and 20.",
      );
    }

    const targetDir =
      params.directory.trim().length > 0
        ? path.resolve(params.directory)
        : path.join(os.homedir(), ".simpletab", "tournaments");
    mkdirSync(targetDir, { recursive: true });
    const dbPath = path.join(targetDir, `${slug}.simpletab.db`);
    if (existsSync(dbPath)) {
      throw new Error(`A tournament database already exists at "${dbPath}".`);
    }

    const preferences: TournamentPreferences = {
      ...defaultPreferences(preset.format),
      ...rulesPresetPreferences(preset),
    };
    const now = (this.clock !== undefined ? this.clock() : new Date()).toISOString();
    const tournamentId = `t-${slug}`;
    const tournament: Tournament = {
      id: tournamentId,
      name: trimmedName,
      shortName: trimmedName.slice(0, 32),
      slug,
      format: preset.format,
      active: true,
      ownerId: HOST_OWNER_ACTOR.ref,
      admins: { [HOST_OWNER_ACTOR.ref]: true },
      preferences,
      createdAt: now,
      updatedAt: now,
    };
    const initialState = createTournamentState(tournament);

    const nextEngine = HostEngine.open(dbPath, {
      initialState,
      ...(this.longOpWorkerDelayMs !== undefined
        ? { longOpWorkerDelayMs: this.longOpWorkerDelayMs }
        : {}),
      ...(this.clock !== undefined ? { clock: this.clock } : {}),
      prewarmWorkers: this.prewarmWorkers,
    });
    try {
      const defaultBreakSize = preferences.teamsInDebate === 4 ? 8 : 4;
      const drawRule: PrelimDrawRule =
        preferences.drawRule === "bracket" ? "random" : preferences.drawRule;
      const rounds = buildRounds({
        tournamentId,
        prelimRounds,
        maxBreakSize: defaultBreakSize,
        teamsInDebate: preferences.teamsInDebate,
        drawRule,
        firstPrelimDrawType: preset.firstPrelimDrawType,
      });

      // buildRounds stamps rounds with the wall clock; use the service's clock so a tournament
      // created with an injected clock (tests, the scripted demo) is fully reproducible.
      for (const builtRound of rounds) {
        const round = { ...builtRound, createdAt: now };
        const res = await nextEngine.submit(
          { type: "round.create", payload: { round } },
          HOST_OWNER_ACTOR,
        );
        if (!res.ok) {
          throw new Error(
            `Failed to create round ${round.name}: ${res.errors.join("; ")}`,
          );
        }
      }

      const breakCategories = buildBreakCategories(tournamentId, [
        {
          key: "open",
          name: "Open",
          breakSize: defaultBreakSize,
          reserveSize: 0,
          isGeneral: true,
        },
      ]);
      const breakRes = await nextEngine.submit(
        {
          type: "break.categories_save",
          payload: { categories: breakCategories },
        },
        HOST_OWNER_ACTOR,
      );
      if (!breakRes.ok) {
        throw new Error(
          `Failed to create default break category: ${breakRes.errors.join("; ")}`,
        );
      }

      const check = await nextEngine.runFastCheck();
      if (!check.ok) {
        throw new Error(`Tournament failed integrity check: ${check.reason}`);
      }
    } catch (error) {
      await nextEngine.close();
      removeDbFiles(dbPath);
      throw error;
    }

    ensureTournamentGitignore(targetDir);
    await this.closeCurrentEngine();
    this.attachEngine(nextEngine, dbPath);
    this.emitStateChanged({
      seq: nextEngine.head().seq,
      type: "tournament.created",
      writes: [],
    });

    const state = this.buildProjectedState();
    if (state === null) {
      throw new Error("Created tournament state could not be loaded.");
    }

    return {
      dbPath,
      workspaceDir: targetDir,
      status: this.buildStatus(),
      state,
    };
  }

  async submit(request: OpRequest): Promise<SubmitResult> {
    if (this.engine === null) {
      return {
        ok: false,
        code: "NO_TOURNAMENT",
        errors: ["No tournament is currently open."],
      };
    }
    const result = await this.engine.submit(request, HOST_OWNER_ACTOR);
    return this.mapApplyResult(result);
  }

  async undo(seq: number): Promise<SubmitResult> {
    if (this.engine === null) {
      return {
        ok: false,
        code: "NO_TOURNAMENT",
        errors: ["No tournament is currently open."],
      };
    }
    const result = await this.engine.undo(seq, HOST_OWNER_ACTOR);
    return this.mapUndoResult(result);
  }

  async getLocks(): Promise<HostLockInfo[]> {
    if (this.engine === null) {
      return [];
    }
    return this.mapLocks(this.engine.detailedLocks());
  }

  async cancelLong(lockId: string): Promise<HostCancelLongResult> {
    if (this.engine === null) {
      return {
        ok: false,
        code: "NO_TOURNAMENT",
        errors: ["No tournament is currently open."],
      };
    }
    const actor: Actor =
      this.localRole.id === BUILT_IN_ROLES.host_owner.id
        ? HOST_OWNER_ACTOR
        : {
            ref: this.localRole.id,
            type: "human",
            role: this.localRole,
            isHostOwner: false,
          };
    return this.engine.cancelLong(lockId, actor);
  }

  async getState(): Promise<ProjectedState | null> {
    return this.buildProjectedState();
  }

  async getDisplayState(): Promise<ProjectedState | null> {
    if (this.engine === null) {
      return null;
    }
    const raw = this.engine.getState();
    if (raw === null) {
      return null;
    }
    const projected = project(raw, BUILT_IN_ROLES.display);
    return {
      ...projected,
      tournament: projected.tournament as OpTournament,
      rounds: projected.rounds as OpRound[],
      ballots: projected.ballots as OpBallotSubmission[],
      seq: this.engine.head().seq,
      roleId: BUILT_IN_ROLES.display.id,
      permissions: [],
      versions: {},
    };
  }

  async runFullCheck(): Promise<HostIntegrityCheckResult> {
    if (this.engine === null) {
      return {
        ok: false,
        reason: "No tournament is currently open.",
      };
    }
    const result = await this.engine.runFullCheck();
    const fullCheck: HostIntegrityCheckResult = {
      ...result,
      checkedAt: new Date().toISOString(),
    };
    this.lastFullCheck = fullCheck;
    return fullCheck;
  }

  async getOnlineSettings(): Promise<OnlineSettings> {
    if (this.engine === null) {
      return { ...DEFAULT_ONLINE_SETTINGS };
    }
    return this.readOnlineSettings(this.engine);
  }

  async updateOnlineSettings(
    patch: Partial<OnlineSettings>,
  ): Promise<OnlineSettings> {
    if (this.engine === null) {
      throw new Error("No tournament is currently open.");
    }
    if (
      patch.ballotCollection !== undefined &&
      patch.ballotCollection !== "online" &&
      patch.ballotCollection !== "online_qr" &&
      patch.ballotCollection !== "qr_only"
    ) {
      throw new Error(
        `Invalid ballotCollection mode: "${String(patch.ballotCollection)}".`,
      );
    }
    if (patch.cdnHost !== undefined) {
      const trimmedCdn = patch.cdnHost.trim().toLowerCase();
      if (trimmedCdn.length > 0 && !isValidCdnHost(trimmedCdn)) {
        throw new Error(
          `Invalid public site host name: "${patch.cdnHost}". Enter a bare hostname such as wudc2027.pages.dev.`,
        );
      }
    }
    if (patch.ballotsOrigin !== undefined && patch.ballotsOrigin.trim().length > 0) {
      let parsed: URL;
      try {
        parsed = new URL(patch.ballotsOrigin.trim());
      } catch {
        throw new Error(`Invalid ballots service URL: "${patch.ballotsOrigin}".`);
      }
      const isLocal =
        parsed.protocol === "http:" &&
        (parsed.hostname === "localhost" ||
          parsed.hostname === "127.0.0.1" ||
          parsed.hostname === "[::1]");
      if (parsed.protocol !== "https:" && !isLocal) {
        throw new Error("Ballots service URL must use https:.");
      }
    }
    if (patch.cloudflareAccountId !== undefined) {
      const trimmed = patch.cloudflareAccountId.trim().toLowerCase();
      if (trimmed.length > 0 && !CLOUDFLARE_ACCOUNT_ID_RE.test(trimmed)) {
        throw new Error(
          `Invalid Cloudflare account ID: "${patch.cloudflareAccountId}". Enter the 32-character hex account id.`,
        );
      }
    }
    if (patch.pagesProject !== undefined) {
      const trimmed = patch.pagesProject.trim();
      if (trimmed.length > 0 && !PAGES_PROJECT_RE.test(trimmed)) {
        throw new Error(
          `Invalid Cloudflare Pages project name: "${patch.pagesProject}". Use lowercase letters, digits and hyphens (up to 58 characters).`,
        );
      }
    }

    const current = this.readOnlineSettings(this.engine);
    const nextCdnHost =
      patch.cdnHost !== undefined
        ? patch.cdnHost.trim().toLowerCase()
        : current.cdnHost;
    const nextBallotsOrigin =
      patch.ballotsOrigin !== undefined
        ? patch.ballotsOrigin.trim()
        : current.ballotsOrigin;
    const nextCloudflareAccountId =
      patch.cloudflareAccountId !== undefined
        ? patch.cloudflareAccountId.trim().toLowerCase()
        : current.cloudflareAccountId;
    const nextPagesProject =
      patch.pagesProject !== undefined
        ? patch.pagesProject.trim()
        : current.pagesProject;
    const nextGithubRepo =
      patch.githubRepo !== undefined ? patch.githubRepo.trim() : current.githubRepo;
    const nextMirror = patch.githubArchiveMirror ?? current.githubArchiveMirror;

    const next: OnlineSettings = {
      ballotPortal: patch.ballotPortal ?? current.ballotPortal,
      livePublicSite: patch.livePublicSite ?? current.livePublicSite,
      githubArchive: patch.githubArchive ?? current.githubArchive,
      onlineRegistration: patch.onlineRegistration ?? current.onlineRegistration,
      ballotCollection: patch.ballotCollection ?? current.ballotCollection,
      trustSignedBallots: patch.trustSignedBallots ?? current.trustSignedBallots,
      ...(patch.keyRequestedAt !== undefined
        ? patch.keyRequestedAt.length > 0
          ? { keyRequestedAt: patch.keyRequestedAt }
          : {}
        : current.keyRequestedAt !== undefined
          ? { keyRequestedAt: current.keyRequestedAt }
          : {}),
      ...(nextCdnHost !== undefined && nextCdnHost.length > 0
        ? { cdnHost: nextCdnHost }
        : {}),
      ...(nextBallotsOrigin !== undefined && nextBallotsOrigin.length > 0
        ? { ballotsOrigin: nextBallotsOrigin }
        : {}),
      ...(nextCloudflareAccountId !== undefined &&
      nextCloudflareAccountId.length > 0
        ? { cloudflareAccountId: nextCloudflareAccountId }
        : {}),
      ...(nextPagesProject !== undefined && nextPagesProject.length > 0
        ? { pagesProject: nextPagesProject }
        : {}),
      ...(nextGithubRepo !== undefined && nextGithubRepo.length > 0
        ? { githubRepo: nextGithubRepo }
        : {}),
      ...(nextMirror === true ? { githubArchiveMirror: true } : {}),
    };
    this.engine.database
      .prepare(
        "INSERT INTO meta(key, value) VALUES ('online_settings', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(next));
    if (patch.trustSignedBallots !== undefined) {
      const currentTrust =
        this.engine.getState()?.tournament.simpletab?.trustSignedBallots === true;
      if (currentTrust !== next.trustSignedBallots) {
        const res = await this.engine.submit(
          {
            type: "settings.update",
            payload: {
              preferences: {},
              simpletab: { trustSignedBallots: next.trustSignedBallots },
            },
          },
          HOST_OWNER_ACTOR,
        );
        if (!res.ok) {
          throw new Error(
            `Failed to update trustSignedBallots setting: ${res.errors.join("; ")}`,
          );
        }
      }
    }
    this.syncScheduler?.updateSettings(next);
    if (patch.ballotCollection !== undefined) {
      this.scheduleRoundFilesBuild();
    }
    this.emitStateChanged({
      seq: this.engine.head().seq,
      type: "settings.online_updated",
      writes: [],
    });
    return next;
  }

  async getSyncStatus(): Promise<SyncStatus> {
    if (this.syncScheduler !== null) {
      return this.syncScheduler.getSyncStatus();
    }
    return {
      enabled: false,
      active: false,
      hostNumber: 1,
      ackedThrough: 0,
      consecutiveFailures: 0,
    };
  }

  async pullNow(): Promise<SyncStatus> {
    if (this.syncScheduler === null) {
      return this.getSyncStatus();
    }
    return this.syncScheduler.pullNow();
  }

  async publishNow(): Promise<PublishStatus> {
    if (this.publisher === null) {
      return {
        state: "not_configured",
        reason: "No tournament is currently open.",
      };
    }
    return this.publisher.publishNow();
  }

  async getPublishStatus(): Promise<PublishStatus> {
    if (this.publisher === null) {
      return {
        state: "not_configured",
        reason: "No tournament is currently open.",
      };
    }
    return this.publisher.getStatus();
  }

  async archiveNow(): Promise<ArchiveStatus> {
    if (this.archiver === null) {
      return { state: "not_configured", reason: "No tournament is currently open." };
    }
    return this.archiver.archiveNow();
  }

  async getArchiveStatus(): Promise<ArchiveStatus> {
    if (this.archiver === null) {
      return { state: "not_configured", reason: "No tournament is currently open." };
    }
    return this.archiver.getStatus();
  }

  async getChangelog(afterSeq?: number, limit?: number): Promise<PublicChainItem[]> {
    if (this.engine === null) {
      return [];
    }
    let items = this.engine.changelog();
    if (afterSeq !== undefined) {
      items = items.filter((item) => item.entry.seq > afterSeq);
    }
    if (limit !== undefined && limit >= 0) {
      items = items.slice(0, limit);
    }
    return items;
  }

  async getOpUndoInfo(): Promise<OpUndoInfo[]> {
    if (this.engine === null) {
      return [];
    }
    return this.engine.opUndoInfo();
  }

  async onStop(): Promise<void> {
    await this.closeCurrentEngine();
    if (this.credentialsFetchClient instanceof IpcCredentialsFetchClient) {
      this.credentialsFetchClient.dispose();
    }
    if (this.pagesDeployer !== null) {
      this.pagesDeployer.dispose();
      this.pagesDeployer = null;
    }
    if (this.githubArchiver !== null) {
      this.githubArchiver.dispose();
      this.githubArchiver = null;
    }
    if (this.smokeTempDir !== null) {
      rmSync(this.smokeTempDir, { recursive: true, force: true });
      this.smokeTempDir = null;
    }
    if (this.demoTempDir !== null) {
      rmSync(this.demoTempDir, { recursive: true, force: true });
      this.demoTempDir = null;
    }
  }

  private async runDemoSequence(): Promise<void> {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "simpletab-demo-"));
    this.demoTempDir = tempDir;
    const demoModule = await import("./demo/scripted-demo");
    const result = await demoModule.runScriptedDemo({
      teamCount: 24,
      format: "bp",
      presetId: "bp",
      slug: "bp-electron-demo",
      name: "BP Electron Demo",
      seed: 4242,
      directory: tempDir,
      clock: new Date("2026-11-24T09:00:00.000Z"),
    });
    console.log(`SIMPLETAB_DEMO_OK rounds=${result.rounds} head=${result.head}`);
  }

  private async runSmokeSequence(): Promise<void> {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "simpletab-smoke-"));
    this.smokeTempDir = tempDir;
    const created = await this.createDemoTournament(tempDir);
    const reopened = await this.openTournament(created.dbPath);
    const seq = reopened.headSeq ?? 0;
    const integrity = Boolean(reopened.integrityOk);
    console.log(`SIMPLETAB_SMOKE_OK seq=${seq} integrity=${integrity}`);
  }

  private attachEngine(nextEngine: HostEngine, dbPath: string): void {
    this.engine = nextEngine;
    this.openDbPath = dbPath;

    const serviceClient = new ServiceClient({
      fetchClient: this.credentialsFetchClient,
      getHostIdentity: () => readHostIdentity(nextEngine.database),
      getBaseUrl: () => this.readOnlineSettings(nextEngine).ballotsOrigin,
      ...(this.clock !== undefined ? { clock: this.clock } : {}),
    });

    this.syncScheduler = new SyncScheduler({
      engine: nextEngine,
      client: serviceClient,
      initialSettings: this.readOnlineSettings(nextEngine),
      hostNumber: readHostNumber(nextEngine.database),
      ...(this.clock !== undefined ? { clock: this.clock } : {}),
      onPortalEnforcingChanged: (enforcing) => {
        nextEngine.setPortalEnforcing(enforcing);
      },
      onStatusChanged: () => {
        this.emitStateChanged({
          seq: nextEngine.head().seq,
          type: "sync.status_updated",
          writes: [],
        });
      },
    });

    this.archiver = new Archiver({
      engine: nextEngine,
      archiver: {
        archive: (request) => this.getGitHubArchiver().archive(request),
      },
      getSettings: () => this.readOnlineSettings(nextEngine),
      publicSiteAssetsDir: resolvePublicSiteAssetsDir(),
      workspaceDir: path.dirname(dbPath),
      ...(this.clock !== undefined ? { clock: this.clock } : {}),
    });

    this.publisher = new Publisher({
      engine: nextEngine,
      deployer: {
        deploy: (request) => this.getPagesDeployer().deploy(request),
      },
      serviceClient,
      getSettings: () => this.readOnlineSettings(nextEngine),
      publicSiteAssetsDir: resolvePublicSiteAssetsDir(),
      workspaceDir: path.dirname(dbPath),
      onPublished: () => this.archiver?.handlePublished(),
      ...(this.clock !== undefined ? { clock: this.clock } : {}),
    });

    this.unsubscribeCommit = nextEngine.onCommitted((event) => {
      this.emitStateChanged({
        seq: event.seq,
        type: event.type,
        writes: [...event.writes],
      });
      this.syncScheduler?.handleCommitted(event);
      this.publisher?.handleCommitted(event);
      if (isPublishRelevantOp(event.type)) {
        this.scheduleRoundFilesBuild();
      }
    });
    this.unsubscribeLocks = nextEngine.onLocksChanged((locks) => {
      this.emitLocksChanged(this.mapLocks(locks));
    });
  }

  private scheduleRoundFilesBuild(): void {
    if (this.engine === null || this.openDbPath === null) {
      return;
    }
    if (this.publishInFlight !== null) {
      this.publishQueued = true;
      return;
    }
    const run = async (): Promise<void> => {
      do {
        this.publishQueued = false;
        const activeEngine = this.engine;
        const activeDbPath = this.openDbPath;
        if (activeEngine === null || activeDbPath === null) {
          break;
        }
        const state = activeEngine.getState();
        if (state === null) {
          break;
        }
        const settings = this.readOnlineSettings(activeEngine);
        const workspaceDir = path.dirname(activeDbPath);
        try {
          await buildRoundFiles({
            state,
            workspaceDir,
            ballotCollection: settings.ballotCollection,
            headHash: activeEngine.head().entryHash,
            ...(this.clock !== undefined
              ? { nowIso: this.clock().toISOString() }
              : {}),
          });
        } catch {
          // Static round file generation runs in background and never blocks tabbing ops.
        }
      } while (this.publishQueued && this.engine !== null);
    };

    const promise = run().finally(() => {
      if (this.publishInFlight === promise) {
        this.publishInFlight = null;
      }
    });
    this.publishInFlight = promise;
  }

  private getGitHubArchiver(): IpcGitHubArchiver {
    if (this.githubArchiver === null) {
      this.githubArchiver = new IpcGitHubArchiver();
    }
    return this.githubArchiver;
  }

  private getPagesDeployer(): IpcPagesDeployer {
    if (this.pagesDeployer === null) {
      this.pagesDeployer = new IpcPagesDeployer();
    }
    return this.pagesDeployer;
  }

  private emitStateChanged(event: StateChangedEvent): void {
    if (this.client === undefined) {
      return;
    }
    try {
      this.client.onStateChanged(event);
    } catch {
      // Disconnected or failing client proxy must not break host operations.
    }
  }

  private emitLocksChanged(locks: HostLockInfo[]): void {
    if (this.client?.onLocksChanged === undefined) {
      return;
    }
    try {
      this.client.onLocksChanged(locks);
    } catch {
      // Disconnected or failing client proxy must not break host operations.
    }
  }

  private async closeCurrentEngine(): Promise<void> {
    if (this.syncScheduler !== null) {
      this.syncScheduler.dispose();
      this.syncScheduler = null;
    }
    if (this.publisher !== null) {
      this.publisher.dispose();
      this.publisher = null;
    }
    if (this.archiver !== null) {
      this.archiver.dispose();
      this.archiver = null;
    }
    this.publishQueued = false;
    if (this.publishInFlight !== null) {
      await this.publishInFlight;
    }
    if (this.unsubscribeCommit !== null) {
      this.unsubscribeCommit();
      this.unsubscribeCommit = null;
    }
    if (this.unsubscribeLocks !== null) {
      this.unsubscribeLocks();
      this.unsubscribeLocks = null;
    }
    this.lastFullCheck = undefined;
    const current = this.engine;
    this.engine = null;
    this.openDbPath = null;
    if (current !== null) {
      await current.close();
      this.emitLocksChanged([]);
    }
  }

  private mapApplyResult(result: HostApplyResult): SubmitResult {
    if (result.ok) {
      return {
        ok: true,
        seq: this.engine?.head().seq ?? 0,
        writes: [...result.writes],
        committedPayload: result.committedPayload,
      };
    }
    return {
      ok: false,
      code: result.code,
      errors: [...result.errors],
      ...(result.current !== undefined ? { current: { ...result.current } } : {}),
      ...(result.lockId !== undefined ? { lockId: result.lockId } : {}),
    };
  }

  private mapUndoResult(result: UndoResult): SubmitResult {
    if (!result.ok && result.code === "CANNOT_UNDO") {
      return {
        ok: false,
        code: result.code,
        errors: [...result.errors],
        blockingSeqs: [...result.blockingSeqs],
      };
    }
    return this.mapApplyResult(result);
  }

  private buildProjectedState(): ProjectedState | null {
    if (this.engine === null) {
      return null;
    }
    const raw = this.engine.getState();
    if (raw === null) {
      return null;
    }
    const projected = project(raw, this.localRole);
    const canEnterLate = hasPermission(this.localRole, "results.enter_late");
    const canViewIntake =
      hasPermission(this.localRole, "results.enter") ||
      hasPermission(this.localRole, "ballots.intake") ||
      hasPermission(this.localRole, "standings.view");
    return {
      ...projected,
      tournament: projected.tournament as OpTournament,
      rounds: projected.rounds as OpRound[],
      ballots: projected.ballots as OpBallotSubmission[],
      seq: this.engine.head().seq,
      roleId: this.localRole.id,
      permissions: [...this.localRole.permissions],
      ...(canEnterLate
        ? { lateSubmissions: structuredClone(raw.lateSubmissions ?? []) }
        : {}),
      ...(canViewIntake
        ? { ballotIntake: structuredClone(raw.ballotIntake ?? []) }
        : {}),
      versions: { ...raw.versions },
    };
  }

  private mapLocks(locks: readonly DetailedActiveLock[]): HostLockInfo[] {
    return locks.map((lock) => ({
      lockId: lock.lockId,
      opType: lock.opType,
      actorRef: lock.actorRef,
      startedAt: lock.startedAt,
      ...(lock.roundId !== undefined ? { roundId: lock.roundId } : {}),
    }));
  }

  private readOnlineSettings(engine: HostEngine): OnlineSettings {
    const row = engine.database
      .prepare("SELECT value FROM meta WHERE key = 'online_settings'")
      .get() as { value: string } | undefined;
    if (row === undefined) {
      return { ...DEFAULT_ONLINE_SETTINGS };
    }
    try {
      const parsed = JSON.parse(row.value) as Partial<OnlineSettings> | null;
      if (parsed === null || typeof parsed !== "object") {
        return { ...DEFAULT_ONLINE_SETTINGS };
      }
      const ballotCollection: BallotCollectionMode =
        parsed.ballotCollection === "online" ||
        parsed.ballotCollection === "online_qr" ||
        parsed.ballotCollection === "qr_only"
          ? parsed.ballotCollection
          : DEFAULT_ONLINE_SETTINGS.ballotCollection;
      return {
        ballotPortal:
          typeof parsed.ballotPortal === "boolean"
            ? parsed.ballotPortal
            : DEFAULT_ONLINE_SETTINGS.ballotPortal,
        livePublicSite:
          typeof parsed.livePublicSite === "boolean"
            ? parsed.livePublicSite
            : DEFAULT_ONLINE_SETTINGS.livePublicSite,
        githubArchive:
          typeof parsed.githubArchive === "boolean"
            ? parsed.githubArchive
            : DEFAULT_ONLINE_SETTINGS.githubArchive,
        onlineRegistration:
          typeof parsed.onlineRegistration === "boolean"
            ? parsed.onlineRegistration
            : DEFAULT_ONLINE_SETTINGS.onlineRegistration,
        ballotCollection,
        trustSignedBallots:
          typeof parsed.trustSignedBallots === "boolean"
            ? parsed.trustSignedBallots
            : DEFAULT_ONLINE_SETTINGS.trustSignedBallots,
        ...(typeof parsed.keyRequestedAt === "string" &&
        parsed.keyRequestedAt.length > 0
          ? { keyRequestedAt: parsed.keyRequestedAt }
          : {}),
        ...(typeof parsed.cdnHost === "string" && parsed.cdnHost.length > 0
          ? { cdnHost: parsed.cdnHost }
          : {}),
        ...(typeof parsed.ballotsOrigin === "string" &&
        parsed.ballotsOrigin.length > 0
          ? { ballotsOrigin: parsed.ballotsOrigin }
          : {}),
        ...(typeof parsed.cloudflareAccountId === "string" &&
        parsed.cloudflareAccountId.length > 0
          ? { cloudflareAccountId: parsed.cloudflareAccountId }
          : {}),
        ...(typeof parsed.pagesProject === "string" &&
        parsed.pagesProject.length > 0
          ? { pagesProject: parsed.pagesProject }
          : {}),
        ...(typeof parsed.githubRepo === "string" && parsed.githubRepo.length > 0
          ? { githubRepo: parsed.githubRepo }
          : {}),
        ...(parsed.githubArchiveMirror === true ? { githubArchiveMirror: true } : {}),
      };
    } catch {
      return { ...DEFAULT_ONLINE_SETTINGS };
    }
  }

  private buildStatus(): HostStatus {
    if (this.engine === null) {
      return {
        open: false,
        locks: [],
      };
    }

    const state = this.engine.getState();
    const head = this.engine.head();
    const locks = this.mapLocks(this.engine.detailedLocks());

    return {
      open: true,
      ...(state !== null ? { slug: state.tournament.slug } : {}),
      ...(this.openDbPath !== null
        ? { workspaceDir: path.dirname(this.openDbPath) }
        : {}),
      headSeq: head.seq,
      integrityOk: this.engine.integrity.ok,
      canSync: this.engine.canSync(),
      locks,
      fastCheck: { ...this.engine.integrity },
      ...(this.lastFullCheck !== undefined
        ? { fullCheck: { ...this.lastFullCheck } }
        : {}),
      hostNumber: readHostNumber(this.engine.database),
      queuedOps: 0,
      onlineSettings: this.readOnlineSettings(this.engine),
      ...(this.syncScheduler !== null
        ? { syncStatus: this.syncScheduler.getSyncStatus() }
        : {}),
    };
  }
}
