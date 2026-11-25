import { describe, expect, it } from "vitest";
import { deriveKeys, encodeQrBallot } from "@simpletab/core/crypto";
import type { TournamentState } from "@simpletab/core/ops";
import { DEBATE_ID, makeState, ROUND_ID } from "../publish/publish-test-fixtures";
import { verifyQrBallot } from "./qr-intake";

// 16 zero bytes in base32 (the link secret format).
const SECRET = "aaaaaaaaaaaaaaaaaaaaaaaaaa";

function withLink(state: TournamentState): TournamentState {
  return { ...state, links: [{ lookupId: "a123456789012", entityId: "adj-chair", secret: SECRET }] } as unknown as TournamentState;
}

async function code(slug: string, payload: unknown, sid = "sub-qr-1"): Promise<string[]> {
  const { qrKey } = await deriveKeys(new Uint8Array(16), slug);
  return encodeQrBallot(qrKey, { sid, slug, lid: "a123456789012", rnd: ROUND_ID, type: "ballot", payload });
}

describe.skipIf(typeof globalThis.CompressionStream !== "function")("verifyQrBallot (host side)", () => {
  const state = withLink(makeState({ releaseResults: false }));
  const ballot = { debateId: DEBATE_ID, roundId: ROUND_ID, speakerScores: {}, teamScores: {} };

  it("accepts a code signed with a participant's link key and builds an unconfirmed ballot", async () => {
    const result = await verifyQrBallot(await code("publish-test", ballot), state);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.submissionId).toBe("sub-qr-1");
    expect(result.ballot).toMatchObject({ debateId: DEBATE_ID, roundId: ROUND_ID, confirmed: false, submitterId: "adj-chair" });
  });

  it("refuses without links, with a foreign key, for another tournament, and without ids", async () => {
    expect(await verifyQrBallot(["ST1.x.y"], makeState())).toMatchObject({ ok: false, kind: "needs_links" });
    expect(await verifyQrBallot([" "], state)).toMatchObject({ ok: false, kind: "empty" });

    const { qrKey } = await deriveKeys(new Uint8Array(16).fill(7), "publish-test");
    const forged = await encodeQrBallot(qrKey, { sid: "s", slug: "publish-test", lid: "a123456789012", rnd: ROUND_ID, type: "ballot", payload: ballot });
    expect(await verifyQrBallot(forged, state)).toMatchObject({ ok: false, kind: "no_matching_key" });

    expect(await verifyQrBallot(await code("other-open", ballot), state)).toMatchObject({ ok: false, kind: "no_matching_key" });
    expect(await verifyQrBallot(await code("publish-test", { speakerScores: {} }), state)).toMatchObject({ ok: false, kind: "missing_ids" });
  });
});
