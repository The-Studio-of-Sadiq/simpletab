import type { CommandService } from "@theia/core/lib/common/command";
import type { ActionResult, ActionRunner, SimpleTabAction } from "./action";

/**
 * The runner a page gets: a button runs its action through the command service, the same path
 * the palette takes. Arguments are always given here, so the action never prompts.
 */
export function commandActionRunner(commands: CommandService): ActionRunner {
  return async <A, R extends ActionResult>(action: SimpleTabAction<A, R>, args: A): Promise<R> => {
    const result = await commands.executeCommand<R>(action.id, args);
    if (result === undefined) {
      throw new Error(`The command ${action.id} returned no result.`);
    }
    return result;
  };
}
