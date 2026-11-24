import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  sealRound,
  type RoundBundlePanelMember,
  type RoundBundleRow,
  type SealRowInput,
} from "@simpletab/core/bundle";
import { canonicalize } from "@simpletab/core/changelog";
import {
  base32Decode,
  deriveKeys,
  LETTER_TO_ROLE,
  type LinkRoleLetter,
} from "@simpletab/core/crypto";
import { motionsVisible } from "@simpletab/core/features/tournament/application/motionRelease";
import { votingAdjudicatorIds } from "@simpletab/core/lib/ballots/individualBallots";
import {
  ballotModeFor,
  debateBallotRules,
  rulesSides,
} from "@simpletab/core/lib/ballots/result";
import {
  isDrawPubliclyReleased,
  isDrawReleasedToTeams,
} from "@simpletab/core/lib/draw/drawStatus";
import { feedbackPathsForRound } from "@simpletab/core/lib/feedback/paths";
import {
  canSubmitParticipantFeedback,
  isFeedbackEnabledForRound,
  questionsForFeedbackSource,
} from "@simpletab/core/lib/feedback/questions";
import { feedbackScoreStep } from "@simpletab/core/lib/scoring/validator";
import type { OpRound, TournamentState } from "@simpletab/core/ops";
import type { LinkRecord } from "@simpletab/core/projection";
import type {
  Debate,
  DebateSide,
  FeedbackSourceRole,
  FeedbackTargetRole,
  TournamentPreferences,
} from "@simpletab/core/types";
import {
  parseFormsFile,
  parseManifest,
  parseMotionsFile,
  SCHEMA_VERSION,
  type BallotCollectionMode as ManifestBallotCollectionMode,
  type BallotFormDefinition,
  type BallotSideRoster,
  type CheckInFormDefinition,
  type FeedbackFormDefinition,
  type FeedbackTarget,
  type FormDefinition,
  type FormsFile,
  type MotionItem,
  type MotionsFile,
  type RoundManifestEntry,
  type TournamentManifest,
} from "@simpletab/core/wire";
import type { BallotCollectionMode as HostBallotCollectionMode } from "../../common/host-protocol";
import { isRoundOpenOnService } from "../sync/permits";

const MAX_NAME_CHARS = 80;
const PUBLISH_DIR_NAME = "publish";
const PUBLISH_CACHE_FILENAME = ".simpletab-publish-cache.json";

export interface BuildRoundFilesOptions {
  state: TournamentState;
  workspaceDir: string;
  ballotCollection: HostBallotCollectionMode;
  headHash?: string;
  nowIso?: string;
}

export interface BuildRoundFilesResult {
  publishDir: string;
  manifest: TournamentManifest;
  writtenFiles: string[];
  removedFiles: string[];
  skippedRounds: string[];
}

interface CachedRoundEntry {
  fingerprint: string;
  manifestEntry: RoundManifestEntry;
  files: string[];
}

interface PublishCache {
  schema: number;
  manifestFingerprint?: string;
  rounds: Record<string, CachedRoundEntry>;
}

export function mapBallotCollectionMode(
  mode: HostBallotCollectionMode,
): ManifestBallotCollectionMode {
  return mode === "online_qr" ? "online_and_qr" : mode;
}

function hash8(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 8);
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function truncateName(value: string, maxLen: number = MAX_NAME_CHARS): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(0, maxLen);
}

function normalizeIsoUtcMs(value: string | null | undefined): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function readCache(cachePath: string): PublishCache {
  if (!existsSync(cachePath)) {
    return { schema: 1, rounds: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as PublishCache;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      parsed.schema === 1 &&
      parsed.rounds !== null &&
      typeof parsed.rounds === "object"
    ) {
      return parsed;
    }
  } catch {
    // Ignore corrupted cache and rebuild cleanly.
  }
  return { schema: 1, rounds: {} };
}

function writePublishFile(
  publishDir: string,
  relPath: string,
  content: string | Uint8Array,
): void {
  const fullPath = path.join(publishDir, relPath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function removePublishFile(publishDir: string, relPath: string): boolean {
  const fullPath = path.join(publishDir, relPath);
  if (!existsSync(fullPath)) {
    return false;
  }
  rmSync(fullPath, { force: true });
  return true;
}

function findPasscode(
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

function anyPasscodeConfigured(state: TournamentState): boolean {
  return (
    state.adjudicators.some(
      (a) => typeof a.privatePasscode === "string" && a.privatePasscode.length > 0,
    ) ||
    state.teams.some(
      (t) =>
        (typeof t.privatePasscode === "string" && t.privatePasscode.length > 0) ||
        t.speakers.some(
          (s) => typeof s.privatePasscode === "string" && s.privatePasscode.length > 0,
        ),
    )
  );
}

function debateRoomLabel(debate: Debate): string {
  if (debate.venueName && debate.venueName.trim().length > 0) {
    return truncateName(debate.venueName);
  }
  return `Room ${debate.roomRank}`;
}

function buildPanelMembers(debate: Debate): RoundBundlePanelMember[] {
  const out: RoundBundlePanelMember[] = [];
  if (debate.adjudicators?.chairName) {
    out.push({
      name: truncateName(debate.adjudicators.chairName),
      role: "chair",
    });
  }
  for (const name of debate.adjudicators?.panellistNames ?? []) {
    out.push({ name: truncateName(name), role: "panellist" });
  }
  for (const name of debate.adjudicators?.traineeNames ?? []) {
    out.push({ name: truncateName(name), role: "trainee" });
  }
  return out;
}

function buildRoundBallotForm(
  state: TournamentState,
  round: OpRound,
  debate: Debate,
): BallotFormDefinition {
  const rules = debateBallotRules(state.tournament, round, debate, state.rounds);
  const sides = rulesSides(rules);
  const mode: BallotFormDefinition["mode"] =
    ballotModeFor(round, {
      format: state.tournament.format,
      preferences: state.tournament.preferences,
    }) === "voting"
      ? "voting_sheet"
      : "consensus";

  const teamById = new Map(state.teams.map((tm) => [tm.id, tm]));
  const sideRosters: Partial<Record<DebateSide, BallotSideRoster>> = {};
  for (const side of sides) {
    const slot = debate.teams?.[side];
    if (!slot) continue;
    const team = teamById.get(slot.teamId);
    sideRosters[side] = {
      teamId: slot.teamId,
      teamName: truncateName(team?.name ?? slot.teamName),
      speakers: (team?.speakers ?? []).map((spk) => ({
        id: spk.id,
        name: truncateName(spk.name),
      })),
    };
  }

  return {
    id: `ballot-${debate.id}`,
    kind: "ballot",
    mode,
    sides: sideRosters,
    ...(mode === "voting_sheet"
      ? { votingAdjudicatorCount: votingAdjudicatorIds(debate).length }
      : {}),
  };
}

function buildFeedbackTargetsForRole(
  state: TournamentState,
  round: OpRound,
  debate: Debate,
  sourceType: "team" | "adjudicator",
  sourceId: string,
  sourceRole: FeedbackSourceRole,
  isChair: boolean,
): { adjTargets: FeedbackTarget[]; teamTargets: FeedbackTarget[] } {
  const pathConfig = feedbackPathsForRound(state.tournament.preferences, round);
  const adjTargets: FeedbackTarget[] = [];
  const teamTargets: FeedbackTarget[] = [];

  const panelCandidates: Array<{
    id: string;
    name: string;
    role: FeedbackTargetRole;
    isChair: boolean;
  }> = [];
  if (debate.adjudicators?.chairId) {
    panelCandidates.push({
      id: debate.adjudicators.chairId,
      name: debate.adjudicators.chairName ?? "Chair",
      role: "chair",
      isChair: true,
    });
  }
  const panIds = debate.adjudicators?.panellistIds ?? [];
  const panNames = debate.adjudicators?.panellistNames ?? [];
  for (let i = 0; i < panIds.length; i += 1) {
    panelCandidates.push({
      id: panIds[i]!,
      name: panNames[i] ?? "Panellist",
      role: "panellist",
      isChair: false,
    });
  }
  const traineeIds = debate.adjudicators?.traineeIds ?? [];
  const traineeNames = debate.adjudicators?.traineeNames ?? [];
  for (let i = 0; i < traineeIds.length; i += 1) {
    panelCandidates.push({
      id: traineeIds[i]!,
      name: traineeNames[i] ?? "Trainee",
      role: "trainee",
      isChair: false,
    });
  }

  for (const target of panelCandidates) {
    if (
      canSubmitParticipantFeedback({
        sourceType,
        sourceId,
        sourceIsChair: isChair,
        sourceRole,
        targetType: "adjudicator",
        targetId: target.id,
        targetIsChair: target.isChair,
        targetRole: target.role,
        path: pathConfig,
      })
    ) {
      adjTargets.push({
        id: target.id,
        name: truncateName(target.name),
        role: target.role,
      });
    }
  }

  for (const slot of Object.values(debate.teams ?? {})) {
    if (!slot?.teamId) continue;
    if (
      canSubmitParticipantFeedback({
        sourceType,
        sourceId,
        sourceIsChair: isChair,
        sourceRole,
        targetType: "team",
        targetId: slot.teamId,
        targetIsChair: false,
        path: pathConfig,
      })
    ) {
      teamTargets.push({
        id: slot.teamId,
        name: truncateName(slot.teamName),
      });
    }
  }

  return { adjTargets, teamTargets };
}

function buildFormsPreferencesSnapshot(
  prefs: TournamentPreferences,
): Partial<TournamentPreferences> {
  return {
    teamsInDebate: prefs.teamsInDebate,
    substantiveSpeakers: prefs.substantiveSpeakers,
    replyScoresEnabled: prefs.replyScoresEnabled,
    minSpeakerScore: prefs.minSpeakerScore,
    maxSpeakerScore: prefs.maxSpeakerScore,
    stepSpeakerScore: prefs.stepSpeakerScore,
    minReplyScore: prefs.minReplyScore,
    maxReplyScore: prefs.maxReplyScore,
    ...(prefs.stepReplyScore !== undefined
      ? { stepReplyScore: prefs.stepReplyScore }
      : {}),
    ...(prefs.sideNames !== undefined ? { sideNames: prefs.sideNames } : {}),
    ...(prefs.winnersInBallots !== undefined
      ? { winnersInBallots: prefs.winnersInBallots }
      : {}),
    ...(prefs.allowLowPointWins !== undefined
      ? { allowLowPointWins: prefs.allowLowPointWins }
      : {}),
    ...(prefs.allowSelfSplitBallots !== undefined
      ? { allowSelfSplitBallots: prefs.allowSelfSplitBallots }
      : {}),
    ...(prefs.enableForfeits !== undefined
      ? { enableForfeits: prefs.enableForfeits }
      : {}),
    ...(prefs.enableMotionVetoes !== undefined
      ? { enableMotionVetoes: prefs.enableMotionVetoes }
      : {}),
    ...(prefs.scoreCriteria !== undefined
      ? { scoreCriteria: prefs.scoreCriteria }
      : {}),
    ...(prefs.speakersInBallots !== undefined
      ? { speakersInBallots: prefs.speakersInBallots }
      : {}),
    ...(prefs.speakerRanks !== undefined
      ? { speakerRanks: prefs.speakerRanks }
      : {}),
    ...(prefs.ballotIntroExplanation !== undefined
      ? { ballotIntroExplanation: prefs.ballotIntroExplanation }
      : {}),
    feedbackMinScore: prefs.feedbackMinScore,
    feedbackMaxScore: prefs.feedbackMaxScore,
    ...(prefs.feedbackScoreStep !== undefined
      ? { feedbackScoreStep: prefs.feedbackScoreStep }
      : {}),
    ...(prefs.feedbackIntroduction !== undefined
      ? { feedbackIntroduction: prefs.feedbackIntroduction }
      : {}),
  };
}

function buildReleasedRoundMotions(
  state: TournamentState,
  round: OpRound,
): MotionsFile | null {
  if (!motionsVisible(round)) {
    return null;
  }
  const roundMotions = state.motions
    .filter((m) => m.rounds?.includes(round.id))
    .sort((a, b) => {
      const seqA = a.roundSeq?.[round.id] ?? a.seq ?? 0;
      const seqB = b.roundSeq?.[round.id] ?? b.seq ?? 0;
      return seqA - seqB || a.id.localeCompare(b.id);
    });

  const motions: MotionItem[] = roundMotions.map((m) => ({
    id: m.id,
    text: m.text,
    ...(typeof m.infoSlide === "string" && m.infoSlide.length > 0
      ? { infoSlide: m.infoSlide }
      : {}),
  }));

  const file: MotionsFile = {
    schema: SCHEMA_VERSION,
    roundId: round.id,
    roundSeq: round.seq,
    motions,
  };
  const parsed = parseMotionsFile(file);
  if (!parsed.ok) {
    throw new Error(
      `Generated motions file failed validation: ${parsed.errors.join("; ")}`,
    );
  }
  return parsed.value;
}

interface BuiltRoundOutput {
  manifestEntry: RoundManifestEntry;
  files: Map<string, string | Uint8Array>;
}

async function buildSingleRoundOutput(
  state: TournamentState,
  round: OpRound,
): Promise<BuiltRoundOutput> {
  const files = new Map<string, string | Uint8Array>();
  const drawPublic = isDrawPubliclyReleased(round);
  const roundDebates = state.debates
    .filter((d) => d.roundId === round.id && !d.byeTeamId)
    .sort((a, b) => a.roomRank - b.roomRank || a.id.localeCompare(b.id));

  const forms: Record<string, FormDefinition> = {};
  const checkinFormId = `checkin-${round.id}`;
  const checkinDef: CheckInFormDefinition = {
    id: checkinFormId,
    kind: "checkin",
    roundId: round.id,
    roundName: round.name,
  };
  forms[checkinFormId] = checkinDef;

  const ballotMode = ballotModeFor(round, {
    format: state.tournament.format,
    preferences: state.tournament.preferences,
  });
  const privateBallotsOn =
    state.tournament.preferences.privateUrlBallots !== false;
  const feedbackOn =
    state.tournament.preferences.feedbackEnabled !== false &&
    state.tournament.preferences.privateUrlFeedback !== false;
  const feedbackInElims =
    state.tournament.preferences.feedbackInEliminationRounds ?? true;
  const teamFeedbackQuestions = questionsForFeedbackSource(
    "team",
    state.tournament.preferences,
  );
  const adjFeedbackQuestions = questionsForFeedbackSource(
    "adjudicator",
    state.tournament.preferences,
  );
  const fbStep = feedbackScoreStep(state.tournament.preferences);

  if (drawPublic && privateBallotsOn) {
    for (const debate of roundDebates) {
      if (debate.postponed) continue;
      const ballotDef = buildRoundBallotForm(state, round, debate);
      forms[ballotDef.id] = ballotDef;
    }
  }

  const teamById = new Map(state.teams.map((tm) => [tm.id, tm]));
  const sealRows: SealRowInput<RoundBundleRow>[] = [];

  for (const link of state.links) {
    const roleLetter = link.lookupId[0] as LinkRoleLetter;
    if (!(roleLetter in LETTER_TO_ROLE)) {
      continue;
    }
    const secretBytes = base32Decode(link.secret);
    if (secretBytes === null || secretBytes.byteLength !== 16) {
      continue;
    }
    const passcode = findPasscode(state, link.entityId, roleLetter);
    const derived = await deriveKeys(
      secretBytes,
      state.tournament.slug,
      passcode,
    );

    const participantForms: string[] = [];
    let room = "Unassigned";
    let venue = "";
    let side: string | undefined;
    let teammates: string[] | undefined;
    let panel: RoundBundlePanelMember[] | undefined;

    if (roleLetter === "a") {
      if (drawPublic) {
        for (const debate of roundDebates) {
          const adj = debate.adjudicators;
          const isChair = adj?.chairId === link.entityId;
          const isPanellist =
            adj?.panellistIds?.includes(link.entityId) ?? false;
          const isTrainee = adj?.traineeIds?.includes(link.entityId) ?? false;
          if (!isChair && !isPanellist && !isTrainee) {
            continue;
          }
          room = debateRoomLabel(debate);
          venue = room;
          panel = buildPanelMembers(debate);

          if (
            privateBallotsOn &&
            !debate.postponed &&
            (isChair || (isPanellist && ballotMode === "voting"))
          ) {
            participantForms.push(`ballot-${debate.id}`);
          }

          if (
            feedbackOn &&
            isFeedbackEnabledForRound(debate, round, feedbackInElims)
          ) {
            const sourceRole: FeedbackSourceRole = isChair
              ? "chair"
              : isPanellist
                ? "panellist"
                : "trainee";
            const { adjTargets, teamTargets } = buildFeedbackTargetsForRole(
              state,
              round,
              debate,
              "adjudicator",
              link.entityId,
              sourceRole,
              isChair,
            );
            if (adjTargets.length > 0) {
              const formId = `fb-adj-${debate.id}-${link.entityId}`;
              const def: FeedbackFormDefinition = {
                id: formId,
                kind: "feedback",
                targetType: "adjudicator",
                targets: adjTargets,
                minScore: state.tournament.preferences.feedbackMinScore,
                maxScore: state.tournament.preferences.feedbackMaxScore,
                scoreStep: fbStep,
                questions: adjFeedbackQuestions,
              };
              forms[formId] = def;
              participantForms.push(formId);
            }
            if (teamTargets.length > 0) {
              const formId = `fb-team-${debate.id}-${link.entityId}`;
              const def: FeedbackFormDefinition = {
                id: formId,
                kind: "feedback",
                targetType: "team",
                targets: teamTargets,
                minScore: state.tournament.preferences.feedbackMinScore,
                maxScore: state.tournament.preferences.feedbackMaxScore,
                scoreStep: fbStep,
                questions: teamFeedbackQuestions,
              };
              forms[formId] = def;
              participantForms.push(formId);
            }
          }
          break;
        }
      }
    } else {
      const teamId =
        roleLetter === "t"
          ? link.entityId
          : state.teams.find((tm) =>
              tm.speakers.some((s) => s.id === link.entityId),
            )?.id;
      const team = teamId ? teamById.get(teamId) : undefined;
      if (team !== undefined) {
        for (const debate of roundDebates) {
          const matchedEntry = Object.entries(debate.teams ?? {}).find(
            ([, slot]) => slot?.teamId === team.id,
          );
          if (!matchedEntry) {
            continue;
          }
          const [matchedSide] = matchedEntry;
          room = debateRoomLabel(debate);
          venue = room;
          side = matchedSide;
          teammates = team.speakers.map((spk) => truncateName(spk.name));
          if (drawPublic) {
            panel = buildPanelMembers(debate);
          }

          if (
            drawPublic &&
            feedbackOn &&
            isFeedbackEnabledForRound(debate, round, feedbackInElims)
          ) {
            const { adjTargets, teamTargets } = buildFeedbackTargetsForRole(
              state,
              round,
              debate,
              "team",
              team.id,
              "team",
              false,
            );
            if (adjTargets.length > 0) {
              const formId = `fb-adj-${debate.id}-${team.id}`;
              if (forms[formId] === undefined) {
                const def: FeedbackFormDefinition = {
                  id: formId,
                  kind: "feedback",
                  targetType: "adjudicator",
                  targets: adjTargets,
                  minScore: state.tournament.preferences.feedbackMinScore,
                  maxScore: state.tournament.preferences.feedbackMaxScore,
                  scoreStep: fbStep,
                  questions: teamFeedbackQuestions,
                };
                forms[formId] = def;
              }
              participantForms.push(formId);
            }
            if (teamTargets.length > 0) {
              const formId = `fb-team-${debate.id}-${team.id}`;
              if (forms[formId] === undefined) {
                const def: FeedbackFormDefinition = {
                  id: formId,
                  kind: "feedback",
                  targetType: "team",
                  targets: teamTargets,
                  minScore: state.tournament.preferences.feedbackMinScore,
                  maxScore: state.tournament.preferences.feedbackMaxScore,
                  scoreStep: fbStep,
                  questions: teamFeedbackQuestions,
                };
                forms[formId] = def;
              }
              participantForms.push(formId);
            }
          }
          break;
        }
      }
    }

    participantForms.push(checkinFormId);

    const row: RoundBundleRow = {
      room,
      venue,
      ...(side !== undefined ? { side } : {}),
      ...(teammates !== undefined ? { teammates } : {}),
      ...(panel !== undefined ? { panel } : {}),
      forms: participantForms,
    };

    sealRows.push({
      lookupId: link.lookupId,
      keys: {
        fileKey: derived.fileKey,
        lookupKey: derived.lookupKey,
      },
      row,
    });
  }

  const formsFile: FormsFile = {
    schema: SCHEMA_VERSION,
    roundId: round.id,
    roundSeq: round.seq,
    format: state.tournament.format,
    stage: round.stage,
    preferences: buildFormsPreferencesSnapshot(state.tournament.preferences),
    forms,
  };
  const validatedForms = parseFormsFile(formsFile);
  if (!validatedForms.ok) {
    throw new Error(
      `Generated forms file failed validation: ${validatedForms.errors.join("; ")}`,
    );
  }
  const formsJson = canonicalize(validatedForms.value);
  const formsRelPath = `forms/${round.seq}.${hash8(formsJson)}.json`;
  files.set(formsRelPath, formsJson);

  const sealedBuckets = await sealRound({
    roundSeq: round.seq,
    roundId: round.id,
    rows: sealRows,
  });
  const bucketPaths: Record<string, string> = {};
  for (const [bucketIdx, bytes] of sealedBuckets.entries()) {
    const bucketRelPath = `rounds/${round.seq}/${bucketIdx}.${hash8(bytes)}.bin`;
    bucketPaths[String(bucketIdx)] = bucketRelPath;
    files.set(bucketRelPath, bytes);
  }

  let motionsRelPath: string | undefined;
  const releasedMotions = buildReleasedRoundMotions(state, round);
  if (releasedMotions !== null) {
    const motionsJson = canonicalize(releasedMotions);
    motionsRelPath = `motions/${round.seq}.${hash8(motionsJson)}.json`;
    files.set(motionsRelPath, motionsJson);
  }

  const ballotDeadline = normalizeIsoUtcMs(round.simpletab?.ballotDeadline);
  const feedbackDeadline = normalizeIsoUtcMs(round.simpletab?.feedbackDeadline);

  const manifestEntry: RoundManifestEntry = {
    roundId: round.id,
    roundSeq: round.seq,
    roundName: round.name,
    stage: round.stage,
    open: isRoundOpenOnService(round),
    buckets: bucketPaths,
    formsFile: formsRelPath,
    ...(motionsRelPath !== undefined ? { motionsFile: motionsRelPath } : {}),
    ...(ballotDeadline !== undefined ? { ballotDeadline } : {}),
    ...(feedbackDeadline !== undefined ? { feedbackDeadline } : {}),
  };

  return { manifestEntry, files };
}

function computeRoundInputFingerprint(
  state: TournamentState,
  round: OpRound,
): string {
  const roundDebates = state.debates
    .filter((d) => d.roundId === round.id && !d.byeTeamId)
    .sort((a, b) => a.id.localeCompare(b.id));
  const roundMotions = motionsVisible(round)
    ? state.motions
        .filter((m) => m.rounds?.includes(round.id))
        .sort((a, b) => a.id.localeCompare(b.id))
    : [];

  return sha256Hex(
    canonicalize({
      slug: state.tournament.slug,
      format: state.tournament.format,
      preferences: buildFormsPreferencesSnapshot(state.tournament.preferences),
      round,
      debates: roundDebates,
      teams: state.teams,
      adjudicators: state.adjudicators,
      links: state.links,
      motions: roundMotions,
      motionsVisible: motionsVisible(round),
    }),
  );
}

/**
 * Generates static round bundles, forms files, released motions files, and `manifest.json`
 * into `<workspaceDir>/publish/`.
 *
 * Uses a content-addressed fingerprint cache outside `publish/` so repeated calls when nothing
 * relevant changed write zero files. Designed to be called on release/change and uploaded in M4.
 */
export async function buildRoundFiles(
  options: BuildRoundFilesOptions,
): Promise<BuildRoundFilesResult> {
  const { state, workspaceDir, ballotCollection, headHash } = options;
  const publishDir = path.join(workspaceDir, PUBLISH_DIR_NAME);
  const cachePath = path.join(workspaceDir, PUBLISH_CACHE_FILENAME);
  mkdirSync(publishDir, { recursive: true });

  const cache = readCache(cachePath);
  const writtenFiles: string[] = [];
  const removedFiles: string[] = [];
  const skippedRounds: string[] = [];

  const releasedRounds = state.rounds
    .filter((r) => !r.cancelled && isDrawReleasedToTeams(r))
    .sort((a, b) => a.seq - b.seq);
  const activeRoundIds = new Set(releasedRounds.map((r) => r.id));

  // Remove files belonging to rounds that are no longer released or were cancelled/deleted.
  for (const [roundId, cachedRound] of Object.entries(cache.rounds)) {
    if (!activeRoundIds.has(roundId)) {
      for (const oldFile of cachedRound.files) {
        if (removePublishFile(publishDir, oldFile)) {
          removedFiles.push(oldFile);
        }
      }
      delete cache.rounds[roundId];
    }
  }

  const roundEntries: RoundManifestEntry[] = [];
  for (const round of releasedRounds) {
    const fingerprint = computeRoundInputFingerprint(state, round);
    const cached = cache.rounds[round.id];
    const allFilesPresent =
      cached !== undefined &&
      cached.fingerprint === fingerprint &&
      cached.files.every((f) => existsSync(path.join(publishDir, f)));

    if (allFilesPresent) {
      roundEntries.push(cached.manifestEntry);
      skippedRounds.push(round.id);
      continue;
    }

    const built = await buildSingleRoundOutput(state, round);
    const newFilesSet = new Set(built.files.keys());

    if (cached !== undefined) {
      for (const oldFile of cached.files) {
        if (!newFilesSet.has(oldFile) && removePublishFile(publishDir, oldFile)) {
          removedFiles.push(oldFile);
        }
      }
    }

    for (const [relPath, content] of built.files.entries()) {
      writePublishFile(publishDir, relPath, content);
      writtenFiles.push(relPath);
    }

    cache.rounds[round.id] = {
      fingerprint,
      manifestEntry: built.manifestEntry,
      files: [...newFilesSet],
    };
    roundEntries.push(built.manifestEntry);
  }

  const timeZone =
    state.tournament.simpletab?.timeZone ??
    releasedRounds.find((r) => r.simpletab?.timeZone)?.simpletab?.timeZone ??
    "UTC";
  const currentRound =
    releasedRounds.find((r) => isRoundOpenOnService(r)) ??
    releasedRounds[releasedRounds.length - 1];
  const currentRoundSeq = currentRound?.seq ?? 0;

  const manifestCore = {
    schema: SCHEMA_VERSION,
    slug: state.tournament.slug,
    tournamentName: state.tournament.name,
    timeZone,
    ballotCollectionMode: mapBallotCollectionMode(ballotCollection),
    usesPasscodes: anyPasscodeConfigured(state),
    ...(state.tournament.preferences?.publicLanguage
      ? { defaultLanguage: state.tournament.preferences.publicLanguage }
      : {}),
    currentRoundSeq,
    rounds: roundEntries,
    ...(headHash !== undefined ? { headHash } : {}),
  };

  const manifestFingerprint = sha256Hex(canonicalize(manifestCore));
  const manifestPath = path.join(publishDir, "manifest.json");
  let manifest: TournamentManifest;

  if (
    cache.manifestFingerprint === manifestFingerprint &&
    existsSync(manifestPath)
  ) {
    const existingParsed = parseManifest(
      JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
    );
    if (existingParsed.ok) {
      manifest = existingParsed.value;
    } else {
      manifest = {
        ...manifestCore,
        publishedAt: options.nowIso ?? new Date().toISOString(),
      };
      writePublishFile(
        publishDir,
        "manifest.json",
        JSON.stringify(manifest, null, 2),
      );
      writtenFiles.push("manifest.json");
    }
  } else {
    manifest = {
      ...manifestCore,
      publishedAt: options.nowIso ?? new Date().toISOString(),
    };
    const validated = parseManifest(manifest);
    if (!validated.ok) {
      throw new Error(
        `Generated manifest failed validation: ${validated.errors.join("; ")}`,
      );
    }
    manifest = validated.value;
    writePublishFile(
      publishDir,
      "manifest.json",
      JSON.stringify(manifest, null, 2),
    );
    writtenFiles.push("manifest.json");
  }

  cache.manifestFingerprint = manifestFingerprint;
  writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf8");

  return {
    publishDir,
    manifest,
    writtenFiles,
    removedFiles,
    skippedRounds,
  };
}
