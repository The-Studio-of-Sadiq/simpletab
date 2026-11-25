import { tournamentSides } from "@simpletab/core/lib/debateSides";
import type {
  PickedTeam,
  TeamLocation,
} from "@simpletab/core/lib/draw/drawEditing";
import {
  drawStageActions,
  drawStageOf,
  type DrawStageAction,
} from "@simpletab/core/lib/draw/drawStatus";
import { getEligibleTeamsForRound } from "@simpletab/core/lib/draw/generator";
import { recordKey, type OpRound, type RecordKey } from "@simpletab/core/ops";
import type { Debate, DebateSide } from "@simpletab/core/types";
import type {
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import { t } from "../i18n";
import { stateHasPermission } from "../lib/permissions";
import type { TournamentStoreSnapshot, TrackedRoundOpType } from "../store/tournament-store";
import { inputNumber } from "./prompt-helpers";
import {
  defineAction,
  type ActionContext,
  type SimpleTabAction,
} from "./action";

/** Widget id of the Draw page. */
export const DRAW_PAGE = "simpletab-draw-widget";

function stateOf(ctx: ActionContext): ProjectedState {
  const state = ctx.store.getState();
  if (state === null) {
    throw new Error(t("common.noTournamentPrompt"));
  }
  return state;
}

function canDraw(snapshot: TournamentStoreSnapshot): boolean {
  return (
    snapshot.state !== null &&
    snapshot.status.open &&
    stateHasPermission(snapshot.state, "draw.generate") &&
    snapshot.state.rounds.some((round) => round.cancelled !== true)
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

function roomTitle(
  debate: Pick<Debate, "byeTeamId" | "venueName" | "roomRank">,
): string {
  if (debate.byeTeamId) {
    return t("draw.byeBadge");
  }
  return debate.venueName || t("draw.roomFallback", { rank: debate.roomRank });
}

function debateVersions(
  state: ProjectedState,
  ids: readonly string[],
): Record<RecordKey, number> {
  const versions: Record<RecordKey, number> = {};
  for (const id of ids) {
    const key = recordKey("debate", id);
    versions[key] = versionOf(state, key);
  }
  return versions;
}

async function pickRound(ctx: ActionContext, state: ProjectedState): Promise<string | undefined> {
  return ctx.prompts.pick(
    activeRounds(state).map((round) => ({
      label: round.name,
      description: String(round.seq),
      value: round.id,
    })),
    t("action.draw.pickRound"),
  );
}

async function pickDebate(ctx: ActionContext, state: ProjectedState): Promise<string | undefined> {
  return ctx.prompts.pick(
    state.debates.map((debate) => ({
      label: roomTitle(debate),
      description: debate.id,
      value: debate.id,
    })),
    t("action.draw.pickDebate"),
  );
}

async function pickOnOff(ctx: ActionContext): Promise<boolean | undefined> {
  return ctx.prompts.pick(
    [
      { label: t("checkin.statusAvailable"), value: true },
      { label: t("checkin.statusUnavailable"), value: false },
    ],
    t("action.draw.pickEnabled"),
  );
}

/** A fresh draw seed, as the page offers one. */
export function randomSeedInt(): number {
  return Math.floor(Math.random() * 1_000_000) + 1;
}

/**
 * Picks a round whose last draw or allocation this session can restore, as the page's Restore
 * button does for the selected round; returns the change to undo.
 */
export async function pickRestorableRound(
  ctx: ActionContext,
  state: ProjectedState,
  opType: TrackedRoundOpType,
  placeholder: string,
): Promise<number | undefined> {
  const choices = activeRounds(state).flatMap((round) => {
    const seq = ctx.store.getLastRoundOpSeq(opType, round.id);
    return seq === undefined ? [] : [{ label: round.name, description: `#${seq}`, value: seq }];
  });
  if (choices.length === 0) {
    // Said, not a silent cancel: nothing was generated in this session yet.
    throw new Error(t("action.draw.nothingToRestore"));
  }
  return ctx.prompts.pick(choices, placeholder);
}

function placedTeamIds(state: ProjectedState, debateId: string): Set<string> {
  const ids = new Set<string>();
  for (const debate of state.debates) {
    if (debate.roundId !== debateId) {
      continue;
    }
    if (debate.byeTeamId) {
      ids.add(debate.byeTeamId);
    }
    for (const slot of Object.values(debate.teams)) {
      if (slot?.teamId) {
        ids.add(slot.teamId);
      }
    }
  }
  return ids;
}

export interface GenerateDrawArgs {
  roundId: string;
  seed: number;
  discardExisting?: boolean;
}

export const generateDrawAction = defineAction<GenerateDrawArgs, SubmitResult>({
  id: "simpletab.draw.generate-draw",
  labelKey: "action.draw.generateDraw",
  page: DRAW_PAGE,
  isEnabled: canDraw,
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const roundId = await pickRound(ctx, state);
    if (roundId === undefined) {
      return undefined;
    }
    const seed = await inputNumber(ctx, t("action.draw.pickSeed"), randomSeedInt(), { integer: true });
    if (seed === undefined) {
      return undefined;
    }
    const hasDraw = state.debates.some((debate) => debate.roundId === roundId);
    if (hasDraw) {
      const confirmed = await ctx.prompts.confirm(
        t("action.draw.confirmRegenerateTitle"),
        t("action.draw.confirmRegenerateMessage"),
      );
      if (!confirmed) {
        return undefined;
      }
    }
    return { roundId, seed, ...(hasDraw ? { discardExisting: true } : {}) };
  },
  run(ctx, { roundId, seed, discardExisting }) {
    const state = stateOf(ctx);
    return ctx.store.submit({
      type: "draw.generate",
      payload: {
        roundId,
        seed,
        ...(discardExisting === true ? { discardExisting: true } : {}),
      },
    });
  },
});

export interface RestoreDrawArgs {
  seq: number;
}

export const restoreDrawAction = defineAction<RestoreDrawArgs, SubmitResult>({
  id: "simpletab.draw.restore-draw",
  labelKey: "action.draw.restoreDraw",
  page: DRAW_PAGE,
  isEnabled: canDraw,
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const seq = await pickRestorableRound(ctx, state, "draw.generate", t("action.draw.pickRound"));
    if (seq === undefined) {
      return undefined;
    }
    const confirmed = await ctx.prompts.confirm(
      t("action.draw.confirmRestoreTitle"),
      t("action.draw.confirmRestoreMessage"),
    );
    return confirmed ? { seq } : undefined;
  },
  run(ctx, { seq }) {
    return ctx.store.undo(seq);
  },
});

export interface MoveTeamArgs {
  pick: PickedTeam;
  target: TeamLocation;
}

export const moveTeamAction = defineAction<MoveTeamArgs, SubmitResult>({
  id: "simpletab.draw.move-team",
  labelKey: "action.draw.moveTeam",
  page: DRAW_PAGE,
  isEnabled: canDraw,
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const roundId = await pickRound(ctx, state);
    if (roundId === undefined) {
      return undefined;
    }
    const round = state.rounds.find((item) => item.id === roundId);
    if (round === undefined) {
      return undefined;
    }
    const placed = placedTeamIds(state, roundId);
    const choices: ReadonlyArray<{ label: string; value: PickedTeam }> = [
      ...state.debates
        .filter((debate) => debate.roundId === roundId)
        .flatMap((debate) =>
          Object.values(debate.teams).flatMap((slot) =>
            slot?.teamId
              ? [
                  {
                    label: t("action.draw.teamInRoom", {
                      team: slot.teamName,
                      room: roomTitle(debate),
                    }),
                    value: {
                      teamId: slot.teamId,
                      teamName: slot.teamName,
                      from: {
                        kind: "slot" as const,
                        debateId: debate.id,
                        side: slot.side,
                      },
                    },
                  },
                ]
              : [],
          ),
        ),
      ...getEligibleTeamsForRound(state.teams, round)
        .filter((team) => !placed.has(team.id))
        .map((team) => ({
          label: t("action.draw.teamInPool", { team: team.name }),
          value: {
            teamId: team.id,
            teamName: team.name,
            from: { kind: "pool" as const },
          },
        })),
    ];
    const pick = await ctx.prompts.pick(choices, t("action.draw.pickTeam"));
    if (pick === undefined) {
      return undefined;
    }
    const targetChoices: ReadonlyArray<{ label: string; value: TeamLocation }> = [
      ...state.debates
        .filter((debate) => debate.roundId === roundId)
        .flatMap((debate) =>
          tournamentSides(state.tournament).map((side) => ({
            label: t("action.draw.slotInRoom", {
              side,
              room: roomTitle(debate),
            }),
            value: { kind: "slot" as const, debateId: debate.id, side },
          })),
        ),
      ...(pick.from.kind === "slot"
        ? [
            {
              label: t("action.draw.poolTarget"),
              value: { kind: "pool" as const },
            },
          ]
        : []),
    ];
    const target = await ctx.prompts.pick(
      targetChoices,
      t("action.draw.pickTarget"),
    );
    return target === undefined ? undefined : { pick, target };
  },
  run(ctx, { pick, target }) {
    const state = stateOf(ctx);
    const ids: string[] = [];
    if (pick.from.kind === "slot") {
      ids.push(pick.from.debateId);
    }
    if (target.kind === "slot") {
      ids.push(target.debateId);
    }
    const expectedVersions = debateVersions(state, [...new Set(ids)]);
    if (pick.from.kind === "pool") {
      const key = recordKey("team", pick.teamId);
      expectedVersions[key] = versionOf(state, key);
    }
    return ctx.store.submit({
      type: "draw.move_team",
      expectedVersions,
      payload: { pick, target },
    });
  },
});

export interface SwapTeamsArgs {
  slotA: { debateId: string; side: DebateSide };
  slotB: { debateId: string; side: DebateSide };
}

export const swapTeamsAction = defineAction<SwapTeamsArgs, SubmitResult>({
  id: "simpletab.draw.swap-teams",
  labelKey: "action.draw.swapTeams",
  page: DRAW_PAGE,
  isEnabled: canDraw,
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const [sideA, sideB] = tournamentSides(state.tournament);
    if (sideA === undefined || sideB === undefined) {
      return undefined;
    }
    const debateId = await pickDebate(ctx, state);
    return debateId === undefined
      ? undefined
      : {
          slotA: { debateId, side: sideA },
          slotB: { debateId, side: sideB },
        };
  },
  run(ctx, { slotA, slotB }) {
    const state = stateOf(ctx);
    return ctx.store.submit({
      type: "draw.swap_teams",
      expectedVersions: debateVersions(state, [slotA.debateId]),
      payload: { slotA, slotB },
    });
  },
});

export interface UpdateDebateArgs {
  debateId: string;
  venueId: string;
}

export const updateDebateAction = defineAction<UpdateDebateArgs, SubmitResult>({
  id: "simpletab.draw.update-debate",
  labelKey: "action.draw.updateDebate",
  page: DRAW_PAGE,
  isEnabled: canDraw,
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const debateId = await pickDebate(ctx, state);
    if (debateId === undefined) {
      return undefined;
    }
    const venueId = await ctx.prompts.pick(
      [
        { label: t("draw.noVenueOption"), value: "" },
        ...state.venues.map((venue) => ({ label: venue.name, value: venue.id })),
      ],
      t("action.draw.pickVenue"),
    );
    return venueId === undefined ? undefined : { debateId, venueId };
  },
  run(ctx, { debateId, venueId }) {
    const state = stateOf(ctx);
    const debate = state.debates.find((item) => item.id === debateId);
    if (debate === undefined) {
      throw new Error(t("draw.noRounds"));
    }
    const venue = state.venues.find((item) => item.id === venueId);
    const updatedDebate: Debate = {
      ...debate,
      ...(venue
        ? { venueId: venue.id, venueName: venue.name }
        : {
            venueId: undefined,
            venueName: t("draw.roomFallback", { rank: debate.roomRank }),
          }),
    };
    return ctx.store.submit({
      type: "draw.update_debate",
      expectedVersions: debateVersions(state, [debateId]),
      payload: { debate: updatedDebate },
    });
  },
});

export interface CreateSwingArgs {
  roundId: string;
  name: string;
  speakers: readonly string[];
}

export const createSwingAction = defineAction<CreateSwingArgs, SubmitResult>({
  id: "simpletab.draw.create-swing",
  labelKey: "action.draw.createSwing",
  page: DRAW_PAGE,
  isEnabled: canDraw,
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const roundId = await pickRound(ctx, state);
    if (roundId === undefined) {
      return undefined;
    }
    const name = await ctx.prompts.input(t("action.draw.pickSwingName"));
    if (name === undefined || name.trim().length === 0) {
      return undefined;
    }
    const speakersText = await ctx.prompts.input(
      t("action.draw.pickSwingSpeakers"),
      { optional: true },
    );
    if (speakersText === undefined) {
      return undefined;
    }
    return {
      roundId,
      name,
      speakers: speakersText
        .split(",")
        .map((speaker) => speaker.trim())
        .filter((speaker) => speaker.length > 0),
    };
  },
  run(ctx, { roundId, name, speakers }) {
    return ctx.store.submit({
      type: "swing.create",
      payload: {
        roundId,
        name: name.trim(),
        speakers: speakers
          .map((speaker) => speaker.trim())
          .filter((speaker) => speaker.length > 0)
          .map((speaker) => ({ name: speaker })),
      },
    });
  },
});

export interface ToggleSwingRoundArgs {
  teamId: string;
  roundId: string;
  enabled: boolean;
}

export const toggleSwingRoundAction = defineAction<
  ToggleSwingRoundArgs,
  SubmitResult
>({
  id: "simpletab.draw.toggle-swing-round",
  labelKey: "action.draw.toggleSwingRound",
  page: DRAW_PAGE,
  isEnabled(snapshot) {
    const state = snapshot.state;
    return (
      canDraw(snapshot) &&
      state !== null &&
      state.teams.some((team) => team.isSwing === true)
    );
  },
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const teamId = await ctx.prompts.pick(
      state.teams
        .filter((team) => team.isSwing === true)
        .map((team) => ({ label: team.name, value: team.id })),
      t("action.draw.pickSwingTeam"),
    );
    if (teamId === undefined) {
      return undefined;
    }
    const roundId = await pickRound(ctx, state);
    if (roundId === undefined) {
      return undefined;
    }
    const enabled = await pickOnOff(ctx);
    return enabled === undefined ? undefined : { teamId, roundId, enabled };
  },
  run(ctx, { teamId, roundId, enabled }) {
    const state = stateOf(ctx);
    const key = recordKey("team", teamId);
    return ctx.store.submit({
      type: "swing.toggle_round",
      expectedVersions: { [key]: versionOf(state, key) },
      payload: { teamId, roundId, enabled },
    });
  },
});

export interface DrawStageArgs {
  roundId: string;
}

function stageAction(
  id: string,
  labelKey: string,
  opType: string,
  stage: DrawStageAction,
): SimpleTabAction<DrawStageArgs, SubmitResult> {
  // Only rounds whose draw is in a stage that offers this step, as the page's stage buttons do.
  const offersStage = (round: ProjectedState["rounds"][number]): boolean =>
    round.cancelled !== true && drawStageActions(drawStageOf(round)).includes(stage);
  return defineAction<DrawStageArgs, SubmitResult>({
    id,
    labelKey,
    page: DRAW_PAGE,
    isEnabled(snapshot) {
      const state = snapshot.state;
      return (
        state !== null &&
        snapshot.status.open &&
        stateHasPermission(state, "draw.release") &&
        state.rounds.some(offersStage)
      );
    },
    async prompt(ctx) {
      const state = ctx.store.getState();
      if (state === null) {
        return undefined;
      }
      const roundId = await ctx.prompts.pick(
        activeRounds(state)
          .filter(offersStage)
          .map((round) => ({ label: round.name, value: round.id })),
        t("action.draw.pickRound"),
      );
      return roundId === undefined ? undefined : { roundId };
    },
    run(ctx, { roundId }) {
      const state = stateOf(ctx);
      const key = recordKey("round", roundId);
      return ctx.store.submit({
        type: opType,
        expectedVersions: { [key]: versionOf(state, key) },
        payload: { roundId },
      });
    },
  });
}

export const lockDrawAction = stageAction(
  "simpletab.draw.lock-draw",
  "action.draw.lockDraw",
  "draw.lock",
  "lock",
);
export const unlockDrawAction = stageAction(
  "simpletab.draw.unlock-draw",
  "action.draw.unlockDraw",
  "draw.unlock",
  "unlock",
);
export const releaseDrawToTeamsAction = stageAction(
  "simpletab.draw.release-draw-to-teams",
  "action.draw.releaseDrawToTeams",
  "draw.release_teams",
  "release_teams",
);
export const releaseDrawAction = stageAction(
  "simpletab.draw.release-draw",
  "action.draw.releaseDraw",
  "draw.release",
  "release",
);
export const unreleaseDrawAction = stageAction(
  "simpletab.draw.unrelease-draw",
  "action.draw.unreleaseDraw",
  "draw.unrelease",
  "unrelease",
);

/** The five stage buttons use the same actions the palette offers. */
export function drawStageActionFor(
  stage: DrawStageAction,
): SimpleTabAction<DrawStageArgs, SubmitResult> {
  switch (stage) {
    case "lock":
      return lockDrawAction;
    case "unlock":
      return unlockDrawAction;
    case "release_teams":
      return releaseDrawToTeamsAction;
    case "release":
      return releaseDrawAction;
    case "unrelease":
      return unreleaseDrawAction;
  }
}


export const DRAW_ACTIONS = [
  generateDrawAction,
  restoreDrawAction,
  moveTeamAction,
  swapTeamsAction,
  updateDebateAction,
  createSwingAction,
  toggleSwingRoundAction,
  lockDrawAction,
  unlockDrawAction,
  releaseDrawToTeamsAction,
  releaseDrawAction,
  unreleaseDrawAction,
] as const;
