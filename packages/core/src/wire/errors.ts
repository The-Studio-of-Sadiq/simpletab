import { err, ok, type Result } from "./result";
import {
  isIanaTimeZone,
  isIsoUtcMs,
  isNonEmptyString,
  isPlainObject,
  isPositiveInt,
} from "./validate";

/**
 * All wire and host-local error codes defined in design Appendix E.
 */
export const ERROR_CODES = [
  "AUTH_INVALID",
  "KEY_REVOKED",
  "HOST_STALE",
  "OVERRIDDEN_BY_HOST",
  "ROUND_CLOSED",
  "DEADLINE_PASSED",
  "FORM_NOT_ALLOWED",
  "SCHEMA_INVALID",
  "SCHEMA_UNSUPPORTED",
  "RATE_LIMITED",
  "QUOTA_EXHAUSTED",
  "REG_CLOSED",
  "REG_CAP_REACHED",
  "TURNSTILE_FAILED",
  "NOT_FOUND",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

/**
 * Authoritative HTTP status code for each {@link ErrorCode} (Appendix E).
 * `OVERRIDDEN_BY_HOST` is host-local and maps to 409 Conflict.
 */
export const HTTP_STATUS: Record<ErrorCode, number> = {
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

export type ErrorBody = {
  code: ErrorCode;
  message: string;
  retryAfterSeconds?: number;
  storedHostNumber?: number;
  deadline?: string;
  timeZone?: string;
};

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && ERROR_CODE_SET.has(value);
}

/**
 * Parses and validates an untrusted JSON value into an {@link ErrorBody}.
 * Unknown extra fields are ignored.
 */
export function parseErrorBody(input: unknown): Result<ErrorBody> {
  if (!isPlainObject(input)) {
    return err("$: must be a JSON object");
  }

  const errors: string[] = [];

  if (!isErrorCode(input.code)) {
    errors.push("code: must be a valid ErrorCode");
  }
  if (!isNonEmptyString(input.message)) {
    errors.push("message: must be a non-empty string");
  }

  if (
    input.retryAfterSeconds !== undefined &&
    (typeof input.retryAfterSeconds !== "number" ||
      !Number.isFinite(input.retryAfterSeconds) ||
      input.retryAfterSeconds < 0)
  ) {
    errors.push("retryAfterSeconds: must be a non-negative finite number");
  }

  if (input.storedHostNumber !== undefined && !isPositiveInt(input.storedHostNumber)) {
    errors.push("storedHostNumber: must be a positive integer");
  }

  if (input.deadline !== undefined && !isIsoUtcMs(input.deadline)) {
    errors.push("deadline: must be an ISO 8601 UTC timestamp with milliseconds");
  }

  if (input.timeZone !== undefined && !isIanaTimeZone(input.timeZone)) {
    errors.push("timeZone: must be an IANA time zone name or \"UTC\"");
  }

  if (errors.length > 0) {
    return err(errors);
  }

  const body: ErrorBody = {
    code: input.code as ErrorCode,
    message: input.message as string,
  };
  if (input.retryAfterSeconds !== undefined) {
    body.retryAfterSeconds = input.retryAfterSeconds as number;
  }
  if (input.storedHostNumber !== undefined) {
    body.storedHostNumber = input.storedHostNumber as number;
  }
  if (input.deadline !== undefined) {
    body.deadline = input.deadline as string;
  }
  if (input.timeZone !== undefined) {
    body.timeZone = input.timeZone as string;
  }

  return ok(body);
}
