import type { AdjudicatorRoomMove } from "@simpletab/core/ops/allocation";
import { recordKey, type OpRound, type RecordKey } from "@simpletab/core/ops";
import type { PreformedPanel } from "@simpletab/core/types";
import type {
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import { t } from "../i18n";
import { stateHasPermission } from "../lib/permissions";
import type { TournamentStoreSnapshot } from "../store/tournament-store";
import { defineAction, type ActionContext } from "./action";

/** Widget id of the Allocation page. */
export const ALLOCATION_PAGE = "simpletab-allocation-widget";

function stateOf(ctx: ActionContext): ProjectedState {
  const state = ctx.store.getState();
  if (state === null) {
    throw new Error(t("common.noTournamentPrompt"));
  }
  return state;
}

function canAllocate(snapshot: TournamentStoreSnapshot): boolean {
  return (
    snapshot.state !== null &&
    snapshot.status.open &&
    stateHasPermission(snapshot.state, "allocation.edit") &&
    snapshot.state.rounds.some((round) => round.cancelled !== true)
  );
}

function versionOf(state: ProjectedState, key: RecordKey): number {
  return state.versions[key] ?? 0;
}

function activeRounds(state: ProjectedState): OpRound[] {
  return state.rounds
    .filter((round) => round.cancelled !== true)
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}

function roomTitle(state: ProjectedState, debateId: string): string {
  const debate = state.debates.find((item) => item.id === debateId);
  if (debate === undefined) {
    return debateId;
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
    t("action.allocation.pickRound"),
  );
}

async function pickDebate(ctx: ActionContext, state: ProjectedState): Promise<string | undefined> {
  return ctx.prompts.pick(
    state.debates
      .filter((debate) => !debate.byeTeamId)
      .map((debate) => ({
        label: roomTitle(state, debate.id),
        description: debate.id,
        value: debate.id,
      })),
    t("action.allocation.pickDebate"),
  );
}

function parseInteger(text: string | undefined): number | undefined {
  if (text === undefined) {
    return undefined;
  }
  const value = Number(text.trim());
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

interface PanelMembers {
  chairId?: string;
  panellistIds: string[];
  traineeIds: string[];
}

/** Picks adjudicators one at a time until "Done"; undefined when the palette is dismissed. */
async function pickMany(
  ctx: ActionContext,
  candidates: ReadonlyArray<{ id: string; name: string }>,
  placeholder: string,
): Promise<string[] | undefined> {
  const chosen: string[] = [];
  for (;;) {
    const left = candidates.filter((adj) => !chosen.includes(adj.id));
    if (left.length === 0) {
      return chosen;
    }
    const next = await ctx.prompts.pick(
      [
        { label: t("action.allocation.doneChoosing"), value: "" },
        ...left.map((adj) => ({ label: adj.name, value: adj.id })),
      ],
      placeholder,
    );
    if (next === undefined) {
      return undefined;
    }
    if (next.length === 0) {
      return chosen;
    }
    chosen.push(next);
  }
}

/** Builds a whole panel from the palette: a chair (or none), then any number of panellists and trainees. */
async function pickPanelMembers(
  ctx: ActionContext,
  state: ProjectedState,
): Promise<PanelMembers | undefined> {
  const chairId = await ctx.prompts.pick(
    [
      { label: t("allocation.noChair"), value: "" },
      ...state.adjudicators
        .filter((adj) => !adj.trainee)
        .map((adj) => ({ label: adj.name, value: adj.id })),
    ],
    t("action.allocation.pickChair"),
  );
  if (chairId === undefined) {
    return undefined;
  }
  const panellistIds = await pickMany(
    ctx,
    state.adjudicators.filter((adj) => !adj.trainee && adj.id !== chairId),
    t("action.allocation.pickPanellist"),
  );
  if (panellistIds === undefined) {
    return undefined;
  }
  const traineeIds = await pickMany(
    ctx,
    state.adjudicators.filter((adj) => adj.trainee && adj.id !== chairId),
    t("action.allocation.pickTrainee"),
  );
  if (traineeIds === undefined) {
    return undefined;
  }
  return { ...(chairId.length > 0 ? { chairId } : {}), panellistIds, traineeIds };
}

export interface AutoAllocateArgs {
  roundId: string;
  panelSize: number;
}

export const autoAllocateAction = defineAction<AutoAllocateArgs, SubmitResult>({
  id: "simpletab.allocation.auto-allocate",
  labelKey: "action.allocation.autoAllocate",
  page: ALLOCATION_PAGE,
  isEnabled: canAllocate,
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const roundId = await pickRound(ctx, state);
    if (roundId === undefined) {
      return undefined;
    }
    const panelSize = parseInteger(
      await ctx.prompts.input(t("action.allocation.pickPanelSize"), {
        value: "3",
      }),
    );
    return panelSize === undefined ? undefined : { roundId, panelSize };
  },
  run(ctx, { roundId, panelSize }) {
    return ctx.store.submit({
      type: "allocation.auto",
      payload: { roundId, panelSize },
    });
  },
});

export interface AssignManualArgs {
  debateId: string;
  chairId?: string;
  panellistIds: readonly string[];
  traineeIds: readonly string[];
}

export const assignManualAction = defineAction<AssignManualArgs, SubmitResult>({
  id: "simpletab.allocation.assign-manual",
  labelKey: "action.allocation.assignManual",
  page: ALLOCATION_PAGE,
  isEnabled: canAllocate,
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const debateId = await pickDebate(ctx, state);
    if (debateId === undefined) {
      return undefined;
    }
    const members = await pickPanelMembers(ctx, state);
    return members === undefined ? undefined : { debateId, ...members };
  },
  run(ctx, { debateId, chairId, panellistIds, traineeIds }) {
    const state = stateOf(ctx);
    return ctx.store.submit({
      type: "allocation.assign_manual",
      expectedVersions: debateVersions(state, [debateId]),
      payload: {
        debateId,
        ...(chairId ? { chairId } : {}),
        panellistIds: [...panellistIds],
        traineeIds: [...traineeIds],
      },
    });
  },
});

export interface SwapRoomsArgs {
  debateIdA: string;
  debateIdB: string;
  moves?: readonly AdjudicatorRoomMove[];
}

export const swapRoomsAction = defineAction<SwapRoomsArgs, SubmitResult>({
  id: "simpletab.allocation.swap-rooms",
  labelKey: "action.allocation.swapRooms",
  page: ALLOCATION_PAGE,
  isEnabled(snapshot) {
    const state = snapshot.state;
    return (
      canAllocate(snapshot) &&
      state !== null &&
      state.debates.filter((debate) => !debate.byeTeamId).length > 1
    );
  },
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const debateIdA = await pickDebate(ctx, state);
    if (debateIdA === undefined) {
      return undefined;
    }
    const debateIdB = await ctx.prompts.pick(
      state.debates
        .filter((debate) => !debate.byeTeamId && debate.id !== debateIdA)
        .map((debate) => ({
          label: roomTitle(state, debate.id),
          value: debate.id,
        })),
      t("action.allocation.pickSecondDebate"),
    );
    if (debateIdB === undefined) {
      return undefined;
    }
    const moveAdjudicator = await ctx.prompts.pick(
      [
        { label: t("checkin.statusUnavailable"), value: false },
        { label: t("checkin.statusAvailable"), value: true },
      ],
      t("action.allocation.pickMoveAdjudicator"),
    );
    if (moveAdjudicator === undefined) {
      return undefined;
    }
    if (!moveAdjudicator) {
      return { debateIdA, debateIdB };
    }
    const adjudicatorId = await ctx.prompts.pick(
      state.adjudicators.map((adj) => ({ label: adj.name, value: adj.id })),
      t("action.allocation.pickAdjudicator"),
    );
    if (adjudicatorId === undefined) {
      return undefined;
    }
    const toRole = await ctx.prompts.pick(
      [
        { label: t("allocation.roleChair"), value: "chair" as const },
        { label: t("allocation.rolePanellist"), value: "panellist" as const },
        { label: t("allocation.roleTrainee"), value: "trainee" as const },
      ],
      t("action.allocation.pickRole"),
    );
    if (toRole === undefined) {
      return undefined;
    }
    return {
      debateIdA,
      debateIdB,
      moves: [
        {
          adjudicatorId,
          fromDebateId: debateIdA,
          toDebateId: debateIdB,
          toRole,
        },
      ],
    };
  },
  run(ctx, { debateIdA, debateIdB, moves }) {
    const state = stateOf(ctx);
    return ctx.store.submit({
      type: "allocation.swap_rooms",
      expectedVersions: debateVersions(state, [debateIdA, debateIdB]),
      payload: {
        debateIdA,
        debateIdB,
        ...(moves !== undefined ? { moves: moves.map((move) => ({ ...move })) } : {}),
      },
    });
  },
});

/** The same id shape the page gives a panel it adds. */
function newPanelId(panels: readonly PreformedPanel[]): string {
  return `panel-${Date.now()}-${panels.length + 1}`;
}

export interface SavePreformedArgs {
  roundId: string;
  panels: readonly PreformedPanel[];
}

export const savePreformedAction = defineAction<SavePreformedArgs, SubmitResult>({
  id: "simpletab.allocation.save-preformed",
  labelKey: "action.allocation.savePreformed",
  page: ALLOCATION_PAGE,
  isEnabled: canAllocate,
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
    const panels = round.preformedPanels ?? [];
    const NEW_PANEL = "";
    const panelId = await ctx.prompts.pick(
      [
        { label: t("allocation.preformedAdd"), value: NEW_PANEL },
        ...panels.map((panel, index) => ({
          label: t("action.allocation.preformedPanelLabel", {
            number: index + 1,
            chair:
              state.adjudicators.find((adj) => adj.id === panel.chairId)?.name ??
              t("allocation.noChair"),
          }),
          value: panel.id,
        })),
      ],
      t("action.allocation.pickPreformedPanel"),
    );
    if (panelId === undefined) {
      return undefined;
    }
    const existing = panels.find((panel) => panel.id === panelId);
    if (existing !== undefined) {
      const choice = await ctx.prompts.pick(
        [
          { label: t("action.allocation.preformedEdit"), value: "edit" as const },
          { label: t("allocation.preformedRemove"), value: "remove" as const },
        ],
        t("action.allocation.pickPreformedChange"),
      );
      if (choice === undefined) {
        return undefined;
      }
      if (choice === "remove") {
        return { roundId, panels: panels.filter((panel) => panel.id !== panelId) };
      }
    }
    const members = await pickPanelMembers(ctx, state);
    if (members === undefined) {
      return undefined;
    }
    const importanceText = await ctx.prompts.input(t("action.allocation.pickImportance"), {
      value: String(existing?.importance ?? 0),
    });
    if (importanceText === undefined) {
      return undefined;
    }
    const importance = Number(importanceText.trim());
    if (!Number.isInteger(importance) || importance < 0 || importance > 10) {
      return undefined;
    }
    const edited: PreformedPanel = {
      ...(existing ?? { id: newPanelId(panels) }),
      ...members,
      importance,
    };
    if (members.chairId === undefined) {
      delete edited.chairId;
    }
    return {
      roundId,
      panels:
        existing === undefined
          ? [...panels, edited]
          : panels.map((panel) => (panel.id === panelId ? edited : panel)),
    };
  },
  run(ctx, { roundId, panels }) {
    const state = stateOf(ctx);
    const key = recordKey("round", roundId);
    return ctx.store.submit({
      type: "allocation.preformed_save",
      expectedVersions: { [key]: versionOf(state, key) },
      payload: { roundId, panels: panels.map((panel) => ({ ...panel })) },
    });
  },
});

export const autofillPreformedAction = defineAction<
  SavePreformedArgs,
  SubmitResult
>({
  id: "simpletab.allocation.autofill-preformed",
  labelKey: "action.allocation.autofillPreformed",
  page: ALLOCATION_PAGE,
  isEnabled: canAllocate,
  async prompt(ctx) {
    // Autofill uses the round's saved panels, as the page does after saving them.
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const roundId = await pickRound(ctx, state);
    const round = state.rounds.find((item) => item.id === roundId);
    if (roundId === undefined || round === undefined) {
      return undefined;
    }
    return { roundId, panels: round.preformedPanels ?? [] };
  },
  run(ctx, { roundId, panels }) {
    return ctx.store.submit({
      type: "allocation.preformed_autofill",
      payload: { roundId, panels: panels.map((panel) => ({ ...panel })) },
    });
  },
});

export interface RestoreAllocationArgs {
  seq: number;
}

export const restoreAllocationAction = defineAction<
  RestoreAllocationArgs,
  SubmitResult
>({
  id: "simpletab.allocation.restore-allocation",
  labelKey: "action.allocation.restoreAllocation",
  page: ALLOCATION_PAGE,
  isEnabled: canAllocate,
  async prompt(ctx) {
    const text = await ctx.prompts.input(t("action.allocation.pickRestoreSeq"));
    const seq = parseInteger(text);
    if (seq === undefined) {
      return undefined;
    }
    const confirmed = await ctx.prompts.confirm(
      t("action.allocation.confirmRestoreTitle"),
      t("action.allocation.confirmRestoreMessage"),
    );
    return confirmed ? { seq } : undefined;
  },
  run(ctx, { seq }) {
    return ctx.store.undo(seq);
  },
});

export const ALLOCATION_ACTIONS = [
  autoAllocateAction,
  assignManualAction,
  swapRoomsAction,
  savePreformedAction,
  autofillPreformedAction,
  restoreAllocationAction,
] as const;
