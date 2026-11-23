import { CommandService, DisposableCollection } from "@theia/core/lib/common";
import { Message } from "@theia/core/lib/browser";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import { ParticipantsView } from "../components/participants-view";
import { onLocaleChange, t } from "../i18n";
import { TournamentStore } from "../store/tournament-store";

export const SIMPLETAB_OPEN_SETUP_COMMAND_ID = "simpletab.setup.open";

@injectable()
export class ParticipantsWidget extends ReactWidget {
  static readonly ID = "simpletab-participants-widget";

  private readonly disposables = new DisposableCollection();

  constructor(
    @inject(TournamentStore) private readonly store: TournamentStore,
    @inject(CommandService) private readonly commandService: CommandService,
  ) {
    super();
    this.id = ParticipantsWidget.ID;
    this.title.label = t("participants.widgetLabel");
    this.title.caption = t("participants.widgetLabel");
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass("simpletab-participants-widget");
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
        this.title.label = t("participants.widgetLabel");
        this.title.caption = t("participants.widgetLabel");
        this.update();
      }),
    );
    this.toDispose.push(this.disposables);
    this.update();
  }

  protected override render(): React.ReactNode {
    const snapshot = this.store.getSnapshot();
    return (
      <ParticipantsView
        state={snapshot.state}
        onSubmitOp={(request) => this.store.submit(request)}
        onOpenSetup={() => {
          void this.commandService.executeCommand(SIMPLETAB_OPEN_SETUP_COMMAND_ID);
        }}
      />
    );
  }
}
