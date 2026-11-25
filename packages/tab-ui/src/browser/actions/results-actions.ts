import {
  blankEntry,
  entryFromBallot,
  nextBallotVersion,
  resolveCheckState,
  roundMotions,
} from "@simpletab/core/features/tournament/application/ballotEntry";
import {
  cleanScore,
  winnerDeclarationFor,
} from "@simpletab/core/lib/ballots/ballotRules";
import { votingAdjudicatorIds } from "@simpletab/core/lib/ballots/individualBallots";
import {
  applyScoreCriteria,
  buildBallotResult,
  debateBallotRules,
  diffBallots,
  rulesSides,
  teamSpeakerTotal,
  usesSpeakerScores,
  usesVotingBallots,
  validateBallotEntry,
  type BallotEntry,
  type BallotResult,
  type BallotDifference,
  type SideRecord,
} from "@simpletab/core/lib/ballots/result";
import { isTwoTeamFormat } from "@simpletab/core/lib/debateSides";
import { hasUniqueTeamRanks } from "@simpletab/core/lib/scoring/validator";
import { sideLabel } from "@simpletab/core/lib/sideNames";
import {
  recordKey,
  type LateSubmissionRecord,
  type OpBallotSubmission,
  type OpRound,
  type RecordKey,
} from "@simpletab/core/ops";
import type { Debate, DebateSide, Speaker } from "@simpletab/core/types";
import type {
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import { t } from "../i18n";
import { isDeadlinePassed } from "../lib/deadline";
import { qrFailureMessage, splitQrCodes } from "../lib/qr-messages";
import { stateHasPermission } from "../lib/permissions";
import type { TournamentStoreSnapshot } from "../store/tournament-store";
import { defineAction, type ActionContext } from "./action";

/** Widget id of the Results page. */
export const RESULTS_PAGE = "simpletab-results-widget";

type QrResult = { ok: true } | { ok: false; errors: string[] };

function stateOf(ctx: ActionContext): ProjectedState {
  const state = ctx.store.getState();
  if (state === null) {
    throw new Error(t("common.noTournamentPrompt"));
  }
  return state;
}

function versionOf(state: ProjectedState, key: RecordKey): number {
  return state.versions[key] ?? 0;
}

function activeRounds(state: ProjectedState): ProjectedState["rounds"] {
  return [...state.rounds].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}

function roundDebates(state: ProjectedState, roundId: string): Debate[] {
  return state.debates
    .filter((debate) => debate.roundId === roundId && !debate.byeTeamId)
    .sort((a, b) => a.roomRank - b.roomRank || a.id.localeCompare(b.id));
}

function roundOf(state: ProjectedState, roundId: string): ProjectedState["rounds"][number] {
  const round = state.rounds.find((item) => item.id === roundId);
  if (round === undefined) {
    throw new Error(t("results.noRounds"));
  }
  return round;
}

function debateOf(state: ProjectedState, debateId: string): Debate {
  const debate = state.debates.find((item) => item.id === debateId);
  if (debate === undefined) {
    throw new Error(t("results.unknownRoom"));
  }
  return debate;
}

function debateLabel(state: ProjectedState, debate: Debate): string {
  return (
    debate.venueName || t("draw.roomFallback", { rank: debate.roomRank })
  );
}

function sideLabelFor(state: ProjectedState, side: DebateSide): string {
  return sideLabel(
    side,
    state.tournament.preferences,
    state.tournament.format === "bp" ? "abbr" : "full",
  );
}

async function pickRound(ctx: ActionContext, state: ProjectedState): Promise<string | undefined> {
  return ctx.prompts.pick(
    activeRounds(state).map((round) => ({
      label: round.name,
      description: String(round.seq),
      value: round.id,
    })),
    t("action.results.pickRound"),
  );
}

async function pickDebate(
  ctx: ActionContext,
  state: ProjectedState,
  roundId: string,
): Promise<string | undefined> {
  return ctx.prompts.pick(
    roundDebates(state, roundId).map((debate) => ({
      label: debateLabel(state, debate),
      description: debate.id,
      value: debate.id,
    })),
    t("action.results.pickDebate"),
  );
}

async function pickYesNo(ctx: ActionContext, question: string): Promise<boolean | undefined> {
  const answer = await ctx.prompts.pick(
    [
      { label: t("common.yes"), value: true },
      { label: t("common.no"), value: false },
    ],
    question,
  );
  return answer;
}

function createBallotId(debateId: string, version: number): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return `ballot-${debateId}-v${version}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  }
  return `ballot-${debateId}-v${version}-${Date.now()}`;
}

function rostersOf(state: ProjectedState, debate: Debate): SideRecord<Speaker[]> {
  const teamById = new Map(state.teams.map((team) => [team.id, team]));
  const rosters: SideRecord<Speaker[]> = {};
  for (const [side, slot] of Object.entries(debate.teams)) {
    if (slot?.teamId) {
      rosters[side as DebateSide] = teamById.get(slot.teamId)?.speakers ?? [];
    }
  }
  return rosters;
}

function teamIdsOf(state: ProjectedState, debate: Debate, sides: readonly DebateSide[]) {
  return Object.fromEntries(
    sides.map((side) => [side, debate.teams[side]?.teamId ?? ""]),
  ) as Record<DebateSide, string>;
}

/** Builds the form's starting entry from the same rules and ballots the action uses. */
export function initialFormEntry(
  state: ProjectedState,
  round: OpRound,
  debate: Debate,
  actorId: string | undefined,
): BallotEntry | undefined {
  const checkState = resolveCheckState({
    ballots: state.ballots,
    debateId: debate.id,
    userId: actorId,
    doubleEntry: state.tournament.preferences.ballotDoubleEntry === true,
    checkMode: state.tournament.preferences.ballotCheckMode ?? "review",
  });
  if (checkState.kind === "blind-check") {
    return undefined;
  }
  const targetBallot =
    checkState.kind === "review"
      ? checkState.pending
      : state.ballots.find((ballot) => ballot.debateId === debate.id && !ballot.discarded);
  if (targetBallot === undefined) {
    return undefined;
  }
  const rules = debateBallotRules(state.tournament, round, debate, state.rounds);
  return entryFromBallot(targetBallot, blankEntry(debate, rostersOf(state, debate), state.adjudicators, rules), rules);
}

/** Validation used by the ballot form; the action never submits an entry that fails it. */
export function ballotValidationErrors(
  state: ProjectedState,
  round: OpRound,
  debate: Debate,
  entry: BallotEntry,
): string[] {
  const rules = debateBallotRules(state.tournament, round, debate, state.rounds);
  const rosters = rostersOf(state, debate);
  const sides = rulesSides(rules);
  const roundMotionIds = state.motions
    .filter((motion) => motion.rounds.includes(round.id))
    .map((motion) => motion.id);
  const votingAdjudicatorCount = votingAdjudicatorIds(debate).length;
  const coreErrors = validateBallotEntry(entry, {
    ...rules,
    rosters,
    ...(roundMotionIds.length > 0 ? { roundMotionIds } : {}),
    votingAdjudicatorCount,
  });
  return [...new Set([...coreErrors, ...extraConsensusRankErrors(entry, sides, rules)])];
}

function extraConsensusRankErrors(
  entry: BallotEntry,
  sides: readonly DebateSide[],
  rules: ReturnType<typeof debateBallotRules>,
): string[] {
  if (entry.forfeitSide || usesVotingBallots(rules) || isTwoTeamFormat(rules.format)) {
    return [];
  }
  const ranks = entry.ranks ?? {};
  const rankValues = sides.map((side) => ranks[side]);
  if (
    rankValues.some(
      (rank) =>
        typeof rank !== "number" ||
        !Number.isInteger(rank) ||
        rank < 1 ||
        rank > sides.length,
    ) ||
    !hasUniqueTeamRanks(ranks as Record<string, number>, [...sides])
  ) {
    return [
      rules.format === "bp"
        ? t("results.validationRankBp")
        : t("results.validationRankCount", { count: sides.length }),
    ];
  }

  if (!usesSpeakerScores(rules) || winnerDeclarationFor(rules.preferences) !== "none") {
    return [];
  }
  const allScoresFinite = sides.every((side) =>
    (entry.speakerScores[side] ?? []).every((speech) => Number.isFinite(speech.score)),
  );
  if (!allScoresFinite) {
    return [];
  }
  const totals = Object.fromEntries(
    sides.map((side) => [
      side,
      teamSpeakerTotal(applyScoreCriteria(entry.speakerScores[side] ?? [], rules), rules),
    ]),
  ) as Record<DebateSide, number>;
  const errors: string[] = [];
  const name = (side: DebateSide): string => sideLabel(side, rules.preferences);
  for (const higher of sides) {
    for (const lower of sides) {
      if ((ranks[higher] as number) >= (ranks[lower] as number)) {
        continue;
      }
      if (totals[higher] < totals[lower]) {
        errors.push(
          t("results.validationLowPoint", {
            higher: name(higher),
            lower: name(lower),
            higherTotal: cleanScore(totals[higher]),
            lowerTotal: cleanScore(totals[lower]),
          }),
        );
      } else if (totals[higher] === totals[lower]) {
        errors.push(
          t("results.validationTie", {
            higher: name(higher),
            lower: name(lower),
            total: cleanScore(totals[higher]),
          }),
        );
      }
    }
  }
  return errors;
}

export interface BuildBallotSubmissionOptions {
  now: string;
  actorId?: string;
  confirmNow?: boolean;
}

/**
 * The one place that turns a ballot form entry into an op ballot and finds blind-entry diffs.
 * The page uses the same helper to show a mismatch that the action submits.
 */
export function buildBallotSubmission(
  state: ProjectedState,
  round: OpRound,
  debate: Debate,
  entry: BallotEntry,
  result: BallotResult,
  options: BuildBallotSubmissionOptions,
): { ballot: OpBallotSubmission; blindDiffs: BallotDifference[] } {
  const doubleEntry = state.tournament.preferences.ballotDoubleEntry === true;
  const checkState = resolveCheckState({
    ballots: state.ballots,
    debateId: debate.id,
    userId: options.actorId,
    doubleEntry,
    checkMode: state.tournament.preferences.ballotCheckMode ?? "review",
  });
  const version = nextBallotVersion(state.ballots, debate.id);
  const deadline = round.simpletab?.ballotDeadline;
  const motion = entry.motionId
    ? state.motions.find((item) => item.id === entry.motionId)
    : undefined;
  const vetoes = Object.fromEntries(
    Object.entries(entry.vetoes ?? {}).filter(
      ([, motionId]) => typeof motionId === "string" && motionId.length > 0,
    ),
  ) as Partial<Record<DebateSide, string>>;

  const baseBallot: OpBallotSubmission = {
    id: createBallotId(debate.id, version),
    tournamentId: state.tournament.id,
    roundId: round.id,
    debateId: debate.id,
    version,
    confirmed: false,
    discarded: false,
    submitterType: "tabroom",
    ...(options.actorId ? { submitterId: options.actorId } : {}),
    ...(entry.motionId ? { motionId: entry.motionId } : {}),
    ...(motion?.text ? { motionText: motion.text } : {}),
    speakerScores: result.speakerScores,
    teamScores: result.teamScores,
    ...(result.sheets ? { sheets: result.sheets } : {}),
    ...(Object.keys(vetoes).length > 0 ? { vetoes } : {}),
    ...(entry.forfeitSide ? { forfeitSide: entry.forfeitSide } : {}),
    ...(result.noSpeakerScores ? { noSpeakerScores: true } : {}),
    ...(result.selfSplit ? { selfSplit: true } : {}),
    ...(debate.adjudicators.chairId ? { chairId: debate.adjudicators.chairId } : {}),
    timestamp: options.now,
    ...(isDeadlinePassed(deadline, Date.parse(options.now)) ? { late: true } : {}),
  };

  let ballot = baseBallot;
  let blindDiffs: BallotDifference[] = [];
  if (checkState.kind === "blind-check") {
    blindDiffs = diffBallots(checkState.pending, baseBallot, state.tournament.format);
    ballot = {
      ...baseBallot,
      confirmed: blindDiffs.length === 0,
      checksVersion: checkState.pending.version,
      ...(blindDiffs.length === 0
        ? {
            confirmedBy: options.actorId ?? "tabroom",
            confirmedTimestamp: options.now,
          }
        : {}),
    };
  } else if (options.confirmNow === true && checkState.kind === "single") {
    ballot = {
      ...baseBallot,
      confirmed: true,
      confirmedBy: options.actorId ?? "tabroom",
      confirmedTimestamp: options.now,
    };
  }
  return { ballot, blindDiffs };
}

export interface EnterBallotArgs {
  roundId: string;
  debateId: string;
  entry: BallotEntry;
  result: BallotResult;
  now: string;
  actorId?: string;
  confirmNow?: boolean;
}

export const enterBallotAction = defineAction<EnterBallotArgs, SubmitResult>({
  id: "simpletab.results.enter-ballot",
  labelKey: "action.results.enterBallot",
  page: RESULTS_PAGE,
  isEnabled(snapshot) {
    return (
      snapshot.state !== null &&
      snapshot.status.open &&
      activeRounds(snapshot.state).length > 0
    );
  },
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const roundId = await pickRound(ctx, state);
    if (roundId === undefined) {
      return undefined;
    }
    const debateId = await pickDebate(ctx, state, roundId);
    if (debateId === undefined) {
      return undefined;
    }
    const round = roundOf(state, roundId);
    const debate = debateOf(state, debateId);
    const rules = debateBallotRules(state.tournament, round, debate, state.rounds);
    const sides = rulesSides(rules);
    const motions = [
      ...roundMotions(state.motions, roundId).map((motion) => ({
        label: motion.reference ? `${motion.reference}: ${motion.text}` : motion.text,
        value: motion.id,
      })),
      { label: t("action.results.noneOption"), value: "" },
    ];
    const motionId = await ctx.prompts.pick(motions, t("action.results.pickMotion"));
    if (motionId === undefined) {
      return undefined;
    }
    const confirmNow = await pickYesNo(ctx, t("action.results.confirmOnEnter"));
    if (confirmNow === undefined) {
      return undefined;
    }

    const entry: BallotEntry = {
      ...blankEntry(debate, rostersOf(state, debate), state.adjudicators, rules),
      motionId,
    };
    const usedRanks = new Set<number>();
    for (const side of sides) {
      const choices = Array.from({ length: sides.length }, (_, idx) => idx + 1)
        .filter((rank) => !usedRanks.has(rank))
        .map((rank) => ({ label: String(rank), value: rank }));
      const rank = await ctx.prompts.pick(choices, t("action.results.pickRank", {
        side: sideLabelFor(state, side),
        count: sides.length,
      }));
      if (rank === undefined) {
        return undefined;
      }
      usedRanks.add(rank);
      entry.ranks = { ...(entry.ranks ?? {}), [side]: rank };

      const speeches = entry.speakerScores[side] ?? [];
      for (let index = 0; index < speeches.length; index += 1) {
        const speech = speeches[index];
        const label = t("action.results.pickScore", {
          side: sideLabelFor(state, side),
          position: speech.position,
        });
        const raw = await ctx.prompts.input(label, {
          value: Number.isFinite(speech.score) ? String(speech.score) : undefined,
          optional: true,
        });
        if (raw === undefined) {
          return undefined;
        }
        // A blank or bad score stays NaN; the check in `run` reports it like the form does.
        const score = raw.trim().length === 0 ? Number.NaN : Number(raw.trim());
        speeches[index] = { ...speech, score };
      }
      entry.speakerScores = { ...entry.speakerScores, [side]: speeches };
      if (entry.sheets !== undefined) {
        entry.sheets = entry.sheets.map((sheet) => ({
          ...sheet,
          speakerScores: {
            ...(sheet.speakerScores ?? {}),
            [side]: speeches.map((speech) => ({ ...speech })),
          },
        }));
      }
    }

    const result = buildBallotResult(
      entry,
      teamIdsOf(state, debate, sides),
      debate.adjudicators.chairId,
      rules,
    );
    return {
      roundId,
      debateId,
      entry,
      result,
      now: new Date().toISOString(),
      confirmNow,
    };
  },
  run(ctx, { roundId, debateId, entry, result, now, actorId, confirmNow }) {
    const state = stateOf(ctx);
    const round = roundOf(state, roundId);
    const debate = debateOf(state, debateId);
    // Same check as the form's disabled Save button: an invalid entry is never submitted.
    const errors = ballotValidationErrors(state, round, debate, entry);
    if (errors.length > 0) {
      return Promise.resolve({ ok: false, code: "INVALID", errors });
    }
    const { ballot } = buildBallotSubmission(state, round, debate, entry, result, {
      now,
      actorId,
      confirmNow,
    });
    const debateKey = recordKey("debate", debateId);
    return ctx.store.submit({
      type: "ballot.enter",
      expectedVersions: { [debateKey]: versionOf(state, debateKey) },
      payload: { ballot },
    });
  },
});

export interface ConfirmBallotArgs {
  ballotId: string;
  confirmedAt: string;
}

export const confirmBallotAction = defineAction<ConfirmBallotArgs, SubmitResult>({
  id: "simpletab.results.confirm-ballot",
  labelKey: "action.results.confirmBallot",
  page: RESULTS_PAGE,
  isEnabled(snapshot) {
    return (
      snapshot.state !== null &&
      snapshot.status.open &&
      stateHasPermission(snapshot.state, "results.confirm_others")
    );
  },
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const ballotId = await ctx.prompts.pick(
      state.ballots
        .filter((ballot) => !ballot.confirmed && !ballot.discarded)
        .map((ballot) => ({
          label: `${debateLabel(state, debateOf(state, ballot.debateId))} v${ballot.version}`,
          description: ballot.id,
          value: ballot.id,
        })),
      t("action.results.pickBallot"),
    );
    return ballotId === undefined
      ? undefined
      : { ballotId, confirmedAt: new Date().toISOString() };
  },
  run(ctx, { ballotId, confirmedAt }) {
    const state = stateOf(ctx);
    const ballot = state.ballots.find((item) => item.id === ballotId);
    if (ballot === undefined) {
      throw new Error(t("results.unknownRoom"));
    }
    return ctx.store.submit({
      type: "ballot.confirm",
      expectedVersions: {
        [recordKey("ballot", ballotId)]: versionOf(state, recordKey("ballot", ballotId)),
        [recordKey("debate", ballot.debateId)]: versionOf(state, recordKey("debate", ballot.debateId)),
      },
      payload: { ballotId, confirmedAt },
    });
  },
});

export interface DiscardBallotArgs {
  ballotId: string;
  discardedAt: string;
}

export const discardBallotAction = defineAction<DiscardBallotArgs, SubmitResult>({
  id: "simpletab.results.discard-ballot",
  labelKey: "action.results.discardBallot",
  page: RESULTS_PAGE,
  isEnabled(snapshot) {
    return (
      snapshot.state !== null &&
      snapshot.status.open &&
      stateHasPermission(snapshot.state, "results.confirm_others")
    );
  },
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const ballotId = await ctx.prompts.pick(
      state.ballots
        .filter((ballot) => !ballot.discarded)
        .map((ballot) => ({
          label: `${debateLabel(state, debateOf(state, ballot.debateId))} v${ballot.version}`,
          description: ballot.id,
          value: ballot.id,
        })),
      t("action.results.pickBallot"),
    );
    if (ballotId === undefined) {
      return undefined;
    }
    const confirmed = await ctx.prompts.confirm(
      t("action.results.confirmDiscardTitle"),
      t("action.results.confirmDiscardMessage"),
    );
    return confirmed
      ? { ballotId, discardedAt: new Date().toISOString() }
      : undefined;
  },
  run(ctx, { ballotId, discardedAt }) {
    const state = stateOf(ctx);
    const ballot = state.ballots.find((item) => item.id === ballotId);
    if (ballot === undefined) {
      throw new Error(t("results.unknownRoom"));
    }
    return ctx.store.submit({
      type: "ballot.discard",
      expectedVersions: {
        [recordKey("ballot", ballotId)]: versionOf(state, recordKey("ballot", ballotId)),
        [recordKey("debate", ballot.debateId)]: versionOf(state, recordKey("debate", ballot.debateId)),
      },
      payload: { ballotId, discardedAt },
    });
  },
});

export interface AcceptLateArgs {
  lateItemId: string;
  now: string;
  actorId?: string;
}

export const acceptLateBallotAction = defineAction<AcceptLateArgs, SubmitResult>({
  id: "simpletab.results.accept-late",
  labelKey: "action.results.acceptLate",
  page: RESULTS_PAGE,
  isEnabled(snapshot) {
    return (
      snapshot.state !== null &&
      snapshot.status.open &&
      stateHasPermission(snapshot.state, "results.enter_late") &&
      (snapshot.state.lateSubmissions ?? []).length > 0
    );
  },
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const lateItemId = await ctx.prompts.pick(
      (state.lateSubmissions ?? []).map((item) => ({
        label: debateLabel(state, debateOf(state, item.debateId)),
        description: item.receivedAt,
        value: item.id,
      })),
      t("action.results.pickLateItem"),
    );
    return lateItemId === undefined
      ? undefined
      : { lateItemId, now: new Date().toISOString() };
  },
  run(ctx, { lateItemId, now, actorId }) {
    const state = stateOf(ctx);
    const item: LateSubmissionRecord | undefined = (state.lateSubmissions ?? []).find(
      (entry) => entry.id === lateItemId,
    );
    if (item === undefined) {
      throw new Error(t("results.lateSubmissionsEmpty"));
    }
    const version = nextBallotVersion(state.ballots, item.debateId);
    const ballot: OpBallotSubmission = {
      ...item.ballot,
      id: createBallotId(item.debateId, version),
      version,
      confirmed: false,
      discarded: false,
      late: true,
      ...(actorId ? { enteredBy: actorId } : {}),
      timestamp: now,
    };
    return ctx.store.submit({
      type: "ballot.enter",
      expectedVersions: {
        [recordKey("debate", item.debateId)]: versionOf(state, recordKey("debate", item.debateId)),
      },
      payload: { ballot },
    });
  },
});

export interface ImportQrArgs {
  codes: string[];
}

export const importQrBallotAction = defineAction<ImportQrArgs, QrResult>({
  id: "simpletab.results.import-qr",
  labelKey: "action.results.importQr",
  page: RESULTS_PAGE,
  isEnabled(snapshot) {
    return snapshot.state !== null && snapshot.status.open;
  },
  async prompt(ctx) {
    const raw = await ctx.prompts.input(t("action.results.qrCodesPrompt"));
    return raw === undefined ? undefined : { codes: splitQrCodes(raw) };
  },
  async run(ctx, { codes }) {
    if (codes.length === 0) {
      return { ok: false, errors: [t("results.qrEmptyError")] };
    }
    const result = await ctx.store.receiveQrBallot(codes);
    if (!result.ok) {
      return { ok: false, errors: [qrFailureMessage(result)] };
    }
    return { ok: true };
  },
});

export interface RecordIntakeArgs {
  sheetCode: string;
  roundId: string;
  receivedAt: string;
}

export const recordBallotIntakeAction = defineAction<RecordIntakeArgs, SubmitResult>({
  id: "simpletab.results.record-intake",
  labelKey: "action.results.recordIntake",
  page: RESULTS_PAGE,
  isEnabled(snapshot) {
    return (
      snapshot.state !== null &&
      snapshot.status.open &&
      stateHasPermission(snapshot.state, "ballots.intake")
    );
  },
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const roundId = await pickRound(ctx, state);
    if (roundId === undefined) {
      return undefined;
    }
    const sheetCode = await ctx.prompts.input(t("action.results.sheetCodePrompt"));
    if (sheetCode === undefined || sheetCode.trim().length === 0) {
      return undefined;
    }
    return { sheetCode: sheetCode.trim(), roundId, receivedAt: new Date().toISOString() };
  },
  run(ctx, { sheetCode, roundId, receivedAt }) {
    stateOf(ctx);
    return ctx.store.submit({
      type: "ballot.intake_record",
      payload: { sheetCode, roundId, receivedAt },
    });
  },
});

/** The round status buttons run `cancelLockAction` / `openSetupAction` from Releases; no duplicates. */
export const RESULTS_ACTIONS = [
  enterBallotAction,
  confirmBallotAction,
  discardBallotAction,
  acceptLateBallotAction,
  importQrBallotAction,
  recordBallotIntakeAction,
] as const;

/** Used by the page to apply the same double-entry check state as the ballot action. */
export function resolveResultsCheckState(
  state: ProjectedState,
  debateId: string,
  actorId: string | undefined,
) {
  return resolveCheckState({
    ballots: state.ballots,
    debateId,
    userId: actorId,
    doubleEntry: state.tournament.preferences.ballotDoubleEntry === true,
    checkMode: state.tournament.preferences.ballotCheckMode ?? "review",
  });
}
