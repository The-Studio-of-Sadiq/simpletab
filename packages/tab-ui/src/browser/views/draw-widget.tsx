import { CommandService, DisposableCollection } from "@theia/core/lib/common";
import { Message } from "@theia/core/lib/browser";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import { DrawView } from "../components/draw-view";
import { onLocaleChange, t } from "../i18n";
import { TournamentStore } from "../store/tournament-store";
import { SIMPLETAB_OPEN_SETUP_COMMAND_ID } from "./participants-widget";

@injectable()
export class DrawWidget extends ReactWidget {
  static readonly ID = "simpletab-draw-widget";

  private readonly disposables = new DisposableCollection();

  constructor(
    @inject(TournamentStore) private readonly store: TournamentStore,
    @inject(CommandService) private readonly commandService: CommandService,
  ) {
    super();
    this.id = DrawWidget.ID;
    this.title.label = t("draw.widgetLabel");
    this.title.caption = t("draw.widgetLabel");
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass("simpletab-draw-widget");
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
        this.title.label = t("draw.widgetLabel");
        this.title.caption = t("draw.widgetLabel");
        this.update();
      }),
    );
    this.toDispose.push(this.disposables);
    this.update();
  }

  protected override render(): React.ReactNode {
    const snapshot = this.store.getSnapshot();
    const selectedRoundId = this.store.getSelectedRoundId() ?? undefined;
    const lastGenerateSeq =
      selectedRoundId !== undefined
        ? this.store.getLastRoundOpSeq("draw.generate", selectedRoundId)
        : undefined;
    return (
      <DrawView
        state={snapshot.state}
        status={snapshot.status}
        selectedRoundId={selectedRoundId}
        onSelectRound={(roundId) => this.store.setSelectedRoundId(roundId)}
        onSubmitOp={(request) => this.store.submit(request)}
        onUndoOp={(seq) => this.store.undo(seq)}
        onCancelLock={(lockId) => this.store.cancelLong(lockId)}
        onGetChangelog={() => this.store.getChangelog()}
        lastGenerateSeq={lastGenerateSeq}
        onOpenSetup={() => {
          void this.commandService.executeCommand(SIMPLETAB_OPEN_SETUP_COMMAND_ID);
        }}
      />
    );
  }
}
