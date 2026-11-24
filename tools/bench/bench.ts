import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { calculateStandings } from "@/lib/standings/calculator";
import { HostEngine, type HostApplyResult } from "../../packages/host/src/node/engine/engine";
import { TAB_DIRECTOR_ACTOR } from "@/ops/test-helpers";
import { BENCH_PRELIM_ROUNDS, generateBenchTournament, type BenchSize } from "./generate";

export interface BenchRow {
  operation: string;
  medianMs: number;
  targetMs: number | null;
  maxLagMs: number;
  passed: boolean;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function timeOperation(operation: () => Promise<void> | void, sampleLag = false): Promise<{ ms: number; lagMs: number }> {
  let lagMs = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  if (sampleLag) {
    let last = performance.now();
    timer = setInterval(() => {
      const now = performance.now();
      lagMs = Math.max(lagMs, now - last - 50);
      last = now;
    }, 50);
  }
  const start = performance.now();
  await operation();
  const ms = performance.now() - start;
  if (timer !== undefined) clearInterval(timer);
  return { ms, lagMs };
}

function assertOk(result: HostApplyResult, operation: string): void {
  if (!result.ok) throw new Error(`${operation} failed: ${result.errors.join("; ")}`);
}

export async function runBench(size: BenchSize): Promise<{ rows: BenchRow[]; output: string }> {
  // Three starting points: nothing played (round 1 draw), five of six rounds played (power-paired
  // draw and allocation), and every prelim played (standings and the break).
  const fresh = generateBenchTournament(size, undefined, 0);
  const generated = generateBenchTournament(size, undefined, BENCH_PRELIM_ROUNDS - 1);
  const finished = generateBenchTournament(size, undefined, BENCH_PRELIM_ROUNDS);
  const tempDir = path.join(os.tmpdir(), `simpletab-bench-${size}-${process.pid}`);
  mkdirSync(tempDir, { recursive: true });
  const rows: BenchRow[] = [];
  const targets: Record<string, number | null> = {
    "draw.generate round 1": 5000,
    "draw.generate round 6": 5000,
    "allocation.auto": 15000,
    standings: 2000,
    "break.compute": 2000,
    "HostEngine reopen fast check": 3000,
  };
  if (size === "xl") {
    for (const key of Object.keys(targets)) targets[key] = null;
  }

  async function measure(
    name: string,
    operation: (engine: HostEngine) => Promise<void> | void,
    sampleLag = false,
    initialState = generated.state,
    setup?: (engine: HostEngine) => Promise<void>,
  ): Promise<void> {
    const timings: number[] = [];
    let lag = 0;
    for (let run = 0; run < 3; run += 1) {
      const dbPath = path.join(tempDir, `bench-${run}.simpletab.db`);
      rmSync(dbPath, { force: true });
      const engine = HostEngine.open(dbPath, { initialState, prewarmWorkers: true });
      try {
        await engine.runFastCheck();
        // The desktop app warms its worker at startup, so time steady-state ops, not a cold start.
        await engine.workersReady();
        if (setup !== undefined) await setup(engine);
        const measured = await timeOperation(async () => {
          await operation(engine);
        }, sampleLag);
        timings.push(measured.ms);
        lag = Math.max(lag, measured.lagMs);
      } finally {
        await engine.close();
      }
    }
    const medianMs = median(timings);
    const targetMs = targets[name] ?? null;
    rows.push({
      operation: name,
      medianMs,
      targetMs,
      maxLagMs: lag,
      passed: targetMs === null || medianMs <= targetMs,
    });
  }

  await measure("draw.generate round 1", async (engine) => {
    const result = await engine.submit({ type: "draw.generate", payload: { roundId: "round-1", seed: 4242 } }, TAB_DIRECTOR_ACTOR);
    assertOk(result, "draw.generate round 1");
  }, true, fresh.state);
  await measure("draw.generate round 6", async (engine) => {
    const result = await engine.submit({ type: "draw.generate", payload: { roundId: "round-6", seed: 4246 } }, TAB_DIRECTOR_ACTOR);
    assertOk(result, "draw.generate round 6");
  }, true);
  await measure("allocation.auto", async (engine) => {
    const result = await engine.submit({ type: "allocation.auto", payload: { roundId: "round-6", panelSize: 3 } }, TAB_DIRECTOR_ACTOR);
    assertOk(result, "allocation.auto");
  }, true, generated.state, async (engine) => {
    // Untimed setup: allocation needs round 6's debates.
    assertOk(await engine.submit({ type: "draw.generate", payload: { roundId: "round-6", seed: 4246 } }, TAB_DIRECTOR_ACTOR), "allocation setup draw");
  });
  await measure("standings", (engine) => {
    const state = engine.getState();
    if (state === null) throw new Error("No benchmark state.");
    calculateStandings(state.tournament, state.rounds, state.teams, state.debates, state.ballots);
  }, false, finished.state);
  await measure("break.compute", async (engine) => {
    const result = await engine.submit({ type: "break.compute", payload: { categoryId: "bc-open" } }, TAB_DIRECTOR_ACTOR);
    assertOk(result, "break.compute");
  }, false, finished.state);
  // Reopening runs the startup fast check, which replays the op log since the latest snapshot, so
  // it is timed on a database that holds real history (a draw and an allocation).
  {
    const timings: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const dbPath = path.join(tempDir, `reopen-${run}.simpletab.db`);
      rmSync(dbPath, { force: true });
      const engine = HostEngine.open(dbPath, { initialState: generated.state });
      assertOk(await engine.submit({ type: "draw.generate", payload: { roundId: "round-6", seed: 4246 } }, TAB_DIRECTOR_ACTOR), "reopen setup draw");
      assertOk(await engine.submit({ type: "allocation.auto", payload: { roundId: "round-6", panelSize: 3 } }, TAB_DIRECTOR_ACTOR), "reopen setup allocation");
      await engine.close();
      const measured = await timeOperation(async () => {
        const reopened = HostEngine.open(dbPath);
        if (!reopened.integrity.ok) throw new Error(`Fast check failed on reopen: ${reopened.integrity.reason}`);
        await reopened.close();
      });
      timings.push(measured.ms);
    }
    const medianMs = median(timings);
    const targetMs = targets["HostEngine reopen fast check"] ?? null;
    rows.push({ operation: "HostEngine reopen fast check", medianMs, targetMs, maxLagMs: 0, passed: targetMs === null || medianMs <= targetMs });
  }

  const date = new Date().toISOString().slice(0, 10);
  const reportDir = path.resolve("docs/checks");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `bench-${date}-${size}.md`);
  const header = `| Operation | Median (3 runs) | Target | Max event-loop lag | Result |\n|---|---:|---:|---:|---|`;
  const table = rows.map((row) =>
    `| ${row.operation} | ${row.medianMs.toFixed(1)} ms | ${row.targetMs === null ? "record only" : `${row.targetMs} ms`} | ${row.maxLagMs.toFixed(1)} ms | ${row.passed ? "PASS" : "FAIL"} |`,
  ).join("\n");
  const output = `# SimpleTab benchmark: ${size}\n\n${header}\n${table}\n\nGenerated: ${generated.teamCount} teams, ${generated.adjudicatorCount} adjudicators, ${generated.institutionCount} institutions, ${generated.venueCount} venues.\n`;
  writeFileSync(reportPath, output);
  rmSync(tempDir, { recursive: true, force: true });
  return { rows, output };
}
