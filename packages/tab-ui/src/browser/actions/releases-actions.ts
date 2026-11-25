import {
  MOTIONS_STATUSES,
  motionsStatusOf,
} from "@simpletab/core/features/tournament/application/motionRelease";
import {
  drawStageOf,
  isDrawPubliclyReleased,
  isDrawReleasedToTeams,
} from "@simpletab/core/lib/draw/drawStatus";
import { getPublicSiteSettings } from "@simpletab/core/lib/publicFeatures";
import { getPublicRelease } from "@simpletab/core/lib/publicRelease";
import {
  recordKey,
  type OpRequest,
  type OpRound,
  type RecordKey,
} from "@simpletab/core/ops";
import type { ReleaseGateName } from "@simpletab/core/ops/releases";
import type { MotionsStatus } from "@simpletab/core/types";
import type {
  ArchiveStatus,
  HostCancelLongResult,
  HostLockInfo,
  ProjectedState,
  PublishStatus,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import { t } from "../i18n";
import { stateHasPermission } from "../lib/permissions";
import type { TournamentStoreSnapshot } from "../store/tournament-store";
import { openSetupPageAction } from "./navigation-actions";
import { defineAction, type ActionContext } from "./action";

/** Widget id of the Releases page. */
export const RELEASES_PAGE = "simpletab-releases-widget";
/** The palette's "open Setup" action uses the same widget id as the shell command. */
export const SETUP_PAGE = "simpletab-setup-widget";

export interface GateSpec {
  gate: ReleaseGateName;
  labelKey: string;
  isReleased: (state: ProjectedState) => boolean;
  categoryId?: string;
  categoryName?: string;
}

const TAB_GATES: readonly GateSpec[] = [
  {
    gate: "tab_team",
    labelKey: "releases.gateTabTeam",
    isReleased: (s) => getPublicRelease(s.tournament.preferences).teamTab,
  },
  {
    gate: "tab_speaker",
    labelKey: "releases.gateTabSpeaker",
    isReleased: (s) => getPublicRelease(s.tournament.preferences).speakerTab,
  },
  {
    gate: "tab_replies",
    labelKey: "releases.gateTabReplies",
    isReleased: (s) => s.tournament.preferences.releaseRepliesTab === true,
  },
  {
    gate: "tab_speaker_categories",
    labelKey: "releases.gateTabSpeakerCategories",
    isReleased: (s) =>
      getPublicRelease(s.tournament.preferences).speakerCategoryTabs,
  },
  {
    gate: "tab_adjudicator",
    labelKey: "releases.gateTabAdjudicator",
    isReleased: (s) =>
      getPublicSiteSettings(s.tournament.preferences).adjudicatorTab,
  },
  {
    gate: "tab_break_categories",
    labelKey: "releases.gateTabBreakCategories",
    isReleased: (s) =>
      getPublicSiteSettings(s.tournament.preferences).breakCategoryTabs,
  },
  {
    gate: "tab_motions",
    labelKey: "releases.gateTabMotions",
    isReleased: (s) => getPublicSiteSettings(s.tournament.preferences).motionTab,
  },
];

const LIST_GATES: readonly GateSpec[] = [
  {
    gate: "public_participants",
    labelKey: "releases.gatePublicParticipants",
    isReleased: (s) => getPublicRelease(s.tournament.preferences).participants,
  },
  {
    gate: "public_institutions",
    labelKey: "releases.gatePublicInstitutions",
    isReleased: (s) => getPublicRelease(s.tournament.preferences).institutions,
  },
  {
    gate: "public_adjudicator_core",
    labelKey: "releases.gatePublicAdjudicatorCore",
    isReleased: (s) =>
      getPublicRelease(s.tournament.preferences).adjudicatorCore,
  },
  {
    gate: "public_breaking_adjudicators",
    labelKey: "releases.gatePublicBreakingAdjudicators",
    isReleased: (s) =>
      getPublicRelease(s.tournament.preferences).breakingAdjudicators,
  },
];

const BALLOT_GATES: readonly GateSpec[] = [
  {
    gate: "public_ballots",
    labelKey: "releases.gatePublicBallots",
    isReleased: (s) => getPublicSiteSettings(s.tournament.preferences).ballots,
  },
  {
    gate: "public_private_ballots",
    labelKey: "releases.gatePublicPrivateBallots",
    isReleased: (s) =>
      getPublicSiteSettings(s.tournament.preferences).privateBallots,
  },
];

const OTHER_PAGE_GATES: readonly GateSpec[] = [
  {
    gate: "public_record_pages",
    labelKey: "releases.gatePublicRecordPages",
    isReleased: (s) => getPublicSiteSettings(s.tournament.preferences).recordPages,
  },
  {
    gate: "public_side_allocations",
    labelKey: "releases.gatePublicSideAllocations",
    isReleased: (s) =>
      getPublicSiteSettings(s.tournament.preferences).sideAllocations,
  },
  {
    gate: "public_bracket",
    labelKey: "releases.gatePublicBracket",
    isReleased: (s) => getPublicSiteSettings(s.tournament.preferences).bracket,
  },
  {
    gate: "public_diversity",
    labelKey: "releases.gatePublicDiversity",
    isReleased: (s) => getPublicSiteSettings(s.tournament.preferences).diversity,
  },
  {
    gate: "public_veto_statistics",
    labelKey: "releases.gatePublicVetoStatistics",
    isReleased: (s) =>
      s.tournament.preferences.publicVetoStatistics === true,
  },
  {
    gate: "public_feedback_progress",
    labelKey: "releases.gatePublicFeedbackProgress",
    isReleased: (s) =>
      getPublicSiteSettings(s.tournament.preferences).feedbackProgress,
  },
];

const RESULTS_GATE: GateSpec = {
  gate: "results_all_rounds",
  labelKey: "releases.gateResultsAllRounds",
  isReleased: (s) => getPublicRelease(s.tournament.preferences).allResults,
};

/** Gate groups, in the page's order, with the per-break-category rows added. */
export function gateGroups(state: ProjectedState): ReadonlyArray<readonly GateSpec[]> {
  return [
    TAB_GATES,
    [
      RESULTS_GATE,
      ...state.breakCategories.map((cat) => ({
        gate: "break_category_published" as const,
        labelKey: "releases.gateBreakCategory" as const,
        isReleased: (s: ProjectedState) =>
          getPublicRelease(s.tournament.preferences).breakCategoryIds.has(
            cat.id,
          ),
        categoryId: cat.id,
        categoryName: cat.name,
      })),
    ],
    LIST_GATES,
    BALLOT_GATES,
    OTHER_PAGE_GATES,
  ];
}

function stateOf(ctx: ActionContext): ProjectedState {
  const state = ctx.store.getState();
  if (state === null) {
    throw new Error(t("common.noTournamentPrompt"));
  }
  return state;
}

function canManage(snapshot: TournamentStoreSnapshot): boolean {
  return (
    snapshot.state !== null &&
    snapshot.status.open &&
    stateHasPermission(snapshot.state, "releases.manage")
  );
}

function activeRounds(state: ProjectedState): OpRound[] {
  return state.rounds
    .filter((round) => round.cancelled !== true)
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}

function versionOf(state: ProjectedState, key: RecordKey): number {
  return state.versions[key] ?? 0;
}

async function pickOnOff(ctx: ActionContext, placeholder: string): Promise<boolean | undefined> {
  return ctx.prompts.pick(
    [
      { label: t("releases.stateReleased"), value: true },
      { label: t("releases.stateUnreleased"), value: false },
    ],
    placeholder,
  );
}

async function pickGate(ctx: ActionContext): Promise<GateSpec | undefined> {
  const state = ctx.store.getState();
  if (state === null) return undefined;
  const specs = gateGroups(state).flat();
  return ctx.prompts.pick(
    specs.map((spec) => ({
      label:
        spec.categoryId === undefined
          ? t(spec.labelKey)
          : t(spec.labelKey, { name: spec.categoryName ?? spec.categoryId }),
      description: spec.categoryId,
      value: spec,
    })),
    t("action.releases.pickGate"),
  );
}

async function pickRound(ctx: ActionContext): Promise<string | undefined> {
  const state = ctx.store.getState();
  if (state === null) return undefined;
  return ctx.prompts.pick(
    activeRounds(state).map((round) => ({
      label: round.name,
      description: String(round.seq),
      value: round.id,
    })),
    t("action.releases.pickRound"),
  );
}

export function lockLabel(
  lock: HostLockInfo,
  rounds: ReadonlyArray<{ id: string; name: string }>,
): string {
  const roundName =
    lock.roundId !== undefined
      ? rounds.find((round) => round.id === lock.roundId)?.name
      : undefined;
  switch (lock.opType) {
    case "draw.generate":
      return roundName
        ? t("lock.generatingRound", { round: roundName })
        : t("lock.generatingFallback");
    case "allocation.auto":
      return roundName
        ? t("lock.allocatingRound", { round: roundName })
        : t("lock.allocatingFallback");
    case "allocation.preformed_autofill":
      return roundName
        ? t("lock.autofillingRound", { round: roundName })
        : t("lock.autofillingFallback");
    case "break.compute":
      return t("lock.computingBreak");
    default:
      return t("lock.generic", {
        opType: lock.opType,
        actorRef: lock.actorRef,
      });
  }
}

export interface SetGateArgs {
  gate: ReleaseGateName;
  released: boolean;
  labelKey: string;
  categoryId?: string;
}

export const setGateAction = defineAction<SetGateArgs, SubmitResult>({
  id: "simpletab.releases.set-gate",
  labelKey: "action.releases.setGate",
  page: RELEASES_PAGE,
  isEnabled: canManage,
  async prompt(ctx) {
    const spec = await pickGate(ctx);
    if (spec === undefined) return undefined;
    const released = await pickOnOff(ctx, t("action.releases.pickGateState"));
    if (released === undefined) return undefined;
    return {
      gate: spec.gate,
      released,
      labelKey: spec.labelKey,
      ...(spec.categoryId !== undefined ? { categoryId: spec.categoryId } : {}),
    };
  },
  run(ctx, { gate, released, categoryId }) {
    const state = stateOf(ctx);
    const tournamentKey = recordKey("tournament", state.tournament.id);
    const expectedVersions: Record<string, number> = {
      [tournamentKey]: versionOf(state, tournamentKey),
    };
    if (categoryId !== undefined) {
      const key = recordKey("breakCategory", categoryId);
      expectedVersions[key] = versionOf(state, key);
    }
    return ctx.store.submit({
      type: "release.set_gate",
      expectedVersions,
      payload: {
        gate,
        released,
        ...(categoryId !== undefined ? { categoryId } : {}),
      },
    });
  },
});

type NoArgs = Record<string, never>;

export const releaseTabBundleAction = defineAction<NoArgs, SubmitResult>({
  id: "simpletab.releases.release-tab-bundle",
  labelKey: "action.releases.releaseTabBundle",
  page: RELEASES_PAGE,
  isEnabled: canManage,
  async prompt(ctx) {
    const confirmed = await ctx.prompts.confirm(
      t("releases.bundleDialogTitle"),
      t("releases.bundleDialogIntro"),
    );
    return confirmed ? {} : undefined;
  },
  run(ctx) {
    const state = stateOf(ctx);
    const versions: Record<string, number> = {};
    const tournamentKey = recordKey("tournament", state.tournament.id);
    versions[tournamentKey] = versionOf(state, tournamentKey);
    for (const cat of state.breakCategories) {
      const key = recordKey("breakCategory", cat.id);
      versions[key] = versionOf(state, key);
    }
    return ctx.store.submit({
      type: "release.tab_bundle",
      expectedVersions: versions,
      payload: {
        breakCategoryIds: state.breakCategories.map((cat) => cat.id),
      },
    });
  },
});

export interface SetDrawGateArgs {
  roundId: string;
  scope: "teams" | "public";
  released: boolean;
}

export const setDrawGateAction = defineAction<SetDrawGateArgs, SubmitResult>({
  id: "simpletab.releases.set-draw-gate",
  labelKey: "action.releases.setDrawGate",
  page: RELEASES_PAGE,
  isEnabled(snapshot) {
    const state = snapshot.state;
    return (
      state !== null &&
      snapshot.status.open &&
      stateHasPermission(state, "draw.release") &&
      activeRounds(state).some((round) => drawStageOf(round) !== "none")
    );
  },
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) return undefined;
    const choices = activeRounds(state).filter(
      (round) => drawStageOf(round) !== "none",
    );
    const roundId = await ctx.prompts.pick(
      choices.map((round) => ({ label: round.name, value: round.id })),
      t("action.releases.pickRound"),
    );
    if (roundId === undefined) return undefined;
    const scope = await ctx.prompts.pick(
      [
        { label: t("releases.gateDrawTeams"), value: "teams" as const },
        { label: t("releases.gateDrawPublic"), value: "public" as const },
      ],
      t("action.releases.pickDrawGate"),
    );
    if (scope === undefined) return undefined;
    const released = await pickOnOff(ctx, t("action.releases.pickGateState"));
    if (released === undefined) return undefined;
    return { roundId, scope, released };
  },
  run(ctx, { roundId, scope, released }) {
    const state = stateOf(ctx);
    const round = state.rounds.find((item) => item.id === roundId);
    if (round === undefined || round.cancelled === true) {
      throw new Error(t("releases.noRounds"));
    }
    const opType =
      scope === "teams"
        ? released
          ? "draw.release_teams"
          : "draw.unrelease"
        : released
          ? "draw.release"
          : "draw.unrelease";
    const key = recordKey("round", round.id);
    return ctx.store.submit({
      type: opType,
      expectedVersions: { [key]: versionOf(state, key) },
      payload: { roundId: round.id },
    });
  },
});

export interface SetRoundMotionsArgs {
  roundId: string;
  status: MotionsStatus;
  now?: string;
}

export const setRoundMotionsAction = defineAction<SetRoundMotionsArgs, SubmitResult>({
  id: "simpletab.releases.set-round-motions",
  labelKey: "action.releases.setRoundMotions",
  page: RELEASES_PAGE,
  isEnabled(snapshot) {
    const state = snapshot.state;
    return (
      state !== null &&
      snapshot.status.open &&
      stateHasPermission(state, "motions.manage") &&
      activeRounds(state).length > 0
    );
  },
  async prompt(ctx) {
    const roundId = await pickRound(ctx);
    if (roundId === undefined) return undefined;
    const status = await ctx.prompts.pick(
      MOTIONS_STATUSES.map((option) => ({
        label: t(
          option === "not_released"
            ? "motions.releaseNotReleased"
            : option === "info_slides_released"
              ? "motions.releaseInfoSlides"
              : "motions.releaseMotions",
        ),
        value: option,
      })),
      t("action.releases.pickMotionsStatus"),
    );
    return status === undefined ? undefined : { roundId, status };
  },
  run(ctx, { roundId, status, now }) {
    const state = stateOf(ctx);
    const round = state.rounds.find((item) => item.id === roundId);
    if (round === undefined || round.cancelled === true) {
      throw new Error(t("releases.noRounds"));
    }
    const key = recordKey("round", round.id);
    return ctx.store.submit({
      type: "motion.set_round_status",
      expectedVersions: { [key]: versionOf(state, key) },
      payload: {
        roundId: round.id,
        status,
        now: now ?? new Date().toISOString(),
      },
    });
  },
});

export type RoundReleaseField =
  | "resultsReleased"
  | "teamSpeaksReleased"
  | "adjudicatorsRevealed";

export interface SetRoundFlagArgs {
  roundId: string;
  field: RoundReleaseField;
  released: boolean;
}

const ROUND_FIELDS: ReadonlyArray<{
  field: RoundReleaseField;
  labelKey: string;
}> = [
  { field: "resultsReleased", labelKey: "releases.gateResults" },
  { field: "teamSpeaksReleased", labelKey: "releases.gateSpeaks" },
  { field: "adjudicatorsRevealed", labelKey: "releases.gateAdjudicators" },
];

export const setRoundFlagAction = defineAction<SetRoundFlagArgs, SubmitResult>({
  id: "simpletab.releases.set-round-flag",
  labelKey: "action.releases.setRoundFlag",
  page: RELEASES_PAGE,
  isEnabled(snapshot) {
    const state = snapshot.state;
    return (
      state !== null &&
      snapshot.status.open &&
      stateHasPermission(state, "rounds.manage") &&
      activeRounds(state).length > 0
    );
  },
  async prompt(ctx) {
    const roundId = await pickRound(ctx);
    if (roundId === undefined) return undefined;
    const field = await ctx.prompts.pick(
      ROUND_FIELDS.map(({ field, labelKey }) => ({
        label: t(labelKey),
        value: field,
      })),
      t("action.releases.pickRoundFlag"),
    );
    if (field === undefined) return undefined;
    const released = await pickOnOff(ctx, t("action.releases.pickGateState"));
    if (released === undefined) return undefined;
    return { roundId, field, released };
  },
  run(ctx, { roundId, field, released }) {
    const state = stateOf(ctx);
    const round = state.rounds.find((item) => item.id === roundId);
    if (round === undefined || round.cancelled === true) {
      throw new Error(t("releases.noRounds"));
    }
    const updatedRound: OpRound = { ...round, [field]: released };
    const key = recordKey("round", round.id);
    return ctx.store.submit({
      type: "round.update",
      expectedVersions: { [key]: versionOf(state, key) },
      payload: { round: updatedRound },
    });
  },
});

export interface CancelLockArgs {
  lockId: string;
}

export const cancelLockAction = defineAction<CancelLockArgs, HostCancelLongResult>({
  id: "simpletab.releases.cancel-lock",
  labelKey: "action.releases.cancelLock",
  page: RELEASES_PAGE,
  isEnabled(snapshot) {
    return (
      snapshot.state?.roleId === "host_owner" &&
      snapshot.status.open &&
      snapshot.status.locks.length > 0
    );
  },
  async prompt(ctx) {
    const { locks } = ctx.store.getSnapshot().status;
    const lockId = await ctx.prompts.pick(
      locks.map((lock) => ({
        label: lockLabel(lock, ctx.store.getState()?.rounds ?? []),
        description: lock.opType,
        value: lock.lockId,
      })),
      t("action.releases.pickLock"),
    );
    return lockId === undefined ? undefined : { lockId };
  },
  run(ctx, { lockId }) {
    return ctx.store.cancelLong(lockId);
  },
});

export type PublishNowResult =
  | { ok: true; status: PublishStatus }
  | { ok: false; errors: string[]; status: PublishStatus };

export const publishNowAction = defineAction<NoArgs, PublishNowResult>({
  id: "simpletab.releases.publish-now",
  labelKey: "action.releases.publishNow",
  page: RELEASES_PAGE,
  isEnabled: canManage,
  async prompt() {
    return {};
  },
  async run(ctx) {
    const status = await ctx.store.publishNow();
    return status.state === "failed"
      ? {
          ok: false,
          errors: [status.reason ?? t("releases.publishState.failed")],
          status,
        }
      : { ok: true, status };
  },
});

export interface SetLiveArgs {
  on: boolean;
}

export const setLivePublicSiteAction = defineAction<SetLiveArgs>({
  id: "simpletab.releases.set-live",
  labelKey: "action.releases.setLive",
  page: RELEASES_PAGE,
  isEnabled: canManage,
  async prompt(ctx) {
    const on = await pickOnOff(ctx, t("action.releases.pickLiveState"));
    return on === undefined ? undefined : { on };
  },
  async run(ctx, { on }) {
    await ctx.store.updateOnlineSettings({ livePublicSite: on });
    return { ok: true };
  },
});

export type ArchiveNowResult =
  | { ok: true; status: ArchiveStatus }
  | { ok: false; errors: string[]; status: ArchiveStatus };

export const archiveNowAction = defineAction<NoArgs, ArchiveNowResult>({
  id: "simpletab.releases.archive-now",
  labelKey: "action.releases.archiveNow",
  page: RELEASES_PAGE,
  isEnabled(snapshot) {
    return (
      canManage(snapshot) &&
      (snapshot.status.onlineSettings?.githubArchive ?? false)
    );
  },
  async prompt() {
    return {};
  },
  async run(ctx) {
    const status = await ctx.store.archiveNow();
    return status.state === "failed"
      ? {
          ok: false,
          errors: [status.reason ?? t("releases.archiveState.failed")],
          status,
        }
      : { ok: true, status };
  },
});

export interface SetMirrorArgs {
  on: boolean;
}

export const setArchiveMirrorAction = defineAction<SetMirrorArgs>({
  id: "simpletab.releases.set-archive-mirror",
  labelKey: "action.releases.setArchiveMirror",
  page: RELEASES_PAGE,
  isEnabled(snapshot) {
    return (
      canManage(snapshot) &&
      (snapshot.status.onlineSettings?.githubArchive ?? false)
    );
  },
  async prompt(ctx) {
    const on = await pickOnOff(ctx, t("action.releases.pickMirrorState"));
    return on === undefined ? undefined : { on };
  },
  async run(ctx, { on }) {
    await ctx.store.updateOnlineSettings({ githubArchiveMirror: on });
    return { ok: true };
  },
});

/** "Open Setup" on any page is the navigation command; re-exported here for the pages. */
export const openSetupAction = openSetupPageAction;

export const RELEASES_ACTIONS = [
  setGateAction,
  releaseTabBundleAction,
  setDrawGateAction,
  setRoundMotionsAction,
  setRoundFlagAction,
  cancelLockAction,
  publishNowAction,
  setLivePublicSiteAction,
  archiveNowAction,
  setArchiveMirrorAction,
] as const;
