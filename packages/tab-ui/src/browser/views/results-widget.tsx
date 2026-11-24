import { CommandService, DisposableCollection } from "@theia/core/lib/common";
import { Message } from "@theia/core/lib/browser";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import { PresenceChips } from "../components/presence-chips";
import { ResultsView } from "../components/results-view";
import { onLocaleChange, t } from "../i18n";
import { TournamentStore } from "../store/tournament-store";
import { SIMPLETAB_OPEN_SETUP_COMMAND_ID } from "./participants-widget";

@injectable()
export class ResultsWidget extends ReactWidget {
  static readonly ID = "simpletab-results-widget";

  private readonly disposables = new DisposableCollection();

  constructor(
    @inject(TournamentStore) private readonly store: TournamentStore,
    @inject(CommandService) private readonly commandService: CommandService,
  ) {
    super();
    this.id = ResultsWidget.ID;
    this.title.label = t("results.widgetLabel");
    this.title.caption = t("results.widgetLabel");
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass("simpletab-results-widget");
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    void this.store.setPresence({ view: "results" });
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
        this.title.label = t("results.widgetLabel");
        this.title.caption = t("results.widgetLabel");
        this.update();
      }),
    );
    this.toDispose.push(this.disposables);
    this.update();
  }

  protected override render(): React.ReactNode {
    const snapshot = this.store.getSnapshot();
    const presence = snapshot.status.presence ?? snapshot.status.device?.presence ?? [];
    const selfId = snapshot.status.device?.deviceId ?? "host";
    return (
      <>
      <PresenceChips entries={presence} view="results" selfId={selfId} />
      <ResultsView
        state={snapshot.state}
        status={snapshot.status}
        selectedRoundId={this.store.getSelectedRoundId() ?? undefined}
        onSelectRound={(roundId) => this.store.setSelectedRoundId(roundId)}
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
