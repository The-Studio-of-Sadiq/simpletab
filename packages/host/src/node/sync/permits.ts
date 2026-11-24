import {
  base32Decode,
  deriveKeys,
  LETTER_TO_ROLE,
  verifier,
  type LinkRoleLetter,
} from "@simpletab/core/crypto";
import { ballotModeFor } from "@simpletab/core/lib/ballots/result";
import { isDrawPubliclyReleased } from "@simpletab/core/lib/draw/drawStatus";
import { feedbackPathsForRound } from "@simpletab/core/lib/feedback/paths";
import {
  canSubmitParticipantFeedback,
  isFeedbackEnabledForRound,
} from "@simpletab/core/lib/feedback/questions";
import type { OpRound, TournamentState } from "@simpletab/core/ops";
import type { LinkRecord } from "@simpletab/core/projection";
import type {
  Debate,
  FeedbackSourceRole,
  FeedbackTargetRole,
} from "@simpletab/core/types";
import {
  parsePermitUpload,
  SCHEMA_VERSION,
  type PermitEntry,
  type PermitForm,
  type PermitUpload,
} from "@simpletab/core/wire";

interface DebateParticipantContext {
  debate: Debate;
  role: FeedbackSourceRole;
  isChair: boolean;
  isPanellist: boolean;
  isTrainee: boolean;
  sourceId: string;
}

function normalizeIsoUtcMs(value: string | null | undefined): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    return undefined;
  }
  return new Date(ms).toISOString();
}

function findPasscodeForLink(
  state: TournamentState,
  entityId: string,
  roleLetter: string,
): string | undefined {
  if (roleLetter === "a") {
    return state.adjudicators.find((a) => a.id === entityId)?.privatePasscode;
  }
  if (roleLetter === "t") {
    return state.teams.find((t) => t.id === entityId)?.privatePasscode;
  }
  for (const team of state.teams) {
    const spk = team.speakers.find((s) => s.id === entityId);
    if (spk !== undefined) {
      return spk.privatePasscode ?? team.privatePasscode;
    }
  }
  return undefined;
}

function resolveParticipantTeamId(
  state: TournamentState,
  entityId: string,
  roleLetter: string,
): string | undefined {
  if (roleLetter === "t") {
    return entityId;
  }
  if (roleLetter === "s") {
    const team = state.teams.find((tm) =>
      tm.speakers.some((spk) => spk.id === entityId),
    );
    return team?.id;
  }
  return undefined;
}

function findDebateContext(
  state: TournamentState,
  roundDebates: readonly Debate[],
  link: LinkRecord,
): DebateParticipantContext | null {
  const letter = link.lookupId[0];
  if (letter === "a") {
    for (const debate of roundDebates) {
      const adj = debate.adjudicators;
      if (adj?.chairId === link.entityId) {
        return {
          debate,
          role: "chair",
          isChair: true,
          isPanellist: false,
          isTrainee: false,
          sourceId: link.entityId,
        };
      }
      if (adj?.panellistIds?.includes(link.entityId)) {
        return {
          debate,
          role: "panellist",
          isChair: false,
          isPanellist: true,
          isTrainee: false,
          sourceId: link.entityId,
        };
      }
      if (adj?.traineeIds?.includes(link.entityId)) {
        return {
          debate,
          role: "trainee",
          isChair: false,
          isPanellist: false,
          isTrainee: true,
          sourceId: link.entityId,
        };
      }
    }
    return null;
  }

  const teamId = resolveParticipantTeamId(state, link.entityId, letter);
  if (!teamId) {
    return null;
  }
  for (const debate of roundDebates) {
    const inDebate = Object.values(debate.teams ?? {}).some(
      (slot) => slot?.teamId === teamId,
    );
    if (inDebate) {
      return {
        debate,
        role: "team",
        isChair: false,
        isPanellist: false,
        isTrainee: false,
        sourceId: teamId,
      };
    }
  }
  return null;
}

function hasAllowedFeedbackTarget(
  state: TournamentState,
  round: OpRound,
  ctx: DebateParticipantContext,
): boolean {
  const { debate } = ctx;
  if (state.tournament.preferences.feedbackEnabled === false) {
    return false;
  }
  if (state.tournament.preferences.privateUrlFeedback === false) {
    return false;
  }
  const feedbackInElims =
    state.tournament.preferences.feedbackInEliminationRounds ?? true;
  if (!isFeedbackEnabledForRound(debate, round, feedbackInElims)) {
    return false;
  }
  const pathConfig = feedbackPathsForRound(state.tournament.preferences, round);
  const sourceType: "team" | "adjudicator" =
    ctx.role === "team" ? "team" : "adjudicator";

  const panelTargets: Array<{
    id: string;
    role: FeedbackTargetRole;
    isChair: boolean;
  }> = [];
  if (debate.adjudicators?.chairId) {
    panelTargets.push({
      id: debate.adjudicators.chairId,
      role: "chair",
      isChair: true,
    });
  }
  for (const id of debate.adjudicators?.panellistIds ?? []) {
    panelTargets.push({ id, role: "panellist", isChair: false });
  }
  for (const id of debate.adjudicators?.traineeIds ?? []) {
    panelTargets.push({ id, role: "trainee", isChair: false });
  }

  for (const target of panelTargets) {
    if (
      canSubmitParticipantFeedback({
        sourceType,
        sourceId: ctx.sourceId,
        sourceIsChair: ctx.isChair,
        sourceRole: ctx.role,
        targetType: "adjudicator",
        targetId: target.id,
        targetIsChair: target.isChair,
        targetRole: target.role,
        path: pathConfig,
      })
    ) {
      return true;
    }
  }

  for (const slot of Object.values(debate.teams ?? {})) {
    if (!slot?.teamId) continue;
    if (
      canSubmitParticipantFeedback({
        sourceType,
        sourceId: ctx.sourceId,
        sourceIsChair: ctx.isChair,
        sourceRole: ctx.role,
        targetType: "team",
        targetId: slot.teamId,
        targetIsChair: false,
        path: pathConfig,
      })
    ) {
      return true;
    }
  }

  return false;
}

/** Whether a round is currently open for online submissions on the shared service. */
export function isRoundOpenOnService(round: OpRound): boolean {
  return !round.cancelled && !round.completed && isDrawPubliclyReleased(round);
}

/**
 * Builds a validated {@link PermitUpload} payload for a round from the current tournament state.
 * Returns `null` if the round does not exist.
 */
export async function buildPermitUpload(
  state: TournamentState,
  roundId: string,
  version: number,
): Promise<PermitUpload | null> {
  const round = state.rounds.find((item) => item.id === roundId);
  if (round === undefined) {
    return null;
  }

  const drawPublic = isDrawPubliclyReleased(round);
  const open = isRoundOpenOnService(round);
  const roundDebates = state.debates.filter(
    (d) => d.roundId === round.id && !d.byeTeamId,
  );
  const ballotMode = ballotModeFor(round, {
    format: state.tournament.format,
    preferences: state.tournament.preferences,
  });
  const privateBallotsEnabled =
    state.tournament.preferences.privateUrlBallots !== false;

  const entries: PermitEntry[] = [];
  for (const link of state.links) {
    const roleLetter = link.lookupId[0] as LinkRoleLetter;
    if (!(roleLetter in LETTER_TO_ROLE)) {
      continue;
    }
    const secretBytes = base32Decode(link.secret);
    if (secretBytes === null || secretBytes.byteLength !== 16) {
      continue;
    }

    const passcode = findPasscodeForLink(state, link.entityId, roleLetter);
    const derived = await deriveKeys(
      secretBytes,
      state.tournament.slug,
      passcode,
    );
    const entryVerifier = await verifier(derived.authKey);

    const ctx = findDebateContext(state, roundDebates, link);
    const roomId = ctx !== null ? ctx.debate.id : "unassigned";
    const forms: PermitForm[] = [];

    if (
      drawPublic &&
      privateBallotsEnabled &&
      ctx !== null &&
      !ctx.debate.postponed &&
      (ctx.isChair || (ctx.isPanellist && ballotMode === "voting"))
    ) {
      forms.push("ballot");
    }

    if (drawPublic && ctx !== null && hasAllowedFeedbackTarget(state, round, ctx)) {
      forms.push("feedback");
    }

    // Everyone may submit self check-in (service still checks round/deadline/preferences at apply).
    forms.push("checkin");

    entries.push({
      lookupId: link.lookupId,
      verifier: entryVerifier,
      roomId,
      forms,
    });
  }

  const timeZone =
    round.simpletab?.timeZone ??
    state.tournament.simpletab?.timeZone ??
    "UTC";
  const ballotDeadline = normalizeIsoUtcMs(round.simpletab?.ballotDeadline);
  const feedbackDeadline = normalizeIsoUtcMs(round.simpletab?.feedbackDeadline);

  const candidate: PermitUpload = {
    schema: SCHEMA_VERSION,
    roundId: round.id,
    version: Math.max(1, Math.floor(version)),
    open,
    timeZone,
    entries,
    ...(ballotDeadline !== undefined ? { ballotDeadline } : {}),
    ...(feedbackDeadline !== undefined ? { feedbackDeadline } : {}),
  };

  const validated = parsePermitUpload(candidate);
  if (!validated.ok) {
    throw new Error(
      `Generated permit failed wire validation: ${validated.errors.join("; ")}`,
    );
  }
  return validated.value;
}
