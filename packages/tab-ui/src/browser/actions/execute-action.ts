import { t } from "../i18n";
import { isFailure, type ActionContext, type ActionResult, type AnyAction } from "./action";

/**
 * Runs one action as a command. With arguments (from a page's button) it runs them as given and
 * returns the result to the page. With none (from the palette) it asks for them, and reports a
 * refusal as a notification because no page is there to show it.
 */
export async function executeAction(
  action: AnyAction,
  ctx: ActionContext,
  args: unknown,
  notify: { error(message: string): void; info(message: string): void },
): Promise<ActionResult | undefined> {
  const fromPalette = args === undefined;
  if (!fromPalette) return action.run(ctx, args as never);
  // From the palette nobody else will see a thrown error (a host call that failed, a file that
  // could not be read), so it is reported like a refusal.
  let result: ActionResult;
  try {
    const resolved = await action.prompt(ctx);
    if (resolved === undefined) return undefined;
    result = await action.run(ctx, resolved as never);
  } catch (error) {
    notify.error(error instanceof Error ? error.message : String(error));
    return undefined;
  }
  if (isFailure(result)) notify.error(result.errors.join(" "));
  else notify.info(t("action.done", { action: t(action.labelKey) }));
  return result;
}
