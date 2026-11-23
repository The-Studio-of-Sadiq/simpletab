import { CommandService, DisposableCollection } from "@theia/core/lib/common";
import { Message } from "@theia/core/lib/browser";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import { CheckinView } from "../components/checkin-view";
import { onLocaleChange, t } from "../i18n";
import { TournamentStore } from "../store/tournament-store";
import { SIMPLETAB_OPEN_SETUP_COMMAND_ID } from "./participants-widget";

@injectable()
export class CheckinWidget extends ReactWidget {
  static readonly ID = "simpletab-checkin-widget";

  private readonly disposables = new DisposableCollection();

  constructor(
    @inject(TournamentStore) private readonly store: TournamentStore,
    @inject(CommandService) private readonly commandService: CommandService,
  ) {
    super();
    this.id = CheckinWidget.ID;
    this.title.label = t("checkin.widgetLabel");
    this.title.caption = t("checkin.widgetLabel");
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass("simpletab-checkin-widget");
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
        this.title.label = t("checkin.widgetLabel");
        this.title.caption = t("checkin.widgetLabel");
        this.update();
      }),
    );
    this.toDispose.push(this.disposables);
    this.update();
  }

  protected override render(): React.ReactNode {
    const snapshot = this.store.getSnapshot();
    return (
      <CheckinView
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
    );
  }
}
