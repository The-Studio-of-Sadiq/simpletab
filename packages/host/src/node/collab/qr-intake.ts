import {
  base32Decode,
  decodeQrBallot,
  deriveKeys,
  QrBallotError,
  type QrBallotEnvelope,
} from "@simpletab/core/crypto";
import type { OpBallotSubmission, TournamentState } from "@simpletab/core/ops";
import type { QrIntakeFailureKind } from "../../common/host-protocol";

/**
 * Verifies a scanned QR ballot (design Appendix E, "QR fallback") on the host, where the link
 * secrets and passcodes live. Staff devices, the assistant mode included, only forward the codes
 * they scanned: most roles never receive link secrets, so they could not check a code themselves.
 */

export type QrIntakeVerification =
  | { ok: true; ballot: OpBallotSubmission; submissionId: string; envelope: QrBallotEnvelope }
  | { ok: false; kind: QrIntakeFailureKind; detail?: string };

function passcodeFor(state: TournamentState, entityId: string): string | undefined {
  const adjudicator = state.adjudicators.find((item) => item.id === entityId) as { privatePasscode?: string } | undefined;
  if (adjudicator?.privatePasscode) return adjudicator.privatePasscode;
  for (const team of state.teams) {
    const t = team as typeof team & { privatePasscode?: string };
    if (t.id === entityId && t.privatePasscode) return t.privatePasscode;
    const speaker = t.speakers.find((item) => item.id === entityId) as { privatePasscode?: string } | undefined;
    if (speaker?.privatePasscode) return speaker.privatePasscode;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function verifyQrBallot(
  rawCodes: readonly string[],
  state: TournamentState,
  now: () => Date = () => new Date(),
): Promise<QrIntakeVerification> {
  const codes = rawCodes.flatMap((code) => code.split(/\s+/)).map((code) => code.trim()).filter((code) => code.length > 0);
  if (codes.length === 0) return { ok: false, kind: "empty" };

  const links = (state.links ?? []).filter((link) => typeof link.secret === "string" && link.secret.length > 0);
  if (links.length === 0) return { ok: false, kind: "needs_links" };

  let envelope: QrBallotEnvelope | null = null;
  let entityId: string | undefined;
  for (const link of links) {
    const secret = base32Decode(link.secret);
    if (secret === null) continue;
    const { qrKey } = await deriveKeys(secret, state.tournament.slug, passcodeFor(state, link.entityId));
    try {
      envelope = await decodeQrBallot(codes, qrKey);
      entityId = link.entityId;
      break;
    } catch (error) {
      if (error instanceof QrBallotError && error.code === "INVALID_MAC") continue;
      return { ok: false, kind: "invalid", detail: error instanceof Error ? error.message : String(error) };
    }
  }
  if (envelope === null) return { ok: false, kind: "no_matching_key" };
  if (envelope.slug !== state.tournament.slug) return { ok: false, kind: "wrong_tournament", detail: envelope.slug };
  if (!isRecord(envelope.payload)) return { ok: false, kind: "invalid_payload" };

  const candidate = envelope.payload;
  const record = isRecord(candidate.ballot) ? candidate.ballot : candidate;
  const debateId = typeof record.debateId === "string" ? record.debateId : "";
  const roundId = typeof record.roundId === "string" ? record.roundId : envelope.rnd;
  if (!debateId || !roundId) return { ok: false, kind: "missing_ids" };

  const ballot: OpBallotSubmission = {
    ...(record as unknown as OpBallotSubmission),
    id: typeof record.id === "string" && record.id.length > 0 ? record.id : `qr-${envelope.sid}`,
    tournamentId:
      typeof record.tournamentId === "string" && record.tournamentId.length > 0 ? record.tournamentId : state.tournament.id,
    roundId,
    debateId,
    confirmed: false,
    discarded: false,
    submitterType: "judge",
    ...(typeof record.submitterId === "string" && record.submitterId.length > 0
      ? { submitterId: record.submitterId }
      : entityId !== undefined
        ? { submitterId: entityId }
        : {}),
    timestamp: typeof record.timestamp === "string" && record.timestamp.length > 0 ? record.timestamp : now().toISOString(),
  };
  return { ok: true, ballot, submissionId: envelope.sid, envelope };
}
