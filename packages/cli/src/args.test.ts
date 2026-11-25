import { describe, expect, it } from "vitest";
import {
  expectPositionals,
  parseCommandArgs,
  repeatedValues,
  singleValue,
  splitGlobals,
  UsageError,
} from "./args";

describe("argument parsing", () => {
  it("pulls global options out of any position", () => {
    const result = splitGlobals([
      "op", "team.update", "--json", "{}", "--dir", "/tmp/pair", "--timeout", "3", "-h",
    ]);
    expect(result.options).toEqual({ dir: "/tmp/pair", timeoutSeconds: 3, help: true });
    expect(result.rest).toEqual(["op", "team.update", "--json", "{}"]);
  });

  it("accepts = forms and keeps flag values together", () => {
    const result = splitGlobals(["pair", "host:1", "12345678", "--dir=/tmp/pair", "--timeout=2", "--name", "desk"]);
    expect(result.options.dir).toBe("/tmp/pair");
    expect(result.options.timeoutSeconds).toBe(2);
    expect(result.rest).toEqual(["pair", "host:1", "12345678", "--name", "desk"]);
  });

  it("rejects a missing or invalid global value", () => {
    expect(() => splitGlobals(["status", "--dir"])).toThrow(UsageError);
    expect(() => splitGlobals(["status", "--timeout", "0"])).toThrow(/positive number/);
    expect(() => splitGlobals(["status", "--dir="])).toThrow(/needs a value/);
  });

  it("parses value flags, repeated flags and boolean flags", () => {
    const parsed = parseCommandArgs(
      ["list", "--all", "--expect", "team:t1=3", "--expect=team:t2=4", "--round", "r-1"],
      { valueFlags: ["--expect", "--round"], booleanFlags: ["--all"] },
    );
    expect(parsed.positionals).toEqual(["list"]);
    expect(parsed.flags.has("--all")).toBe(true);
    expect(repeatedValues(parsed, "--expect")).toEqual(["team:t1=3", "team:t2=4"]);
    expect(singleValue(parsed, "--round")).toBe("r-1");
  });

  it("keeps a lone dash as a positional value", () => {
    const parsed = parseCommandArgs(["-"], { valueFlags: [], booleanFlags: [] });
    expect(parsed.positionals).toEqual(["-"]);
  });

  it("rejects unknown options, duplicate single values and extra positionals", () => {
    expect(() => parseCommandArgs(["--bogus"], { valueFlags: [], booleanFlags: [] })).toThrow(/Unknown option/);
    expect(() => parseCommandArgs(["--all=1"], { valueFlags: [], booleanFlags: ["--all"] })).toThrow(/does not take a value/);
    expect(() => singleValue(parseCommandArgs(["--json", "{}", "--json", "[]"], { valueFlags: ["--json"], booleanFlags: [] }), "--json")).toThrow(UsageError);
    expect(() => expectPositionals(parseCommandArgs(["a", "b"], { valueFlags: [], booleanFlags: [] }), 1, "cmd a")).toThrow(/Usage: cmd a/);
  });
});
