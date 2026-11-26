import {
  ExtensionsService,
  type ExtensionsStatus,
} from "@simpletab/extensions/lib/common/extensions-protocol";
import { CommandRegistry, CommandService, DisposableCollection } from "@theia/core/lib/common";
import { Message } from "@theia/core/lib/browser";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, optional, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import { FileDialogService } from "@theia/filesystem/lib/browser/file-dialog";
import type { ActionResult, ActionRunner, SimpleTabAction } from "../actions/action";
import { commandActionRunner } from "../actions/action-runner";
import { EXTENSIONS_ACTIONS, EXTENSIONS_PAGE } from "../actions/extensions-actions";
import { ExtensionsView } from "../components/extensions-view";
import { onLocaleChange, t } from "../i18n";

const EMPTY_STATUS: ExtensionsStatus = {
  extensions: [],
  reason: "may-host",
  startupReason: null,
  restartNeeded: false,
  ignoredFiles: [],
};

@injectable()
export class ExtensionsWidget extends ReactWidget {
  static readonly ID = EXTENSIONS_PAGE;

  private readonly disposables = new DisposableCollection();
  private readonly run: ActionRunner;
  private extensionsStatus: ExtensionsStatus = EMPTY_STATUS;

  @inject(CommandRegistry)
  protected readonly commandRegistry!: CommandRegistry;

  constructor(
    @inject(CommandService) commands: CommandService,
    @inject(ExtensionsService)
    @optional()
    private readonly extensionsService?: ExtensionsService,
    @inject(FileDialogService)
    @optional()
    private readonly fileDialogService?: FileDialogService,
  ) {
    super();
    const commandRunner = commandActionRunner(commands);
    this.run = async <A, R extends ActionResult>(
      action: SimpleTabAction<A, R>,
      args: A,
    ): Promise<R> => {
      const result = await commandRunner(action, args);
      await this.refreshExtensions();
      return result;
    };
    this.id = ExtensionsWidget.ID;
    this.title.label = t("extensions.widgetLabel");
    this.title.caption = t("extensions.widgetLabel");
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass("simpletab-extensions-widget");
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    this.node.focus();
    void this.refreshExtensions();
  }

  @postConstruct()
  protected init(): void {
    this.disposables.push(
      onLocaleChange(() => {
        this.title.label = t("extensions.widgetLabel");
        this.title.caption = t("extensions.widgetLabel");
        this.update();
      }),
    );
    // A change made from the command palette must show here too, not only the page's own buttons.
    const extensionCommands = new Set<string>(EXTENSIONS_ACTIONS.map((action) => action.id));
    this.disposables.push(
      this.commandRegistry.onDidExecuteCommand((event) => {
        if (extensionCommands.has(event.commandId)) void this.refreshExtensions();
      }),
    );
    this.toDispose.push(this.disposables);
    void this.refreshExtensions();
    this.update();
  }

  private async refreshExtensions(): Promise<void> {
    if (this.extensionsService === undefined) {
      return;
    }
    try {
      this.extensionsStatus = await this.extensionsService.status();
    } catch {
      // Keep the last status on screen: a failed refresh must not hide the page.
      return;
    }
    this.update();
  }

  private async pickVsix(): Promise<string | undefined> {
    if (this.fileDialogService === undefined) {
      return undefined;
    }
    const uri = await this.fileDialogService.showOpenDialog({
      title: t("action.extensions.filePrompt"),
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { [t("extensions.fileFilter")]: ["vsix"] },
    });
    return uri?.path.fsPath();
  }

  protected override render(): React.ReactNode {
    return (
      <ExtensionsView
        status={this.extensionsStatus}
        available={this.extensionsService !== undefined}
        onPickVsix={this.fileDialogService === undefined ? undefined : () => this.pickVsix()}
        run={this.run}
      />
    );
  }
}
