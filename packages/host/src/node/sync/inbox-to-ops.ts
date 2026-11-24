import { nextBallotVersion } from "@simpletab/core/features/tournament/application/ballotEntry";
import {
  consensusTeamScores,
  debateBallotRules,
  effectiveRanks,
  rulesSides,
} from "@simpletab/core/lib/ballots/result";
import {
  type Actor,
  type OpBallotSubmission,
  type TournamentState,
} from "@simpletab/core/ops";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import type {
  Debate,
  DebateSide,
  FeedbackAnswer,
  FeedbackSubmission,
  SpeakerScoreEntry,
  TeamScoreEntry,
} from "@simpletab/core/types";
import type { InboxItem } from "@simpletab/core/wire";
import type { HostEngine } from "../engine/engine";

export const SERVICE_ACTOR: Actor = {
  ref: "service",
  type: "service",
  role: BUILT_IN_ROLES.host_owner,
  isHostOwner: false,
};

export interface InboxItemError {
  rowid: number;
  submissionId: string;
  code: string;
  errors: string[];
}

export interface ProcessInboxResult {
  appliedCount: number;
  duplicateCount: number;
  ignoredCount: number;
  lateCount: number;
  highestProcessedRowId: number | null;
  stoppedOnError?: InboxItemError;
}

interface ResolvedLinkIdentity {
  kind: "adjudicator" | "team";
  entityId: string;
  name: string;
}

function resolveLinkIdentity(
  state: TournamentState,
  lookupId: string,
): ResolvedLinkIdentity | null {
  const link = state.links.find((l) => l.lookupId === lookupId);
  if (link === undefined) {
    return null;
  }
  const prefix = link.lookupId[0];
  if (prefix === "a") {
    const adj = state.adjudicators.find((a) => a.id === link.entityId);
    return adj
      ? { kind: "adjudicator", entityId: adj.id, name: adj.name }
      : null;
  }
  if (prefix === "t") {
    const team = state.teams.find((t) => t.id === link.entityId);
    return team ? { kind: "team", entityId: team.id, name: team.name } : null;
  }
  if (prefix === "s") {
    const team = state.teams.find((t) =>
      t.speakers.some((s) => s.id === link.entityId),
    );
    return team ? { kind: "team", entityId: team.id, name: team.name } : null;
  }
  return null;
}

function findDebateForItem(
  state: TournamentState,
  roundId: string,
  payload: Record<string, unknown>,
  identity: ResolvedLinkIdentity | null,
  formPrefix?: string,
): Debate | undefined {
  const roundDebates = state.debates.filter(
    (d) => d.roundId === roundId && !d.byeTeamId,
  );
  if (typeof payload.debateId === "string" && payload.debateId.length > 0) {
    const direct = roundDebates.find((d) => d.id === payload.debateId);
    if (direct !== undefined) {
      return direct;
    }
  }
  if (
    formPrefix !== undefined &&
    typeof payload.formId === "string" &&
    payload.formId.startsWith(formPrefix)
  ) {
    const rest = payload.formId.slice(formPrefix.length);
    const byForm = roundDebates.find(
      (d) => rest === d.id || rest.startsWith(`${d.id}-`),
    );
    if (byForm !== undefined) {
      return byForm;
    }
  }
  if (identity !== null) {
    const byParticipant = roundDebates.find((d) => {
      if (identity.kind === "adjudicator") {
        return (
          d.adjudicators?.chairId === identity.entityId ||
          d.adjudicators?.panellistIds?.includes(identity.entityId) ||
          d.adjudicators?.traineeIds?.includes(identity.entityId)
        );
      }
      return Object.values(d.teams ?? {}).some(
        (slot) => slot?.teamId === identity.entityId,
      );
    });
    if (byParticipant !== undefined) {
      return byParticipant;
    }
  }
  if (typeof payload.room === "string" && payload.room.length > 0) {
    return roundDebates.find((d) => d.venueName === payload.room);
  }
  return undefined;
}

function buildBallotFromInboxItem(
  state: TournamentState,
  item: InboxItem,
): { ok: true; ballot: OpBallotSubmission } | { ok: false; error: string } {
  const raw = item.payload;
  const ballotObj =
    raw.ballot !== null &&
    typeof raw.ballot === "object" &&
    !Array.isArray(raw.ballot)
      ? (raw.ballot as Record<string, unknown>)
      : raw;

  const identity = resolveLinkIdentity(state, item.lookupId);
  const debate = findDebateForItem(
    state,
    item.roundId,
    ballotObj,
    identity,
    "ballot-",
  );
  if (debate === undefined) {
    return {
      ok: false,
      error: `Could not resolve debate for ballot submission ${item.submissionId} in round ${item.roundId}.`,
    };
  }

  const round = state.rounds.find((r) => r.id === item.roundId);
  if (round === undefined) {
    return {
      ok: false,
      error: `Round ${item.roundId} does not exist.`,
    };
  }

  const rules = debateBallotRules(state.tournament, round, debate, state.rounds);
  const sides = rulesSides(rules);
  const speakerScores =
    (ballotObj.speakerScores as Record<DebateSide, SpeakerScoreEntry[]>) ??
    ({} as Record<DebateSide, SpeakerScoreEntry[]>);

  let teamScores = ballotObj.teamScores as
    | Record<DebateSide, TeamScoreEntry>
    | undefined;
  const teamIds = Object.fromEntries(
    sides.map((side) => [side, debate.teams?.[side]?.teamId ?? ""]),
  ) as Partial<Record<DebateSide, string>>;

  if (teamScores === undefined || typeof teamScores !== "object") {
    const rawRanks =
      ballotObj.ranks !== null &&
      typeof ballotObj.ranks === "object" &&
      !Array.isArray(ballotObj.ranks)
        ? (ballotObj.ranks as Partial<Record<DebateSide, number>>)
        : undefined;
    const ranks = effectiveRanks(speakerScores, rawRanks, rules);
    teamScores = consensusTeamScores(
      speakerScores,
      ranks,
      teamIds,
      rules,
    ) as Record<DebateSide, TeamScoreEntry>;
  } else {
    const filled: Partial<Record<DebateSide, TeamScoreEntry>> = {};
    for (const side of sides) {
      const existing = teamScores[side];
      if (existing !== undefined) {
        filled[side] = {
          ...existing,
          side,
          teamId:
            typeof existing.teamId === "string" && existing.teamId.length > 0
              ? existing.teamId
              : teamIds[side] ?? "",
        };
      }
    }
    teamScores = filled as Record<DebateSide, TeamScoreEntry>;
  }

  const submitterId =
    typeof ballotObj.submitterId === "string" && ballotObj.submitterId.length > 0
      ? ballotObj.submitterId
      : identity?.entityId;
  const submitterName =
    typeof ballotObj.submitterName === "string" &&
    ballotObj.submitterName.length > 0
      ? ballotObj.submitterName
      : identity?.name;

  const version =
    typeof ballotObj.version === "number" &&
    Number.isInteger(ballotObj.version) &&
    ballotObj.version > 0
      ? ballotObj.version
      : nextBallotVersion(state.ballots, debate.id);

  const motionId =
    typeof ballotObj.motionId === "string" && ballotObj.motionId.length > 0
      ? ballotObj.motionId
      : undefined;
  const motion =
    motionId !== undefined
      ? state.motions.find((m) => m.id === motionId)
      : undefined;

  const ballot: OpBallotSubmission = {
    id:
      typeof ballotObj.id === "string" && ballotObj.id.length > 0
        ? ballotObj.id
        : `inbox-${item.submissionId}`,
    tournamentId: state.tournament.id,
    roundId: item.roundId,
    debateId: debate.id,
    version,
    confirmed:
      typeof ballotObj.confirmed === "boolean" ? ballotObj.confirmed : true,
    discarded: false,
    submitterType: "judge",
    ...(submitterId !== undefined ? { submitterId } : {}),
    ...(submitterName !== undefined ? { submitterName } : {}),
    ...(debate.adjudicators?.chairId !== undefined
      ? { chairId: debate.adjudicators.chairId }
      : {}),
    ...(motionId !== undefined ? { motionId } : {}),
    ...(typeof ballotObj.motionText === "string"
      ? { motionText: ballotObj.motionText }
      : motion !== undefined
        ? { motionText: motion.text }
        : {}),
    speakerScores,
    teamScores,
    ...(typeof ballotObj.forfeitSide === "string"
      ? { forfeitSide: ballotObj.forfeitSide as DebateSide }
      : {}),
    ...(ballotObj.noSpeakerScores === true ? { noSpeakerScores: true } : {}),
    ...(ballotObj.selfSplit === true ? { selfSplit: true } : {}),
    ...(ballotObj.vetoes !== undefined
      ? { vetoes: ballotObj.vetoes as OpBallotSubmission["vetoes"] }
      : {}),
    ...(ballotObj.motionPreferences !== undefined
      ? {
          motionPreferences:
            ballotObj.motionPreferences as OpBallotSubmission["motionPreferences"],
        }
      : {}),
    timestamp:
      typeof ballotObj.timestamp === "string" && ballotObj.timestamp.length > 0
        ? ballotObj.timestamp
        : item.receivedAt,
  };

  return { ok: true, ballot };
}

function buildFeedbackFromInboxItem(
  state: TournamentState,
  item: InboxItem,
): { ok: true; feedback: FeedbackSubmission } | { ok: false; error: string } {
  const raw = item.payload;
  const fbObj =
    raw.feedback !== null &&
    typeof raw.feedback === "object" &&
    !Array.isArray(raw.feedback)
      ? (raw.feedback as Record<string, unknown>)
      : raw;

  const identity = resolveLinkIdentity(state, item.lookupId);
  const sourceType: "team" | "adjudicator" =
    fbObj.sourceType === "team" || fbObj.sourceType === "adjudicator"
      ? fbObj.sourceType
      : identity?.kind === "adjudicator"
        ? "adjudicator"
        : "team";
  const sourceId =
    typeof fbObj.sourceId === "string" && fbObj.sourceId.length > 0
      ? fbObj.sourceId
      : identity?.entityId ?? "";
  const sourceName =
    typeof fbObj.sourceName === "string" && fbObj.sourceName.length > 0
      ? fbObj.sourceName
      : identity?.name ?? "";

  if (!sourceId) {
    return {
      ok: false,
      error: `Could not resolve feedback source for submission ${item.submissionId}.`,
    };
  }

  const formPrefix =
    typeof fbObj.formId === "string" && fbObj.formId.startsWith("fb-team-")
      ? "fb-team-"
      : "fb-adj-";
  const debate = findDebateForItem(
    state,
    item.roundId,
    fbObj,
    identity,
    formPrefix,
  );
  if (debate === undefined) {
    return {
      ok: false,
      error: `Could not resolve debate for feedback submission ${item.submissionId}.`,
    };
  }

  const targetType: "adjudicator" | "team" =
    fbObj.targetType === "team" ? "team" : "adjudicator";
  const rawTargetId =
    typeof fbObj.targetAdjudicatorId === "string" &&
    fbObj.targetAdjudicatorId.length > 0
      ? fbObj.targetAdjudicatorId
      : typeof fbObj.targetTeamId === "string" && fbObj.targetTeamId.length > 0
        ? fbObj.targetTeamId
        : typeof fbObj.targetId === "string" && fbObj.targetId.length > 0
          ? fbObj.targetId
          : "";

  const score = typeof fbObj.score === "number" ? fbObj.score : Number.NaN;
  const answers =
    fbObj.answers !== null &&
    typeof fbObj.answers === "object" &&
    !Array.isArray(fbObj.answers)
      ? (fbObj.answers as Record<string, FeedbackAnswer>)
      : undefined;

  let targetAdjudicatorId: string | undefined;
  let targetAdjudicatorName: string | undefined;
  let targetTeamId: string | undefined;
  let targetTeamName: string | undefined;

  if (targetType === "adjudicator") {
    targetAdjudicatorId = rawTargetId || debate.adjudicators?.chairId;
    const adj = state.adjudicators.find((a) => a.id === targetAdjudicatorId);
    targetAdjudicatorName =
      typeof fbObj.targetAdjudicatorName === "string"
        ? fbObj.targetAdjudicatorName
        : adj?.name;
  } else {
    targetTeamId = rawTargetId;
    const tm = state.teams.find((t) => t.id === targetTeamId);
    targetTeamName =
      typeof fbObj.targetTeamName === "string" ? fbObj.targetTeamName : tm?.name;
  }

  const feedback: FeedbackSubmission = {
    id:
      typeof fbObj.id === "string" && fbObj.id.length > 0
        ? fbObj.id
        : `fb-${item.submissionId}`,
    tournamentId: state.tournament.id,
    roundId: item.roundId,
    debateId: debate.id,
    targetType,
    ...(targetAdjudicatorId !== undefined ? { targetAdjudicatorId } : {}),
    ...(targetAdjudicatorName !== undefined ? { targetAdjudicatorName } : {}),
    ...(targetTeamId !== undefined ? { targetTeamId } : {}),
    ...(targetTeamName !== undefined ? { targetTeamName } : {}),
    sourceType,
    sourceId,
    sourceName,
    score,
    ...(typeof fbObj.comments === "string" ? { comments: fbObj.comments } : {}),
    ...(answers !== undefined ? { answers } : {}),
    confirmed: typeof fbObj.confirmed === "boolean" ? fbObj.confirmed : true,
    timestamp:
      typeof fbObj.timestamp === "string" && fbObj.timestamp.length > 0
        ? fbObj.timestamp
        : item.receivedAt,
  };

  return { ok: true, feedback };
}

/**
 * Applies pulled inbox items into {@link HostEngine} in ascending `rowid` order.
 *
 * Idempotent on `submissionId`: items already in `processedIds` are skipped without re-applying.
 * Stops immediately on the first failing item so `highestProcessedRowId` only advances through
 * items that were fully processed.
 */
export async function processInboxItems(
  engine: HostEngine,
  items: readonly InboxItem[],
  processedIds: Set<string>,
): Promise<ProcessInboxResult> {
  const ordered = [...items].sort((a, b) => a.rowid - b.rowid);
  let appliedCount = 0;
  let duplicateCount = 0;
  let ignoredCount = 0;
  let lateCount = 0;
  let highestProcessedRowId: number | null = null;

  for (const item of ordered) {
    if (processedIds.has(item.submissionId)) {
      duplicateCount += 1;
      highestProcessedRowId = item.rowid;
      continue;
    }

    if (item.type === "registration") {
      // Online registration arrives in M10; ignore safely for now.
      processedIds.add(item.submissionId);
      ignoredCount += 1;
      highestProcessedRowId = item.rowid;
      continue;
    }

    const state = engine.getState();
    if (state === null) {
      return {
        appliedCount,
        duplicateCount,
        ignoredCount,
        lateCount,
        highestProcessedRowId,
        stoppedOnError: {
          rowid: item.rowid,
          submissionId: item.submissionId,
          code: "NO_TOURNAMENT",
          errors: ["No tournament state loaded."],
        },
      };
    }

    if (item.type === "ballot") {
      const built = buildBallotFromInboxItem(state, item);
      if (!built.ok) {
        return {
          appliedCount,
          duplicateCount,
          ignoredCount,
          lateCount,
          highestProcessedRowId,
          stoppedOnError: {
            rowid: item.rowid,
            submissionId: item.submissionId,
            code: "INVALID",
            errors: [built.error],
          },
        };
      }
      const res = await engine.submit(
        {
          type: "ballot.receive_online",
          payload: {
            source: "inbox",
            ballot: built.ballot,
            receivedAt: item.receivedAt,
            submissionId: item.submissionId,
          },
        },
        SERVICE_ACTOR,
      );
      if (!res.ok) {
        return {
          appliedCount,
          duplicateCount,
          ignoredCount,
          lateCount,
          highestProcessedRowId,
          stoppedOnError: {
            rowid: item.rowid,
            submissionId: item.submissionId,
            code: res.code,
            errors: [...res.errors],
          },
        };
      }
      const committed = res.committedPayload as { routedToLate?: boolean };
      if (committed?.routedToLate === true) {
        lateCount += 1;
      }
      processedIds.add(item.submissionId);
      appliedCount += 1;
      highestProcessedRowId = item.rowid;
      continue;
    }

    if (item.type === "feedback") {
      const built = buildFeedbackFromInboxItem(state, item);
      if (!built.ok) {
        return {
          appliedCount,
          duplicateCount,
          ignoredCount,
          lateCount,
          highestProcessedRowId,
          stoppedOnError: {
            rowid: item.rowid,
            submissionId: item.submissionId,
            code: "INVALID",
            errors: [built.error],
          },
        };
      }
      const res = await engine.submit(
        {
          type: "feedback.receive_online",
          payload: {
            feedback: built.feedback,
            receivedAt: item.receivedAt,
          },
        },
        SERVICE_ACTOR,
      );
      if (!res.ok) {
        return {
          appliedCount,
          duplicateCount,
          ignoredCount,
          lateCount,
          highestProcessedRowId,
          stoppedOnError: {
            rowid: item.rowid,
            submissionId: item.submissionId,
            code: res.code,
            errors: [...res.errors],
          },
        };
      }
      processedIds.add(item.submissionId);
      appliedCount += 1;
      highestProcessedRowId = item.rowid;
      continue;
    }

    if (item.type === "checkin") {
      const identity = resolveLinkIdentity(state, item.lookupId);
      if (identity === null) {
        return {
          appliedCount,
          duplicateCount,
          ignoredCount,
          lateCount,
          highestProcessedRowId,
          stoppedOnError: {
            rowid: item.rowid,
            submissionId: item.submissionId,
            code: "INVALID",
            errors: [
              `Could not resolve participant for check-in lookupId "${item.lookupId}".`,
            ],
          },
        };
      }
      const roundId =
        typeof item.payload.roundId === "string" &&
        item.payload.roundId.length > 0
          ? item.payload.roundId
          : item.roundId;
      const available =
        typeof item.payload.available === "boolean"
          ? item.payload.available
          : true;

      const res = await engine.submit(
        {
          type: "checkin.self_checkin",
          payload: {
            entityType: identity.kind,
            entityId: identity.entityId,
            roundId,
            available,
          },
        },
        SERVICE_ACTOR,
      );
      if (!res.ok) {
        return {
          appliedCount,
          duplicateCount,
          ignoredCount,
          lateCount,
          highestProcessedRowId,
          stoppedOnError: {
            rowid: item.rowid,
            submissionId: item.submissionId,
            code: res.code,
            errors: [...res.errors],
          },
        };
      }
      processedIds.add(item.submissionId);
      appliedCount += 1;
      highestProcessedRowId = item.rowid;
      continue;
    }

    // Unknown submission type: skip safely rather than poisoning the inbox cursor.
    processedIds.add(item.submissionId);
    ignoredCount += 1;
    highestProcessedRowId = item.rowid;
  }

  return {
    appliedCount,
    duplicateCount,
    ignoredCount,
    lateCount,
    highestProcessedRowId,
  };
}
