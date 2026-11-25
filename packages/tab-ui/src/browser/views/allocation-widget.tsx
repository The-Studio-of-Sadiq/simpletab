import { CommandService, DisposableCollection } from "@theia/core/lib/common";
import { Message } from "@theia/core/lib/browser";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import type { ActionRunner } from "../actions/action";
import { commandActionRunner } from "../actions/action-runner";
import { PresenceChips } from "../components/presence-chips";
import { AllocationView } from "../components/allocation-view";
import { onLocaleChange, t } from "../i18n";
import { TournamentStore } from "../store/tournament-store";

@injectable()
export class AllocationWidget extends ReactWidget {
  static readonly ID = "simpletab-allocation-widget";

  private readonly disposables = new DisposableCollection();

  private readonly run: ActionRunner;

  constructor(
    @inject(TournamentStore) private readonly store: TournamentStore,
    @inject(CommandService) commands: CommandService,
  ) {
    super();
    this.run = commandActionRunner(commands);
    this.id = AllocationWidget.ID;
    this.title.label = t("allocation.widgetLabel");
    this.title.caption = t("allocation.widgetLabel");
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass("simpletab-allocation-widget");
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    void this.store.setPresence({ view: "allocation" });
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
        this.title.label = t("allocation.widgetLabel");
        this.title.caption = t("allocation.widgetLabel");
        this.update();
      }),
    );
    this.toDispose.push(this.disposables);
    this.update();
  }

  protected override render(): React.ReactNode {
    const snapshot = this.store.getSnapshot();
    const selectedRoundId = this.store.getSelectedRoundId() ?? undefined;
    const lastAutoSeq =
      selectedRoundId !== undefined
        ? this.store.getLastRoundOpSeq("allocation.auto", selectedRoundId)
        : undefined;
    const presence = snapshot.status.presence ?? snapshot.status.device?.presence ?? [];
    const selfId = snapshot.status.device?.deviceId ?? "host";
    return (
      <>
      <PresenceChips entries={presence} view="allocation" selfId={selfId} />
      <AllocationView
        state={snapshot.state}
        status={snapshot.status}
        selectedRoundId={selectedRoundId}
        onSelectRound={(roundId) => this.store.setSelectedRoundId(roundId)}
        run={this.run}
        onGetChangelog={() => this.store.getChangelog()}
        lastAutoSeq={lastAutoSeq}
      />
      </>
    );
  }
}
