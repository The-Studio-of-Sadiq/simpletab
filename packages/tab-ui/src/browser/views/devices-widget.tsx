import { CommandService, DisposableCollection } from "@theia/core/lib/common";
import { Message } from "@theia/core/lib/browser";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import type { ActionRunner } from "../actions/action";
import { commandActionRunner } from "../actions/action-runner";
import { DevicesView } from "../components/devices-view";
import { onLocaleChange, t } from "../i18n";
import { stateHasPermission } from "../lib/permissions";
import { TournamentStore } from "../store/tournament-store";

@injectable()
export class DevicesWidget extends ReactWidget {
  static readonly ID = "simpletab-devices-widget";

  private readonly disposables = new DisposableCollection();

  private readonly run: ActionRunner;

  constructor(
    @inject(TournamentStore) private readonly store: TournamentStore,
    @inject(CommandService) commands: CommandService,
  ) {
    super();
    this.run = commandActionRunner(commands);
    this.id = DevicesWidget.ID;
    this.title.label = t("devices.widgetLabel");
    this.title.caption = t("devices.widgetLabel");
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass("simpletab-devices-widget");
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
        this.title.label = t("devices.widgetLabel");
        this.title.caption = t("devices.widgetLabel");
        this.update();
      }),
    );
    this.toDispose.push(this.disposables);
    // Commands need the device list to decide what they can do, even before the page polls.
    void this.store.getDevicesStatus();
    this.update();
  }

  private readonly loadStatus = () => this.store.getDevicesStatus();

  protected override render(): React.ReactNode {
    const snapshot = this.store.getSnapshot();
    return (
      <DevicesView
        open={snapshot.status.open}
        canManage={snapshot.state !== null && stateHasPermission(snapshot.state, "devices.manage")}
        loadStatus={this.loadStatus}
        run={this.run}
      />
    );
  }
}
