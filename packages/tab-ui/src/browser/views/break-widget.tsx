import { CommandService, DisposableCollection } from "@theia/core/lib/common";
import { Message } from "@theia/core/lib/browser";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import type { ActionRunner } from "../actions/action";
import { commandActionRunner } from "../actions/action-runner";
import { BreakView } from "../components/break-view";
import { onLocaleChange, t } from "../i18n";
import { TournamentStore } from "../store/tournament-store";

@injectable()
export class BreakWidget extends ReactWidget {
  static readonly ID = "simpletab-break-widget";

  private readonly disposables = new DisposableCollection();

  private readonly run: ActionRunner;

  constructor(
    @inject(TournamentStore) private readonly store: TournamentStore,
    @inject(CommandService) commands: CommandService,
  ) {
    super();
    this.run = commandActionRunner(commands);
    this.id = BreakWidget.ID;
    this.title.label = t("break.widgetLabel");
    this.title.caption = t("break.widgetLabel");
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass("simpletab-break-widget");
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
        this.title.label = t("break.widgetLabel");
        this.title.caption = t("break.widgetLabel");
        this.update();
      }),
    );
    this.toDispose.push(this.disposables);
    this.update();
  }

  protected override render(): React.ReactNode {
    const snapshot = this.store.getSnapshot();
    return (
      <BreakView
        state={snapshot.state}
        status={snapshot.status}
        run={this.run}
      />
    );
  }
}
