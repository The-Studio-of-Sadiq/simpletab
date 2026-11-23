import { describe, expect, it } from "vitest";

import { canonicalize } from "./jcs";

describe("canonicalize (RFC 8785)", () => {
  it("serializes literals", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
    expect(canonicalize([null, true, false])).toBe("[null,true,false]");
  });

  it("serializes RFC 8785 number test vectors", () => {
    expect(canonicalize(0)).toBe("0");
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize(1)).toBe("1");
    expect(canonicalize(-1)).toBe("-1");
    expect(canonicalize(4.50)).toBe("4.5");
    expect(canonicalize(2e-3)).toBe("0.002");
    expect(canonicalize(1e-6)).toBe("0.000001");
    expect(canonicalize(1e-7)).toBe("1e-7");
    expect(canonicalize(1e20)).toBe("100000000000000000000");
    expect(canonicalize(1e21)).toBe("1e+21");
    expect(canonicalize(1e30)).toBe("1e+30");
    expect(canonicalize(333333333.33333329)).toBe("333333333.3333333");
    expect(canonicalize(0.000000000000000000000000001)).toBe("1e-27");
    expect(canonicalize(1.0000000000000002)).toBe("1.0000000000000002");
    expect(canonicalize(Number.MIN_VALUE)).toBe("5e-324");
    expect(canonicalize(Number.MAX_VALUE)).toBe("1.7976931348623157e+308");
    expect(canonicalize(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
  });

  it("escapes strings according to RFC 8785", () => {
    expect(canonicalize("\u0000\u0008\u0009\u000a\u000c\u000d\u001f")).toBe(
      '"\\u0000\\b\\t\\n\\f\\r\\u001f"',
    );
    expect(canonicalize("\u20ac$\u000f\u000aA'\u0042\u0022\u005c\\\"/")).toBe(
      '"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"',
    );
    expect(canonicalize("€\u0080😀")).toBe('"€\u0080😀"');
  });

  it("matches the RFC 8785 combined numbers, string, and literals vector", () => {
    const input = {
      numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 0.000000000000000000000000001],
      string: "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"/",
      literals: [null, true, false],
    };

    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it("sorts object keys by UTF-16 code units including unicode keys from RFC 8785", () => {
    const input = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis",
    };

    expect(canonicalize(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it("sorts nested objects recursively and preserves array order", () => {
    const input = {
      z: [{ b: 2, a: 1 }, { d: 4, c: 3 }],
      a: { nested: { y: true, x: false }, empty: {} },
    };

    expect(canonicalize(input)).toBe(
      '{"a":{"empty":{},"nested":{"x":false,"y":true}},"z":[{"a":1,"b":2},{"c":3,"d":4}]}',
    );
  });

  it("omits undefined object members and normalizes undefined array items to null", () => {
    expect(canonicalize({ b: undefined, a: 1, c: undefined })).toBe('{"a":1}');
    expect(canonicalize([1, undefined, 2])).toBe("[1,null,2]");
    expect(() => canonicalize(undefined)).toThrow(TypeError);
  });

  it("throws on NaN, Infinity, bigint, functions, symbols, and circular references", () => {
    expect(() => canonicalize(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalize(Number.NEGATIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalize({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalize(10n)).toThrow(TypeError);
    expect(() => canonicalize(() => 1)).toThrow(TypeError);
    expect(() => canonicalize(Symbol("x"))).toThrow(TypeError);
    expect(() => canonicalize({ fn: () => 1 })).toThrow(TypeError);
    expect(() => canonicalize([Symbol("x")])).toThrow(TypeError);
    expect(() => canonicalize([1n])).toThrow(TypeError);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalize(circular)).toThrow(TypeError);
  });
});
