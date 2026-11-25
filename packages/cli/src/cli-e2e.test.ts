import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostEngine } from "../../host/src/node/engine/engine";
import { HostServiceImpl } from "../../host/src/node/host-service";
import { makeState } from "../../host/src/node/publish/publish-test-fixtures";
import { defaultContext, run } from "./run";

/** A Windows file lock can outlive the service that held it; the next test can still use its dir. */
function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") return;
    throw error;
  }
}

interface CliResult {
  code: number;
  values: unknown[];
  err: string[];
}

/**
 * The CLI as a real device: real pairing over TLS, a real host, and one process-like `run` call per
 * command. No fakes here; only the person approving the six words is done through the host service.
 */
describe("simpletab CLI end to end", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(() => removeTempDir(dir));
    return dir;
  }

  async function makeHost(): Promise<{ host: HostServiceImpl; address: string }> {
    const dir = tempDir("simpletab-cli-e2e-host-");
    const dbPath = path.join(dir, "cli-test.simpletab.db");
    const state = makeState({ releaseResults: true });
    const seed = HostEngine.open(dbPath, { initialState: state });
    await seed.close();

    const host = new HostServiceImpl();
    host.setCollabListen({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => host.onStop());
    await host.openTournament(dbPath);
    const devices = await host.setDevicesEnabled(true);
    expect(devices.running).toBe(true);
    return { host, address: `127.0.0.1:${devices.port}` };
  }

  function cli(host: HostServiceImpl): {
    call(argv: string[]): Promise<CliResult>;
    pair(roleId: string, address: string, dir: string, name: string): Promise<CliResult>;
  } {
    const base = defaultContext();

    async function call(argv: string[]): Promise<CliResult> {
      const out: string[] = [];
      const err: string[] = [];
      const ctx = {
        ...base,
        stdout: (text: string) => { out.push(text); },
        stderr: (text: string) => { err.push(text); },
      };
      const code = await run(argv, ctx);
      return { code, values: out.map((text) => JSON.parse(text) as unknown), err };
    }

    async function pair(roleId: string, address: string, dir: string, name: string): Promise<CliResult> {
      const out: string[] = [];
      const err: string[] = [];
      const ctx = {
        ...base,
        stdout: (text: string) => { out.push(text); },
        stderr: (text: string) => { err.push(text); },
      };
      const { code } = await host.issuePairingCode(roleId);
      const promise = run(["pair", address, code, "--name", name, "--dir", dir, "--timeout", "10"], ctx);

      await vi.waitFor(
        async () => {
          expect((await host.getDevicesStatus()).pendingJoins).toHaveLength(1);
        },
        { timeout: 10_000, interval: 50 },
      );
      const join = (await host.getDevicesStatus()).pendingJoins[0]!;
      await vi.waitFor(() => expect(err.join("\n")).toContain("six words"));
      expect(err).toContain(join.words.join(" "));
      await host.approveJoin(join.joinId);

      const exitCode = await promise;
      return { code: exitCode, values: out.map((text) => JSON.parse(text) as unknown), err };
    }

    return { call, pair };
  }

  it("pairs as AI, proposes changes, and lets a person resolve them", async () => {
    const { host, address } = await makeHost();
    const tools = cli(host);
    const aiDir = tempDir("simpletab-cli-e2e-ai-");

    const paired = await tools.pair("ai", address, aiDir, "AI agent");
    expect(paired.code).toBe(0);
    expect(paired.values[0]).toMatchObject({
      paired: true,
      url: `wss://${address}`,
      deviceName: "AI agent",
      role: { id: "ai", name: "AI" },
    });

    const status = await tools.call(["status", "--dir", aiDir, "--timeout", "10"]);
    expect(status.code).toBe(0);
    expect(status.values[0]).toMatchObject({
      connected: true,
      role: { id: "ai", proposalsOnly: true },
      tournament: { slug: "publish-test" },
      pendingProposals: 0,
    });

    const teams = await tools.call(["show", "teams", "--dir", aiDir, "--timeout", "10"]);
    expect(teams.code).toBe(0);
    const teamList = teams.values[0] as Array<{ id: string; name: string }>;
    expect(teamList.map((team) => team.id)).toEqual(["team-og", "team-oo"]);
    expect(teamList[0]!.name).toBeTruthy();

    const proposed = await tools.call([
      "op", "release.set_gate", "--json", '{"gate":"tab_team","released":true}',
      "--dir", aiDir, "--timeout", "10",
    ]);
    expect(proposed.code).toBe(0);
    expect(proposed.values[0]).toMatchObject({ ok: true });
    const proposalId = (proposed.values[0] as { committedPayload: { id: string } }).committedPayload.id;
    expect(proposalId).toMatch(/^proposal-/);
    expect(proposed.err).toContain(`Proposal ${proposalId} is waiting for a person to accept it in the app.`);

    const before = await host.getState();
    expect(before?.tournament).toBeDefined();
    expect(before?.proposals?.find((p) => p.id === proposalId)?.status).toBe("pending");

    const pending = await tools.call(["proposals", "list", "--dir", aiDir, "--timeout", "10"]);
    expect(pending.code).toBe(0);
    expect(pending.values[0]).toMatchObject([{ id: proposalId, status: "pending", type: "release.set_gate" }]);

    expect(await host.submit({ type: "proposal.accept", payload: { proposalId } })).toMatchObject({ ok: true });
    const all = await tools.call(["proposals", "list", "--all", "--dir", aiDir, "--timeout", "10"]);
    expect(all.code).toBe(0);
    expect(all.values[0]).toMatchObject([{ id: proposalId, status: "accepted", resolvedBy: expect.any(String) }]);

    const refused = await tools.call(["proposals", "accept", proposalId, "--dir", aiDir]);
    expect(refused.code).toBe(1);
    expect(refused.err).toEqual([
      "Only a person can accept or reject proposals; this CLI is paired with the AI role.",
    ]);

    const team = (teams.values[0] as Array<{ id: string }>)[1]!;
    const forbidden = await tools.call([
      "op", "team.update", "--json", JSON.stringify({ team: { ...team, name: "Nope" } }),
      "--dir", aiDir, "--timeout", "10",
    ]);
    expect(forbidden.code).toBe(1);
    expect(forbidden.values[0]).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(forbidden.err.join("\n")).toMatch(/only propose changes/i);

    const directorDir = tempDir("simpletab-cli-e2e-director-");
    const directorPaired = await tools.pair("tab_director", address, directorDir, "Director CLI");
    expect(directorPaired.code).toBe(0);

    const second = await tools.call([
      "op", "release.set_gate", "--json", '{"gate":"tab_team","released":false}',
      "--dir", aiDir, "--timeout", "10",
    ]);
    expect(second.code).toBe(0);
    const secondId = (second.values[0] as { committedPayload: { id: string } }).committedPayload.id;

    const rejected = await tools.call([
      "proposals", "reject", secondId, "--reason", "Not yet", "--dir", directorDir, "--timeout", "10",
    ]);
    expect(rejected.code).toBe(0);
    expect(rejected.values[0]).toMatchObject({ ok: true });

    const directorList = await tools.call(["proposals", "list", "--all", "--dir", directorDir, "--timeout", "10"]);
    expect(directorList.code).toBe(0);
    expect(directorList.values[0]).toMatchObject([
      { id: proposalId, status: "accepted" },
      { id: secondId, status: "rejected", reason: "Not yet" },
    ]);
  }, 60_000);
});
