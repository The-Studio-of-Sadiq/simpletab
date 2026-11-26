import { CredentialsService } from "@simpletab/host/lib/common/credentials-protocol";
import { ProjectorService } from "@simpletab/host/lib/common/projector-protocol";
import { ExtensionsRestartService, ExtensionsService } from "@simpletab/extensions/lib/common/extensions-protocol";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { ConfirmDialog } from "@theia/core/lib/browser/dialogs";
import { WidgetManager } from "@theia/core/lib/browser/widget-manager";
import type { CommandContribution, CommandRegistry } from "@theia/core/lib/common/command";
import { MessageService } from "@theia/core/lib/common/message-service";
import { QuickInputService } from "@theia/core/lib/common/quick-pick-service";
import type URI from "@theia/core/lib/common/uri";
import { inject, injectable, optional } from "@theia/core/shared/inversify";
import { FileDialogService } from "@theia/filesystem/lib/browser/file-dialog/file-dialog-service";
import { FileService } from "@theia/filesystem/lib/browser/file-service";
import { t } from "../i18n";
import { TournamentStore } from "../store/tournament-store";
import { executeAction } from "./execute-action";
import type { ActionContext, ActionPrompts } from "./action";
import { ALL_ACTIONS } from "./all-actions";

export const ACTION_CATEGORY = "SimpleTab";

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

  @inject(FileDialogService)
  protected readonly fileDialogs!: FileDialogService;

  @inject(FileService)
  protected readonly files!: FileService;

  @inject(CredentialsService)
  @optional()
  protected readonly credentialsService?: CredentialsService;

  @inject(ProjectorService)
  @optional()
  protected readonly projectorService?: ProjectorService;

  @inject(ExtensionsService)
  @optional()
  protected readonly extensionsService?: ExtensionsService;

  @inject(ExtensionsRestartService)
  @optional()
  protected readonly restartService?: ExtensionsRestartService;

  protected readonly prompts: ActionPrompts = {
    pick: async (items, placeholder) => {
      const picked = await this.quickInput.showQuickPick(
        items.map((item) => ({ label: item.label, description: item.description, detail: item.detail, value: item.value })),
        { placeholder },
      );
      return picked?.value;
    },
    input: (prompt, options) =>
      this.quickInput.input({
        prompt,
        value: options?.value,
        placeHolder: prompt,
        password: options?.password,
      }),
    confirm: async (title, msg) => (await new ConfirmDialog({ title, msg }).open()) === true,
    pickFile: async (title, extensions) => (await this.chooseFile(title, extensions))?.path.fsPath(),
    openTextFile: async (title, extensions) => {
      const uri = await this.chooseFile(title, extensions);
      return uri === undefined ? undefined : (await this.files.read(uri)).value;
    },
  };

  protected chooseFile(title: string, extensions: readonly string[]): Promise<URI | undefined> {
    return this.fileDialogs.showOpenDialog({
      title,
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { [title]: [...extensions] },
    });
  }

  protected context(): ActionContext {
    return {
      store: this.store,
      prompts: this.prompts,
      openPage: async (widgetId) => {
        const widget = await this.widgets.getOrCreateWidget(widgetId);
        if (!widget.isAttached) await this.shell.addWidget(widget, { area: "main" });
        await this.shell.activateWidget(widgetId);
      },
      services: {
        credentials: this.credentialsService,
        projector: this.projectorService,
        extensions: this.extensionsService,
        restart: this.restartService,
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
