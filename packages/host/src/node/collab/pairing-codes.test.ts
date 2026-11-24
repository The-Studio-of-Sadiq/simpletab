import { describe, expect, it } from "vitest";
import { PAIRING_CODE_TTL_MS, PAIRING_MAX_WRONG_ATTEMPTS } from "../../common/collab-protocol";
import { PairingCodes } from "./pairing-codes";

describe("PairingCodes", () => {
  it("issues zero-padded unique 8-digit codes and consumes them once", () => {
    const seq = [42, 42, 7];
    let idx = 0;
    const nowMs = 1_700_000_000_000;
    const codes = new PairingCodes({
      now: () => nowMs,
      random: () => seq[idx++] ?? 99,
    });

    const first = codes.issue("tab_director");
    const second = codes.issue("tab_assistant");

    expect(first.code).toBe("00000042");
    expect(first.roleId).toBe("tab_director");
    expect(first.expiresAt).toBe(new Date(nowMs + PAIRING_CODE_TTL_MS).toISOString());
    expect(second.code).toBe("00000007");
    expect(codes.active()).toHaveLength(2);

    expect(codes.redeem("00000042")).toEqual({ ok: true, roleId: "tab_director" });
    expect(codes.redeem("00000042")).toEqual({ ok: false, reason: "BAD_CODE" });
    expect(codes.active()).toEqual([second]);
  });

  it("expires codes after PAIRING_CODE_TTL_MS", () => {
    let nowMs = 1_700_000_000_000;
    const codes = new PairingCodes({
      now: () => nowMs,
      random: () => 12345678,
    });

    const issued = codes.issue("equity");
    expect(codes.active()).toEqual([issued]);

    nowMs += PAIRING_CODE_TTL_MS;
    expect(codes.active()).toEqual([]);
    expect(codes.redeem(issued.code)).toEqual({ ok: false, reason: "BAD_CODE" });
  });

  it("locks out and cancels all active codes on the 5th wrong attempt until a new code is issued", () => {
    let nextRandom = 10000001;
    const codes = new PairingCodes({
      now: () => 1_700_000_000_000,
      random: () => nextRandom++,
    });

    const valid1 = codes.issue("tab_director");
    const valid2 = codes.issue("tab_assistant");

    for (let i = 1; i < PAIRING_MAX_WRONG_ATTEMPTS; i++) {
      expect(codes.redeem("99999999")).toEqual({ ok: false, reason: "BAD_CODE" });
    }
    expect(codes.active()).toHaveLength(2);

    // 5th wrong attempt triggers lockout and wipes every active code.
    expect(codes.redeem("short")).toEqual({ ok: false, reason: "LOCKED_OUT" });
    expect(codes.active()).toEqual([]);
    expect(codes.redeem(valid1.code)).toEqual({ ok: false, reason: "LOCKED_OUT" });
    expect(codes.redeem(valid2.code)).toEqual({ ok: false, reason: "LOCKED_OUT" });

    // Issuing a fresh code resets the lockout.
    const fresh = codes.issue("display");
    expect(codes.redeem(fresh.code)).toEqual({ ok: true, roleId: "display" });
  });

  it("cancels individual codes", () => {
    const codes = new PairingCodes({
      now: () => 1_700_000_000_000,
      random: () => 55555555,
    });

    const issued = codes.issue("ballot_desk");
    codes.cancel(issued.code);
    expect(codes.active()).toEqual([]);
    expect(codes.redeem(issued.code)).toEqual({ ok: false, reason: "BAD_CODE" });
  });
});
