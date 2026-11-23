import { CredentialsService } from "@simpletab/host/lib/common/credentials-protocol";
import type { HostStatus } from "@simpletab/host/lib/common/host-protocol";
import {
  AbstractViewContribution,
  FrontendApplicationContribution,
  StatusBar,
  StatusBarAlignment,
  ViewContainer,
} from "@theia/core/lib/browser";
import {
  Command,
  CommandRegistry,
  MessageService,
} from "@theia/core/lib/common";
import { inject, injectable, optional } from "@theia/core/shared/inversify";
import { onLocaleChange, t } from "./i18n";
import {
  SIMPLETAB_CREATE_DEMO_COMMAND_ID,
  SimpleTabStatusWidget,
} from "./simpletab-status-widget";
import { TournamentStore } from "./store/tournament-store";
import { AllocationWidget } from "./views/allocation-widget";
import { BreakWidget } from "./views/break-widget";
import { ChangelogWidget } from "./views/changelog-widget";
import { CheckinWidget } from "./views/checkin-widget";
import { DrawWidget } from "./views/draw-widget";
import { FeedbackWidget } from "./views/feedback-widget";
import { MotionsWidget } from "./views/motions-widget";
import { ParticipantsWidget } from "./views/participants-widget";
import { ReleasesWidget } from "./views/releases-widget";
import { ResultsWidget } from "./views/results-widget";
import { SetupWidget } from "./views/setup-widget";
import {
  SIMPLETAB_OPEN_ALLOCATION_COMMAND,
  SIMPLETAB_OPEN_BREAK_COMMAND,
  SIMPLETAB_OPEN_CHANGELOG_COMMAND,
  SIMPLETAB_OPEN_CHECKIN_COMMAND,
  SIMPLETAB_OPEN_DRAW_COMMAND,
  SIMPLETAB_OPEN_FEEDBACK_COMMAND,
  SIMPLETAB_OPEN_MOTIONS_COMMAND,
  SIMPLETAB_OPEN_PARTICIPANTS_COMMAND,
  SIMPLETAB_OPEN_RELEASES_COMMAND,
  SIMPLETAB_OPEN_RESULTS_COMMAND,
  SIMPLETAB_OPEN_SETUP_COMMAND,
  SIMPLETAB_OPEN_STANDINGS_COMMAND,
  SIMPLETAB_OPEN_STATUS_COMMAND,
} from "./views/simpletab-nav-widget";
import { StandingsWidget } from "./views/standings-widget";

export const SIMPLETAB_VIEW_CONTAINER_ID = "simpletab-view-container";
export const SIMPLETAB_CONTAINER_TOGGLE_COMMAND_ID = "simpletab.container.toggle";
export const SIMPLETAB_STATUS_TOGGLE_COMMAND_ID = "simpletab.status.toggle";
export const SIMPLETAB_SETUP_TOGGLE_COMMAND_ID = "simpletab.setup.toggle";
export const SIMPLETAB_PARTICIPANTS_TOGGLE_COMMAND_ID =
  "simpletab.participants.toggle";
export const SIMPLETAB_CHECKIN_TOGGLE_COMMAND_ID = "simpletab.checkin.toggle";
export const SIMPLETAB_DRAW_TOGGLE_COMMAND_ID = "simpletab.draw.toggle";
export const SIMPLETAB_ALLOCATION_TOGGLE_COMMAND_ID =
  "simpletab.allocation.toggle";
export const SIMPLETAB_MOTIONS_TOGGLE_COMMAND_ID = "simpletab.motions.toggle";
export const SIMPLETAB_RESULTS_TOGGLE_COMMAND_ID = "simpletab.results.toggle";
export const SIMPLETAB_FEEDBACK_TOGGLE_COMMAND_ID = "simpletab.feedback.toggle";
export const SIMPLETAB_STANDINGS_TOGGLE_COMMAND_ID =
  "simpletab.standings.toggle";
export const SIMPLETAB_BREAK_TOGGLE_COMMAND_ID = "simpletab.break.toggle";
export const SIMPLETAB_RELEASES_TOGGLE_COMMAND_ID = "simpletab.releases.toggle";
export const SIMPLETAB_CHANGELOG_TOGGLE_COMMAND_ID =
  "simpletab.changelog.toggle";

const STATUS_BAR_ENTRY_ID = "simpletab-status-bar";

export const SIMPLETAB_CREATE_DEMO_COMMAND: Command = {
  id: SIMPLETAB_CREATE_DEMO_COMMAND_ID,
  label: t("command.createDemo"),
};

@injectable()
export class SimpleTabContainerContribution extends AbstractViewContribution<ViewContainer> {
  constructor() {
    super({
      widgetId: SIMPLETAB_VIEW_CONTAINER_ID,
      viewContainerId: SIMPLETAB_VIEW_CONTAINER_ID,
      widgetName: t("nav.containerTitle"),
      defaultWidgetOptions: {
        area: "left",
      },
      toggleCommandId: SIMPLETAB_CONTAINER_TOGGLE_COMMAND_ID,
    });
  }
}

@injectable()
export class SetupViewContribution extends AbstractViewContribution<SetupWidget> {
  constructor() {
    super({
      widgetId: SetupWidget.ID,
      widgetName: t("setup.widgetLabel"),
      defaultWidgetOptions: {
        area: "main",
      },
      toggleCommandId: SIMPLETAB_SETUP_TOGGLE_COMMAND_ID,
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(
      { id: SIMPLETAB_OPEN_SETUP_COMMAND },
      {
        execute: () => this.openView({ activate: true, reveal: true }),
      },
    );
  }
}

@injectable()
export class ParticipantsViewContribution extends AbstractViewContribution<ParticipantsWidget> {
  constructor() {
    super({
      widgetId: ParticipantsWidget.ID,
      widgetName: t("participants.widgetLabel"),
      defaultWidgetOptions: {
        area: "main",
      },
      toggleCommandId: SIMPLETAB_PARTICIPANTS_TOGGLE_COMMAND_ID,
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(
      { id: SIMPLETAB_OPEN_PARTICIPANTS_COMMAND },
      {
        execute: () => this.openView({ activate: true, reveal: true }),
      },
    );
  }
}

@injectable()
export class CheckinViewContribution extends AbstractViewContribution<CheckinWidget> {
  constructor() {
    super({
      widgetId: CheckinWidget.ID,
      widgetName: t("checkin.widgetLabel"),
      defaultWidgetOptions: {
        area: "main",
      },
      toggleCommandId: SIMPLETAB_CHECKIN_TOGGLE_COMMAND_ID,
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(
      { id: SIMPLETAB_OPEN_CHECKIN_COMMAND },
      {
        execute: () => this.openView({ activate: true, reveal: true }),
      },
    );
  }
}

@injectable()
export class DrawViewContribution extends AbstractViewContribution<DrawWidget> {
  constructor() {
    super({
      widgetId: DrawWidget.ID,
      widgetName: t("draw.widgetLabel"),
      defaultWidgetOptions: {
        area: "main",
      },
      toggleCommandId: SIMPLETAB_DRAW_TOGGLE_COMMAND_ID,
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(
      { id: SIMPLETAB_OPEN_DRAW_COMMAND },
      {
        execute: () => this.openView({ activate: true, reveal: true }),
      },
    );
  }
}

@injectable()
export class AllocationViewContribution extends AbstractViewContribution<AllocationWidget> {
  constructor() {
    super({
      widgetId: AllocationWidget.ID,
      widgetName: t("allocation.widgetLabel"),
      defaultWidgetOptions: {
        area: "main",
      },
      toggleCommandId: SIMPLETAB_ALLOCATION_TOGGLE_COMMAND_ID,
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(
      { id: SIMPLETAB_OPEN_ALLOCATION_COMMAND },
      {
        execute: () => this.openView({ activate: true, reveal: true }),
      },
    );
  }
}

@injectable()
export class MotionsViewContribution extends AbstractViewContribution<MotionsWidget> {
  constructor() {
    super({
      widgetId: MotionsWidget.ID,
      widgetName: t("motions.widgetLabel"),
      defaultWidgetOptions: {
        area: "main",
      },
      toggleCommandId: SIMPLETAB_MOTIONS_TOGGLE_COMMAND_ID,
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(
      { id: SIMPLETAB_OPEN_MOTIONS_COMMAND },
      {
        execute: () => this.openView({ activate: true, reveal: true }),
      },
    );
  }
}

@injectable()
export class ResultsViewContribution extends AbstractViewContribution<ResultsWidget> {
  constructor() {
    super({
      widgetId: ResultsWidget.ID,
      widgetName: t("results.widgetLabel"),
      defaultWidgetOptions: {
        area: "main",
      },
      toggleCommandId: SIMPLETAB_RESULTS_TOGGLE_COMMAND_ID,
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(
      { id: SIMPLETAB_OPEN_RESULTS_COMMAND },
      {
        execute: () => this.openView({ activate: true, reveal: true }),
      },
    );
  }
}

@injectable()
export class FeedbackViewContribution extends AbstractViewContribution<FeedbackWidget> {
  constructor() {
    super({
      widgetId: FeedbackWidget.ID,
      widgetName: t("feedback.widgetLabel"),
      defaultWidgetOptions: {
        area: "main",
      },
      toggleCommandId: SIMPLETAB_FEEDBACK_TOGGLE_COMMAND_ID,
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(
      { id: SIMPLETAB_OPEN_FEEDBACK_COMMAND },
      {
        execute: () => this.openView({ activate: true, reveal: true }),
      },
    );
  }
}

@injectable()
export class StandingsViewContribution extends AbstractViewContribution<StandingsWidget> {
  constructor() {
    super({
      widgetId: StandingsWidget.ID,
      widgetName: t("standings.widgetLabel"),
      defaultWidgetOptions: {
        area: "main",
      },
      toggleCommandId: SIMPLETAB_STANDINGS_TOGGLE_COMMAND_ID,
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(
      { id: SIMPLETAB_OPEN_STANDINGS_COMMAND },
      {
        execute: () => this.openView({ activate: true, reveal: true }),
      },
    );
  }
}

@injectable()
export class BreakViewContribution extends AbstractViewContribution<BreakWidget> {
  constructor() {
    super({
      widgetId: BreakWidget.ID,
      widgetName: t("break.widgetLabel"),
      defaultWidgetOptions: {
        area: "main",
      },
      toggleCommandId: SIMPLETAB_BREAK_TOGGLE_COMMAND_ID,
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(
      { id: SIMPLETAB_OPEN_BREAK_COMMAND },
      {
        execute: () => this.openView({ activate: true, reveal: true }),
      },
    );
  }
}

@injectable()
export class ReleasesViewContribution extends AbstractViewContribution<ReleasesWidget> {
  constructor() {
    super({
      widgetId: ReleasesWidget.ID,
      widgetName: t("releases.widgetLabel"),
      defaultWidgetOptions: {
        area: "main",
      },
      toggleCommandId: SIMPLETAB_RELEASES_TOGGLE_COMMAND_ID,
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(
      { id: SIMPLETAB_OPEN_RELEASES_COMMAND },
      {
        execute: () => this.openView({ activate: true, reveal: true }),
      },
    );
  }
}

@injectable()
export class ChangelogViewContribution extends AbstractViewContribution<ChangelogWidget> {
  constructor() {
    super({
      widgetId: ChangelogWidget.ID,
      widgetName: t("changelog.widgetLabel"),
      defaultWidgetOptions: {
        area: "main",
      },
      toggleCommandId: SIMPLETAB_CHANGELOG_TOGGLE_COMMAND_ID,
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(
      { id: SIMPLETAB_OPEN_CHANGELOG_COMMAND },
      {
        execute: () => this.openView({ activate: true, reveal: true }),
      },
    );
  }
}

@injectable()
export class SimpleTabContribution
  extends AbstractViewContribution<SimpleTabStatusWidget>
  implements FrontendApplicationContribution
{
  @inject(TournamentStore)
  protected readonly store!: TournamentStore;

  @inject(SimpleTabContainerContribution)
  protected readonly containerContribution!: SimpleTabContainerContribution;

  @inject(SetupViewContribution)
  protected readonly setupContribution!: SetupViewContribution;

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
      widgetName: t("status.widgetLabel"),
      defaultWidgetOptions: {
        area: "main",
      },
      toggleCommandId: SIMPLETAB_STATUS_TOGGLE_COMMAND_ID,
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(
      { id: SIMPLETAB_OPEN_STATUS_COMMAND },
      {
        execute: () => this.openView({ activate: true, reveal: true }),
      },
    );
    commands.registerCommand(SIMPLETAB_CREATE_DEMO_COMMAND, {
      execute: async () => {
        try {
          const created = await this.store.createDemoTournament("");
          this.updateStatusBar(created.status);
          await this.messageService.info(
            t("command.demoCreated", {
              slug: created.status.slug ?? "bp-demo",
              dbPath: created.dbPath,
            }),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.messageService.error(
            t("command.demoFailed", { message }),
          );
        }
      },
    });
  }

  async onDidInitializeLayout(): Promise<void> {
    this.updateStatusBar({ open: false, locks: [] });
    this.store.subscribe((snapshot) => {
      this.updateStatusBar(snapshot.status);
    });
    onLocaleChange(() => {
      this.updateStatusBar(this.store.getStatus());
    });

    await this.containerContribution.openView({ reveal: true });
    const snapshot = await this.store.refresh();
    this.updateStatusBar(snapshot.status);

    if (!snapshot.status.open) {
      await this.setupContribution.openView({ activate: true, reveal: true });
    } else {
      await this.openView({ activate: true, reveal: true });
    }

    if (this.credentialsService !== undefined) {
      await this.credentialsService.status();
    }
  }

  private updateStatusBar(status: HostStatus): void {
    const text =
      status.open && status.slug
        ? t("statusBar.tournament", {
            slug: status.slug,
            seq: status.headSeq ?? 0,
          })
        : t("statusBar.noTournament");

    void this.statusBar.setElement(STATUS_BAR_ENTRY_ID, {
      text,
      alignment: StatusBarAlignment.LEFT,
      priority: 100,
      tooltip: t("statusBar.tooltip"),
      command: SIMPLETAB_STATUS_TOGGLE_COMMAND_ID,
    });
  }
}
