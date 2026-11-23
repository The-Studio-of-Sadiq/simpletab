/**
 * Validation result type used by wire message and error parsers.
 *
 * Error strings use JSON-path prefixes (for example,
 * `"entries[3].verifier: must be 64 lowercase hex characters"`).
 */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

/**
 * Constructs a successful {@link Result}.
 */
export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

/**
 * Constructs a failed {@link Result} with one or more error messages.
 */
export function err<T = never>(errors: string | readonly string[]): Result<T> {
  return {
    ok: false,
    errors: typeof errors === "string" ? [errors] : [...errors],
  };
}
