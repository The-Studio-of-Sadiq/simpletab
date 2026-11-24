import { randomInt, timingSafeEqual } from "node:crypto";
import {
  PAIRING_CODE_DIGITS,
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_WRONG_ATTEMPTS,
  type IssuedPairingCode,
} from "../../common/collab-protocol";

/**
 * Single-use 8-digit pairing codes with TTL expiry and lockout after 5 wrong attempts
 * (design section 4, amendment 7).
 */

export interface PairingCodesOptions {
  now?: () => number;
  random?: (maxExclusive: number) => number;
}

export type RedeemResult =
  | { ok: true; roleId: string }
  | { ok: false; reason: "BAD_CODE" | "LOCKED_OUT" };

interface StoredCode {
  code: string;
  codeBytes: Buffer;
  roleId: string;
  expiresAtMs: number;
  expiresAt: string;
}

const CODE_SPACE = 10 ** PAIRING_CODE_DIGITS;
const MAX_GENERATION_ATTEMPTS = 1_000;

export class PairingCodes {
  private readonly now: () => number;
  private readonly random: (maxExclusive: number) => number;
  private readonly entries = new Map<string, StoredCode>();
  private wrongAttempts = 0;
  private lockedOut = false;

  constructor(options: PairingCodesOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? ((maxExclusive) => randomInt(maxExclusive));
  }

  /**
   * Issues a new 8-digit single-use pairing code for a role, clearing any prior wrong-attempt
   * lockout so the host user can recover by issuing a fresh code.
   */
  issue(roleId: string): IssuedPairingCode {
    const trimmedRole = roleId.trim();
    if (trimmedRole.length === 0) {
      throw new Error("Role id must not be empty.");
    }

    const nowMs = this.now();
    this.pruneExpired(nowMs);
    this.wrongAttempts = 0;
    this.lockedOut = false;

    const code = this.generateUniqueCode();
    const expiresAtMs = nowMs + PAIRING_CODE_TTL_MS;
    const expiresAt = new Date(expiresAtMs).toISOString();

    this.entries.set(code, {
      code,
      codeBytes: Buffer.from(code, "utf8"),
      roleId: trimmedRole,
      expiresAtMs,
      expiresAt,
    });

    return { code, roleId: trimmedRole, expiresAt };
  }

  /**
   * Attempts to redeem a pairing code. Valid codes are consumed on use; expired codes fail with
   * `BAD_CODE`; 5 wrong attempts cancel all active codes and trigger `LOCKED_OUT`.
   */
  redeem(code: string): RedeemResult {
    if (this.lockedOut) {
      return { ok: false, reason: "LOCKED_OUT" };
    }

    const nowMs = this.now();
    this.pruneExpired(nowMs);

    const candidateRaw = Buffer.from(code, "utf8");
    const lengthMatches = candidateRaw.byteLength === PAIRING_CODE_DIGITS;
    const candidatePadded = Buffer.alloc(PAIRING_CODE_DIGITS);
    candidateRaw.copy(candidatePadded, 0, 0, Math.min(candidateRaw.byteLength, PAIRING_CODE_DIGITS));

    let matched: StoredCode | undefined;
    for (const entry of this.entries.values()) {
      const equal = timingSafeEqual(candidatePadded, entry.codeBytes);
      if (lengthMatches && equal && matched === undefined) {
        matched = entry;
      }
    }

    if (matched !== undefined) {
      this.entries.delete(matched.code);
      return { ok: true, roleId: matched.roleId };
    }

    this.wrongAttempts++;
    if (this.wrongAttempts >= PAIRING_MAX_WRONG_ATTEMPTS) {
      this.entries.clear();
      this.lockedOut = true;
      return { ok: false, reason: "LOCKED_OUT" };
    }
    return { ok: false, reason: "BAD_CODE" };
  }

  cancel(code: string): void {
    this.entries.delete(code);
  }

  active(): IssuedPairingCode[] {
    this.pruneExpired(this.now());
    return Array.from(this.entries.values(), ({ code, roleId, expiresAt }) => ({
      code,
      roleId,
      expiresAt,
    }));
  }

  private pruneExpired(nowMs: number): void {
    for (const [code, entry] of this.entries) {
      if (nowMs >= entry.expiresAtMs) {
        this.entries.delete(code);
      }
    }
  }

  private generateUniqueCode(): string {
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
      const n = this.random(CODE_SPACE);
      if (!Number.isInteger(n) || n < 0 || n >= CODE_SPACE) {
        throw new Error("Random generator returned an out-of-range pairing code.");
      }
      const code = String(n).padStart(PAIRING_CODE_DIGITS, "0");
      if (!this.entries.has(code)) {
        return code;
      }
    }
    throw new Error("Could not generate a unique pairing code.");
  }
}
