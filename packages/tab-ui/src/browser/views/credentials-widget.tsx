import {
  CredentialsService,
  type CredentialName,
  type CredentialStatusEntry,
  type CredentialTestResult,
} from "@simpletab/host/lib/common/credentials-protocol";
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
import { CredentialsView } from "../components/credentials-view";
import { onLocaleChange, t } from "../i18n";
import { TournamentStore } from "../store/tournament-store";

@injectable()
export class CredentialsWidget extends ReactWidget {
  static readonly ID = "simpletab-credentials-widget";

  private readonly disposables = new DisposableCollection();
  private credentialsStatus: CredentialStatusEntry[] = [];

  constructor(
    @inject(TournamentStore) private readonly store: TournamentStore,
    @inject(CredentialsService)
    @optional()
    private readonly credentialsService?: CredentialsService,
  ) {
    super();
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

  private async refreshCredentials(): Promise<CredentialStatusEntry[]> {
    if (this.credentialsService === undefined) {
      return [];
    }
    const entries = await this.credentialsService.status();
    this.credentialsStatus = entries;
    this.update();
    return entries;
  }

  private async handleSetCredential(
    name: CredentialName,
    value: string,
  ): Promise<void> {
    if (this.credentialsService === undefined) {
      throw new Error(t("credentials.unavailable"));
    }
    await this.credentialsService.set(name, value);
    await this.refreshCredentials();
  }

  private async handleClearCredential(name: CredentialName): Promise<void> {
    if (this.credentialsService === undefined) {
      throw new Error(t("credentials.unavailable"));
    }
    await this.credentialsService.clear(name);
    await this.refreshCredentials();
  }

  private async handleTestCredential(
    name: CredentialName,
  ): Promise<CredentialTestResult> {
    if (this.credentialsService === undefined) {
      return { ok: false, error: t("credentials.unavailable") };
    }
    const result = await this.credentialsService.test(name);
    await this.refreshCredentials();
    return result;
  }

  protected override render(): React.ReactNode {
    const snapshot = this.store.getSnapshot();
    return (
      <CredentialsView
        state={snapshot.state}
        status={snapshot.status}
        available={this.credentialsService !== undefined}
        credentialsStatus={this.credentialsStatus}
        onRefreshCredentials={() => this.refreshCredentials()}
        onSetCredential={(name, value) => this.handleSetCredential(name, value)}
        onClearCredential={(name) => this.handleClearCredential(name)}
        onTestCredential={(name) => this.handleTestCredential(name)}
        onUpdateOnlineSettings={(patch) =>
          this.store.updateOnlineSettings(patch)
        }
      />
    );
  }
}
