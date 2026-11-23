import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  HTTP_STATUS,
  parseErrorBody,
  type ErrorCode,
} from "./errors";

describe("wire error codes and HTTP status table", () => {
  it("gives every ERROR_CODES entry its exact Appendix E HTTP status", () => {
    const expected: Record<ErrorCode, number> = {
      AUTH_INVALID: 401,
      KEY_REVOKED: 403,
      HOST_STALE: 409,
      OVERRIDDEN_BY_HOST: 409,
      ROUND_CLOSED: 409,
      DEADLINE_PASSED: 409,
      FORM_NOT_ALLOWED: 403,
      SCHEMA_INVALID: 400,
      SCHEMA_UNSUPPORTED: 415,
      RATE_LIMITED: 429,
      QUOTA_EXHAUSTED: 429,
      REG_CLOSED: 409,
      REG_CAP_REACHED: 409,
      TURNSTILE_FAILED: 400,
      NOT_FOUND: 404,
      INTERNAL: 500,
    };

    expect(Object.keys(HTTP_STATUS).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      expect(HTTP_STATUS[code]).toBe(expected[code]);
    }
  });

  it("parses a minimal and full ErrorBody and ignores extra fields", () => {
    const minimal = parseErrorBody({
      code: "NOT_FOUND",
      message: "Tournament not found",
      extraField: "ignored",
    });
    expect(minimal).toEqual({
      ok: true,
      value: {
        code: "NOT_FOUND",
        message: "Tournament not found",
      },
    });

    const full = parseErrorBody({
      code: "DEADLINE_PASSED",
      message: "Ballot deadline has passed",
      retryAfterSeconds: 30,
      storedHostNumber: 2,
      deadline: "2026-11-23T14:00:00.000Z",
      timeZone: "Asia/Dhaka",
    });
    expect(full).toEqual({
      ok: true,
      value: {
        code: "DEADLINE_PASSED",
        message: "Ballot deadline has passed",
        retryAfterSeconds: 30,
        storedHostNumber: 2,
        deadline: "2026-11-23T14:00:00.000Z",
        timeZone: "Asia/Dhaka",
      },
    });
  });

  it("rejects non-object and invalid ErrorBody fields with clear paths", () => {
    const nonObj = parseErrorBody(null);
    expect(nonObj.ok).toBe(false);
    if (!nonObj.ok) {
      expect(nonObj.errors[0]).toContain("$:");
    }

    const bad = parseErrorBody({
      code: "UNKNOWN_CODE",
      message: "",
      retryAfterSeconds: -1,
      storedHostNumber: 0,
      deadline: "2026-11-23T14:00:00Z",
      timeZone: "Mars",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.some((e) => e.startsWith("code:"))).toBe(true);
      expect(bad.errors.some((e) => e.startsWith("message:"))).toBe(true);
      expect(bad.errors.some((e) => e.startsWith("retryAfterSeconds:"))).toBe(true);
      expect(bad.errors.some((e) => e.startsWith("storedHostNumber:"))).toBe(true);
      expect(bad.errors.some((e) => e.startsWith("deadline:"))).toBe(true);
      expect(bad.errors.some((e) => e.startsWith("timeZone:"))).toBe(true);
    }
  });
});
