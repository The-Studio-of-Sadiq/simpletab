import type { SubmitResult } from "@simpletab/host/lib/common/host-protocol";
import { t } from "../i18n";
import type { TournamentStoreSnapshot } from "../store/tournament-store";
import { defineAction, type ActionContext } from "./action";

/** Widget id of the Changelog page. */
export const CHANGELOG_PAGE = "simpletab-changelog-widget";

export interface UndoOpArgs {
  seq: number;
}

/**
 * Undo one change from the changelog. The page offers Undo on every entry except those the
 * host says have no inverse; the palette offers the same entries, newest first.
 */
export const undoChangelogOpAction = defineAction<UndoOpArgs, SubmitResult>({
  id: "simpletab.changelog.undo-op",
  labelKey: "action.changelog.undoOp",
  page: CHANGELOG_PAGE,
  isEnabled(snapshot: TournamentStoreSnapshot): boolean {
    return snapshot.state !== null && snapshot.status.open;
  },
  async prompt(ctx: ActionContext): Promise<UndoOpArgs | undefined> {
    if (ctx.store.getState() === null) {
      return undefined;
    }
    const [items, undoInfo] = await Promise.all([
      ctx.store.getChangelog(),
      ctx.store.getOpUndoInfo(),
    ]);
    const infoBySeq = new Map(undoInfo.map((info) => [info.seq, info]));
    const choices = items
      .map((item) => item.entry)
      .filter((entry) => infoBySeq.get(entry.seq)?.hasInverse !== false)
      .sort((a, b) => b.seq - a.seq)
      .map((entry) => ({
        label: `#${entry.seq} ${entry.summary}`,
        ...(entry.summary !== entry.opType ? { description: entry.opType } : {}),
        detail: entry.ts,
        value: entry.seq,
      }));
    const seq = await ctx.prompts.pick(choices, t("action.changelog.pickSeq"));
    if (seq === undefined) {
      return undefined;
    }
    const confirmed = await ctx.prompts.confirm(
      t("action.changelog.confirmUndoTitle"),
      t("action.changelog.confirmUndoMessage"),
    );
    return confirmed ? { seq } : undefined;
  },
  run(ctx: ActionContext, { seq }: UndoOpArgs): Promise<SubmitResult> {
    return ctx.store.undo(seq);
  },
});

export const CHANGELOG_ACTIONS = [undoChangelogOpAction] as const;
