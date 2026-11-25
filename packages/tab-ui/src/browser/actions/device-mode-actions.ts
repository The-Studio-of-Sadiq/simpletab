import type {
  JoinHostParams,
  JoinProgress,
} from "@simpletab/host/lib/common/host-protocol";
import { t } from "../i18n";
import { defineAction, type SimpleTabAction } from "./action";
import { inputRequired } from "./prompt-helpers";

/** Widget id of the Setup page, where device-mode controls live. */
export const DEVICE_MODE_PAGE = "simpletab-setup-widget";

type NoArgs = Record<string, never>;

const noArgs = async (): Promise<NoArgs> => ({});

function failure(error: unknown): { ok: false; errors: string[] } {
  return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
}

export const joinHostAction: SimpleTabAction<
  JoinHostParams,
  { ok: true; progress: JoinProgress } | { ok: false; errors: string[] }
> = defineAction({
  id: "simpletab.device-mode.join-host",
  labelKey: "action.device-mode.joinHost",
  page: DEVICE_MODE_PAGE,
  isEnabled: (snapshot) => !snapshot.status.open && snapshot.status.device === undefined,
  async prompt(ctx) {
    const address = await inputRequired(ctx, t("deviceMode.addressLabel"), undefined);
    if (address === undefined) {
      return undefined;
    }
    const code = await inputRequired(ctx, t("deviceMode.codeLabel"), undefined);
    if (code === undefined) {
      return undefined;
    }
    const deviceName = await inputRequired(ctx, t("deviceMode.nameLabel"), undefined);
    if (deviceName === undefined) {
      return undefined;
    }
    return { address, code, deviceName };
  },
  async run(ctx, params) {
    try {
      return { ok: true, progress: await ctx.store.startJoin(params) };
    } catch (error) {
      return failure(error);
    }
  },
});

export const leaveHostAction: SimpleTabAction<NoArgs, { ok: true } | { ok: false; errors: string[] }> =
  defineAction({
    id: "simpletab.device-mode.leave-host",
    labelKey: "action.device-mode.leaveHost",
    page: DEVICE_MODE_PAGE,
    isEnabled: (snapshot) => snapshot.status.device !== undefined,
    // The banner asks with the same text before leaving.
    async prompt(ctx) {
      const confirmed = await ctx.prompts.confirm(
        t("action.device-mode.leaveHost"),
        t("deviceMode.leaveConfirm"),
      );
      return confirmed ? {} : undefined;
    },
    async run(ctx) {
      try {
        await ctx.store.leaveHost();
        return { ok: true };
      } catch (error) {
        return failure(error);
      }
    },
  });

export const dismissRejectedEditsAction: SimpleTabAction<
  NoArgs,
  { ok: true } | { ok: false; errors: string[] }
> = defineAction({
  id: "simpletab.device-mode.dismiss-rejected",
  labelKey: "action.device-mode.dismissRejected",
  page: DEVICE_MODE_PAGE,
  isEnabled: (snapshot) => (snapshot.status.device?.rejected.length ?? 0) > 0,
  prompt: noArgs,
  async run(ctx) {
    try {
      await ctx.store.dismissRejectedEdits();
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
});

export const DEVICE_MODE_ACTIONS = [
  joinHostAction,
  leaveHostAction,
  dismissRejectedEditsAction,
] as const;
