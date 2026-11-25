import { CommandService, DisposableCollection } from "@theia/core/lib/common";
import { Message } from "@theia/core/lib/browser";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import type { ActionRunner } from "../actions/action";
import { commandActionRunner } from "../actions/action-runner";
import { AssistantView } from "../components/assistant-view";
import { onLocaleChange, t } from "../i18n";
import { stateHasPermission } from "../lib/permissions";
import { TournamentStore } from "../store/tournament-store";

@injectable()
export class AssistantWidget extends ReactWidget {
  static readonly ID = "simpletab-assistant-widget";

  private readonly disposables = new DisposableCollection();
  private readonly run: ActionRunner;

  constructor(
    @inject(TournamentStore) private readonly store: TournamentStore,
    @inject(CommandService) commands: CommandService,
  ) {
    super();
    this.run = commandActionRunner(commands);
    this.id = AssistantWidget.ID;
    this.title.label = t("assistant.widgetLabel");
    this.title.caption = t("assistant.widgetLabel");
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass("simpletab-assistant-widget");
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    void this.store.setPresence({ view: "assistant" });
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
        this.title.label = t("assistant.widgetLabel");
        this.title.caption = t("assistant.widgetLabel");
        this.update();
      }),
    );
    this.toDispose.push(this.disposables);
    this.update();
  }

  protected override render(): React.ReactNode {
    const { state } = this.store.getSnapshot();
    const canScan =
      state !== null && (stateHasPermission(state, "results.enter") || stateHasPermission(state, "results.enter_late"));
    return (
      <AssistantView state={state} canScan={canScan} run={this.run} />
    );
  }
}
