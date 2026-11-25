import { CredentialsService, type CredentialStatusEntry } from "@simpletab/host/lib/common/credentials-protocol";
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
import type { ActionResult, ActionRunner, SimpleTabAction } from "../actions/action";
import { commandActionRunner } from "../actions/action-runner";
import { CredentialsView } from "../components/credentials-view";
import { onLocaleChange, t } from "../i18n";
import { TournamentStore } from "../store/tournament-store";

@injectable()
export class CredentialsWidget extends ReactWidget {
  static readonly ID = "simpletab-credentials-widget";

  private readonly disposables = new DisposableCollection();
  private credentialsStatus: CredentialStatusEntry[] = [];
  private readonly run: ActionRunner;

  constructor(
    @inject(TournamentStore) private readonly store: TournamentStore,
    @inject(CommandService) commands: CommandService,
    @inject(CredentialsService)
    @optional()
    private readonly credentialsService?: CredentialsService,
  ) {
    super();
    const commandRunner = commandActionRunner(commands);
    this.run = async <A, R extends ActionResult>(
      action: SimpleTabAction<A, R>,
      args: A,
    ): Promise<R> => {
      const result = await commandRunner(action, args);
      await this.refreshCredentials();
      return result;
    };
    this.id = CredentialsWidget.ID;
    this.title.label = t("credentials.widgetLabel");
    this.title.caption = t("credentials.widgetLabel");
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass("simpletab-credentials-widget");
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    this.node.focus();
    void this.refreshCredentials();
  }

  @postConstruct()
  protected init(): void {
    const unsub = this.store.subscribe(() => {
      this.update();
    });
    this.disposables.push({ dispose: unsub });
    this.disposables.push(
      onLocaleChange(() => {
        this.title.label = t("credentials.widgetLabel");
        this.title.caption = t("credentials.widgetLabel");
        this.update();
      }),
    );
    this.toDispose.push(this.disposables);
    void this.refreshCredentials();
    this.update();
  }

  private async refreshCredentials(): Promise<void> {
    if (this.credentialsService === undefined) {
      return;
    }
    this.credentialsStatus = await this.credentialsService.status();
    this.update();
  }

  protected override render(): React.ReactNode {
    const snapshot = this.store.getSnapshot();
    return (
      <CredentialsView
        state={snapshot.state}
        status={snapshot.status}
        available={this.credentialsService !== undefined}
        credentialsStatus={this.credentialsStatus}
        run={this.run}
      />
    );
  }
}
