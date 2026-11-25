import {
  DEFAULT_PROJECTOR_CONTROL,
  type ProjectorControlPatch,
  type ProjectorControlState,
} from "@simpletab/host/lib/common/projector-protocol";
import { t } from "../i18n";
import { defineAction, type ActionContext, type SimpleTabAction } from "./action";
import { inputNumber, inputOptionalNumber } from "./prompt-helpers";

/** Widget id of the Projector control page. */
export const PROJECTOR_PAGE = "simpletab-projector-control-widget";

export type ProjectorActionResult =
  | { ok: true; control: ProjectorControlState }
  | { ok: false; errors: string[] };

type NoArgs = Record<string, never>;

function service(ctx: ActionContext) {
  const projector = ctx.services?.projector;
  if (projector === undefined) {
    throw new Error(t("projector.unavailable"));
  }
  return projector;
}

const noArgs = async (): Promise<NoArgs> => ({});

/** Asks for a countdown length in minutes, as the page does; blank keeps the host's choice. */
async function promptMinutes(
  ctx: ActionContext,
  currentSeconds: number,
): Promise<{ durationSeconds?: number } | undefined> {
  const minutes = await inputOptionalNumber(
    ctx,
    t("projector.durationMinutesLabel"),
    Math.max(1, Math.round(currentSeconds / 60)),
    { min: 1, max: 180 },
  );
  if (minutes === undefined) return undefined;
  return minutes === null ? {} : { durationSeconds: Math.round(minutes * 60) };
}

async function currentControl(ctx: ActionContext): Promise<ProjectorControlState> {
  const projector = ctx.services?.projector;
  if (projector === undefined) return DEFAULT_PROJECTOR_CONTROL;
  return (await projector.getSyncPayload()).control;
}

export const openProjectorAction: SimpleTabAction<NoArgs, ProjectorActionResult> = defineAction({
  id: "simpletab.projector.open",
  labelKey: "action.projector.open",
  page: PROJECTOR_PAGE,
  isEnabled: () => true,
  prompt: noArgs,
  async run(ctx) {
    const projector = service(ctx);
    const displayState = await ctx.store.getDisplayState();
    await projector.pushDisplayState(displayState);
    return { ok: true, control: await projector.openProjector() };
  },
});

export const closeProjectorAction: SimpleTabAction<NoArgs, ProjectorActionResult> = defineAction({
  id: "simpletab.projector.close",
  labelKey: "action.projector.close",
  page: PROJECTOR_PAGE,
  isEnabled: () => true,
  prompt: noArgs,
  async run(ctx) {
    return { ok: true, control: await service(ctx).closeProjector() };
  },
});

export const toggleProjectorFullscreenAction: SimpleTabAction<NoArgs, ProjectorActionResult> =
  defineAction({
    id: "simpletab.projector.toggle-fullscreen",
    labelKey: "action.projector.toggleFullscreen",
    page: PROJECTOR_PAGE,
    isEnabled: () => true,
    prompt: noArgs,
    async run(ctx) {
      return { ok: true, control: await service(ctx).toggleFullscreen() };
    },
  });

type ControlField = "roundId" | "mode" | "pageIntervalSeconds" | "roomsPerPage";

const CONTROL_FIELDS: ReadonlyArray<{ value: ControlField; labelKey: string }> = [
  { value: "roundId", labelKey: "action.projector.fieldRound" },
  { value: "mode", labelKey: "action.projector.fieldMode" },
  { value: "pageIntervalSeconds", labelKey: "action.projector.fieldInterval" },
  { value: "roomsPerPage", labelKey: "action.projector.fieldRooms" },
];

const PROJECTOR_MODES = [
  { value: "auto", labelKey: "projector.modeAuto" },
  { value: "motion", labelKey: "projector.modeMotion" },
  { value: "draw", labelKey: "projector.modeDraw" },
  { value: "countdown", labelKey: "projector.modeCountdown" },
] as const;

export interface UpdateProjectorControlArgs {
  patch: ProjectorControlPatch;
}

export const updateProjectorControlAction: SimpleTabAction<
  UpdateProjectorControlArgs,
  ProjectorActionResult
> = defineAction({
  id: "simpletab.projector.update-control",
  labelKey: "action.projector.updateControl",
  page: PROJECTOR_PAGE,
  isEnabled: () => true,
  async prompt(ctx) {
    const control = await currentControl(ctx);
    const field = await ctx.prompts.pick(
      CONTROL_FIELDS.map((item) => ({ label: t(item.labelKey), value: item.value })),
      t("action.projector.pickField"),
    );
    if (field === undefined) {
      return undefined;
    }
    if (field === "roundId") {
      const rounds = ctx.store.getState()?.rounds ?? [];
      const roundId = await ctx.prompts.pick(
        rounds.map((round) => ({
          label: round.name,
          description: round.id === control.roundId ? t("action.prompt.current") : undefined,
          value: round.id,
        })),
        t("projector.roundLabel"),
      );
      return roundId === undefined ? undefined : { patch: { roundId } };
    }
    if (field === "mode") {
      const mode = await ctx.prompts.pick(
        PROJECTOR_MODES.map((item) => ({
          label: t(item.labelKey),
          description: item.value === control.mode ? t("action.prompt.current") : undefined,
          value: item.value,
        })),
        t("projector.modeLabel"),
      );
      return mode === undefined ? undefined : { patch: { mode } };
    }
    // The page's number fields: page interval 2-120 seconds, rooms per page 1-32.
    const value =
      field === "pageIntervalSeconds"
        ? await inputNumber(ctx, t("projector.pageIntervalLabel"), control.pageIntervalSeconds, {
            integer: true,
            min: 2,
            max: 120,
          })
        : await inputNumber(ctx, t("projector.roomsPerPageLabel"), control.roomsPerPage, {
            integer: true,
            min: 1,
            max: 32,
          });
    return value === undefined ? undefined : { patch: { [field]: value } };
  },
  async run(ctx, { patch }) {
    return { ok: true, control: await service(ctx).updateControl(patch) };
  },
});

export const startProjectorCountdownAction: SimpleTabAction<
  { durationSeconds?: number },
  ProjectorActionResult
> = defineAction({
  id: "simpletab.projector.start-countdown",
  labelKey: "action.projector.startCountdown",
  page: PROJECTOR_PAGE,
  isEnabled: () => true,
  async prompt(ctx) {
    const { countdown } = await currentControl(ctx);
    // A running or paused timer resumes; a finished one starts again for the chosen length.
    if (countdown.running || countdown.remainingSeconds > 0) return {};
    return promptMinutes(ctx, countdown.durationSeconds);
  },
  async run(ctx, { durationSeconds }) {
    return { ok: true, control: await service(ctx).startCountdown(durationSeconds) };
  },
});

export const pauseProjectorCountdownAction: SimpleTabAction<NoArgs, ProjectorActionResult> =
  defineAction({
    id: "simpletab.projector.pause-countdown",
    labelKey: "action.projector.pauseCountdown",
    page: PROJECTOR_PAGE,
    isEnabled: () => true,
    prompt: noArgs,
    async run(ctx) {
      return { ok: true, control: await service(ctx).pauseCountdown() };
    },
  });

export const resetProjectorCountdownAction: SimpleTabAction<
  { durationSeconds?: number },
  ProjectorActionResult
> = defineAction({
  id: "simpletab.projector.reset-countdown",
  labelKey: "action.projector.resetCountdown",
  page: PROJECTOR_PAGE,
  isEnabled: () => true,
  async prompt(ctx) {
    return promptMinutes(ctx, (await currentControl(ctx)).countdown.durationSeconds);
  },
  async run(ctx, { durationSeconds }) {
    return { ok: true, control: await service(ctx).resetCountdown(durationSeconds) };
  },
});

export const PROJECTOR_ACTIONS = [
  openProjectorAction,
  closeProjectorAction,
  toggleProjectorFullscreenAction,
  updateProjectorControlAction,
  startProjectorCountdownAction,
  pauseProjectorCountdownAction,
  resetProjectorCountdownAction,
] as const;
