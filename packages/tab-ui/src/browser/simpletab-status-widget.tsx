import type {
  CreateDemoResult,
  HostStatus,
} from "@simpletab/host/lib/common/host-protocol";
import {
  CommandService,
  DisposableCollection,
  Emitter,
  type Event,
} from "@theia/core/lib/common";
import { Message } from "@theia/core/lib/browser";
import { MessageService } from "@theia/core/lib/common/message-service";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import type {
  ActionResult,
  ActionRunner,
  SimpleTabAction,
} from "./actions/action";
import { commandActionRunner } from "./actions/action-runner";
import { createDemoTournamentAction } from "./actions/status-actions";
import { DeviceBanner } from "./components/device-banner";
import { ReplacedBanner } from "./components/promote-panel";
import { StatusView } from "./components/status-view";
import { onLocaleChange, t } from "./i18n";
import {
  TournamentStore,
  type TournamentStoreSnapshot,
} from "./store/tournament-store";
import "./style/simpletab-status.css";

@injectable()
export class SimpleTabStatusWidget extends ReactWidget {
  static readonly ID = "simpletab-status-widget";

  private readonly disposables = new DisposableCollection();
  private readonly onDidUpdateStatusEmitter = new Emitter<HostStatus>();
  private readonly run: ActionRunner;

  readonly onDidUpdateStatus: Event<HostStatus> =
    this.onDidUpdateStatusEmitter.event;

  constructor(
    @inject(TournamentStore) private readonly store: TournamentStore,
    @inject(CommandService) commands: CommandService,
    @inject(MessageService) private readonly messages: MessageService,
  ) {
    super();
    const commandRunner = commandActionRunner(commands);
    this.run = async <A, R extends ActionResult>(
      action: SimpleTabAction<A, R>,
      args: A,
    ): Promise<R> => {
      const result = await commandRunner(action, args);
      if (action.id === createDemoTournamentAction.id) {
        if (result.ok && "result" in result) {
          const created = (result as { result: CreateDemoResult }).result;
          void this.messages.info(
            t("command.demoCreated", {
              slug: created.status.slug ?? "bp-demo",
              dbPath: created.dbPath,
            }),
          );
        } else if (!result.ok) {
          void this.messages.error(
            t("command.demoFailed", {
              message: (result as { errors: string[] }).errors.join(" "),
            }),
          );
        }
      }
      return result;
    };
    this.id = SimpleTabStatusWidget.ID;
    this.title.label = t("status.widgetLabel");
    this.title.caption = t("status.widgetLabel");
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass("simpletab-status-widget");
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    this.node.focus();
  }

  @postConstruct()
  protected init(): void {
    this.toDispose.push(this.onDidUpdateStatusEmitter);
    const unsub = this.store.subscribe((snapshot: TournamentStoreSnapshot) => {
      this.onDidUpdateStatusEmitter.fire(snapshot.status);
      this.update();
    });
    this.disposables.push({ dispose: unsub });
    this.disposables.push(
      onLocaleChange(() => {
        this.title.label = t("status.widgetLabel");
        this.title.caption = t("status.widgetLabel");
        this.update();
      }),
    );
    this.toDispose.push(this.disposables);
    this.update();
  }

  applyStatus(_status: HostStatus): void {
    void this.store.refresh();
  }

  async refresh(): Promise<HostStatus | null> {
    const snapshot = await this.store.refresh();
    return snapshot.error === null ? snapshot.status : null;
  }

  protected override render(): React.ReactNode {
    const snapshot = this.store.getSnapshot();
    const device = snapshot.status.device;
    return (
      <>
        {snapshot.status.replacedBy !== undefined ? <ReplacedBanner info={snapshot.status.replacedBy} /> : null}
        {device !== undefined ? (
          <DeviceBanner device={device} run={this.run} />
        ) : null}
      <StatusView
        status={snapshot.status}
        state={snapshot.state}
        loading={snapshot.loading}
        error={snapshot.error}
        onRefresh={() => this.refresh()}
        run={this.run}
        canPullNow={true}
      />
      </>
    );
  }
}
