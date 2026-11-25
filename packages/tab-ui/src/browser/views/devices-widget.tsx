import { DisposableCollection } from "@theia/core/lib/common";
import { Message } from "@theia/core/lib/browser";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import { DevicesView } from "../components/devices-view";
import { onLocaleChange, t } from "../i18n";
import { stateHasPermission } from "../lib/permissions";
import { TournamentStore } from "../store/tournament-store";

@injectable()
export class DevicesWidget extends ReactWidget {
  static readonly ID = "simpletab-devices-widget";

  private readonly disposables = new DisposableCollection();

  constructor(@inject(TournamentStore) private readonly store: TournamentStore) {
    super();
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
    this.update();
  }

  private readonly loadStatus = () => this.store.getDevicesStatus();
  private readonly setEnabled = (enabled: boolean) => this.store.setDevicesEnabled(enabled);
  private readonly issueCode = (roleId: string) => this.store.issuePairingCode(roleId);
  private readonly cancelCode = (code: string) => this.store.cancelPairingCode(code);
  private readonly approve = (joinId: string) => this.store.approveJoin(joinId);
  private readonly reject = (joinId: string) => this.store.rejectJoin(joinId);
  private readonly remove = (deviceId: string) => this.store.removeDevice(deviceId);
  private readonly setSuccession = (order: string[]) => this.store.setSuccession(order);

  protected override render(): React.ReactNode {
    const snapshot = this.store.getSnapshot();
    return (
      <DevicesView
        open={snapshot.status.open}
        canManage={snapshot.state !== null && stateHasPermission(snapshot.state, "devices.manage")}
        loadStatus={this.loadStatus}
        onSetEnabled={this.setEnabled}
        onIssueCode={this.issueCode}
        onCancelCode={this.cancelCode}
        onApprove={this.approve}
        onReject={this.reject}
        onRemove={this.remove}
        onSetSuccession={this.setSuccession}
      />
    );
  }
}
