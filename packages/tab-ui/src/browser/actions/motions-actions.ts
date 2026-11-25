import {
  motionsStatusOf,
} from "@simpletab/core/features/tournament/application/motionRelease";
import { recordKey, type OpRound, type RecordKey } from "@simpletab/core/ops";
import type { Motion } from "@simpletab/core/types";
import type {
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import { t } from "../i18n";
import { inputRequired } from "./prompt-helpers";
import {
  defaultTournamentTimeZone,
  isValidIanaTimeZone,
  localDateTimeToUtcIso,
  utcIsoToLocalParts,
} from "../lib/deadline";
import { stateHasPermission } from "../lib/permissions";
import type { TournamentStoreSnapshot } from "../store/tournament-store";
import { defineAction, type ActionContext } from "./action";

/** Widget id of the Motions page. */
export const MOTIONS_PAGE = "simpletab-motions-widget";

function stateOf(ctx: ActionContext): ProjectedState {
  const state = ctx.store.getState();
  if (state === null) {
    throw new Error(t("common.noTournamentPrompt"));
  }
  return state;
}

function canManageMotions(snapshot: TournamentStoreSnapshot): boolean {
  return (
    snapshot.state !== null &&
    snapshot.status.open &&
    stateHasPermission(snapshot.state, "motions.manage") &&
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

async function pickRound(ctx: ActionContext, state: ProjectedState): Promise<string | undefined> {
  return ctx.prompts.pick(
    activeRounds(state).map((round) => ({
      label: round.name,
      description: String(round.seq),
      value: round.id,
    })),
    t("action.motions.pickRound"),
  );
}

function createMotionId(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return `motion-${globalThis.crypto.randomUUID()}`;
  }
  return `motion-${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
}

export interface SetBallotDeadlineArgs {
  roundId: string;
  ballotDeadline: string | null;
  timeZone: string;
}

export const setBallotDeadlineAction = defineAction<
  SetBallotDeadlineArgs,
  SubmitResult
>({
  id: "simpletab.motions.set-ballot-deadline",
  labelKey: "action.motions.setBallotDeadline",
  page: MOTIONS_PAGE,
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
    const clearing = await ctx.prompts.pick(
      [
        { label: t("motions.saveDeadline"), value: false },
        { label: t("motions.clearDeadline"), value: true },
      ],
      t("action.motions.pickDeadlineAction"),
    );
    if (clearing === undefined) {
      return undefined;
    }
    const timeZone = defaultTournamentTimeZone(state, round);
    if (clearing) {
      return { roundId, ballotDeadline: null, timeZone };
    }
    const existing = round.simpletab?.ballotDeadline;
    const parts =
      existing != null ? utcIsoToLocalParts(existing, timeZone) : null;
    const date = await ctx.prompts.input(t("motions.deadlineDateLabel"), {
      value: parts?.date,
    });
    if (date === undefined) {
      return undefined;
    }
    const time = await ctx.prompts.input(t("motions.deadlineTimeLabel"), {
      value: parts?.time ?? "14:00",
    });
    if (time === undefined) {
      return undefined;
    }
    const enteredZone = await ctx.prompts.input(
      t("motions.deadlineZoneLabel"),
      { value: timeZone },
    );
    if (enteredZone === undefined || !isValidIanaTimeZone(enteredZone.trim())) {
      return undefined;
    }
    const ballotDeadline = localDateTimeToUtcIso(
      date,
      time,
      enteredZone.trim(),
    );
    return ballotDeadline === null
      ? undefined
      : { roundId, ballotDeadline, timeZone: enteredZone.trim() };
  },
  run(ctx, { roundId, ballotDeadline, timeZone }) {
    const state = stateOf(ctx);
    const key = recordKey("round", roundId);
    return ctx.store.submit({
      type: "round.set_ballot_deadline",
      expectedVersions: { [key]: versionOf(state, key) },
      payload: { roundId, ballotDeadline, timeZone },
    });
  },
});

function trimmedText(value: string | undefined): string | undefined {
  return value?.trim();
}

async function pickMotionFields(
  ctx: ActionContext,
  defaults: { text: string; infoSlide: string; reference: string },
): Promise<{ text: string; infoSlide?: string; reference?: string } | undefined> {
  // A motion needs text: asked again when blank, never a silent cancel.
  const text = trimmedText(await inputRequired(ctx, t("motions.motionTextLabel"), defaults.text));
  if (text === undefined) {
    return undefined;
  }
  const infoSlide = trimmedText(
    await ctx.prompts.input(t("motions.infoSlideLabel"), {
      value: defaults.infoSlide,
      optional: true,
    }),
  );
  if (infoSlide === undefined) {
    return undefined;
  }
  const reference = trimmedText(
    await ctx.prompts.input(t("motions.referenceLabel"), {
      value: defaults.reference,
      optional: true,
    }),
  );
  if (reference === undefined) {
    return undefined;
  }
  return {
    text,
    ...(infoSlide.length > 0 ? { infoSlide } : {}),
    ...(reference.length > 0 ? { reference } : {}),
  };
}

export interface CreateMotionArgs {
  roundId: string;
  text: string;
  infoSlide?: string;
  reference?: string;
}

export const createMotionAction = defineAction<CreateMotionArgs, SubmitResult>({
  id: "simpletab.motions.create-motion",
  labelKey: "action.motions.createMotion",
  page: MOTIONS_PAGE,
  isEnabled: canManageMotions,
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const roundId = await pickRound(ctx, state);
    if (roundId === undefined) {
      return undefined;
    }
    const fields = await pickMotionFields(ctx, {
      text: "",
      infoSlide: "",
      reference: "",
    });
    return fields === undefined ? undefined : { roundId, ...fields };
  },
  run(ctx, { roundId, text, infoSlide, reference }) {
    const state = stateOf(ctx);
    const round = state.rounds.find((item) => item.id === roundId);
    if (round === undefined) {
      throw new Error(t("motions.noRounds"));
    }
    const nextSeq =
      state.motions
        .filter((motion) => (motion.rounds ?? []).includes(roundId))
        .reduce(
          (max, motion) =>
            Math.max(max, motion.roundSeq?.[roundId] ?? motion.seq ?? 0),
          0,
        ) + 1;
    const motion: Motion = {
      id: createMotionId(),
      tournamentId: state.tournament.id,
      text,
      ...(infoSlide !== undefined ? { infoSlide } : {}),
      ...(reference !== undefined ? { reference } : {}),
      rounds: [roundId],
      seq: nextSeq,
      roundSeq: { [roundId]: nextSeq },
      released: motionsStatusOf(round) === "motions_released",
    };
    return ctx.store.submit({
      type: "motion.create",
      payload: { motion },
    });
  },
});

export interface UpdateMotionArgs {
  motionId: string;
  text: string;
  infoSlide?: string;
  reference?: string;
}

export const updateMotionAction = defineAction<UpdateMotionArgs, SubmitResult>({
  id: "simpletab.motions.update-motion",
  labelKey: "action.motions.updateMotion",
  page: MOTIONS_PAGE,
  isEnabled: canManageMotions,
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null || state.motions.length === 0) {
      return undefined;
    }
    const motionId = await ctx.prompts.pick(
      state.motions.map((motion) => ({
        label: motion.text,
        description: motion.id,
        value: motion.id,
      })),
      t("action.motions.pickMotion"),
    );
    if (motionId === undefined) {
      return undefined;
    }
    const motion = state.motions.find((item) => item.id === motionId);
    if (motion === undefined) {
      return undefined;
    }
    const fields = await pickMotionFields(ctx, {
      text: motion.text,
      infoSlide: motion.infoSlide ?? "",
      reference: motion.reference ?? "",
    });
    return fields === undefined ? undefined : { motionId, ...fields };
  },
  run(ctx, { motionId, text, infoSlide, reference }) {
    const state = stateOf(ctx);
    const existing = state.motions.find((item) => item.id === motionId);
    if (existing === undefined) {
      throw new Error(t("motions.motionMissing"));
    }
    const motion: Motion = {
      ...existing,
      text,
      ...(infoSlide !== undefined ? { infoSlide } : {}),
      ...(reference !== undefined ? { reference } : {}),
    };
    if (infoSlide === undefined) {
      delete motion.infoSlide;
    }
    if (reference === undefined) {
      delete motion.reference;
    }
    const key = recordKey("motion", motionId);
    return ctx.store.submit({
      type: "motion.update",
      expectedVersions: { [key]: versionOf(state, key) },
      payload: { motion },
    });
  },
});

export interface DeleteMotionArgs {
  motionId: string;
}

export const deleteMotionAction = defineAction<DeleteMotionArgs, SubmitResult>({
  id: "simpletab.motions.delete-motion",
  labelKey: "action.motions.deleteMotion",
  page: MOTIONS_PAGE,
  isEnabled: canManageMotions,
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null || state.motions.length === 0) {
      return undefined;
    }
    const motionId = await ctx.prompts.pick(
      state.motions.map((motion) => ({
        label: motion.text,
        description: motion.id,
        value: motion.id,
      })),
      t("action.motions.pickMotionToDelete"),
    );
    if (motionId === undefined) {
      return undefined;
    }
    const confirmed = await ctx.prompts.confirm(
      t("action.motions.confirmDeleteTitle"),
      t("action.motions.confirmDeleteMessage"),
    );
    return confirmed ? { motionId } : undefined;
  },
  run(ctx, { motionId }) {
    const state = stateOf(ctx);
    const key = recordKey("motion", motionId);
    return ctx.store.submit({
      type: "motion.delete",
      expectedVersions: { [key]: versionOf(state, key) },
      payload: { motionId },
    });
  },
});

/** The round status buttons run `setRoundMotionsAction` from the Releases page; one command per op. */
export const MOTIONS_ACTIONS = [
  setBallotDeadlineAction,
  createMotionAction,
  updateMotionAction,
  deleteMotionAction,
] as const;
