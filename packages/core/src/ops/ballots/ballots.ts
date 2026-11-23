import { nextBallotVersion } from "@/features/tournament/application/ballotEntry";
import {
  addIntakeRecord,
  buildBallotSheetIndex,
  createIntakeRecord,
  resolveIntakeScan,
} from "@/features/tournament/application/ballotIntake";
import {
  checkBallotSubmission,
  checkIndependentConfirmation,
  checkResultChange,
  isRoundLockedForPortalBallots,
  remoteBallotSubmissionBlocker,
  type RuleOverride,
} from "@/features/tournament/application/stateGuards";
import { votingAdjudicatorIds } from "@/lib/ballots/individualBallots";
import { debateWithBallotTotals } from "@/lib/ballots/resave";
import {
  ballotMatchesDebate,
  debateBallotRules,
  rulesSides,
  validateBallotEntry,
  type BallotEntry,
  type SideRecord,
} from "@/lib/ballots/result";
import {
  applyPrivateBallotConfirmation,
  planIndividualBallotWrites,
  usesIndividualBallots,
  votingRoundPrivateBallot,
} from "@/lib/privateIndividualBallots";
import {
  isTabRoomConfirmed,
  planPrivateBallotWrites,
  type ExistingBallotRecord,
} from "@/lib/privateSync";
import type { Debate, DebateSide, Speaker } from "@/types";
import {
  cloneValue,
  dedupeKeys,
  isNonEmptyText,
  isValidIsoInstant,
  violationsToErrors,
} from "../setup/helpers";
import {
  recordKey,
  type LateSubmissionRecord,
  type OpBallotSubmission,
  type OpDef,
  type OpRound,
  type RecordKey,
  type TournamentState,
} from "../types";

export interface BallotEnterPayload {
  ballot: OpBallotSubmission;
  override?: RuleOverride;
}

export interface BallotReceiveOnlinePayload {
  source: "inbox" | "qr";
  ballot: OpBallotSubmission;
  receivedAt?: string;
  submissionId?: string;
  writtenBallotIds?: string[];
  primaryBallotId?: string;
  routedToLate?: boolean;
}

export interface BallotConfirmPayload {
  ballotId: string;
  override?: RuleOverride;
  confirmedAt?: string;
  unconfirmedBallotIds?: string[];
}

export interface BallotDiscardPayload {
  ballotId: string;
  override?: RuleOverride;
  discardedAt?: string;
}

export interface BallotIntakeRecordPayload {
  sheetCode: string;
  roundId: string;
  receivedAt?: string;
  receivedByName?: string;
  recordId?: string;
}

function isBallotDeadlineActive(
  state: TournamentState,
  roundId: string,
  clockIso?: string,
): { late: boolean; deadline?: string } {
  if (state.runtime?.portalEnforcing !== true) {
    return { late: false };
  }
  const round = state.rounds.find((item) => item.id === roundId);
  const deadline = round?.simpletab?.ballotDeadline;
  if (typeof deadline !== "string" || deadline.trim().length === 0) {
    return { late: false };
  }
  const effectiveNow = clockIso ?? state.runtime.now;
  const nowMs = Date.parse(effectiveNow);
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(nowMs) || !Number.isFinite(deadlineMs)) {
    return { late: false };
  }
  return nowMs >= deadlineMs ? { late: true, deadline } : { late: false, deadline };
}

function buildDebateRosters(
  state: TournamentState,
  debate: Debate,
): SideRecord<Speaker[]> {
  const teamById = new Map(state.teams.map((team) => [team.id, team]));
  const rosters: SideRecord<Speaker[]> = {};
  for (const [side, slot] of Object.entries(debate.teams)) {
    if (!slot?.teamId) continue;
    rosters[side as DebateSide] = teamById.get(slot.teamId)?.speakers ?? [];
  }
  return rosters;
}

function buildBallotEntryForValidation(
  ballot: OpBallotSubmission,
  sides: readonly DebateSide[],
  singleSheet: boolean,
): BallotEntry {
  const ranks: SideRecord<number> = {};
  for (const side of sides) {
    const score = ballot.teamScores?.[side];
    if (typeof score?.rank === "number") {
      ranks[side] = score.rank;
    } else if (sides.length === 2 && score) {
      ranks[side] = score.win === true || score.points === 1 ? 1 : 2;
    }
  }

  if (singleSheet && (!ballot.sheets || ballot.sheets.length === 0)) {
    const declaredWinner = (
      Object.entries(ballot.teamScores ?? {}) as [DebateSide, { rank?: number; win?: boolean } | undefined][]
    ).find(([, score]) => score?.rank === 1 || score?.win === true)?.[0];
    return {
      speakerScores: {},
      sheets: [
        {
          adjudicatorId: ballot.submitterId ?? "",
          ...(ballot.submitterName ? { adjudicatorName: ballot.submitterName } : {}),
          speakerScores: ballot.speakerScores ?? ({} as OpBallotSubmission["speakerScores"]),
          ...(declaredWinner ? { declaredWinner } : {}),
        },
      ],
      ...(ballot.forfeitSide ? { forfeitSide: ballot.forfeitSide } : {}),
      ...(ballot.motionId ? { motionId: ballot.motionId } : {}),
      ...(ballot.vetoes ? { vetoes: ballot.vetoes } : {}),
      ...(ballot.motionPreferences ? { motionPreferences: ballot.motionPreferences } : {}),
      ...(ballot.selfSplit ? { selfSplit: true } : {}),
    };
  }

  return {
    speakerScores: ballot.speakerScores ?? {},
    ranks,
    ...(ballot.sheets ? { sheets: ballot.sheets } : {}),
    ...(ballot.forfeitSide ? { forfeitSide: ballot.forfeitSide } : {}),
    ...(ballot.motionId ? { motionId: ballot.motionId } : {}),
    ...(ballot.vetoes ? { vetoes: ballot.vetoes } : {}),
    ...(ballot.motionPreferences ? { motionPreferences: ballot.motionPreferences } : {}),
    ...(ballot.selfSplit ? { selfSplit: true } : {}),
  };
}

function validateBallotScores(
  state: TournamentState,
  round: OpRound,
  debate: Debate,
  ballot: OpBallotSubmission,
  singleSheet: boolean,
): string[] {
  const rules = debateBallotRules(state.tournament, round, debate, state.rounds);
  const sides = rulesSides(rules);
  const rosters = buildDebateRosters(state, debate);
  const roundMotionIds = state.motions
    .filter((motion) => motion.rounds.includes(round.id))
    .map((motion) => motion.id);
  const entry = buildBallotEntryForValidation(ballot, sides, singleSheet);
  return validateBallotEntry(entry, {
    ...rules,
    rosters,
    ...(roundMotionIds.length > 0 ? { roundMotionIds } : {}),
    votingAdjudicatorCount: votingAdjudicatorIds(debate).length,
  });
}

function updateDebateForBallots(
  debate: Debate,
  ballots: readonly OpBallotSubmission[],
): Debate {
  const liveForDebate = ballots.filter(
    (ballot) => ballot.debateId === debate.id && !ballot.discarded,
  );
  const confirmed = liveForDebate.find((ballot) => ballot.confirmed);
  if (confirmed) {
    return debateWithBallotTotals(
      { ...cloneValue(debate), resultStatus: "confirmed" },
      confirmed,
    );
  }

  const nextDebate = cloneValue(debate);
  nextDebate.resultStatus = liveForDebate.length > 0 ? "draft" : "none";
  const nextTeams = { ...nextDebate.teams };
  for (const [key, slot] of Object.entries(nextTeams)) {
    if (!slot) continue;
    const cleaned = { ...slot };
    delete cleaned.points;
    delete cleaned.speakerScoreTotal;
    nextTeams[key as DebateSide] = cleaned;
  }
  nextDebate.teams = nextTeams;
  return nextDebate;
}

function existingRecordsForDebate(
  ballots: readonly OpBallotSubmission[],
  debateId: string,
): ExistingBallotRecord[] {
  return ballots
    .filter((ballot) => ballot.debateId === debateId)
    .map((ballot) => ({ id: ballot.id, data: ballot }));
}

export const ballotEnterOp: OpDef<BallotEnterPayload> = {
  type: "ballot.enter",
  permission(state, payload) {
    return isBallotDeadlineActive(state, payload.ballot.roundId).late
      ? "results.enter_late"
      : "results.enter";
  },
  category: "ballot",
  visibility: "private",
  lock: false,
  checkActor(actor, state, payload) {
    if (payload.ballot.confirmed !== true) {
      return null;
    }
    const violations = checkIndependentConfirmation(
      payload.ballot,
      "submit_confirmed",
      {
        doubleEntry: state.tournament.preferences.ballotDoubleEntry === true,
        actorId: actor.ref,
      },
      { ballots: state.ballots },
    );
    const errors = violationsToErrors(violations, payload.override);
    return errors.length > 0 ? errors.join(" ") : null;
  },
  reads(state, payload) {
    return dedupeKeys([
      recordKey("round", payload.ballot.roundId),
      recordKey("debate", payload.ballot.debateId),
      recordKey("ballot", payload.ballot.id),
      ...state.ballots
        .filter((ballot) => ballot.debateId === payload.ballot.debateId)
        .map((ballot) => recordKey("ballot", ballot.id)),
    ]);
  },
  writes(state, payload) {
    const previouslyConfirmed = payload.ballot.confirmed
      ? state.ballots
          .filter(
            (ballot) =>
              ballot.debateId === payload.ballot.debateId &&
              ballot.id !== payload.ballot.id &&
              ballot.confirmed &&
              !ballot.discarded,
          )
          .map((ballot) => recordKey("ballot", ballot.id))
      : [];
    return dedupeKeys([
      recordKey("ballot", payload.ballot.id),
      recordKey("debate", payload.ballot.debateId),
      ...previouslyConfirmed,
    ]);
  },
  validate(state, payload) {
    const { ballot } = payload;
    if (!isNonEmptyText(ballot.id)) {
      return ["Ballot id must not be empty."];
    }
    if (!isNonEmptyText(ballot.roundId)) {
      return ["Ballot roundId must not be empty."];
    }
    if (!isNonEmptyText(ballot.debateId)) {
      return ["Ballot debateId must not be empty."];
    }

    const round = state.rounds.find((item) => item.id === ballot.roundId);
    if (!round) {
      return [`Round ${ballot.roundId} does not exist.`];
    }
    const debate = state.debates.find((item) => item.id === ballot.debateId);
    if (!debate) {
      return [`Debate ${ballot.debateId} does not exist.`];
    }
    if (debate.roundId !== ballot.roundId) {
      return [
        `Debate ${ballot.debateId} belongs to round ${debate.roundId}, expected ${ballot.roundId}.`,
      ];
    }

    const errors: string[] = [];
    if (!ballotMatchesDebate(ballot, debate)) {
      errors.push("Ballot teams do not match the debate.");
    }

    errors.push(
      ...violationsToErrors(
        checkBallotSubmission(ballot, {
          rounds: state.rounds,
          debates: state.debates,
          ballots: state.ballots,
        }),
        payload.override,
      ),
    );
    errors.push(...validateBallotScores(state, round, debate, ballot, false));
    return errors;
  },
  apply(state, payload, actor) {
    const stored = cloneValue(payload.ballot);
    if (!Number.isInteger(stored.version) || stored.version <= 0) {
      stored.version = nextBallotVersion(state.ballots, stored.debateId);
    }
    const deadlineStatus = isBallotDeadlineActive(state, stored.roundId);
    if (deadlineStatus.late) {
      stored.late = true;
      if (actor?.ref) {
        stored.enteredBy = actor.ref;
      }
    }

    const exists = state.ballots.some((item) => item.id === stored.id);
    const updatedExisting = state.ballots.map((item) => {
      if (item.id === stored.id) {
        return stored;
      }
      if (
        stored.confirmed &&
        item.debateId === stored.debateId &&
        item.confirmed &&
        !item.discarded
      ) {
        return { ...cloneValue(item), confirmed: false };
      }
      return item;
    });
    const nextBallots = exists ? updatedExisting : [...updatedExisting, stored];

    const nextDebates = state.debates.map((debate) =>
      debate.id === stored.debateId
        ? updateDebateForBallots(debate, nextBallots)
        : debate,
    );

    return {
      state: {
        ...state,
        ballots: nextBallots,
        debates: nextDebates,
      },
      committedPayload: {
        ...cloneValue(payload),
        ballot: cloneValue(stored),
      },
    };
  },
  inverse(committedPayload) {
    return {
      type: "ballot.discard",
      payload: {
        ballotId: committedPayload.ballot.id,
        override: { reason: "Undo ballot.enter" },
      },
    };
  },
};

export const ballotReceiveOnlineOp: OpDef<BallotReceiveOnlinePayload> = {
  type: "ballot.receive_online",
  permission(state, payload) {
    if (payload.source === "qr") {
      return isBallotDeadlineActive(state, payload.ballot.roundId).late
        ? "results.enter_late"
        : "results.enter";
    }
    return "service";
  },
  category: "ballot",
  visibility: "private",
  lock: false,
  reads(state, payload) {
    return dedupeKeys([
      recordKey("tournament", state.tournament.id),
      recordKey("round", payload.ballot.roundId),
      recordKey("debate", payload.ballot.debateId),
      ...state.ballots
        .filter((ballot) => ballot.debateId === payload.ballot.debateId)
        .map((ballot) => recordKey("ballot", ballot.id)),
    ]);
  },
  writes(state, payload) {
    if (
      payload.routedToLate ||
      (payload.source === "inbox" &&
        payload.receivedAt !== undefined &&
        isBallotDeadlineActive(state, payload.ballot.roundId, payload.receivedAt).late)
    ) {
      return [recordKey("lateSubmission", payload.submissionId ?? payload.ballot.id)];
    }
    const ballotIds = payload.writtenBallotIds ?? [payload.ballot.id];
    return dedupeKeys([
      ...ballotIds.map((id) => recordKey("ballot", id)),
      recordKey("debate", payload.ballot.debateId),
    ]);
  },
  validate(state, payload) {
    if (payload.source !== "inbox" && payload.source !== "qr") {
      return ["source must be \"inbox\" or \"qr\"."];
    }
    if (payload.source === "inbox" && !isValidIsoInstant(payload.receivedAt)) {
      return ["receivedAt must be a valid ISO 8601 instant for inbox submissions."];
    }
    const { ballot } = payload;
    if (!isNonEmptyText(ballot.id)) {
      return ["Ballot id must not be empty."];
    }
    if (!isNonEmptyText(ballot.roundId)) {
      return ["Ballot roundId must not be empty."];
    }
    if (!isNonEmptyText(ballot.debateId)) {
      return ["Ballot debateId must not be empty."];
    }

    const round = state.rounds.find((item) => item.id === ballot.roundId);
    if (!round) {
      return [`Round ${ballot.roundId} does not exist.`];
    }
    const debate = state.debates.find((item) => item.id === ballot.debateId);
    if (!debate) {
      return [`Debate ${ballot.debateId} does not exist.`];
    }
    if (debate.roundId !== ballot.roundId) {
      return [
        `Debate ${ballot.debateId} belongs to round ${debate.roundId}, expected ${ballot.roundId}.`,
      ];
    }

    const blocker = remoteBallotSubmissionBlocker(round);
    if (blocker) {
      return [blocker];
    }

    if (
      payload.source === "inbox" &&
      isBallotDeadlineActive(state, ballot.roundId, payload.receivedAt).late
    ) {
      const lateId = payload.submissionId ?? ballot.id;
      if ((state.lateSubmissions ?? []).some((item) => item.id === lateId)) {
        return [`Late submission ${lateId} is already recorded.`];
      }
      return [];
    }

    const errors: string[] = [];
    if (!ballotMatchesDebate(ballot, debate)) {
      errors.push("Ballot teams do not match the debate.");
    }
    errors.push(
      ...violationsToErrors(
        checkBallotSubmission(
          { ...ballot, confirmed: false },
          {
            rounds: state.rounds,
            debates: state.debates,
            ballots: state.ballots,
          },
        ),
      ),
    );
    const individual = usesIndividualBallots(state.tournament, round);
    errors.push(...validateBallotScores(state, round, debate, ballot, individual));
    return errors;
  },
  apply(state, payload, actor) {
    const ballot = cloneValue(payload.ballot);
    const round = state.rounds.find((item) => item.id === ballot.roundId)!;
    const debate = state.debates.find((item) => item.id === ballot.debateId)!;

    if (payload.source === "inbox") {
      const inboxDeadline = isBallotDeadlineActive(
        state,
        ballot.roundId,
        payload.receivedAt,
      );
      if (inboxDeadline.late) {
        const lateId = payload.submissionId ?? ballot.id;
        const record: LateSubmissionRecord = {
          id: lateId,
          roundId: ballot.roundId,
          debateId: ballot.debateId,
          receivedAt: payload.receivedAt!,
          deadline: inboxDeadline.deadline!,
          ballot,
          source: "inbox",
        };
        return {
          state: {
            ...state,
            lateSubmissions: [...(state.lateSubmissions ?? []), record],
          },
          committedPayload: {
            ...cloneValue(payload),
            routedToLate: true,
          },
        };
      }
    }

    const existingRecords = existingRecordsForDebate(state.ballots, debate.id);
    const existingByDebate = new Map<string, readonly ExistingBallotRecord[]>([
      [debate.id, existingRecords],
    ]);
    const timestamp =
      payload.receivedAt ??
      state.runtime?.now ??
      ballot.timestamp ??
      state.tournament.updatedAt;
    const isQrLate =
      payload.source === "qr" && isBallotDeadlineActive(state, ballot.roundId).late;

    const annotateQrLate = (item: OpBallotSubmission): OpBallotSubmission => {
      if (!isQrLate) {
        return item;
      }
      return {
        ...item,
        late: true,
        ...(actor?.ref ? { enteredBy: actor.ref } : {}),
      };
    };

    let discardIds = new Set<string>();
    let writtenBallots: OpBallotSubmission[] = [];
    let primaryBallotId: string | undefined;

    if (usesIndividualBallots(state.tournament, round)) {
      const lockedDebateIds = isRoundLockedForPortalBallots(round)
        ? new Set([debate.id])
        : new Set<string>();
      const autoConfirm =
        payload.source === "qr"
          ? state.tournament.simpletab?.trustSignedBallots === true
          : state.tournament.preferences?.privateBallotConfirmation !== "tab_room";
      const submission: OpBallotSubmission = {
        ...ballot,
        submitterType: "judge",
      };
      const plan = planIndividualBallotWrites({
        submissions: [submission],
        existingByDebate,
        lockedDebateIds,
        debates: new Map([[debate.id, debate]]),
        rulesFor: (targetDebate) =>
          debateBallotRules(state.tournament, round, targetDebate, state.rounds),
        autoConfirm,
        timestamp,
      });

      const mergedIds = new Set(plan.merged.map((item) => item.id));
      discardIds = new Set(plan.discardExistingIds);
      writtenBallots = plan.writes.map((written) => {
        const next: OpBallotSubmission = cloneValue(written);
        if (payload.source === "qr" && autoConfirm && mergedIds.has(next.id)) {
          next.confirmedBy = "system";
          next.confirmedTimestamp = timestamp;
        }
        return annotateQrLate(next);
      });
      primaryBallotId = plan.merged[0]?.id ?? writtenBallots[0]?.id;
    } else {
      let prepared: OpBallotSubmission = votingRoundPrivateBallot(ballot, {
        tournament: state.tournament,
        round,
        debate,
        rounds: state.rounds,
      });
      const locked =
        isRoundLockedForPortalBallots(round) ||
        existingRecords.some((record) => isTabRoomConfirmed(record.data));

      if (payload.source === "qr") {
        if (state.tournament.simpletab?.trustSignedBallots === true && !locked) {
          prepared = {
            ...prepared,
            confirmed: true,
            confirmedBy: "system",
            confirmedTimestamp: timestamp,
          };
        } else {
          const nextUnconfirmed = cloneValue(prepared);
          delete nextUnconfirmed.confirmedBy;
          delete nextUnconfirmed.confirmedTimestamp;
          nextUnconfirmed.confirmed = false;
          prepared = nextUnconfirmed;
        }
      } else {
        prepared = applyPrivateBallotConfirmation(
          prepared,
          state.tournament,
          round,
        );
      }

      const plan = planPrivateBallotWrites(
        [prepared],
        existingByDebate,
        locked ? new Set([debate.id]) : new Set<string>(),
      );
      discardIds = new Set(plan.discardExistingIds);
      writtenBallots = plan.writes.map((written) =>
        annotateQrLate(cloneValue(written)),
      );
      primaryBallotId = writtenBallots[writtenBallots.length - 1]?.id;
    }

    const updatedExisting = state.ballots.map((item) => {
      if (!discardIds.has(item.id)) {
        return item;
      }
      return {
        ...cloneValue(item),
        confirmed: false,
        discarded: true,
      };
    });
    const nextBallots = [...updatedExisting, ...writtenBallots];
    const nextDebates = state.debates.map((item) =>
      item.id === debate.id ? updateDebateForBallots(item, nextBallots) : item,
    );

    const writtenBallotIds = dedupeKeys([
      ...writtenBallots.map((item) => item.id),
      ...[...discardIds],
    ] as unknown as RecordKey[]) as unknown as string[];

    return {
      state: {
        ...state,
        ballots: nextBallots,
        debates: nextDebates,
      },
      committedPayload: {
        ...cloneValue(payload),
        writtenBallotIds,
        ...(primaryBallotId ? { primaryBallotId } : {}),
        routedToLate: false,
      },
    };
  },
  inverse(committedPayload) {
    if (committedPayload.routedToLate || !committedPayload.primaryBallotId) {
      return null;
    }
    return {
      type: "ballot.discard",
      payload: {
        ballotId: committedPayload.primaryBallotId,
        override: { reason: "Undo ballot.receive_online" },
      },
    };
  },
};

export const ballotConfirmOp: OpDef<BallotConfirmPayload> = {
  type: "ballot.confirm",
  permission: "results.confirm_others",
  category: "ballot",
  visibility: "public",
  releaseGate: "round_results_released",
  lock: false,
  checkActor(actor, state, payload) {
    const ballot = state.ballots.find((item) => item.id === payload.ballotId);
    if (!ballot) {
      return null;
    }
    const violations = checkIndependentConfirmation(
      ballot,
      "confirm_existing",
      {
        doubleEntry: state.tournament.preferences.ballotDoubleEntry === true,
        actorId: actor.ref,
      },
      { ballots: state.ballots },
    );
    const errors = violationsToErrors(violations, payload.override);
    return errors.length > 0 ? errors.join(" ") : null;
  },
  reads(state, payload) {
    const ballot = state.ballots.find((item) => item.id === payload.ballotId);
    return dedupeKeys([
      recordKey("ballot", payload.ballotId),
      ...(ballot
        ? [
            recordKey("debate", ballot.debateId),
            recordKey("round", ballot.roundId),
            ...state.ballots
              .filter((item) => item.debateId === ballot.debateId)
              .map((item) => recordKey("ballot", item.id)),
          ]
        : []),
    ]);
  },
  writes(state, payload) {
    const ballot = state.ballots.find((item) => item.id === payload.ballotId);
    if (!ballot) {
      return [recordKey("ballot", payload.ballotId)];
    }
    const otherConfirmed = payload.unconfirmedBallotIds
      ? payload.unconfirmedBallotIds
      : state.ballots
          .filter(
            (item) =>
              item.debateId === ballot.debateId &&
              item.id !== ballot.id &&
              item.confirmed &&
              !item.discarded,
          )
          .map((item) => item.id);
    return dedupeKeys([
      recordKey("ballot", ballot.id),
      recordKey("debate", ballot.debateId),
      ...otherConfirmed.map((id) => recordKey("ballot", id)),
    ]);
  },
  validate(state, payload) {
    const ballot = state.ballots.find((item) => item.id === payload.ballotId);
    if (!ballot) {
      return [`Ballot ${payload.ballotId} does not exist.`];
    }
    if (ballot.discarded) {
      return [`Ballot ${payload.ballotId} has been discarded.`];
    }
    if (ballot.confirmed) {
      return [`Ballot ${payload.ballotId} is already confirmed.`];
    }
    if (
      payload.confirmedAt !== undefined &&
      !isValidIsoInstant(payload.confirmedAt)
    ) {
      return ["confirmedAt must be a valid ISO 8601 instant."];
    }
    const debate = state.debates.find((item) => item.id === ballot.debateId);
    if (!debate) {
      return [`Debate ${ballot.debateId} does not exist.`];
    }
    const errors: string[] = [];
    if (!ballotMatchesDebate(ballot, debate)) {
      errors.push("Ballot teams do not match the debate.");
    }
    errors.push(
      ...violationsToErrors(
        checkResultChange(ballot, {
          rounds: state.rounds,
          debates: state.debates,
          ballots: state.ballots,
        }),
        payload.override,
      ),
    );
    return errors;
  },
  apply(state, payload, actor) {
    const target = state.ballots.find((item) => item.id === payload.ballotId)!;
    const confirmedTimestamp =
      payload.confirmedAt ?? state.runtime?.now ?? state.tournament.updatedAt;
    const unconfirmedBallotIds: string[] = [];

    const nextBallots = state.ballots.map((item) => {
      if (item.id === target.id) {
        return {
          ...cloneValue(item),
          confirmed: true,
          confirmedBy: actor?.ref ?? "tabroom",
          ...(actor?.ref ? { confirmedById: actor.ref } : {}),
          confirmedTimestamp,
        };
      }
      if (
        item.debateId === target.debateId &&
        item.confirmed &&
        !item.discarded
      ) {
        unconfirmedBallotIds.push(item.id);
        return {
          ...cloneValue(item),
          confirmed: false,
        };
      }
      return item;
    });

    const nextDebates = state.debates.map((debate) =>
      debate.id === target.debateId
        ? updateDebateForBallots(debate, nextBallots)
        : debate,
    );

    return {
      state: {
        ...state,
        ballots: nextBallots,
        debates: nextDebates,
      },
      committedPayload: {
        ...cloneValue(payload),
        unconfirmedBallotIds,
      },
    };
  },
  inverse(committedPayload) {
    return {
      type: "ballot.discard",
      payload: {
        ballotId: committedPayload.ballotId,
        override: { reason: "Undo ballot.confirm" },
      },
    };
  },
};

export const ballotDiscardOp: OpDef<BallotDiscardPayload> = {
  type: "ballot.discard",
  permission: "results.confirm_others",
  category: "ballot",
  visibility: "public",
  releaseGate: "round_results_released",
  lock: false,
  reads(state, payload) {
    const ballot = state.ballots.find((item) => item.id === payload.ballotId);
    return dedupeKeys([
      recordKey("ballot", payload.ballotId),
      ...(ballot
        ? [recordKey("debate", ballot.debateId), recordKey("round", ballot.roundId)]
        : []),
    ]);
  },
  writes(state, payload) {
    const ballot = state.ballots.find((item) => item.id === payload.ballotId);
    return dedupeKeys([
      recordKey("ballot", payload.ballotId),
      ...(ballot ? [recordKey("debate", ballot.debateId)] : []),
    ]);
  },
  validate(state, payload) {
    const ballot = state.ballots.find((item) => item.id === payload.ballotId);
    if (!ballot) {
      return [`Ballot ${payload.ballotId} does not exist.`];
    }
    if (ballot.discarded) {
      return [`Ballot ${payload.ballotId} is already discarded.`];
    }
    if (
      payload.discardedAt !== undefined &&
      !isValidIsoInstant(payload.discardedAt)
    ) {
      return ["discardedAt must be a valid ISO 8601 instant."];
    }
    return violationsToErrors(
      checkResultChange(ballot, {
        rounds: state.rounds,
        debates: state.debates,
        ballots: state.ballots,
      }),
      payload.override,
    );
  },
  apply(state, payload, actor) {
    const target = state.ballots.find((item) => item.id === payload.ballotId)!;
    const discardedTimestamp =
      payload.discardedAt ?? state.runtime?.now ?? state.tournament.updatedAt;
    const nextBallots = state.ballots.map((item) =>
      item.id === target.id
        ? {
            ...cloneValue(item),
            confirmed: false,
            discarded: true,
            discardedBy: actor?.ref ?? "tabroom",
            discardedTimestamp,
          }
        : item,
    );
    const nextDebates = state.debates.map((debate) =>
      debate.id === target.debateId
        ? updateDebateForBallots(debate, nextBallots)
        : debate,
    );

    return {
      state: {
        ...state,
        ballots: nextBallots,
        debates: nextDebates,
      },
      committedPayload: cloneValue(payload),
    };
  },
  inverse() {
    return null;
  },
};

export const ballotIntakeRecordOp: OpDef<BallotIntakeRecordPayload> = {
  type: "ballot.intake_record",
  permission: "ballots.intake",
  category: "ballot",
  visibility: "private",
  lock: false,
  reads(state, payload) {
    return dedupeKeys([
      recordKey("round", payload.roundId),
      ...state.debates
        .filter((debate) => debate.roundId === payload.roundId)
        .map((debate) => recordKey("debate", debate.id)),
      ...(state.ballotIntake ?? []).map((record) =>
        recordKey("ballotIntake", record.id),
      ),
    ]);
  },
  writes(state, payload) {
    if (payload.recordId) {
      return [recordKey("ballotIntake", payload.recordId)];
    }
    const index = buildBallotSheetIndex(state.debates, state.adjudicators);
    const outcome = resolveIntakeScan({
      input: payload.sheetCode,
      roundId: payload.roundId,
      index,
      intake: state.ballotIntake ?? [],
      rounds: state.rounds,
      debates: state.debates,
    });
    if (outcome.kind === "accepted") {
      return [recordKey("ballotIntake", `intake-${outcome.sheet.code}`)];
    }
    return [];
  },
  validate(state, payload) {
    if (!isNonEmptyText(payload.sheetCode)) {
      return ["sheetCode must not be empty."];
    }
    if (!isNonEmptyText(payload.roundId)) {
      return ["roundId must not be empty."];
    }
    if (
      payload.receivedAt !== undefined &&
      !isValidIsoInstant(payload.receivedAt)
    ) {
      return ["receivedAt must be a valid ISO 8601 instant."];
    }
    const index = buildBallotSheetIndex(state.debates, state.adjudicators);
    const outcome = resolveIntakeScan({
      input: payload.sheetCode,
      roundId: payload.roundId,
      index,
      intake: state.ballotIntake ?? [],
      rounds: state.rounds,
      debates: state.debates,
    });
    if (outcome.kind !== "accepted") {
      return [outcome.message];
    }
    return [];
  },
  apply(state, payload, actor) {
    const index = buildBallotSheetIndex(state.debates, state.adjudicators);
    const outcome = resolveIntakeScan({
      input: payload.sheetCode,
      roundId: payload.roundId,
      index,
      intake: state.ballotIntake ?? [],
      rounds: state.rounds,
      debates: state.debates,
    });
    if (outcome.kind !== "accepted") {
      throw new Error(outcome.message);
    }
    const round = state.rounds.find((item) => item.id === outcome.sheet.roundId);
    const receivedAt =
      payload.receivedAt ?? state.runtime?.now ?? state.tournament.updatedAt;
    const record = createIntakeRecord({
      sheet: outcome.sheet,
      round,
      tournamentId: state.tournament.id,
      receivedAt,
      ...(actor?.ref ? { receivedBy: actor.ref } : {}),
      ...(payload.receivedByName
        ? { receivedByName: payload.receivedByName }
        : actor?.ref
          ? { receivedByName: actor.ref }
          : {}),
    });
    const { intake } = addIntakeRecord(cloneValue(state.ballotIntake ?? []), record);
    return {
      state: {
        ...state,
        ballotIntake: intake,
      },
      committedPayload: {
        ...cloneValue(payload),
        recordId: record.id,
      },
    };
  },
  inverse() {
    return null;
  },
};
