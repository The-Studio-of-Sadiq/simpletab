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
  type DevicesStatus,
  type PromoteParams,
  type QrReceiveResult,
  type ReplacedInfo,
  type JoinHostParams,
  type JoinProgress,
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
import type {
  CollabRequestMethod,
  CollabStateView,
  HostIdentity,
  IssuedPairingCode,
  PresenceInfo,
} from "../common/collab-protocol";
import { HostCollab } from "./devices/host-collab";
import { DeviceMode } from "./device/device-mode";
import { ProjectionStream } from "./collab/projection-stream";
import { ReplicaFeed } from "./collab/replica-feed";
import { exportDivergent } from "./handover/divergent";
import { restoreHiddenFields } from "./collab/hidden-fields";
import { verifyQrBallot } from "./collab/qr-intake";
import { buildProjectedStateFor } from "./state/projected-state";
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
  // The host certificate's private key for live collaboration (section 4).
  "collab/",
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

function readMetaValue(engine: HostEngine, key: string): string | undefined {
  return (
    engine.database.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined
  )?.value;
}

function readReplacedInfo(engine: HostEngine): ReplacedInfo | undefined {
  const raw = readMetaValue(engine, "replaced_by");
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<ReplacedInfo>;
    if (typeof parsed.hostNumber !== "number" || typeof parsed.hostRank !== "number" || typeof parsed.at !== "string") {
      return undefined;
    }
    return {
      hostNumber: parsed.hostNumber,
      hostRank: parsed.hostRank,
      at: parsed.at,
      forkSeq: typeof parsed.forkSeq === "number" ? parsed.forkSeq : 0,
      ...(typeof parsed.divergentFile === "string" ? { divergentFile: parsed.divergentFile } : {}),
    };
  } catch {
    return undefined;
  }
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
  private collab: HostCollab | null = null;
  private deviceMode: DeviceMode | null = null;
  private stream: ProjectionStream | null = null;
  private replicaFeed: ReplicaFeed | null = null;
  private replacedBy: ReplacedInfo | undefined;
  private collabListen: { port: number; host?: string } | undefined;
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

  /** Where the device server listens when no port is given (tests use 127.0.0.1 and port 0). */
  setCollabListen(listen: { port: number; host?: string } | undefined): void {
    this.collabListen = listen;
  }

  /** Replaces the device-mode controller (tests point it at a temporary pairing folder). */
  setDeviceMode(deviceMode: DeviceMode | null): void {
    this.deviceMode?.dispose();
    this.deviceMode = deviceMode;
  }

  /** Reconnects to the host this laptop is paired with, if any (called once at start-up). */
  resumeDeviceMode(): void {
    try {
      this.getDeviceMode().resume();
    } catch (error) {
      console.warn("SimpleTab: could not resume device mode", error);
    }
  }

  private getDeviceMode(): DeviceMode {
    if (this.deviceMode === null) {
      this.deviceMode = new DeviceMode({ onChange: () => this.onDeviceChanged() });
    }
    return this.deviceMode;
  }

  /** The host connection when this laptop runs as a staff device. */
  private remote() {
    return this.deviceMode?.active() ?? null;
  }

  private onDeviceChanged(): void {
    const remote = this.remote();
    this.emitStateChanged({
      seq: remote?.getState()?.seq ?? 0,
      type: "device.updated",
      writes: [],
    });
    if (remote !== null) {
      this.emitLocksChanged(remote.getLocks());
    }
  }

  /** Host-only actions are refused on a staff device, in words. */
  private assertNotDevice(action: string): void {
    const remote = this.remote();
    if (remote !== null) {
      throw new Error(
        `This laptop is joined to the host at ${remote.status().hostAddress} as a device, so it cannot ${action}. Leave the host first.`,
      );
    }
  }

  async startJoin(params: JoinHostParams): Promise<JoinProgress> {
    if (this.engine !== null) {
      throw new Error("Close the open tournament before joining another host as a device.");
    }
    return this.getDeviceMode().startJoin(params);
  }

  async getJoinProgress(): Promise<JoinProgress> {
    return this.deviceMode?.joinProgress() ?? { state: "idle" };
  }

  async leaveHost(): Promise<void> {
    this.deviceMode?.leave();
    this.emitStateChanged({ seq: 0, type: "device.left", writes: [] });
  }

  async receiveQrBallot(codes: string[]): Promise<QrReceiveResult> {
    const remote = this.remote();
    if (remote !== null) {
      return remote.receiveQrBallot(codes);
    }
    const replaced = this.replacedFailure();
    if (replaced !== null && !replaced.ok) {
      return { ok: false, kind: "rejected", errors: replaced.errors };
    }
    if (this.engine === null) {
      return { ok: false, kind: "rejected", errors: ["No tournament is currently open."] };
    }
    return this.receiveQrOnEngine(this.engine, codes, HOST_OWNER_ACTOR);
  }

  /** Checks a scanned QR ballot with the host's link secrets, then records it as `actor`. */
  private async receiveQrOnEngine(engine: HostEngine, codes: string[], actor: Actor): Promise<QrReceiveResult> {
    const state = engine.getState();
    if (state === null) {
      return { ok: false, kind: "rejected", errors: ["No tournament is currently open."] };
    }
    const verified = await verifyQrBallot(codes, state, this.clock ?? (() => new Date()));
    if (!verified.ok) {
      return {
        ok: false,
        kind: verified.kind,
        errors: [],
        ...(verified.detail !== undefined ? { detail: verified.detail } : {}),
      };
    }
    const current = engine.getState();
    if (current?.ballots.some((ballot) => ballot.id === verified.ballot.id) === true) {
      return { ok: false, kind: "duplicate", errors: [] };
    }
    const result = this.mapApplyResult(
      await engine.submit(
        {
          type: "ballot.receive_online",
          payload: {
            source: "qr",
            ballot: verified.ballot,
            submissionId: verified.submissionId,
            receivedAt: (this.clock?.() ?? new Date()).toISOString(),
          },
        },
        actor,
      ),
    );
    if (!result.ok) {
      return { ok: false, kind: "rejected", errors: result.errors };
    }
    return { ok: true, seq: result.seq, roundId: verified.ballot.roundId, debateId: verified.ballot.debateId };
  }

  async promoteToHost(params: PromoteParams): Promise<HostStatus> {
    const deviceMode = this.deviceMode;
    if (deviceMode === null || deviceMode.active() === null) {
      throw new Error("Only a tab director's laptop joined to a host can be promoted.");
    }
    const directory = params.directory.trim();
    if (directory.length === 0) {
      throw new Error("Choose a folder for the new host's tournament file.");
    }
    const result = await deviceMode.promote({
      directory,
      ...(params.newerCopyPath !== undefined ? { newerCopyPath: params.newerCopyPath } : {}),
    });
    const status = await this.openTournament(result.dbPath);
    ensureTournamentGitignore(path.dirname(result.dbPath));
    return status;
  }

  async exportDeviceCopy(directory: string): Promise<string> {
    const deviceMode = this.deviceMode;
    if (deviceMode === null || deviceMode.active() === null) {
      throw new Error("This laptop is not joined to a host.");
    }
    return deviceMode.exportCopy(directory.trim());
  }

  async dismissRejectedEdits(): Promise<void> {
    this.remote()?.dismissRejected();
  }

  async setPresence(info: PresenceInfo): Promise<void> {
    const clean: PresenceInfo = {
      ...(typeof info.view === "string" ? { view: info.view.slice(0, 100) } : {}),
      ...(typeof info.roundId === "string" ? { roundId: info.roundId.slice(0, 100) } : {}),
      ...(typeof info.debateId === "string" ? { debateId: info.debateId.slice(0, 100) } : {}),
    };
    const remote = this.remote();
    if (remote !== null) {
      remote.setPresence(clean);
      return;
    }
    this.stream?.setHostPresence({ ...clean, name: "Host" });
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
    this.assertNotDevice("open a tournament of its own");
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
    this.assertNotDevice("create a tournament of its own");
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
    this.assertNotDevice("create a tournament of its own");
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
    const remote = this.remote();
    if (remote !== null) {
      return remote.submit(request);
    }
    const replaced = this.replacedFailure();
    if (replaced !== null) {
      return replaced;
    }
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
    const remote = this.remote();
    if (remote !== null) {
      return remote.undo(seq);
    }
    const replaced = this.replacedFailure();
    if (replaced !== null) {
      return replaced;
    }
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
    const remote = this.remote();
    if (remote !== null) {
      return remote.getLocks();
    }
    if (this.engine === null) {
      return [];
    }
    return this.mapLocks(this.engine.detailedLocks());
  }

  async cancelLong(lockId: string): Promise<HostCancelLongResult> {
    const remote = this.remote();
    if (remote !== null) {
      return remote.cancelLong(lockId);
    }
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
    const remote = this.remote();
    if (remote !== null) {
      return remote.getState();
    }
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
    this.assertNotDevice("change the host's online settings");
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
    this.assertNotDevice("publish; only the host publishes");
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

  private requireCollab(): HostCollab {
    this.assertNotDevice("manage devices; only the host pairs devices");
    if (this.collab === null) {
      throw new Error("No tournament is currently open.");
    }
    if (!hasPermission(this.localRole, "devices.manage")) {
      throw new Error("Only the host owner and tab directors can manage devices.");
    }
    return this.collab;
  }

  async getDevicesStatus(): Promise<DevicesStatus> {
    return this.requireCollab().status();
  }

  async setSuccession(order: string[]): Promise<void> {
    this.requireCollab();
    const result = await this.submit({ type: "succession.set", payload: { order } });
    if (!result.ok) {
      throw new Error(result.errors.join(" "));
    }
  }

  async setDevicesEnabled(enabled: boolean, port?: number): Promise<DevicesStatus> {
    const collab = this.requireCollab();
    if (enabled && this.replacedBy !== undefined) {
      throw new Error(this.replacedMessage(this.replacedBy));
    }
    if (enabled) {
      if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
        throw new Error("Choose a port between 1024 and 65535.");
      }
      await collab.start(port ?? this.collabListen?.port, port === undefined ? this.collabListen?.host : undefined);
    } else {
      await collab.stop();
    }
    return collab.status();
  }

  async issuePairingCode(roleId: string): Promise<IssuedPairingCode> {
    return this.requireCollab().issueCode(roleId);
  }

  async cancelPairingCode(code: string): Promise<void> {
    this.requireCollab().cancelCode(code);
  }

  async approveJoin(joinId: string): Promise<void> {
    await this.requireCollab().approveJoin(joinId);
  }

  async rejectJoin(joinId: string): Promise<void> {
    this.requireCollab().rejectJoin(joinId);
  }

  async removeDevice(deviceId: string): Promise<void> {
    await this.requireCollab().removeDevice(deviceId);
  }

  async archiveNow(): Promise<ArchiveStatus> {
    this.assertNotDevice("archive; only the host archives");
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
    const remote = this.remote();
    if (remote !== null) {
      return remote.getChangelog(afterSeq, limit);
    }
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
    const remote = this.remote();
    if (remote !== null) {
      return remote.getOpUndoInfo();
    }
    if (this.engine === null) {
      return [];
    }
    return this.engine.opUndoInfo();
  }

  async onStop(): Promise<void> {
    await this.closeCurrentEngine();
    this.deviceMode?.dispose();
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

    const stream = new ProjectionStream({
      getView: (role) => {
        const raw = nextEngine.getState();
        return raw === null
          ? null
          : (buildProjectedStateFor(raw, role, nextEngine.head().seq) as unknown as CollabStateView);
      },
      getLocks: () => this.mapLocks(nextEngine.detailedLocks()),
      handleRequest: (method, params, actor) =>
        this.handleDeviceRequest(nextEngine, method, params, actor),
      deviceName: (deviceId) =>
        nextEngine.getState()?.devices.find((device) => device.id === deviceId)?.name ?? deviceId,
    });
    this.stream = stream;
    const replicaFeed = new ReplicaFeed(nextEngine);
    this.replicaFeed = replicaFeed;
    this.replacedBy = readReplacedInfo(nextEngine);

    this.collab = new HostCollab({
      engine: {
        getState: () => nextEngine.getState(),
        submit: (request, actor) => nextEngine.submit(request, actor),
        readMeta: (key) =>
          (
            nextEngine.database
              .prepare("SELECT value FROM meta WHERE key = ?")
              .get(key) as { value: string } | undefined
          )?.value,
        writeMeta: (key, value) => {
          nextEngine.database
            .prepare(
              "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .run(key, value);
        },
      },
      workspaceDir: path.dirname(dbPath),
      hostOwner: HOST_OWNER_ACTOR,
      getHostIdentity: () => {
        const promoted = readMetaValue(nextEngine, "promoted_from_seq");
        const promotedFromSeq = promoted === undefined ? NaN : Number(promoted);
        return {
          ...readHostIdentity(nextEngine.database),
          ...(Number.isInteger(promotedFromSeq) ? { promotedFromSeq } : {}),
        };
      },
      onSuperseded: (winner) => {
        void this.demote(nextEngine, winner);
      },
      ...(this.clock !== undefined ? { now: this.clock } : {}),
      onChanged: () => {
        this.emitStateChanged({
          seq: nextEngine.head().seq,
          type: "devices.status_updated",
          writes: [],
        });
      },
      onSession: (session) => {
        stream.addSession(session);
        replicaFeed.addSession(session);
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
      this.stream?.notifyCommitted(event.type);
      this.replicaFeed?.notifyCommitted();
      this.publisher?.handleCommitted(event);
      if (isPublishRelevantOp(event.type)) {
        this.scheduleRoundFilesBuild();
      }
    });
    this.unsubscribeLocks = nextEngine.onLocksChanged((locks) => {
      this.emitLocksChanged(this.mapLocks(locks));
      this.stream?.notifyLocksChanged();
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
    if (this.stream !== null) {
      this.stream.dispose();
      this.stream = null;
    }
    if (this.replicaFeed !== null) {
      this.replicaFeed.dispose();
      this.replicaFeed = null;
    }
    this.replacedBy = undefined;
    if (this.collab !== null) {
      await this.collab.stop().catch((error: unknown) => {
        console.warn("SimpleTab: stopping the device server failed", error);
      });
      this.collab = null;
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
    return buildProjectedStateFor(raw, this.localRole, this.engine.head().seq);
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
    const remote = this.remote();
    if (remote !== null) {
      const state = remote.getState();
      const succession = this.deviceMode?.successionInfo();
      const device = {
        ...remote.status(),
        ...(succession !== undefined
          ? { successionRank: succession.rank, betterRanked: succession.betterRanked }
          : {}),
      };
      return {
        open: state !== null,
        ...(state !== null ? { slug: state.tournament.slug, headSeq: state.seq } : {}),
        locks: remote.getLocks(),
        queuedOps: device.queued.length,
        device,
      };
    }
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
      ...(this.stream !== null && this.stream.sessionCount() > 0
        ? { presence: this.stream.presence() }
        : {}),
      ...(this.replacedBy !== undefined ? { replacedBy: { ...this.replacedBy } } : {}),
    };
  }

  private replacedMessage(info: ReplacedInfo): string {
    return `This laptop was replaced by host ${info.hostNumber}, so the tournament here is read-only. Changes made here after the handover were saved for review.`;
  }

  private replacedFailure(): SubmitResult | null {
    if (this.replacedBy === undefined) return null;
    return { ok: false, code: "FORBIDDEN", errors: [this.replacedMessage(this.replacedBy)] };
  }

  /**
   * Another host beat this one (design section 4, promotion step 7): stop serving devices, become
   * read-only, and write every op committed after the fork point to `<slug>.divergent.simpletab`.
   */
  private async demote(engine: HostEngine, winner: HostIdentity): Promise<void> {
    if (this.engine !== engine || this.replacedBy !== undefined) return;
    const forkSeq = Math.min(winner.promotedFromSeq ?? 0, engine.head().seq);
    const info: ReplacedInfo = {
      hostNumber: winner.hostNumber,
      hostRank: winner.hostRank,
      at: (this.clock?.() ?? new Date()).toISOString(),
      forkSeq,
    };
    if (engine.head().seq > forkSeq && this.openDbPath !== null) {
      try {
        const exported = exportDivergent(engine, forkSeq, path.dirname(this.openDbPath) + path.sep);
        info.divergentFile = exported.filePath;
      } catch (error) {
        console.warn("SimpleTab: could not write the divergent ops file", error);
      }
    }
    engine.database
      .prepare("INSERT INTO meta(key, value) VALUES ('replaced_by', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(info));
    this.replacedBy = info;
    await this.collab?.stop().catch(() => undefined);
    this.emitStateChanged({ seq: engine.head().seq, type: "host.replaced", writes: [] });
  }

  /**
   * Runs a staff device's request as that device's own actor (design section 4.1): its role's
   * permissions apply in the engine, and host precedence never does.
   */
  private async handleDeviceRequest(
    engine: HostEngine,
    method: CollabRequestMethod,
    params: unknown[],
    actor: Actor,
  ): Promise<unknown> {
    if (
      this.replacedBy !== undefined &&
      (method === "submit" || method === "undo" || method === "cancelLong" || method === "receiveQrBallot")
    ) {
      throw new Error(this.replacedMessage(this.replacedBy));
    }
    switch (method) {
      case "submit": {
        const request = params[0];
        if (
          request === null ||
          typeof request !== "object" ||
          typeof (request as { type?: unknown }).type !== "string"
        ) {
          throw new Error("The change was not in a form the host understands.");
        }
        const { forced: _forced, ...op } = request as OpRequest & { forced?: boolean };
        const current = engine.getState();
        const safe = current === null ? op : restoreHiddenFields(op, current, actor.role);
        return this.mapApplyResult(await engine.submit(safe, actor));
      }
      case "undo": {
        const seq = params[0];
        if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
          throw new Error("Undo needs the number of the change to undo.");
        }
        return this.mapUndoResult(await engine.undo(seq, actor));
      }
      case "cancelLong": {
        const lockId = params[0];
        if (typeof lockId !== "string") {
          throw new Error("Cancelling needs the id of the running task.");
        }
        return engine.cancelLong(lockId, actor);
      }
      case "getChangelog": {
        const afterSeq = typeof params[0] === "number" ? params[0] : undefined;
        const limit = typeof params[1] === "number" ? params[1] : undefined;
        let items = engine.changelog();
        if (afterSeq !== undefined) items = items.filter((item) => item.entry.seq > afterSeq);
        if (limit !== undefined && limit >= 0) items = items.slice(0, limit);
        return items;
      }
      case "getOpUndoInfo":
        return engine.opUndoInfo();
      case "receiveQrBallot": {
        const codes = params[0];
        if (!Array.isArray(codes) || codes.some((code) => typeof code !== "string")) {
          throw new Error("The scanned codes were not in a form the host understands.");
        }
        return this.receiveQrOnEngine(engine, codes as string[], actor);
      }
      default:
        throw new Error("The host does not offer that action to devices.");
    }
  }
}
