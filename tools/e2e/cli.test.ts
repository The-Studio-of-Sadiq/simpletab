import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BallotSubmission, Debate, Team, Tournament } from "@simpletab/core/types";
import { afterAll, describe, expect, it } from "vitest";
import { createSeededRng } from "../../packages/core/src/lib/draw/rng";
import { simulateBallot } from "../../packages/core/src/test/tournamentFixtures";
import { HostEngine } from "../../packages/host/src/node/engine/engine";
import { HostServiceImpl } from "../../packages/host/src/node/host-service";
import { generateBenchTournament } from "../bench/generate";

/**
 * M6 checkpoint (`npm run e2e:cli`): a WUDC-size tournament on a real host, with the BUILT
 * `simpletab` command run as a separate OS process for every CLI command. Passes when:
 * - an AI-paired CLI can propose one change in each of draw, allocation, results, break and
 *   releases, and a person accepts all five through the host;
 * - the host's committed ops keep the proposer's `actorType: "ai"` in `proposedBy`, and the
 *   changelog contains each accept;
 * - an AI cannot resolve proposals, and an op outside the five categories is refused with
 *   `FORBIDDEN`;
 * - an expected version that the host changes before acceptance produces `VERSION_CONFLICT`,
 *   and a tab-director CLI can reject the stale proposal with a reason;
 * - the CLI never loads `better-sqlite3`;
 * - p95 wall time of the spawned non-pair commands stays under 10 s.
 */

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/cli");
const CLI_BIN = path.join(CLI_DIR, "bin", "simpletab.mjs");
const CLI_BUNDLE = path.join(CLI_DIR, "lib", "simpletab.js");
const P95_LIMIT_MS = 10_000;

// `npm test` runs this file too (the e2e project), where the bundle may not be built yet.
if (!existsSync(CLI_BUNDLE)) {
  execFileSync(process.execPath, [path.join(CLI_DIR, "scripts", "build.mjs")], { cwd: CLI_DIR, stdio: "inherit" });
}

type JsonRecord = Record<string, unknown>;

interface CliResult {
  code: number | null;
  value: unknown;
  stdout: string;
  stderr: string;
}

interface CliOptions {
  label: string;
  execArgv?: string[];
  timed?: boolean;
  onStderr?: (chunk: string) => void;
  expectJson?: boolean;
}

interface SlotView {
  teamId: string;
  teamName?: string;
}

interface DebateView {
  id: string;
  roundId: string;
  teams: Record<string, SlotView | undefined>;
  adjudicators?: { chairId?: string; panellistIds?: string[]; traineeIds?: string[] };
}

interface BallotView {
  id: string;
  debateId: string;
  confirmed: boolean;
  discarded: boolean;
}

interface BreakCategoryView {
  id: string;
  generatedBreak?: { breakingTeamIds: string[] };
}

interface ProposalView {
  id: string;
  status: string;
  type: string;
  proposedBy?: { ref?: string };
  resolvedBy?: string;
  reason?: string;
}

interface HostView {
  seq: number;
  debates: DebateView[];
  ballots: BallotView[];
  breakCategories: BreakCategoryView[];
  tournament: { id: string; preferences: Record<string, unknown> };
  proposals: ProposalView[];
  versions: Record<string, number>;
}

interface ProposalInfo {
  area: string;
  type: string;
  id: string;
  payload: JsonRecord;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label}: expected a JSON object`);
  return value;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}: expected a JSON array`);
  return value;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}: expected a string`);
  return value;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function parseCliJson(stdout: string, label: string): unknown {
  const text = stdout.trim();
  if (text.length === 0) throw new Error(`${label}: the CLI printed no JSON on stdout`);
  try {
    // Every command writes exactly one JSON value (pretty-printed, so it spans several lines).
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label}: stdout was not one JSON value: ${text.slice(0, 200)}`);
  }
}

async function readHost(host: HostServiceImpl): Promise<HostView> {
  const state = await host.getState();
  if (state === null) throw new Error("The host has no tournament open");
  return {
    seq: state.seq,
    debates: state.debates as unknown as DebateView[],
    ballots: state.ballots as unknown as BallotView[],
    breakCategories: state.breakCategories as unknown as BreakCategoryView[],
    tournament: state.tournament as unknown as HostView["tournament"],
    proposals: (state.proposals ?? []) as unknown as ProposalView[],
    versions: state.versions,
  };
}

function debateById(view: HostView, id: string): DebateView {
  const debate = view.debates.find((item) => item.id === id);
  if (debate === undefined) throw new Error(`No debate ${id} in the host state`);
  return debate;
}

function ballotById(view: HostView, id: string): BallotView {
  const ballot = view.ballots.find((item) => item.id === id);
  if (ballot === undefined) throw new Error(`No ballot ${id} in the host state`);
  return ballot;
}

function breakById(view: HostView, id: string): BreakCategoryView {
  const category = view.breakCategories.find((item) => item.id === id);
  if (category === undefined) throw new Error(`No break category ${id} in the host state`);
  return category;
}

function proposalById(view: HostView, id: string): ProposalView {
  const proposal = view.proposals.find((item) => item.id === id);
  if (proposal === undefined) throw new Error(`No proposal ${id} in the host state`);
  return proposal;
}

describe("M6 CLI and AI proposals checkpoint (e2e:cli)", () => {
  const dirs: string[] = [];
  const services: HostServiceImpl[] = [];
  const children = new Set<ChildProcess>();
  const timings: number[] = [];

  afterAll(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    for (const service of services.reverse()) await service.onStop().catch(() => undefined);
    for (const dir of dirs.reverse()) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Windows may keep SQLite files locked for a moment; temp folders are left to the OS.
      }
    }
  });

  function tempDir(label: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), `simpletab-cli-m6-${label}-`));
    dirs.push(dir);
    return dir;
  }

  function spawnCli(args: string[], options: CliOptions): Promise<CliResult> {
    const started = performance.now();
    const child = spawn(process.execPath, [...(options.execArgv ?? []), CLI_BIN, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: Buffer | string) => { stdout += String(chunk); });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      stderr += text;
      options.onStderr?.(text);
    });
    const exit = new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`${options.label}: the CLI process did not exit within 60 s`));
      }, 60_000);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("close", (code) => { clearTimeout(timeout); resolve(code); });
    });
    const finish = (): void => {
      children.delete(child);
      if (options.timed !== false) timings.push(performance.now() - started);
    };
    return exit.then(
      (code) => {
        finish();
        return {
          code,
          stdout,
          stderr,
          // A local refusal (for example an AI trying to accept) prints no JSON at all.
          value: options.expectJson === false ? undefined : parseCliJson(stdout, options.label),
        };
      },
      (error: unknown) => {
        finish();
        throw error;
      },
    );
  }

  /** Every command except `pair` uses a 10 s host timeout and is included in the timing summary. */
  function cli(
    dir: string,
    args: string[],
    label: string,
    execArgv?: string[],
    expectJson = true,
  ): Promise<CliResult> {
    return spawnCli([...args, "--dir", dir, "--timeout", "10"], { label, execArgv, expectJson });
  }

  async function pairAs(
    host: HostServiceImpl,
    roleId: string,
    address: string,
    dir: string,
    name: string,
  ): Promise<CliResult> {
    const { code } = await host.issuePairingCode(roleId);
    const stderr: string[] = [];
    const pairing = spawnCli(["pair", address, code, "--name", name, "--dir", dir], {
      label: `pair ${name}`,
      timed: false,
      onStderr: (chunk) => stderr.push(chunk),
    });
    await until(async () => (await host.getDevicesStatus()).pendingJoins.length > 0, 20_000, `${roleId} join request`);
    const join = (await host.getDevicesStatus()).pendingJoins[0]!;
    expect(join.words, "six pairing words").toHaveLength(6);
    await until(() => stderr.join("").includes(join.words.join(" ")), 20_000, `${roleId} words on stderr`);
    await host.approveJoin(join.joinId);
    const result = await pairing;
    expect(result.code, `pair ${name} exit code`).toBe(0);
    return result;
  }

  function submitRecord(result: CliResult, label: string): JsonRecord {
    expect(result.code, `${label} exit code`).toBe(0);
    const record = asRecord(result.value, label);
    expect(record["ok"], `${label} ok`).toBe(true);
    return record;
  }

  async function propose(
    aiDir: string,
    area: string,
    type: string,
    payload: JsonRecord,
    extraArgs: string[] = [],
  ): Promise<ProposalInfo> {
    const label = `op ${type} (${area})`;
    const result = await cli(aiDir, ["op", type, "--json", JSON.stringify(payload), ...extraArgs], label);
    const submitted = submitRecord(result, label);
    const committed = asRecord(submitted["committedPayload"], `${label} committedPayload`);
    const id = asString(committed["id"], `${label} proposal id`);
    expect(id).toMatch(/^proposal-/);
    expect(result.stderr).toContain(`Proposal ${id} is waiting for a person to accept it in the app.`);
    return { area, type, id, payload };
  }

  it("pairs an AI CLI, proposes five changes, and resolves them on a WUDC-size host", async () => {
    const { state: bench } = generateBenchTournament("wudc");
    const hostDir = tempDir("host");
    const dbPath = path.join(hostDir, `${bench.tournament.slug}.simpletab.db`);
    const seed = HostEngine.open(dbPath, { initialState: bench });
    await seed.close();

    const host = new HostServiceImpl();
    services.push(host);
    host.setCollabListen({ port: 0, host: "127.0.0.1" });
    await host.openTournament(dbPath);
    const devices = await host.setDevicesEnabled(true);
    expect(devices.running).toBe(true);
    const address = `127.0.0.1:${devices.port}`;

    // Real setup on the host: the sixth preliminary round has no draw, panels or ballot yet,
    // so the AI's draw/allocation/results proposals need no override of a hard rule.
    const latestRound = [...bench.rounds]
      .filter((round) => round.stage === "preliminary")
      .sort((a, b) => b.seq - a.seq)[0]!;
    const drawn = await host.submit({ type: "draw.generate", payload: { roundId: latestRound.id, seed: 4246 } });
    if (!drawn.ok) throw new Error(`setup draw failed: ${drawn.errors.join("; ")}`);
    const allocated = await host.submit({ type: "allocation.auto", payload: { roundId: latestRound.id, panelSize: 3 } });
    if (!allocated.ok) throw new Error(`setup allocation failed: ${allocated.errors.join("; ")}`);

    const seeded = await host.getState();
    if (seeded === null) throw new Error("The host has no tournament after setup");
    const setupDebate = seeded.debates.find((debate) => debate.roundId === latestRound.id)!;
    const draftBallot = simulateBallot(
      setupDebate as unknown as Debate,
      seeded.teams as unknown as Team[],
      seeded.tournament as unknown as Tournament,
      createSeededRng(999),
      { confirmed: false, id: "ballot-m6-draft" },
    );
    const entered = await host.submit({ type: "ballot.enter", payload: { ballot: draftBallot } });
    if (!entered.ok) throw new Error(`setup ballot failed: ${entered.errors.join("; ")}`);
    const initial = await readHost(host);

    const aiDir = tempDir("ai");
    const paired = await pairAs(host, "ai", address, aiDir, "AI agent");
    expect(asRecord(paired.value, "pair AI")).toMatchObject({ paired: true, role: { id: "ai" } });

    const status = asRecord((await cli(aiDir, ["status"], "status")).value, "status");
    expect(status).toMatchObject({ connected: true, role: { id: "ai", proposalsOnly: true } });

    // All ids below come from the AI's own role-filtered CLI view, as an agent would read them.
    const rounds = asArray((await cli(aiDir, ["show", "rounds"], "show rounds")).value, "rounds").map((item) => asRecord(item, "round"));
    const aiRound = rounds
      .filter((round) => round["stage"] === "preliminary")
      .sort((a, b) => Number(b["seq"]) - Number(a["seq"]))[0]!;
    const roundId = asString(aiRound["id"], "latest round id");
    expect(roundId).toBe(latestRound.id);

    const teams = asArray((await cli(aiDir, ["show", "teams"], "show teams")).value, "teams").map((item) => asRecord(item, "team"));
    expect(teams.length).toBe(400);
    const viewDebates = asArray((await cli(aiDir, ["show", "draw", "--round", roundId], "show draw")).value, "draw")
      .map((item) => asRecord(item, "debate"));
    // The draft ballot belongs to one debate; matchups of a debate with a ballot are hard-locked.
    const editableDebates = viewDebates.filter((item) => item["id"] !== draftBallot.debateId);
    expect(editableDebates.length).toBeGreaterThan(1);
    const slotA = { debateId: asString(editableDebates[0]!["id"], "debate A"), side: "OG" };
    const slotB = { debateId: asString(editableDebates[1]!["id"], "debate B"), side: "CO" };
    expect(slotA.debateId).not.toBe(slotB.debateId);

    const viewBallots = asArray((await cli(aiDir, ["show", "results", "--round", roundId], "show results")).value, "results")
      .map((item) => asRecord(item, "ballot"));
    const ballotId = viewBallots.find((item) => item["id"] === draftBallot.id)
      ? draftBallot.id
      : asString(viewBallots[0]!["id"], "draft ballot id");

    const viewBreaks = asArray((await cli(aiDir, ["show", "break"], "show break")).value, "break").map((item) => asRecord(item, "break category"));
    const breakCategoryId = asString(viewBreaks[0]!["id"], "break category id");
    expect(breakCategoryId).toBe("bc-open");

    const stateView = asRecord((await cli(aiDir, ["show", "state"], "show state")).value, "show state");
    const versions = asRecord(stateView["versions"], "show state versions");
    const tournamentKey = `tournament:${bench.tournament.id}`;
    const seenVersion = versions[tournamentKey];
    expect(typeof seenVersion).toBe("number");

    const releaseNow = initial.tournament.preferences["releaseTeamTab"] === true;
    const proposals: ProposalInfo[] = [];
    proposals.push(await propose(aiDir, "draw", "draw.swap_teams", { slotA, slotB }));
    proposals.push(await propose(aiDir, "allocation", "allocation.swap_rooms", {
      debateIdA: slotA.debateId,
      debateIdB: slotB.debateId,
    }));
    proposals.push(await propose(aiDir, "results", "ballot.discard", { ballotId }));
    proposals.push(await propose(aiDir, "break", "break.compute", {
      categoryId: breakCategoryId,
      // The sixth preliminary is deliberately unfinished. Its warning is overridable; no hard
      // constraint (tie at the cutoff, started elimination round, ...) is relaxed here.
      override: { reason: "Provisional break from five played rounds for the M6 checkpoint" },
    }));
    proposals.push(await propose(aiDir, "releases", "release.set_gate", {
      gate: "tab_team",
      released: !releaseNow,
    }));
    expect(proposals.map((item) => item.area)).toEqual(["draw", "allocation", "results", "break", "releases"]);

    const beforeAcceptance = await readHost(host);
    // The proposals were committed (pairing and proposal.create also advance the op log), but none
    // of them has changed a tournament record yet.
    expect(beforeAcceptance.seq).toBeGreaterThan(initial.seq);
    expect(debateById(beforeAcceptance, slotA.debateId).teams.OG?.teamId)
      .toBe(debateById(initial, slotA.debateId).teams.OG?.teamId);
    expect(debateById(beforeAcceptance, slotB.debateId).adjudicators?.chairId)
      .toBe(debateById(initial, slotB.debateId).adjudicators?.chairId);
    expect(ballotById(beforeAcceptance, ballotId).discarded).toBe(false);
    expect(breakById(beforeAcceptance, breakCategoryId).generatedBreak).toBeUndefined();
    expect(beforeAcceptance.tournament.preferences["releaseTeamTab"] === true).toBe(releaseNow);
    for (const proposal of proposals) {
      expect(proposalById(beforeAcceptance, proposal.id), `${proposal.area} proposal`).toMatchObject({ status: "pending" });
    }

    const pendingList = asArray((await cli(aiDir, ["proposals", "list"], "proposals list")).value, "proposals list")
      .map((item) => asRecord(item, "proposal"));
    expect(new Set(pendingList.map((item) => item["id"]))).toEqual(new Set(proposals.map((item) => item.id)));
    expect(pendingList.every((item) => item["status"] === "pending")).toBe(true);

    const accepts: Array<{ seq: number; payload: JsonRecord }> = [];
    for (const proposal of proposals) {
      const result = await host.submit({ type: "proposal.accept", payload: { proposalId: proposal.id } });
      if (!result.ok) throw new Error(`accept ${proposal.area} failed: ${result.code} ${result.errors.join("; ")}`);
      const payload = asRecord(result.committedPayload, `accept ${proposal.area} payload`);
      expect(payload, `${proposal.area} accept`).toMatchObject({
        op: { type: proposal.type },
        proposedBy: { type: "ai", actorType: "ai" },
        acceptedBy: expect.any(String),
      });
      accepts.push({ seq: result.seq, payload });
    }

    const after = await readHost(host);
    expect(after.debates.map((debate) => debate.id)).toEqual(initial.debates.map((debate) => debate.id));
    const oldA = debateById(initial, slotA.debateId);
    const oldB = debateById(initial, slotB.debateId);
    expect(debateById(after, slotA.debateId).teams.OG?.teamId).toBe(oldB.teams.CO?.teamId);
    expect(debateById(after, slotB.debateId).teams.CO?.teamId).toBe(oldA.teams.OG?.teamId);
    expect(debateById(after, slotA.debateId).adjudicators?.chairId).toBe(oldB.adjudicators?.chairId);
    expect(debateById(after, slotB.debateId).adjudicators?.chairId).toBe(oldA.adjudicators?.chairId);
    expect(ballotById(after, ballotId)).toMatchObject({ discarded: true, confirmed: false });
    expect(breakById(after, breakCategoryId).generatedBreak?.breakingTeamIds).toHaveLength(8);
    expect(after.tournament.preferences["releaseTeamTab"] === true).toBe(!releaseNow);
    for (const proposal of proposals) {
      expect(proposalById(after, proposal.id), `${proposal.area} proposal`).toMatchObject({
        status: "accepted",
        resolvedBy: expect.any(String),
      });
    }

    const chain = await host.getChangelog(initial.seq);
    for (const accepted of accepts) {
      const entry = chain.find((item) => item.entry.seq === accepted.seq);
      expect(entry, `changelog entry at seq ${accepted.seq}`).toBeDefined();
      expect(entry!.entry.opType).toBe("proposal.accept");
      expect(asRecord(accepted.payload["proposedBy"], "proposedBy")["actorType"]).toBe("ai");
    }

    const aiAccept = await cli(
      aiDir, ["proposals", "accept", proposals[0]!.id], "AI proposals accept refusal", undefined, false,
    );
    expect(aiAccept.code).toBe(1);
    expect(aiAccept.stderr).toContain("Only a person can accept or reject proposals");

    const forbidden = await cli(aiDir, [
      "op", "team.update", "--json", JSON.stringify({ team: { ...teams[0]!, name: "Nope" } }),
    ], "team.update refusal");
    expect(forbidden.code).toBe(1);
    expect(asRecord(forbidden.value, "team.update refusal")).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(forbidden.stderr).toContain("The AI can only propose changes to the draw, allocation, results, break and releases");

    // A person changes the same record the stale proposal read, after the proposal was created.
    const staleState = asRecord((await cli(aiDir, ["show", "state"], "show state before stale proposal")).value, "stale state");
    const staleVersion = asRecord(staleState["versions"], "stale versions")[tournamentKey];
    const stale = await propose(aiDir, "stale release", "release.set_gate", {
      gate: "tab_speaker",
      released: true,
    }, ["--expect", `${tournamentKey}=${String(staleVersion)}`]);
    const direct = await host.submit({ type: "release.set_gate", payload: { gate: "tab_motions", released: true } });
    if (!direct.ok) throw new Error(`host release change failed: ${direct.errors.join("; ")}`);
    const conflict = await host.submit({ type: "proposal.accept", payload: { proposalId: stale.id } });
    expect(conflict).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    expect(proposalById(await readHost(host), stale.id).status).toBe("pending");

    const directorDir = tempDir("director");
    const directorPaired = await pairAs(host, "tab_director", address, directorDir, "Director CLI");
    expect(asRecord(directorPaired.value, "pair director")).toMatchObject({ paired: true, role: { id: "tab_director" } });
    const rejected = submitRecord(
      await cli(directorDir, ["proposals", "reject", stale.id, "--reason", "Stale"], "director reject"),
      "director reject",
    );
    expect(rejected["ok"]).toBe(true);
    const allList = asArray((await cli(directorDir, ["proposals", "list", "--all"], "director list --all")).value, "proposals list --all")
      .map((item) => asRecord(item, "proposal"));
    expect(allList.find((item) => item["id"] === stale.id)).toMatchObject({ status: "rejected", reason: "Stale" });

    // The CLI bundle must never load the host's database driver, even with a preload that traps it.
    const guardDir = tempDir("guard");
    const guardPath = path.join(guardDir, "no-sqlite.cjs");
    writeFileSync(guardPath, [
      'const Module = require("node:module");',
      "const load = Module._load;",
      'Module._load = function (request, parent, isMain) {',
      '  if (request === "better-sqlite3") throw new Error("CLI loaded better-sqlite3");',
      "  return load.call(this, request, parent, isMain);",
      "};",
      "",
    ].join("\n"));
    const guarded = await cli(aiDir, ["status"], "status with better-sqlite3 trap", ["--require", guardPath]);
    expect(guarded.code).toBe(0);
    expect(asRecord(guarded.value, "guarded status")["connected"]).toBe(true);
    // The trap above covers require(); this covers an ESM import of it too.
    expect(readFileSync(CLI_BUNDLE, "utf8")).not.toContain("better-sqlite3");

    const p50 = percentile(timings, 50);
    const p95 = percentile(timings, 95);
    console.log("M6 checkpoint: WUDC-size host, built CLI as separate processes, five areas resolved by a person");
    console.log(`e2e:cli: ${timings.length} commands, p50 ${p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms`);
    expect(p95).toBeLessThan(P95_LIMIT_MS);
  }, 180_000);
});
