const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const LOOKUP_ID_RE = /^[ats][abcdefghjkmnpqrstuvwxyz23456789]{12}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const ISO_UTC_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TIME_ZONE_RE = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z][A-Za-z0-9_+-]*)+)$/;

/**
 * Returns true if `value` is a plain JSON-like object (non-null, non-array,
 * with `Object.prototype` or `null` prototype).
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Returns true if `value` is a non-empty string (at least one non-whitespace char).
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Returns true if `value` is a positive safe integer (`>= 1`).
 */
export function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Returns true if `value` is a non-negative safe integer (`>= 0`).
 */
export function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Returns true if `value` is a 26-character canonical Crockford Base32 ULID.
 */
export function isCrockfordUlid(value: unknown): value is string {
  return typeof value === "string" && ULID_RE.test(value);
}

/**
 * Returns true if `value` is a participant lookup ID (`a|t|s` + 12 chars from
 * CrabbyTab's 31-character alphabet).
 */
export function isLookupId(value: unknown): value is string {
  return typeof value === "string" && LOOKUP_ID_RE.test(value);
}

/**
 * Returns true if `value` is a 64-character lowercase hexadecimal string.
 */
export function isHex64(value: unknown): value is string {
  return typeof value === "string" && HEX64_RE.test(value);
}

/**
 * Returns true if `value` is a valid ISO 8601 UTC timestamp with millisecond
 * precision (`YYYY-MM-DDTHH:mm:ss.sssZ`).
 */
export function isIsoUtcMs(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_UTC_MS_RE.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

/**
 * Returns true if `value` is `"UTC"` or an `Area/Location` IANA-looking zone name.
 */
export function isIanaTimeZone(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && TIME_ZONE_RE.test(value);
}
