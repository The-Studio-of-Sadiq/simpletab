import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BackendApplicationContribution } from "@theia/core/lib/node";
import { injectable } from "@theia/core/shared/inversify";
import type {
  CreateDemoResult,
  HostStatus,
  HostService as HostServiceContract,
} from "../common/host-protocol";
import { seedDemoTournament } from "./demo-fixture";
import { HostEngine } from "./engine/engine";

const DEMO_DB_FILENAME = "bp-demo.simpletab.db";

@injectable()
export class HostServiceImpl
  implements HostServiceContract, BackendApplicationContribution
{
  private engine: HostEngine | null = null;
  private smokeHandled = false;
  private smokeTempDir: string | null = null;

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
    const nextEngine = HostEngine.open(resolvedPath);
    try {
      await nextEngine.runFastCheck();
      this.engine = nextEngine;
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
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }

    this.engine = await seedDemoTournament(dbPath);
    return {
      dbPath,
      status: this.buildStatus(),
    };
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

  private async closeCurrentEngine(): Promise<void> {
    const current = this.engine;
    this.engine = null;
    if (current !== null) {
      await current.close();
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
    const locks = this.engine.locks().map((lock) => ({
      opType: lock.opType,
      actorRef: lock.actorRef,
    }));

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
