import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpRequest, ProposalRecord, RecordKey } from "@simpletab/core/ops";
import { CollabClient, type CollabPairOptions, type CollabPairResult } from "../../host/src/node/collab/device-client";
import { generateSelfSignedCertificate } from "../../host/src/node/collab/tls";
import type { ProjectedState, SubmitResult } from "../../host/src/common/host-protocol";
import { PairingStore, type StoredPairing } from "../../host/src/node/device/pairing-store";
import { parseHostAddress, plainPairFailure } from "../../host/src/node/device/pairing-text";
import { RemoteHost } from "../../host/src/node/device/remote-host";
import {
  expectPositionals,
  parseCommandArgs,
  repeatedValues,
  singleValue,
  splitGlobals,
  UsageError,
  type GlobalOptions,
  type ParsedCommand,
} from "./args";
import { awaitConnection, type RemoteHooks, type RemoteLike } from "./session";
import { AREA_NAMES, usageText } from "./usage";

/** Only these methods of `PairingStore` are needed; a fake can stand in for it in tests. */
export interface PairingStoreLike {
  readonly directory: string;
  load(): StoredPairing | undefined;
  save(pairing: StoredPairing): void;
  clear(): void;
}

/** Everything `run` needs from the outside world. Commands never call Node or the network directly. */
export interface CliContext {
  /** A fresh store for the resolved pairing folder (`--dir` or the default). */
  store: (dir: string) => PairingStoreLike;
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Promise<string>;
  readFile(filePath: string): string;
  hostname(): string;
  now(): Date;
  pair(opts: CollabPairOptions): Promise<CollabPairResult>;
  openRemote(pairing: StoredPairing, hooks: RemoteHooks): RemoteLike;
}

export function defaultContext(): CliContext {
  return {
    store: (dir) => new PairingStore(dir),
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    readStdin: async () => readFileSync(0, "utf8"),
    readFile: (filePath) => readFileSync(filePath, "utf8"),
    hostname: () => os.hostname(),
    now: () => new Date(),
    pair: (opts) => CollabClient.pair(opts),
    openRemote: (pairing, hooks) => {
      // The CLI opens a connection for one command. `run` always stops it in a `finally`.
      const remote = new RemoteHost({ pairing, onChange: hooks.onChange, onRemoved: hooks.onRemoved });
      remote.start();
      return remote;
    },
  };
}

const AREA_ALIASES: Readonly<Record<string, string>> = {
  debates: "draw",
  ballots: "results",
  breakCategories: "break",
};

const PAIR_CODE_DIGITS = 8;
const MAX_DEVICE_NAME_LENGTH = 60;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeJson(ctx: CliContext, value: unknown): void {
  ctx.stdout(JSON.stringify(value, null, 2));
}

function resolvedDir(option: string | undefined): string {
  if (option !== undefined) return option;
  const override = process.env.SIMPLETAB_CLI_DIR;
  if (override !== undefined && override.trim().length > 0) return override;
  return path.join(os.homedir(), ".simpletab", "cli");
}

function requirePairing(ctx: CliContext, store: PairingStoreLike): StoredPairing | null {
  const pairing = store.load();
  if (pairing === undefined) {
    ctx.stderr("This CLI is not paired. Run `simpletab pair` first.");
    return null;
  }
  return pairing;
}

/** The host told this device it was removed: its stored pairing is no longer valid. */
function reportRemoved(ctx: CliContext, store: PairingStoreLike): number {
  store.clear();
  ctx.stderr("The host removed this device. Its pairing has been cleared. Run `simpletab pair` again.");
  return 3;
}

async function withRemote(
  ctx: CliContext,
  store: PairingStoreLike,
  pairing: StoredPairing,
  options: GlobalOptions,
  task: (remote: RemoteLike, state: ProjectedState) => Promise<number> | number,
): Promise<number> {
  let removed = false;
  const remote = ctx.openRemote(pairing, { onRemoved: () => { removed = true; } });
  try {
    // Submitting before a snapshot arrives only queues the op in memory, which is lost on exit.
    const outcome = await awaitConnection(remote, {
      timeoutMs: options.timeoutSeconds * 1000,
      isRemoved: () => removed,
    });
    if (outcome.kind === "removed") return reportRemoved(ctx, store);
    if (outcome.kind === "unreachable") {
      ctx.stderr(`Cannot reach the host within ${options.timeoutSeconds} seconds. Check that it is on and allows devices.`);
      return 3;
    }
    const code = await task(remote, outcome.state);
    return removed ? reportRemoved(ctx, store) : code;
  } finally {
    remote.stop();
  }
}

function pairRefusalExit(reason: string): number {
  return reason === "BAD_CODE" || reason === "LOCKED_OUT" || reason === "REJECTED" || reason === "TIMEOUT" ? 1 : 3;
}

async function runPair(args: string[], ctx: CliContext, store: PairingStoreLike): Promise<number> {
  const parsed = parseCommandArgs(args, { valueFlags: ["--name"], booleanFlags: [] });
  const [addressArg, codeArg] = expectPositionals(parsed, 2, "simpletab pair <address> <code> [--name <name>]");
  const address = parseHostAddress(addressArg!);
  if (!address.ok) throw new UsageError(address.error);

  const code = codeArg!.replace(/\s+/g, "");
  if (!new RegExp(`^\\d{${PAIR_CODE_DIGITS}}$`).test(code)) {
    throw new UsageError(`The code has ${PAIR_CODE_DIGITS} digits, as shown on the host's Devices page.`);
  }

  const givenName = singleValue(parsed, "--name");
  const deviceName = (givenName ?? "").trim() || `simpletab CLI on ${ctx.hostname()}`;
  if (deviceName.length > MAX_DEVICE_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(deviceName)) {
    throw new UsageError(`Use a device name of at most ${MAX_DEVICE_NAME_LENGTH} characters.`);
  }

  const existing = store.load();
  if (existing !== undefined) {
    ctx.stderr(`Already paired with ${existing.url}. Run \`simpletab leave\` first.`);
    return 2;
  }

  const certificate = await generateSelfSignedCertificate({ commonName: deviceName, now: ctx.now() });
  const result = await ctx.pair({
    url: address.url,
    certificate,
    code,
    deviceName,
    // No --timeout here: a person has to compare the words and approve, so pairing keeps the
    // host's own approval window (the pairing client's default).
    onWords: (words) => {
      ctx.stderr("Check that the host shows these six words, then approve this device there:");
      ctx.stderr(words.join(" "));
    },
  });
  if (!result.ok) {
    ctx.stderr(plainPairFailure(result.reason));
    return pairRefusalExit(result.reason);
  }

  const pairing: StoredPairing = {
    version: 1,
    url: address.url,
    deviceId: result.deviceId,
    deviceName,
    role: result.role,
    hostFingerprint: result.hostFingerprint,
    host: result.host,
    certificate,
    pairedAt: ctx.now().toISOString(),
  };
  store.save(pairing);
  ctx.stderr(`Paired with ${address.url} as "${deviceName}" (role: ${result.role.name}).`);
  writeJson(ctx, {
    paired: true,
    url: address.url,
    deviceId: result.deviceId,
    deviceName,
    role: { id: result.role.id, name: result.role.name },
  });
  return 0;
}

function runLeave(args: string[], ctx: CliContext, store: PairingStoreLike): number {
  const parsed = parseCommandArgs(args, { valueFlags: [], booleanFlags: [] });
  expectPositionals(parsed, 0, "simpletab leave");
  const pairing = store.load();
  store.clear();
  ctx.stderr(
    pairing === undefined
      ? "This CLI is not paired."
      : `Left ${pairing.url}. Pair again to reconnect.`,
  );
  return 0;
}

function proposalCount(state: ProjectedState): number {
  return (state.proposals ?? []).filter((proposal) => proposal.status === "pending").length;
}

async function runStatus(
  args: string[],
  ctx: CliContext,
  store: PairingStoreLike,
  options: GlobalOptions,
): Promise<number> {
  const parsed = parseCommandArgs(args, { valueFlags: [], booleanFlags: [] });
  expectPositionals(parsed, 0, "simpletab status");
  const pairing = requirePairing(ctx, store);
  if (pairing === null) return 3;
  return withRemote(ctx, store, pairing, options, (_remote, state) => {
    writeJson(ctx, {
      url: pairing.url,
      deviceName: pairing.deviceName,
      role: {
        id: pairing.role.id,
        name: pairing.role.name,
        proposalsOnly: pairing.role.proposalsOnly === true,
      },
      connected: true,
      seq: state.seq,
      tournament: { name: state.tournament.name, slug: state.tournament.slug },
      pendingProposals: proposalCount(state),
    });
    return 0;
  });
}

/** Only array areas can be narrowed to a round; a whole-state view is printed unchanged. */
function filterByRound(value: unknown, round: string | undefined): unknown {
  if (round === undefined || !Array.isArray(value)) return value;
  return value.filter((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const record: Record<string, unknown> = item;
    return record["roundId"] === round;
  });
}

function selectArea(state: ProjectedState, area: string): unknown {
  switch (area) {
    case "tournament": return state.tournament;
    case "rounds": return state.rounds;
    case "teams": return state.teams;
    case "adjudicators": return state.adjudicators;
    case "institutions": return state.institutions;
    case "venues": return state.venues;
    case "draw": return state.debates;
    case "motions": return state.motions;
    case "results": return state.ballots;
    case "feedback": return state.feedback;
    case "break": return state.breakCategories;
    case "proposals": return state.proposals ?? [];
    default: return state;
  }
}

async function runShow(
  args: string[],
  ctx: CliContext,
  store: PairingStoreLike,
  options: GlobalOptions,
): Promise<number> {
  const parsed = parseCommandArgs(args, { valueFlags: ["--round"], booleanFlags: [] });
  const [givenArea] = expectPositionals(parsed, 1, "simpletab show <area> [--round <roundId>]");
  const area = AREA_ALIASES[givenArea!] ?? givenArea!;
  if (!AREA_NAMES.includes(area)) {
    throw new UsageError(
      `Unknown or missing area "${givenArea}". Areas: ${AREA_NAMES.join(", ")} (aliases: debates, ballots, breakCategories).`,
    );
  }
  const round = singleValue(parsed, "--round");
  const pairing = requirePairing(ctx, store);
  if (pairing === null) return 3;
  return withRemote(ctx, store, pairing, options, (_remote, state) => {
    writeJson(ctx, filterByRound(selectArea(state, area), round));
    return 0;
  });
}

function parseExpectations(specs: string[]): Record<RecordKey, number> {
  const expected: Record<RecordKey, number> = {};
  for (const spec of specs) {
    const separator = spec.indexOf("=");
    const key = separator < 0 ? spec : spec.slice(0, separator);
    const versionText = separator < 0 ? "" : spec.slice(separator + 1);
    const version = Number(versionText);
    if (separator <= 0 || !/^[^:]+:.+$/.test(key) || !Number.isInteger(version) || version < 0) {
      throw new UsageError("--expect must look like --expect team:t1=3.");
    }
    expected[key as RecordKey] = version;
  }
  return expected;
}

function readPayloadText(ctx: CliContext, parsed: ParsedCommand): Promise<string> {
  const json = singleValue(parsed, "--json");
  const file = singleValue(parsed, "--file");
  if ((json === undefined) === (file === undefined)) {
    throw new UsageError("Give exactly one of --json <payload> or --file <path>.");
  }
  if (file !== undefined) {
    try {
      return Promise.resolve(ctx.readFile(file));
    } catch (error) {
      throw new UsageError(`Cannot read ${file}: ${describeError(error)}`);
    }
  }
  if (json === "-") {
    return ctx.readStdin().catch((error: unknown) => {
      throw new UsageError(`Cannot read stdin: ${describeError(error)}`);
    });
  }
  return Promise.resolve(json!);
}

async function submitAndReport(
  ctx: CliContext,
  remote: RemoteLike,
  op: OpRequest,
  proposalsOnly: boolean,
): Promise<number> {
  const result: SubmitResult = await remote.submit(op);
  writeJson(ctx, result);
  if (result.ok) {
    if (proposalsOnly) {
      const payload: Record<string, unknown> =
        typeof result.committedPayload === "object" && result.committedPayload !== null
          ? result.committedPayload as Record<string, unknown>
          : {};
      const id = typeof payload["id"] === "string" ? payload["id"] : "";
      ctx.stderr(`Proposal ${id} is waiting for a person to accept it in the app.`);
    }
    return 0;
  }
  for (const error of result.errors) ctx.stderr(error);
  if (result.code === "QUEUED") {
    ctx.stderr("The change was not sent. Try again when the host is reachable.");
    return 3;
  }
  return 1;
}

async function runOp(
  args: string[],
  ctx: CliContext,
  store: PairingStoreLike,
  options: GlobalOptions,
): Promise<number> {
  const parsed = parseCommandArgs(args, {
    valueFlags: ["--json", "--file", "--expect"],
    booleanFlags: [],
  });
  const [type] = expectPositionals(parsed, 1, "simpletab op <type> (--json <payload> | --json - | --file <path>) [--expect <key>=<version>]");
  const text = await readPayloadText(ctx, parsed);
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new UsageError("The JSON payload is not valid.");
  }
  const expectedVersions = parseExpectations(repeatedValues(parsed, "--expect"));
  const op: OpRequest = {
    type: type!,
    payload,
    ...(Object.keys(expectedVersions).length > 0 ? { expectedVersions } : {}),
  };

  const pairing = requirePairing(ctx, store);
  if (pairing === null) return 3;
  return withRemote(ctx, store, pairing, options, (remote) =>
    submitAndReport(ctx, remote, op, pairing.role.proposalsOnly === true),
  );
}

function proposalView(proposal: ProposalRecord): Record<string, unknown> {
  return {
    id: proposal.id,
    status: proposal.status,
    type: proposal.op.type,
    payload: proposal.op.payload,
    proposedBy: proposal.proposedBy.ref,
    createdAt: proposal.createdAt,
    ...(proposal.resolvedBy !== undefined ? { resolvedBy: proposal.resolvedBy } : {}),
    ...(proposal.reason !== undefined ? { reason: proposal.reason } : {}),
  };
}

async function runProposals(
  args: string[],
  ctx: CliContext,
  store: PairingStoreLike,
  options: GlobalOptions,
): Promise<number> {
  const parsed = parseCommandArgs(args, { valueFlags: ["--reason"], booleanFlags: ["--all"] });
  const [action, id] = parsed.positionals;
  if (action === undefined) {
    throw new UsageError("Usage: simpletab proposals <list|accept|reject> ...");
  }
  if (action === "list") {
    expectPositionals(parsed, 1, "simpletab proposals list [--all]");
    if (parsed.values.has("--reason")) throw new UsageError("--reason is only for proposals reject.");
    const all = parsed.flags.has("--all");
    const pairing = requirePairing(ctx, store);
    if (pairing === null) return 3;
    return withRemote(ctx, store, pairing, options, (_remote, state) => {
      const proposals = (state.proposals ?? [])
        .filter((proposal) => all || proposal.status === "pending")
        .slice()
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      writeJson(ctx, proposals.map(proposalView));
      return 0;
    });
  }
  if (action !== "accept" && action !== "reject") {
    throw new UsageError(`Unknown proposals command "${action}". Use list, accept or reject.`);
  }
  expectPositionals(parsed, 2, `simpletab proposals ${action} <id>${action === "reject" ? " [--reason <text>]" : ""}`);
  if (parsed.flags.has("--all")) throw new UsageError("--all is only for proposals list.");
  const reason = action === "accept" ? undefined : singleValue(parsed, "--reason")?.trim();
  if (action === "accept" && parsed.values.has("--reason")) {
    throw new UsageError("--reason is only for proposals reject.");
  }

  const pairing = requirePairing(ctx, store);
  if (pairing === null) return 3;
  if (pairing.role.proposalsOnly === true) {
    // Refuse locally: an AI device must not even try to decide on a proposal.
    ctx.stderr("Only a person can accept or reject proposals; this CLI is paired with the AI role.");
    return 1;
  }
  const op: OpRequest = action === "accept"
    ? { type: "proposal.accept", payload: { proposalId: id! } }
    : {
        type: "proposal.reject",
        payload: {
          proposalId: id!,
          ...(reason !== undefined && reason.length > 0 ? { reason } : {}),
        },
      };
  return withRemote(ctx, store, pairing, options, (remote) => submitAndReport(ctx, remote, op, false));
}

/**
 * Runs one command. Exit code 2 is for what the person typed; 3 is for a missing pairing or a host
 * that could not be reached; 1 is for a refusal from the host.
 */
export async function run(argv: string[], ctx: CliContext): Promise<number> {
  let split;
  try {
    split = splitGlobals(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      ctx.stderr(error.message);
      return 2;
    }
    ctx.stderr(describeError(error));
    return 1;
  }
  if (split.options.help) {
    ctx.stdout(usageText());
    return 0;
  }
  const [command, ...rest] = split.rest;
  if (command === undefined) {
    ctx.stderr(usageText());
    return 2;
  }

  try {
    if (command === "help") {
      parseCommandArgs(rest, { valueFlags: [], booleanFlags: [] });
      if (rest.length > 0) throw new UsageError("Usage: simpletab help");
      ctx.stdout(usageText());
      return 0;
    }
    const store = ctx.store(resolvedDir(split.options.dir));
    switch (command) {
      case "pair": return await runPair(rest, ctx, store);
      case "leave": return runLeave(rest, ctx, store);
      case "status": return await runStatus(rest, ctx, store, split.options);
      case "show": return await runShow(rest, ctx, store, split.options);
      case "op": return await runOp(rest, ctx, store, split.options);
      case "proposals": return await runProposals(rest, ctx, store, split.options);
      default:
        throw new UsageError(`Unknown command "${command}".\n${usageText()}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      ctx.stderr(error.message);
      return 2;
    }
    ctx.stderr(`Error: ${describeError(error)}`);
    return 1;
  }
}
