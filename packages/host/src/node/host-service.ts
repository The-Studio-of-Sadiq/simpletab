import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import type {
  CreateDemoResult,
  CreateTournamentParams,
  CreateTournamentResult,
  HostCancelLongResult,
  HostLockInfo,
  HostServiceClient,
  HostService as HostServiceContract,
  HostStatus,
  ProjectedState,
  StateChangedEvent,
  SubmitResult,
} from "../common/host-protocol";
import { seedDemoTournament } from "./demo-fixture";
import { HostEngine, type HostApplyResult, type UndoResult } from "./engine/engine";
import type { DetailedActiveLock } from "./engine/locks";

const DEMO_DB_FILENAME = "bp-demo.simpletab.db";
const DEFAULT_PRELIM_ROUNDS = 4;

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
  private unsubscribeCommit: (() => void) | null = null;
  private unsubscribeLocks: (() => void) | null = null;
  private client: HostServiceClient | undefined;
  private localRole: Role = BUILT_IN_ROLES.host_owner;
  private longOpWorkerDelayMs: number | undefined;
  private smokeHandled = false;
  private smokeTempDir: string | null = null;

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
    if (process.env.SIMPLETAB_SMOKE === "1" && !this.smokeHandled) {
      this.smokeHandled = true;
      await this.runSmokeSequence();
    }
    return this.buildStatus();
  }

  async openTournament(dbPath: string): Promise<HostStatus> {
    const resolvedPath = path.resolve(dbPath);
    await this.closeCurrentEngine();
    const nextEngine = HostEngine.open(
      resolvedPath,
      this.longOpWorkerDelayMs !== undefined
        ? { longOpWorkerDelayMs: this.longOpWorkerDelayMs }
        : {},
    );
    try {
      await nextEngine.runFastCheck();
      this.attachEngine(nextEngine);
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
    this.attachEngine(nextEngine);
    this.emitStateChanged({
      seq: nextEngine.head().seq,
      type: "tournament.created",
      writes: [],
    });
    return {
      dbPath,
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
    const now = new Date().toISOString();
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

      for (const round of rounds) {
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

    await this.closeCurrentEngine();
    this.attachEngine(nextEngine);
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

  async onStop(): Promise<void> {
    await this.closeCurrentEngine();
    if (this.smokeTempDir !== null) {
      rmSync(this.smokeTempDir, { recursive: true, force: true });
      this.smokeTempDir = null;
    }
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

  private attachEngine(nextEngine: HostEngine): void {
    this.engine = nextEngine;
    this.unsubscribeCommit = nextEngine.onCommitted((event) => {
      this.emitStateChanged({
        seq: event.seq,
        type: event.type,
        writes: [...event.writes],
      });
    });
    this.unsubscribeLocks = nextEngine.onLocksChanged((locks) => {
      this.emitLocksChanged(this.mapLocks(locks));
    });
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
    if (this.unsubscribeCommit !== null) {
      this.unsubscribeCommit();
      this.unsubscribeCommit = null;
    }
    if (this.unsubscribeLocks !== null) {
      this.unsubscribeLocks();
      this.unsubscribeLocks = null;
    }
    const current = this.engine;
    this.engine = null;
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
      headSeq: head.seq,
      integrityOk: this.engine.integrity.ok,
      canSync: this.engine.canSync(),
      locks,
    };
  }
}
