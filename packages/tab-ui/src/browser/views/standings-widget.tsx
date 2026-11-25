import { CommandService, DisposableCollection } from "@theia/core/lib/common";
import { Message } from "@theia/core/lib/browser";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import type { ActionRunner } from "../actions/action";
import { commandActionRunner } from "../actions/action-runner";
import { StandingsView } from "../components/standings-view";
import { onLocaleChange, t } from "../i18n";
import { TournamentStore } from "../store/tournament-store";

@injectable()
export class StandingsWidget extends ReactWidget {
  static readonly ID = "simpletab-standings-widget";

  private readonly disposables = new DisposableCollection();

  private readonly run: ActionRunner;

  constructor(
    @inject(TournamentStore) private readonly store: TournamentStore,
    @inject(CommandService) commands: CommandService,
  ) {
    super();
    this.run = commandActionRunner(commands);
    this.id = StandingsWidget.ID;
    this.title.label = t("standings.widgetLabel");
    this.title.caption = t("standings.widgetLabel");
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass("simpletab-standings-widget");
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    this.node.focus();
  }

  @postConstruct()
  protected init(): void {
    const unsub = this.store.subscribe(() => {
      this.update();
    });
    this.disposables.push({ dispose: unsub });
    this.disposables.push(
      onLocaleChange(() => {
        this.title.label = t("standings.widgetLabel");
        this.title.caption = t("standings.widgetLabel");
        this.update();
      }),
    );
    this.toDispose.push(this.disposables);
    this.update();
  }

  protected override render(): React.ReactNode {
    const snapshot = this.store.getSnapshot();
    return (
      <StandingsView
        state={snapshot.state}
        status={snapshot.status}
        run={this.run}
      />
    );
  }
}
