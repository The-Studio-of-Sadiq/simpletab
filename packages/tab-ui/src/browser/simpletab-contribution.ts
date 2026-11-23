import {
  CredentialsService,
} from "@simpletab/host/lib/common/credentials-protocol";
import {
  HostService,
  type HostStatus,
} from "@simpletab/host/lib/common/host-protocol";
import {
  AbstractViewContribution,
  FrontendApplicationContribution,
  StatusBar,
  StatusBarAlignment,
} from "@theia/core/lib/browser";
import {
  Command,
  CommandRegistry,
  MessageService,
} from "@theia/core/lib/common";
import { inject, injectable, optional } from "@theia/core/shared/inversify";
import {
  SIMPLETAB_CREATE_DEMO_COMMAND_ID,
  SimpleTabStatusWidget,
} from "./simpletab-status-widget";

export const SIMPLETAB_STATUS_TOGGLE_COMMAND_ID = "simpletab.status.toggle";
const STATUS_BAR_ENTRY_ID = "simpletab-status-bar";

export const SIMPLETAB_CREATE_DEMO_COMMAND: Command = {
  id: SIMPLETAB_CREATE_DEMO_COMMAND_ID,
  label: "SimpleTab: Create demo tournament",
};

@injectable()
export class SimpleTabContribution
  extends AbstractViewContribution<SimpleTabStatusWidget>
  implements FrontendApplicationContribution
{
  @inject(HostService)
  protected readonly hostService!: HostService;

  @inject(StatusBar)
  protected readonly statusBar!: StatusBar;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  @inject(CredentialsService)
  @optional()
  protected readonly credentialsService?: CredentialsService;

  constructor() {
    super({
      widgetId: SimpleTabStatusWidget.ID,
      widgetName: SimpleTabStatusWidget.LABEL,
      defaultWidgetOptions: {
        area: "main",
      },
      toggleCommandId: SIMPLETAB_STATUS_TOGGLE_COMMAND_ID,
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(SIMPLETAB_CREATE_DEMO_COMMAND, {
      execute: async () => {
        try {
          const created = await this.hostService.createDemoTournament("");
          this.updateStatusBar(created.status);
          const widget = this.tryGetWidget();
          if (widget !== undefined) {
            widget.applyStatus(created.status);
          }
          await this.messageService.info(
            `Created SimpleTab demo tournament (${created.status.slug ?? "bp-demo"}) at ${created.dbPath}.`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.messageService.error(
            `Failed to create demo tournament: ${message}`,
          );
        }
      },
    });
  }

  async onDidInitializeLayout(): Promise<void> {
    this.updateStatusBar({ open: false, locks: [] });
    const widget = await this.openView({ activate: true, reveal: true });
    widget.onDidUpdateStatus((status) => {
      this.updateStatusBar(status);
    });
    const status = await widget.refresh();
    if (status !== null) {
      this.updateStatusBar(status);
    }
    if (this.credentialsService !== undefined) {
      await this.credentialsService.status();
    }
  }

  private updateStatusBar(status: HostStatus): void {
    const text =
      status.open && status.slug
        ? `SimpleTab: ${status.slug} · seq ${status.headSeq ?? 0}`
        : "SimpleTab: no tournament";

    void this.statusBar.setElement(STATUS_BAR_ENTRY_ID, {
      text,
      alignment: StatusBarAlignment.LEFT,
      priority: 100,
      tooltip: "Toggle SimpleTab Status view",
      command: SIMPLETAB_STATUS_TOGGLE_COMMAND_ID,
    });
  }
}
