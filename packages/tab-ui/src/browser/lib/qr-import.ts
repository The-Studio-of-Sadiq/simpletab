import {
  base32Decode,
  decodeQrBallot,
  deriveKeys,
  QrBallotError,
  type QrBallotEnvelope,
} from "@simpletab/core/crypto";
import type { OpBallotSubmission } from "@simpletab/core/ops";
import type { ProjectedState } from "@simpletab/host/lib/common/host-protocol";
import { t } from "../i18n";

export type QrImportResult =
  | {
      ok: true;
      ballot: OpBallotSubmission;
      submissionId: string;
      envelope: QrBallotEnvelope;
    }
  | {
      ok: false;
      kind: "empty" | "needs_links" | "invalid";
      message: string;
    };

function findPasscodeForEntity(
  state: ProjectedState,
  entityId: string,
): string | undefined {
  const adj = state.adjudicators.find((item) => item.id === entityId);
  if (adj?.privatePasscode) {
    return adj.privatePasscode;
  }
  const team = state.teams.find((item) => item.id === entityId);
  if (team?.privatePasscode) {
    return team.privatePasscode;
  }
  for (const tm of state.teams) {
    const spk = tm.speakers.find((item) => item.id === entityId);
    if (spk?.privatePasscode) {
      return spk.privatePasscode;
    }
  }
  return undefined;
}

export async function importQrBallotText(
  rawText: string,
  state: ProjectedState,
): Promise<QrImportResult> {
  const codes = rawText
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (codes.length === 0) {
    return {
      ok: false,
      kind: "empty",
      message: t("results.qrEmptyError"),
    };
  }

  const links = (state.links ?? []).filter(
    (link) => typeof link.secret === "string" && link.secret.length > 0,
  );
  if (links.length === 0) {
    return {
      ok: false,
      kind: "needs_links",
      message: t("results.qrNeedsPrivateLinks"),
    };
  }

  let matchedEnvelope: QrBallotEnvelope | null = null;
  let matchedEntityId: string | undefined;

  for (const link of links) {
    const secretBytes = base32Decode(link.secret);
    if (secretBytes === null) {
      continue;
    }
    const passcode = findPasscodeForEntity(state, link.entityId);
    const { qrKey } = await deriveKeys(
      secretBytes,
      state.tournament.slug,
      passcode,
    );
    try {
      matchedEnvelope = await decodeQrBallot(codes, qrKey);
      matchedEntityId = link.entityId;
      break;
    } catch (error) {
      if (error instanceof QrBallotError && error.code === "INVALID_MAC") {
        continue;
      }
      return {
        ok: false,
        kind: "invalid",
        message:
          error instanceof Error ? error.message : t("results.qrDecodeFailed"),
      };
    }
  }

  if (matchedEnvelope === null) {
    return {
      ok: false,
      kind: "invalid",
      message: t("results.qrNoMatchingKey"),
    };
  }

  if (matchedEnvelope.slug !== state.tournament.slug) {
    return {
      ok: false,
      kind: "invalid",
      message: t("results.qrWrongTournament", { slug: matchedEnvelope.slug }),
    };
  }

  const rawPayload = matchedEnvelope.payload;
  if (
    rawPayload === null ||
    typeof rawPayload !== "object" ||
    Array.isArray(rawPayload)
  ) {
    return {
      ok: false,
      kind: "invalid",
      message: t("results.qrInvalidPayload"),
    };
  }

  const candidate = rawPayload as Record<string, unknown>;
  const ballotRecord =
    candidate.ballot !== null &&
    typeof candidate.ballot === "object" &&
    !Array.isArray(candidate.ballot)
      ? (candidate.ballot as Record<string, unknown>)
      : candidate;

  const debateId =
    typeof ballotRecord.debateId === "string" ? ballotRecord.debateId : "";
  const roundId =
    typeof ballotRecord.roundId === "string"
      ? ballotRecord.roundId
      : matchedEnvelope.rnd;

  if (!debateId || !roundId) {
    return {
      ok: false,
      kind: "invalid",
      message: t("results.qrMissingIds"),
    };
  }

  const ballot: OpBallotSubmission = {
    ...(ballotRecord as unknown as OpBallotSubmission),
    id:
      typeof ballotRecord.id === "string" && ballotRecord.id.length > 0
        ? ballotRecord.id
        : `qr-${matchedEnvelope.sid}`,
    tournamentId:
      typeof ballotRecord.tournamentId === "string" &&
      ballotRecord.tournamentId.length > 0
        ? ballotRecord.tournamentId
        : state.tournament.id,
    roundId,
    debateId,
    confirmed: false,
    discarded: false,
    submitterType: "judge",
    ...(typeof ballotRecord.submitterId === "string" &&
    ballotRecord.submitterId.length > 0
      ? { submitterId: ballotRecord.submitterId }
      : matchedEntityId
        ? { submitterId: matchedEntityId }
        : {}),
    timestamp:
      typeof ballotRecord.timestamp === "string" &&
      ballotRecord.timestamp.length > 0
        ? ballotRecord.timestamp
        : new Date().toISOString(),
  };

  return {
    ok: true,
    ballot,
    submissionId: matchedEnvelope.sid,
    envelope: matchedEnvelope,
  };
}
