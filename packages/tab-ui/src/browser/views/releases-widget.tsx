import { CommandService, DisposableCollection } from "@theia/core/lib/common";
import { Message } from "@theia/core/lib/browser";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import { ArchivePanel } from "../components/archive-panel";
import { PublishPanel } from "../components/publish-panel";
import { ReleasesView } from "../components/releases-view";
import { stateHasPermission } from "../lib/permissions";
import { onLocaleChange, t } from "../i18n";
import { DEFAULT_ONLINE_SETTINGS } from "@simpletab/host/lib/common/host-protocol";
import { TournamentStore } from "../store/tournament-store";
import { SIMPLETAB_OPEN_SETUP_COMMAND_ID } from "./participants-widget";

@injectable()
export class ReleasesWidget extends ReactWidget {
  static readonly ID = "simpletab-releases-widget";

  private readonly disposables = new DisposableCollection();

  constructor(
    @inject(TournamentStore) private readonly store: TournamentStore,
    @inject(CommandService) private readonly commandService: CommandService,
  ) {
    super();
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
  private readonly publishNow = () => this.store.publishNow();
  private readonly setLive = async (on: boolean): Promise<void> => {
    await this.store.updateOnlineSettings({ livePublicSite: on });
  };
  private readonly loadArchiveStatus = () => this.store.getArchiveStatus();
  private readonly archiveNow = () => this.store.archiveNow();
  private readonly setMirror = async (on: boolean): Promise<void> => {
    await this.store.updateOnlineSettings({ githubArchiveMirror: on });
  };

  protected override render(): React.ReactNode {
    const snapshot = this.store.getSnapshot();
    return (
      <>
        <PublishPanel
          open={snapshot.status.open}
          canManage={stateHasPermission(snapshot.state, "releases.manage")}
          onlineSettings={snapshot.status.onlineSettings ?? DEFAULT_ONLINE_SETTINGS}
          loadStatus={this.loadPublishStatus}
          onPublishNow={this.publishNow}
          onSetLive={this.setLive}
        />
        <ArchivePanel
          open={snapshot.status.open}
          canManage={stateHasPermission(snapshot.state, "releases.manage")}
          onlineSettings={snapshot.status.onlineSettings ?? DEFAULT_ONLINE_SETTINGS}
          loadStatus={this.loadArchiveStatus}
          onArchiveNow={this.archiveNow}
          onSetMirror={this.setMirror}
        />
        <ReleasesView
        state={snapshot.state}
        status={snapshot.status}
        onSubmitOp={(request) => this.store.submit(request)}
        onCancelLock={(lockId) => this.store.cancelLong(lockId)}
        onOpenSetup={() => {
          void this.commandService.executeCommand(SIMPLETAB_OPEN_SETUP_COMMAND_ID);
        }}
        />
      </>
    );
  }
}
