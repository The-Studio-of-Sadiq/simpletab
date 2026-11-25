import { CommandService, DisposableCollection } from "@theia/core/lib/common";
import { Message } from "@theia/core/lib/browser";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import type { ActionRunner } from "../actions/action";
import { commandActionRunner } from "../actions/action-runner";
import { ArchivePanel } from "../components/archive-panel";
import { PublishPanel } from "../components/publish-panel";
import { ReleasesView } from "../components/releases-view";
import { stateHasPermission } from "../lib/permissions";
import { onLocaleChange, t } from "../i18n";
import { DEFAULT_ONLINE_SETTINGS } from "@simpletab/host/lib/common/host-protocol";
import { TournamentStore } from "../store/tournament-store";

@injectable()
export class ReleasesWidget extends ReactWidget {
  static readonly ID = "simpletab-releases-widget";

  private readonly disposables = new DisposableCollection();

  private readonly run: ActionRunner;

  constructor(
    @inject(TournamentStore) private readonly store: TournamentStore,
    @inject(CommandService) commands: CommandService,
  ) {
    super();
    this.run = commandActionRunner(commands);
    this.id = ReleasesWidget.ID;
    this.title.label = t("releases.widgetLabel");
    this.title.caption = t("releases.widgetLabel");
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass("simpletab-releases-widget");
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
        this.title.label = t("releases.widgetLabel");
        this.title.caption = t("releases.widgetLabel");
        this.update();
      }),
    );
    this.toDispose.push(this.disposables);
    this.update();
  }

  private readonly loadPublishStatus = () => this.store.getPublishStatus();
  private readonly loadArchiveStatus = () => this.store.getArchiveStatus();

  protected override render(): React.ReactNode {
    const snapshot = this.store.getSnapshot();
    return (
      <>
        <PublishPanel
          open={snapshot.status.open}
          canManage={stateHasPermission(snapshot.state, "releases.manage")}
          onlineSettings={snapshot.status.onlineSettings ?? DEFAULT_ONLINE_SETTINGS}
          loadStatus={this.loadPublishStatus}
          run={this.run}
        />
        <ArchivePanel
          open={snapshot.status.open}
          canManage={stateHasPermission(snapshot.state, "releases.manage")}
          onlineSettings={snapshot.status.onlineSettings ?? DEFAULT_ONLINE_SETTINGS}
          loadStatus={this.loadArchiveStatus}
          run={this.run}
        />
        <ReleasesView state={snapshot.state} status={snapshot.status} run={this.run} />
      </>
    );
  }
}
