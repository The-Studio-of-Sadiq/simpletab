import type { SubmitResult } from "@simpletab/host/lib/common/host-protocol";
import type { TournamentStore, TournamentStoreSnapshot } from "../store/tournament-store";

/**
 * Design section 11, "Command palette commands (M8)": every SimpleTab action is a command.
 *
 * An action is defined once. The command palette runs it with no arguments: the action asks for
 * what it needs (`prompt`) and then runs. A page's button runs the same command with its
 * arguments already known (the proposal on that row, for example), so the button and the
 * command can never do different things.
 *
 * What counts as an action: anything that changes tournament data, asks the host to do
 * something (publish, pair a device, save a credential), or opens a page. Controls that only
 * change the view (expand, sort, switch tabs, Cancel in a form) are not actions; pages mark those
 * buttons `data-view-only` so the inventory test can tell the two apart.
 */

/** Asks the person for an action's arguments when it is run from the command palette. */
export interface ActionPrompts {
  pick<T>(
    items: ReadonlyArray<{ label: string; description?: string; detail?: string; value: T }>,
    placeholder: string,
  ): Promise<T | undefined>;
  input(prompt: string, options?: { value?: string; optional?: boolean }): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
}

export interface ActionContext {
  store: TournamentStore;
  prompts: ActionPrompts;
  /** Opens (and reveals) a SimpleTab page by its widget id. */
  openPage(widgetId: string): Promise<void>;
}

/**
 * What an action returns. A submit result is shown inline by the page that ran it, or as a
 * notification when the action ran from the palette.
 */
export type ActionResult = SubmitResult | { ok: true } | { ok: false; errors: string[] };

export interface SimpleTabAction<A, R extends ActionResult = ActionResult> {
  /** The command id, for example `simpletab.proposals.accept`. */
  readonly id: string;
  /** i18n key of the command label (shown after "SimpleTab: " in the palette). */
  readonly labelKey: string;
  /** Widget id of the page this action belongs to. */
  readonly page: string;
  /** Whether the palette offers the action now; it is always runnable from its page's buttons. */
  isEnabled?(snapshot: TournamentStoreSnapshot): boolean;
  /** Asks for the arguments when run from the palette; undefined means the person cancelled. */
  prompt(ctx: ActionContext): Promise<A | undefined>;
  run(ctx: ActionContext, args: A): Promise<R>;
}

/** Any action, whatever its argument type, for lists and the registry. */
export interface AnyAction {
  readonly id: string;
  readonly labelKey: string;
  readonly page: string;
  isEnabled?(snapshot: TournamentStoreSnapshot): boolean;
  prompt(ctx: ActionContext): Promise<unknown>;
  run(ctx: ActionContext, args: never): Promise<ActionResult>;
}

/** Keeps an action's argument type checked where it is defined. */
export function defineAction<A, R extends ActionResult = ActionResult>(
  action: SimpleTabAction<A, R>,
): SimpleTabAction<A, R> {
  return action;
}

/** Runs an action with known arguments; pages receive one of these instead of building ops. */
export type ActionRunner = <A, R extends ActionResult>(
  action: SimpleTabAction<A, R>,
  args: A,
) => Promise<R>;

export function isFailure(result: ActionResult): result is { ok: false; errors: string[] } {
  return result.ok === false;
}
