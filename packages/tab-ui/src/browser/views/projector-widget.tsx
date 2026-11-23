import {
  DEFAULT_PROJECTOR_CONTROL,
  ProjectorService,
  type ProjectorControlState,
} from "@simpletab/host/lib/common/projector-protocol";
import { DisposableCollection } from "@theia/core/lib/common";
import { Message } from "@theia/core/lib/browser";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import {
  inject,
  injectable,
  optional,
  postConstruct,
} from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import { ProjectorControlView } from "../components/projector-control-view";
import { onLocaleChange, t } from "../i18n";
import { ProjectorServiceClientDispatcher } from "../store/projector-service-client";
import { TournamentStore } from "../store/tournament-store";

@injectable()
export class ProjectorControlWidget extends ReactWidget {
  static readonly ID = "simpletab-projector-control-widget";

  private readonly disposables = new DisposableCollection();
  private control: ProjectorControlState = {
    ...DEFAULT_PROJECTOR_CONTROL,
    countdown: { ...DEFAULT_PROJECTOR_CONTROL.countdown },
  };

  constructor(
    @inject(TournamentStore) private readonly store: TournamentStore,
    @inject(ProjectorService)
    @optional()
    private readonly projectorService?: ProjectorService,
    @inject(ProjectorServiceClientDispatcher)
    @optional()
    private readonly projectorClient?: ProjectorServiceClientDispatcher,
  ) {
    super();
    this.id = ProjectorControlWidget.ID;
    this.title.label = t("projector.widgetLabel");
    this.title.caption = t("projector.widgetLabel");
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass("simpletab-projector-control-widget");
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    this.node.focus();
    void this.syncFromProjector();
  }

  @postConstruct()
  protected init(): void {
    const unsub = this.store.subscribe(() => {
      this.update();
    });
    this.disposables.push({ dispose: unsub });
    this.disposables.push(
      onLocaleChange(() => {
        this.title.label = t("projector.widgetLabel");
        this.title.caption = t("projector.widgetLabel");
        this.update();
      }),
    );
    if (this.projectorClient !== undefined) {
      this.disposables.push(
        this.projectorClient.onDidUpdate((payload) => {
          this.control = payload.control;
          this.update();
        }),
      );
    }
    this.toDispose.push(this.disposables);

    if (this.projectorService !== undefined) {
      void this.syncFromProjector();
    }
    this.update();
  }

  private async syncFromProjector(): Promise<void> {
    if (this.projectorService === undefined) {
      return;
    }
    const payload = await this.projectorService.getSyncPayload();
    this.control = payload.control;
    this.update();
  }

  private async syncDisplayAndOpen(): Promise<ProjectorControlState | void> {
    if (this.projectorService === undefined) {
      return undefined;
    }
    const displayState = await this.store.getDisplayState();
    await this.projectorService.pushDisplayState(displayState);
    const next = await this.projectorService.openProjector();
    this.control = next;
    this.update();
    return next;
  }

  protected override render(): React.ReactNode {
    const snapshot = this.store.getSnapshot();
    const svc = this.projectorService;
    return (
      <ProjectorControlView
        state={snapshot.state}
        available={svc !== undefined}
        control={this.control}
        onOpenProjector={() => this.syncDisplayAndOpen()}
        onCloseProjector={async () => {
          if (svc === undefined) return;
          this.control = await svc.closeProjector();
          this.update();
          return this.control;
        }}
        onToggleFullscreen={async () => {
          if (svc === undefined) return;
          this.control = await svc.toggleFullscreen();
          this.update();
          return this.control;
        }}
        onUpdateControl={async (patch) => {
          if (svc === undefined) return;
          this.control = await svc.updateControl(patch);
          this.update();
          return this.control;
        }}
        onStartCountdown={async (durationSeconds) => {
          if (svc === undefined) return;
          this.control = await svc.startCountdown(durationSeconds);
          this.update();
          return this.control;
        }}
        onPauseCountdown={async () => {
          if (svc === undefined) return;
          this.control = await svc.pauseCountdown();
          this.update();
          return this.control;
        }}
        onResetCountdown={async (durationSeconds) => {
          if (svc === undefined) return;
          this.control = await svc.resetCountdown(durationSeconds);
          this.update();
          return this.control;
        }}
      />
    );
  }
}
