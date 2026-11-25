import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { ConfirmDialog } from "@theia/core/lib/browser/dialogs";
import { WidgetManager } from "@theia/core/lib/browser/widget-manager";
import type { CommandContribution, CommandRegistry } from "@theia/core/lib/common/command";
import { MessageService } from "@theia/core/lib/common/message-service";
import { QuickInputService } from "@theia/core/lib/common/quick-pick-service";
import { inject, injectable } from "@theia/core/shared/inversify";
import { t } from "../i18n";
import { TournamentStore } from "../store/tournament-store";
import {
  isFailure,
  type ActionContext,
  type ActionPrompts,
  type ActionResult,
  type AnyAction,
} from "./action";
import { ALL_ACTIONS } from "./all-actions";

export const ACTION_CATEGORY = "SimpleTab";

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
  const resolved = fromPalette ? await action.prompt(ctx) : args;
  if (resolved === undefined) return undefined;
  const result = await action.run(ctx, resolved as never);
  if (fromPalette) {
    if (isFailure(result)) notify.error(result.errors.join(" "));
    else notify.info(t("action.done", { action: t(action.labelKey) }));
  }
  return result;
}

@injectable()
export class ActionCommandContribution implements CommandContribution {
  @inject(TournamentStore)
  protected readonly store!: TournamentStore;

  @inject(QuickInputService)
  protected readonly quickInput!: QuickInputService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(ApplicationShell)
  protected readonly shell!: ApplicationShell;

  @inject(WidgetManager)
  protected readonly widgets!: WidgetManager;

  protected readonly prompts: ActionPrompts = {
    pick: async (items, placeholder) => {
      const picked = await this.quickInput.showQuickPick(
        items.map((item) => ({ label: item.label, description: item.description, detail: item.detail, value: item.value })),
        { placeholder },
      );
      return picked?.value;
    },
    input: (prompt, options) =>
      this.quickInput.input({ prompt, value: options?.value, placeHolder: prompt }),
    confirm: async (title, msg) => (await new ConfirmDialog({ title, msg }).open()) === true,
  };

  protected context(): ActionContext {
    return {
      store: this.store,
      prompts: this.prompts,
      openPage: async (widgetId) => {
        const widget = await this.widgets.getOrCreateWidget(widgetId);
        if (!widget.isAttached) await this.shell.addWidget(widget, { area: "main" });
        await this.shell.activateWidget(widgetId);
      },
    };
  }

  registerCommands(registry: CommandRegistry): void {
    for (const action of ALL_ACTIONS) {
      registry.registerCommand(
        { id: action.id, label: t(action.labelKey), category: ACTION_CATEGORY },
        {
          execute: (args?: unknown) =>
            executeAction(action, this.context(), args, {
              error: (message) => void this.messages.error(message),
              info: (message) => void this.messages.info(message),
            }),
          // A page's button always runs its action; the palette offers it only when it applies.
          isEnabled: (args?: unknown) =>
            args !== undefined || (action.isEnabled?.(this.store.getSnapshot()) ?? true),
        },
      );
    }
  }
}
