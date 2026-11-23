import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalize } from "./canonical";

describe("canonicalize (RFC 8785 JCS)", () => {
  it("serializes primitives canonically", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
    expect(canonicalize(0)).toBe("0");
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize(42.5)).toBe("42.5");
    expect(canonicalize("hello\n\"world\"")).toBe('"hello\\n\\"world\\""');
  });

  it("sorts object keys lexicographically by UTF-16 code units and omits undefined", () => {
    const input = {
      z: 1,
      a: 2,
      B: 3,
      omitMe: undefined,
      nested: { b: true, a: [1, undefined, { d: 4, c: 3 }] },
    };
    expect(canonicalize(input)).toBe(
      '{"B":3,"a":2,"nested":{"a":[1,null,{"c":3,"d":4}],"b":true},"z":1}',
    );
  });

  it("sorts Unicode keys by UTF-16 code units per RFC 8785 §3.2.3", () => {
    // U+E000 (0xE000) sorts AFTER U+1F600 (surrogate pair 0xD83D 0xDE00) in UTF-16.
    const input = {
      "\ue000": "pua",
      "\u{1f600}": "emoji",
      "\r": "cr",
      "1": "one",
    };
    expect(canonicalize(input)).toBe(
      '{"\\r":"cr","1":"one","😀":"emoji","\ue000":"pua"}',
    );
  });

  it("honours toJSON methods", () => {
    const obj = {
      date: new Date("2026-11-23T12:00:00.000Z"),
    };
    expect(canonicalize(obj)).toBe('{"date":"2026-11-23T12:00:00.000Z"}');
  });

  it("throws CanonicalJsonError on non-finite numbers", () => {
    expect(() => canonicalize(Number.NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(
      CanonicalJsonError,
    );
    expect(() => canonicalize(Number.NEGATIVE_INFINITY)).toThrow(
      CanonicalJsonError,
    );
    expect(() => canonicalize({ score: Number.NaN })).toThrow(
      CanonicalJsonError,
    );
  });

  it("throws CanonicalJsonError on unsupported types and circular references", () => {
    expect(() => canonicalize(undefined)).toThrow(CanonicalJsonError);
    expect(() => canonicalize(10n)).toThrow(CanonicalJsonError);
    expect(() => canonicalize(Symbol("x"))).toThrow(CanonicalJsonError);
    expect(() => canonicalize(() => {})).toThrow(CanonicalJsonError);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalize(cyclic)).toThrow(CanonicalJsonError);
  });
});
