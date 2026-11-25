import { describe, expect, it, vi } from "vitest";
import type { OpRequest, ProposalRecord } from "@simpletab/core/ops";
import type { Role } from "@simpletab/core/permissions";
import type {
  CollabPairOptions,
  CollabPairResult,
} from "../../host/src/node/collab/device-client";
import type {
  DeviceModeStatus,
  ProjectedState,
  SubmitResult,
} from "../../host/src/common/host-protocol";
import type { HostIdentity } from "../../host/src/common/collab-protocol";
import type { StoredPairing } from "../../host/src/node/device/pairing-store";
import { plainPairFailure } from "../../host/src/node/device/pairing-text";
import { makeState, DEBATE_ID, ROUND_ID } from "../../host/src/node/publish/publish-test-fixtures";
import type { CliContext, PairingStoreLike } from "./run";
import { run } from "./run";
import type { RemoteHooks, RemoteLike } from "./session";

const FINGERPRINT = "a".repeat(64);
const HOST: HostIdentity = { hostNumber: 1, hostId: "host-1", hostRank: 1, certFingerprint: FINGERPRINT };
const AI_ROLE: Role = { id: "ai", name: "AI", permissions: [], proposalsOnly: true };
const HUMAN_ROLE: Role = { id: "tab_director", name: "Tab director", permissions: [] };

function pairingFor(role: Role): StoredPairing {
  return {
    version: 1,
    url: "wss://127.0.0.1:47820",
    deviceId: "dev-1",
    deviceName: "Test CLI",
    role,
    hostFingerprint: FINGERPRINT,
    host: HOST,
    certificate: { certPem: "cert", keyPem: "key", fingerprint: FINGERPRINT },
    pairedAt: "2026-11-25T09:00:00.000Z",
  };
}

function okPair(role: Role): CollabPairResult {
  return { ok: true, deviceId: "dev-2", role, host: HOST, hostFingerprint: FINGERPRINT };
}

function stateWith(overrides: Partial<ProjectedState> = {}): ProjectedState {
  return {
    ...makeState(),
    seq: 7,
    roleId: "ai",
    versions: {},
    proposals: [],
    ...overrides,
  };
}

function proposal(id: string, status: ProposalRecord["status"], createdAt: string): ProposalRecord {
  return {
    id,
    op: { type: "release.set_gate", payload: { gate: "tab_team", released: true } },
    proposedBy: { ref: `device:${id}`, type: "ai", role: AI_ROLE, isHostOwner: false },
    createdAt,
    status,
  };
}

class FakeRemote implements RemoteLike {
  readonly hooks: RemoteHooks;
  readonly submitted: OpRequest[] = [];
  stopped = false;
  nextResult: SubmitResult = { ok: true, seq: 8, writes: [], committedPayload: { id: "p-1" } };

  constructor(
    private readonly state: ProjectedState,
    hooks: RemoteHooks,
    private readonly connected: boolean,
  ) {
    this.hooks = hooks;
  }

  start(): void {}
  stop(): void { this.stopped = true; }
  isConnected(): boolean { return this.connected; }
  getState(): ProjectedState | null { return this.state; }
  status(): DeviceModeStatus {
    return {
      connection: this.connected ? "connected" : "connecting",
      deviceId: "dev-1",
      hostAddress: "127.0.0.1:47820",
      deviceName: "Test CLI",
      roleId: this.state.roleId,
      roleName: "AI",
      queued: [],
      rejected: [],
      presence: [],
    };
  }
  async submit(op: OpRequest): Promise<SubmitResult> {
    this.submitted.push(op);
    return this.nextResult;
  }
  removed(): void { this.hooks.onRemoved?.(); }
}

interface HarnessOptions {
  paired?: boolean;
  role?: Role;
  state?: ProjectedState;
  connected?: boolean;
  pairResult?: CollabPairResult;
  result?: SubmitResult;
  removeImmediately?: boolean;
  files?: Record<string, string>;
  stdin?: string;
}

function harness(options: HarnessOptions = {}) {
  const role = options.role ?? AI_ROLE;
  const state = options.state ?? stateWith();
  const out: string[] = [];
  const err: string[] = [];
  const files = options.files ?? {};
  let stored = options.paired === false ? undefined : pairingFor(role);
  let remote: FakeRemote | undefined;
  let pairOpts: CollabPairOptions | undefined;

  const store: PairingStoreLike = {
    directory: "/fake/cli",
    load: vi.fn(() => stored),
    save: vi.fn((value: StoredPairing) => { stored = value; }),
    clear: vi.fn(() => { stored = undefined; }),
  };

  const ctx: CliContext = {
    store: vi.fn(() => store),
    stdout: (text) => { out.push(text); },
    stderr: (text) => { err.push(text); },
    readStdin: vi.fn(async () => options.stdin ?? ""),
    readFile: (filePath) => {
      if (!(filePath in files)) throw new Error(`No such file: ${filePath}`);
      return files[filePath]!;
    },
    hostname: () => "test-host",
    now: () => new Date("2026-11-25T09:00:00.000Z"),
    pair: vi.fn(async (opts: CollabPairOptions) => {
      pairOpts = opts;
      opts.onWords(["one", "two", "three", "four", "five", "six"]);
      return options.pairResult ?? okPair(role);
    }),
    openRemote: (_pairing, hooks) => {
      remote = new FakeRemote(state, hooks, options.connected ?? true);
      if (options.result !== undefined) remote.nextResult = options.result;
      if (options.removeImmediately === true) remote.removed();
      return remote;
    },
  };

  return {
    ctx,
    out,
    err,
    store,
    state,
    get remote(): FakeRemote {
      if (remote === undefined) throw new Error("No remote was opened.");
      return remote;
    },
    get pairOpts(): CollabPairOptions {
      if (pairOpts === undefined) throw new Error("pair was not called.");
      return pairOpts;
    },
    get pairing(): StoredPairing | undefined { return stored; },
  };
}

function jsonOut(out: string[]): unknown {
  expect(out).toHaveLength(1);
  return JSON.parse(out[0]!);
}

describe("usage errors", () => {
  const cases: string[][] = [
    ["pair"],
    ["pair", "127.0.0.1:47820"],
    ["pair", "not an address", "12345678"],
    ["pair", "127.0.0.1:47820", "1234567a"],
    ["pair", "127.0.0.1:47820", "12345678", "extra"],
    ["pair", "127.0.0.1:47820", "12345678", "--name"],
    ["leave", "extra"],
    ["leave", "--bogus"],
    ["status", "extra"],
    ["show"],
    ["show", "unknown"],
    ["show", "teams", "extra"],
    ["show", "teams", "--round"],
    ["op"],
    ["op", "team.update"],
    ["op", "team.update", "--json", "{"],
    ["op", "team.update", "--json", "{}", "--file", "payload.json"],
    ["op", "team.update", "--file", "payload.json", "--expect", "bad"],
    ["op", "team.update", "--json", "{}", "--expect", "team:t1=x"],
    ["proposals"],
    ["proposals", "unknown"],
    ["proposals", "list", "extra"],
    ["proposals", "list", "--reason", "no"],
    ["proposals", "accept"],
    ["proposals", "accept", "p-1", "extra"],
    ["proposals", "reject"],
    ["proposals", "reject", "p-1", "--reason"],
    ["--timeout", "0", "status"],
  ];

  it.each(cases)("exits 2 for %j", async (...argv) => {
    const h = harness({ files: { "payload.json": "{}" } });
    expect(await run(argv, h.ctx)).toBe(2);
    expect(h.out).toEqual([]);
    expect(h.err.join("\n")).not.toContain("cert");
  });

  it("prints usage on stderr with no arguments and on stdout for help", async () => {
    const none = harness();
    expect(await run([], none.ctx)).toBe(2);
    expect(none.err[0]).toContain("Usage:");

    for (const argv of [["help"], ["--help"], ["status", "--help"]]) {
      const h = harness();
      expect(await run(argv, h.ctx)).toBe(0);
      expect(h.out[0]).toContain("Usage:");
      expect(h.err).toEqual([]);
    }
  });

  it("rejects an unknown command", async () => {
    const h = harness();
    expect(await run(["frobnicate"], h.ctx)).toBe(2);
    expect(h.err.join("\n")).toContain("Unknown command");
  });
});

describe("pair and leave", () => {
  it("shows the words, saves the pairing and prints the paired record", async () => {
    const h = harness({ paired: false });
    expect(await run(["pair", "192.168.1.20:47820", "1234 5678"], h.ctx)).toBe(0);
    expect(h.err).toContain("Check that the host shows these six words, then approve this device there:");
    expect(h.err).toContain("one two three four five six");
    expect(h.err).toContain('Paired with wss://192.168.1.20:47820 as "simpletab CLI on test-host" (role: AI).');
    expect(jsonOut(h.out)).toEqual({
      paired: true,
      url: "wss://192.168.1.20:47820",
      deviceId: "dev-2",
      deviceName: "simpletab CLI on test-host",
      role: { id: "ai", name: "AI" },
    });
    expect(h.pairing).toMatchObject({
      url: "wss://192.168.1.20:47820",
      deviceName: "simpletab CLI on test-host",
      deviceId: "dev-2",
      role: AI_ROLE,
    });
    expect(h.pairOpts.code).toBe("12345678");
    // Pairing waits for a person, so it keeps the pairing client's own approval window.
    expect(h.pairOpts.timeoutMs).toBeUndefined();
    expect(JSON.stringify(h.out)).not.toContain("keyPem");
  });

  it("refuses to overwrite an existing pairing", async () => {
    const h = harness();
    expect(await run(["pair", "192.168.1.20:47820", "12345678"], h.ctx)).toBe(2);
    expect(h.err.join("\n")).toContain("Already paired with wss://127.0.0.1:47820.");
    expect(h.ctx.pair).not.toHaveBeenCalled();
  });

  it.each([
    ["BAD_CODE", 1],
    ["LOCKED_OUT", 1],
    ["REJECTED", 1],
    ["TIMEOUT", 1],
    ["HOST_UNREACHABLE", 3],
    ["PROTOCOL", 3],
  ] as const)("maps a %s refusal to exit %i", async (reason, expectedCode) => {
    const h = harness({ paired: false, pairResult: { ok: false, reason } });
    expect(await run(["pair", "127.0.0.1", "12345678"], h.ctx)).toBe(expectedCode);
    expect(h.err.at(-1)).toBe(plainPairFailure(reason));
    expect(h.pairing).toBeUndefined();
  });

  it("clears a pairing on leave", async () => {
    const h = harness();
    expect(await run(["leave"], h.ctx)).toBe(0);
    expect(h.err).toEqual(["Left wss://127.0.0.1:47820. Pair again to reconnect."]);
    expect(h.store.clear).toHaveBeenCalled();
    expect(h.pairing).toBeUndefined();
  });

  it("says so when there is no pairing to leave", async () => {
    const h = harness({ paired: false });
    expect(await run(["leave"], h.ctx)).toBe(0);
    expect(h.err).toEqual(["This CLI is not paired."]);
  });
});

describe("status and show", () => {
  it("prints the status of a connected device", async () => {
    const state = stateWith({ proposals: [proposal("p-1", "pending", "2026-11-25T09:00:00.000Z")] });
    const h = harness({ state });
    expect(await run(["status"], h.ctx)).toBe(0);
    expect(jsonOut(h.out)).toEqual({
      url: "wss://127.0.0.1:47820",
      deviceName: "Test CLI",
      role: { id: "ai", name: "AI", proposalsOnly: true },
      connected: true,
      seq: 7,
      tournament: { name: "Publish Test Open", slug: "publish-test" },
      pendingProposals: 1,
    });
    expect(h.remote.stopped).toBe(true);
  });

  it("prints every show area, including aliases", async () => {
    const state = stateWith();
    const cases: Array<[string, unknown]> = [
      ["tournament", state.tournament],
      ["rounds", state.rounds],
      ["teams", state.teams],
      ["adjudicators", state.adjudicators],
      ["institutions", state.institutions],
      ["venues", state.venues],
      ["draw", state.debates],
      ["debates", state.debates],
      ["motions", state.motions],
      ["results", state.ballots],
      ["ballots", state.ballots],
      ["feedback", state.feedback],
      ["break", state.breakCategories],
      ["breakCategories", state.breakCategories],
      ["proposals", []],
      ["state", state],
    ];
    for (const [area, expected] of cases) {
      const h = harness({ state });
      expect(await run(["show", area], h.ctx), area).toBe(0);
      expect(jsonOut(h.out), area).toEqual(expected);
    }
  });

  it("filters array areas by round", async () => {
    const state = stateWith();
    const other = { ...state.debates[0]!, id: "d-2", roundId: "r-2" };
    const h = harness({ state: stateWith({ debates: [...state.debates, other] }) });
    expect(await run(["show", "draw", "--round", "r-2"], h.ctx)).toBe(0);
    expect(jsonOut(h.out)).toEqual([other]);
    expect(DEBATE_ID).toBeTruthy();
    expect(ROUND_ID).toBe("r-1");
  });

  it("leaves non-array areas unfiltered", async () => {
    const h = harness();
    expect(await run(["show", "tournament", "--round", "r-2"], h.ctx)).toBe(0);
    expect(jsonOut(h.out)).toEqual(h.state.tournament);
  });

  it("reports an unreachable host with exit 3", async () => {
    const h = harness({ connected: false });
    expect(await run(["status", "--timeout", "0.001"], h.ctx)).toBe(3);
    expect(h.err.join("\n")).toContain("Cannot reach the host");
    expect(h.remote.stopped).toBe(true);
  });

  it("clears the pairing and exits 3 when the host removed this device", async () => {
    const h = harness({ removeImmediately: true });
    expect(await run(["status"], h.ctx)).toBe(3);
    expect(h.err.join("\n")).toContain("removed this device");
    expect(h.store.clear).toHaveBeenCalled();
    expect(h.pairing).toBeUndefined();
  });

  it("exits 3 when not paired", async () => {
    const h = harness({ paired: false });
    expect(await run(["status"], h.ctx)).toBe(3);
    expect(h.err.join("\n")).toContain("not paired");
  });
});

describe("op", () => {
  const okResult: SubmitResult = { ok: true, seq: 8, writes: [], committedPayload: { id: "p-1" } };

  it("submits --json with expected versions", async () => {
    const h = harness({ result: okResult });
    expect(await run([
      "op", "release.set_gate", "--json", '{"gate":"tab_team","released":true}',
      "--expect", "team:t1=3", "--expect", "tournament:t-1=7",
    ], h.ctx)).toBe(0);
    expect(h.remote.submitted).toEqual([{
      type: "release.set_gate",
      payload: { gate: "tab_team", released: true },
      expectedVersions: { "team:t1": 3, "tournament:t-1": 7 },
    }]);
    expect(jsonOut(h.out)).toEqual(okResult);
    expect(h.err).toEqual(["Proposal p-1 is waiting for a person to accept it in the app."]);
    expect(h.remote.stopped).toBe(true);
  });

  it("reads --json - from stdin", async () => {
    const h = harness({ stdin: '{"gate":"results","released":true}' });
    expect(await run(["op", "release.set_gate", "--json", "-"], h.ctx)).toBe(0);
    expect(h.remote.submitted[0]!.payload).toEqual({ gate: "results", released: true });
    expect(h.ctx.readStdin).toHaveBeenCalled();
  });

  it("reads a file", async () => {
    const h = harness({ files: { "payload.json": '{"gate":"break","released":false}' } });
    expect(await run(["op", "release.set_gate", "--file", "payload.json"], h.ctx)).toBe(0);
    expect(h.remote.submitted[0]!.payload).toEqual({ gate: "break", released: false });
  });

  it("does not add an empty expectedVersions object", async () => {
    const h = harness();
    expect(await run(["op", "release.set_gate", "--json", "{}"], h.ctx)).toBe(0);
    expect(h.remote.submitted[0]).toEqual({ type: "release.set_gate", payload: {} });
  });

  it("prints the host's errors and exits 1 when refused", async () => {
    const h = harness({ result: { ok: false, code: "FORBIDDEN", errors: ["Only a person", "No access"] } });
    expect(await run(["op", "team.update", "--json", "{}"], h.ctx)).toBe(1);
    expect(h.err).toEqual(["Only a person", "No access"]);
    expect(jsonOut(h.out)).toEqual(h.remote.nextResult);
  });

  it("treats QUEUED as not sent and exits 3", async () => {
    const h = harness({ result: { ok: false, code: "QUEUED", errors: ["Out of reach"] } });
    expect(await run(["op", "team.update", "--json", "{}"], h.ctx)).toBe(3);
    expect(h.err.join("\n")).toContain("not sent");
  });

  it("does not print a proposal message for a human role", async () => {
    const h = harness({ role: HUMAN_ROLE });
    expect(await run(["op", "team.update", "--json", "{}"], h.ctx)).toBe(0);
    expect(h.err).toEqual([]);
  });

  it("does not submit when not paired or unreachable", async () => {
    const unpaired = harness({ paired: false });
    expect(await run(["op", "team.update", "--json", "{}"], unpaired.ctx)).toBe(3);
    expect(unpaired.err.join("\n")).toContain("not paired");

    const offline = harness({ connected: false });
    expect(await run(["op", "team.update", "--json", "{}", "--timeout", "0.001"], offline.ctx)).toBe(3);
    expect(offline.remote.submitted).toEqual([]);
  });
});

describe("proposals", () => {
  const pendingA = proposal("p-2", "pending", "2026-11-25T09:00:00.000Z");
  const pendingB = proposal("p-1", "pending", "2026-11-24T09:00:00.000Z");
  const accepted = { ...proposal("p-0", "accepted", "2026-11-23T09:00:00.000Z"), resolvedBy: "owner", reason: "OK" };
  const state = stateWith({ proposals: [pendingA, accepted, pendingB] });

  it("lists pending proposals oldest first", async () => {
    const h = harness({ state });
    expect(await run(["proposals", "list"], h.ctx)).toBe(0);
    expect(jsonOut(h.out)).toEqual([
      {
        id: "p-1", status: "pending", type: "release.set_gate",
        payload: { gate: "tab_team", released: true },
        proposedBy: "device:p-1", createdAt: "2026-11-24T09:00:00.000Z",
      },
      {
        id: "p-2", status: "pending", type: "release.set_gate",
        payload: { gate: "tab_team", released: true },
        proposedBy: "device:p-2", createdAt: "2026-11-25T09:00:00.000Z",
      },
    ]);
  });

  it("lists every proposal with --all", async () => {
    const h = harness({ state });
    expect(await run(["proposals", "list", "--all"], h.ctx)).toBe(0);
    expect(jsonOut(h.out)).toMatchObject([
      { id: "p-0", status: "accepted", resolvedBy: "owner", reason: "OK" },
      { id: "p-1", status: "pending" },
      { id: "p-2", status: "pending" },
    ]);
  });

  it("lets a human accept and reject with a reason", async () => {
    const accept = harness({ role: HUMAN_ROLE });
    expect(await run(["proposals", "accept", "p-1"], accept.ctx)).toBe(0);
    expect(accept.remote.submitted).toEqual([{ type: "proposal.accept", payload: { proposalId: "p-1" } }]);
    expect(jsonOut(accept.out)).toEqual(accept.remote.nextResult);

    const reject = harness({ role: HUMAN_ROLE });
    expect(await run(["proposals", "reject", "p-2", "--reason", "  Not yet  "], reject.ctx)).toBe(0);
    expect(reject.remote.submitted).toEqual([{
      type: "proposal.reject",
      payload: { proposalId: "p-2", reason: "Not yet" },
    }]);

    const noReason = harness({ role: HUMAN_ROLE });
    expect(await run(["proposals", "reject", "p-2", "--reason", "   "], noReason.ctx)).toBe(0);
    expect(noReason.remote.submitted[0]!.payload).toEqual({ proposalId: "p-2" });
  });

  it("refuses accept and reject locally for an AI role", async () => {
    for (const argv of [["proposals", "accept", "p-1"], ["proposals", "reject", "p-1", "--reason", "no"]]) {
      const h = harness();
      expect(await run(argv, h.ctx)).toBe(1);
      expect(h.err).toEqual(["Only a person can accept or reject proposals; this CLI is paired with the AI role."]);
      expect(h.out).toEqual([]);
      expect(() => h.remote).toThrow(/No remote was opened/);
    }
  });

  it("uses the same exit codes as op for a refused resolution", async () => {
    const refused: SubmitResult = { ok: false, code: "NOT_FOUND", errors: ["No such proposal"] } as unknown as SubmitResult;
    const h = harness({ role: HUMAN_ROLE, result: refused });
    expect(await run(["proposals", "accept", "missing"], h.ctx)).toBe(1);
    expect(h.err).toEqual(["No such proposal"]);
    expect(jsonOut(h.out)).toEqual(h.remote.nextResult);
  });
});

describe("session failures", () => {
  it("does not open a remote for usage errors", async () => {
    const h = harness();
    expect(await run(["show", "nope"], h.ctx)).toBe(2);
    expect(() => h.remote).toThrow(/No remote was opened/);
  });
});
