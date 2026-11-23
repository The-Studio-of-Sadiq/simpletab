/**
 * Constant-time passcode comparison. Both values are UTF-8 encoded and every
 * byte up to the longer input's length is XORed into an accumulator together
 * with the length difference, so no hashing is needed because the loop length
 * does not depend on where the first difference is.
 */
export function passcodesMatch(stored: unknown, provided: unknown): boolean {
  if (typeof stored !== "string" || typeof provided !== "string" || stored.length === 0) return false;
  const encoder = new TextEncoder();
  const a = encoder.encode(stored);
  const b = encoder.encode(provided);
  let diff = a.length ^ b.length;
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
