import type {
  CreateDemoResult,
  HostIntegrityCheckResult,
  SyncStatus,
} from "@simpletab/host/lib/common/host-protocol";
import { t } from "../i18n";
import { defineAction, type ActionContext, type SimpleTabAction } from "./action";

/** Widget id of the Status page. */
export const STATUS_PAGE = "simpletab-status-widget";

type NoArgs = Record<string, never>;

const noArgs = async (): Promise<NoArgs> => ({});

function failure(error: unknown): { ok: false; errors: string[] } {
  return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
}

function requireOpen(ctx: ActionContext): boolean {
  return ctx.store.getStatus().open;
}

export const runFullCheckAction: SimpleTabAction<
  NoArgs,
  { ok: true; check: HostIntegrityCheckResult } | { ok: false; errors: string[] }
> = defineAction({
  id: "simpletab.status.run-full-check",
  labelKey: "action.status.runFullCheck",
  page: STATUS_PAGE,
  isEnabled: (snapshot) => snapshot.status.open,
  prompt: noArgs,
  async run(ctx) {
    try {
      return { ok: true, check: await ctx.store.runFullCheck() };
    } catch (error) {
      return failure(error);
    }
  },
});

export const pullNowAction: SimpleTabAction<
  NoArgs,
  { ok: true; sync: SyncStatus } | { ok: false; errors: string[] }
> = defineAction({
  id: "simpletab.status.pull-now",
  labelKey: "action.status.pullNow",
  page: STATUS_PAGE,
  isEnabled: (snapshot) => snapshot.status.open,
  prompt: noArgs,
  async run(ctx) {
    if (!requireOpen(ctx)) {
      return { ok: false, errors: [t("credentials.noTournamentOnline")] };
    }
    try {
      return { ok: true, sync: await ctx.store.pullNow() };
    } catch (error) {
      return failure(error);
    }
  },
});

export const createDemoTournamentAction: SimpleTabAction<
  { directory: string },
  { ok: true; result: CreateDemoResult } | { ok: false; errors: string[] }
> = defineAction({
  id: "simpletab.status.create-demo",
  labelKey: "action.status.createDemo",
  page: STATUS_PAGE,
  isEnabled: () => true,
  async prompt(ctx) {
    const directory = await ctx.prompts.input(t("action.status.demoDirectoryPrompt"), {
      optional: true,
    });
    return directory === undefined ? undefined : { directory: directory.trim() };
  },
  async run(ctx, { directory }) {
    try {
      return { ok: true, result: await ctx.store.createDemoTournament(directory) };
    } catch (error) {
      return failure(error);
    }
  },
});

export const STATUS_ACTIONS = [
  runFullCheckAction,
  pullNowAction,
  createDemoTournamentAction,
] as const;
