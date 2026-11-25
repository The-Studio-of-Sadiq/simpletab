/**
 * Argument parsing for `simpletab`. Hand-written: the CLI needs so few options that a third-party
 * parser would be more dependency than help, and the messages here are part of the tool's contract.
 */

/** A problem with what the person typed: exit code 2, never a network attempt. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const DEFAULT_TIMEOUT_SECONDS = 15;

export interface GlobalOptions {
  /** Pairing folder from `--dir`, when given. */
  dir?: string;
  timeoutSeconds: number;
  help: boolean;
}

export interface SplitArgs {
  options: GlobalOptions;
  /** Everything that is not a global option, in the order it was typed. */
  rest: string[];
}

/** Options that consume the next token, so a value is never mistaken for a command. */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--name",
  "--json",
  "--file",
  "--expect",
  "--round",
  "--reason",
]);

function optionValue(argv: string[], index: number, flag: string): { value: string; next: number } {
  const token = argv[index]!;
  const equals = token.indexOf("=");
  if (equals >= 0) {
    const value = token.slice(equals + 1);
    if (value.length === 0) throw new UsageError(`${flag} needs a value.`);
    return { value, next: index };
  }
  const value = argv[index + 1];
  if (value === undefined) throw new UsageError(`${flag} needs a value.`);
  return { value, next: index + 1 };
}

/**
 * Pulls the global options out of an argument list. Global options are allowed anywhere, before or
 * after the command and its own options.
 */
export function splitGlobals(argv: string[]): SplitArgs {
  const options: GlobalOptions = { timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, help: false };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--dir" || token.startsWith("--dir=")) {
      const { value, next } = optionValue(argv, i, "--dir");
      options.dir = value;
      i = next;
      continue;
    }
    if (token === "--timeout" || token.startsWith("--timeout=")) {
      const { value, next } = optionValue(argv, i, "--timeout");
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new UsageError("--timeout must be a positive number of seconds.");
      }
      options.timeoutSeconds = seconds;
      i = next;
      continue;
    }
    rest.push(token);
    if (VALUE_FLAGS.has(token)) {
      const value = argv[i + 1];
      if (value !== undefined) {
        rest.push(value);
        i += 1;
      }
    }
  }

  return { options, rest };
}

export interface FlagSpec {
  /** Flags that take a value. Any other `--flag` in a command's arguments is a mistake. */
  valueFlags: readonly string[];
  /** Flags that take no value. */
  booleanFlags: readonly string[];
}

export interface ParsedCommand {
  positionals: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

/** Parses one command's arguments against the flags it accepts. */
export function parseCommandArgs(tokens: string[], spec: FlagSpec): ParsedCommand {
  const valueFlags = new Set(spec.valueFlags);
  const booleanFlags = new Set(spec.booleanFlags);
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  let literal = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (literal) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      literal = true;
      continue;
    }
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = equals >= 0 ? token.slice(0, equals) : token;
      if (booleanFlags.has(name)) {
        if (equals >= 0) throw new UsageError(`${name} does not take a value.`);
        flags.add(name);
        continue;
      }
      if (!valueFlags.has(name)) throw new UsageError(`Unknown option ${name}.`);
      let value: string;
      if (equals >= 0) {
        value = token.slice(equals + 1);
        if (value.length === 0) throw new UsageError(`${name} needs a value.`);
      } else {
        const next = tokens[i + 1];
        if (next === undefined) throw new UsageError(`${name} needs a value.`);
        value = next;
        i += 1;
      }
      const list = values.get(name) ?? [];
      list.push(value);
      values.set(name, list);
      continue;
    }
    if (token.startsWith("-") && token !== "-") throw new UsageError(`Unknown option ${token}.`);
    positionals.push(token);
  }

  return { positionals, values, flags };
}

/** The one value of a flag that may appear at most once. */
export function singleValue(parsed: ParsedCommand, flag: string): string | undefined {
  const list = parsed.values.get(flag);
  if (list === undefined) return undefined;
  if (list.length > 1) throw new UsageError(`${flag} can be given only once.`);
  return list[0];
}

/** Every value of a flag that may repeat, in the order given. */
export function repeatedValues(parsed: ParsedCommand, flag: string): string[] {
  return parsed.values.get(flag) ?? [];
}

/** Refuses extra positional words, so a typo is never silently ignored. */
export function expectPositionals(parsed: ParsedCommand, count: number, usage: string): string[] {
  if (parsed.positionals.length !== count) throw new UsageError(`Usage: ${usage}`);
  return parsed.positionals;
}
