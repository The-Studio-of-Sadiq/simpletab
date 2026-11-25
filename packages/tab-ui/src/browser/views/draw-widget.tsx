import { CommandService, DisposableCollection } from "@theia/core/lib/common";
import { Message } from "@theia/core/lib/browser";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import type { ActionRunner } from "../actions/action";
import { commandActionRunner } from "../actions/action-runner";
import { PresenceChips } from "../components/presence-chips";
import { DrawView } from "../components/draw-view";
import { onLocaleChange, t } from "../i18n";
import { TournamentStore } from "../store/tournament-store";

@injectable()
export class DrawWidget extends ReactWidget {
  static readonly ID = "simpletab-draw-widget";

  private readonly disposables = new DisposableCollection();

  private readonly run: ActionRunner;

  constructor(
    @inject(TournamentStore) private readonly store: TournamentStore,
    @inject(CommandService) commands: CommandService,
  ) {
    super();
    this.run = commandActionRunner(commands);
    this.id = DrawWidget.ID;
    this.title.label = t("draw.widgetLabel");
    this.title.caption = t("draw.widgetLabel");
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass("simpletab-draw-widget");
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    void this.store.setPresence({ view: "draw" });
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
    const presence = snapshot.status.presence ?? snapshot.status.device?.presence ?? [];
    const selfId = snapshot.status.device?.deviceId ?? "host";
    return (
      <>
      <PresenceChips entries={presence} view="draw" selfId={selfId} />
      <DrawView
        state={snapshot.state}
        status={snapshot.status}
        selectedRoundId={selectedRoundId}
        onSelectRound={(roundId) => this.store.setSelectedRoundId(roundId)}
        run={this.run}
        onGetChangelog={() => this.store.getChangelog()}
        lastGenerateSeq={lastGenerateSeq}
      />
      </>
    );
  }
}
