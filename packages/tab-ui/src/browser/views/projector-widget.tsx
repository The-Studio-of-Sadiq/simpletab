import {
  DEFAULT_PROJECTOR_CONTROL,
  ProjectorService,
  type ProjectorControlState,
} from "@simpletab/host/lib/common/projector-protocol";
import { CommandService, DisposableCollection } from "@theia/core/lib/common";
import { Message } from "@theia/core/lib/browser";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import {
  inject,
  injectable,
  optional,
  postConstruct,
} from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import type {
  ActionResult,
  ActionRunner,
  SimpleTabAction,
} from "../actions/action";
import { commandActionRunner } from "../actions/action-runner";
import { ProjectorControlView } from "../components/projector-control-view";
import { onLocaleChange, t } from "../i18n";
import { ProjectorServiceClientDispatcher } from "../store/projector-service-client";
import { TournamentStore } from "../store/tournament-store";

@injectable()
export class ProjectorControlWidget extends ReactWidget {
  static readonly ID = "simpletab-projector-control-widget";

  private readonly disposables = new DisposableCollection();
  private readonly run: ActionRunner;
  private control: ProjectorControlState = {
    ...DEFAULT_PROJECTOR_CONTROL,
    countdown: { ...DEFAULT_PROJECTOR_CONTROL.countdown },
  };

  constructor(
    @inject(TournamentStore) private readonly store: TournamentStore,
    @inject(CommandService) commands: CommandService,
    @inject(ProjectorService)
    @optional()
    private readonly projectorService?: ProjectorService,
    @inject(ProjectorServiceClientDispatcher)
    @optional()
    private readonly projectorClient?: ProjectorServiceClientDispatcher,
  ) {
    super();
    const commandRunner = commandActionRunner(commands);
    this.run = async <A, R extends ActionResult>(
      action: SimpleTabAction<A, R>,
      args: A,
    ): Promise<R> => {
      const result = await commandRunner(action, args);
      if (result.ok && "control" in result) {
        this.control = (result as { control: ProjectorControlState }).control;
        this.update();
      }
      return result;
    };
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

  protected override render(): React.ReactNode {
    const snapshot = this.store.getSnapshot();
    return (
      <ProjectorControlView
        state={snapshot.state}
        available={this.projectorService !== undefined}
        control={this.control}
        run={this.run}
      />
    );
  }
}
