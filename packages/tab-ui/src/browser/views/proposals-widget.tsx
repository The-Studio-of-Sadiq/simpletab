import { DisposableCollection } from "@theia/core/lib/common";
import { Message } from "@theia/core/lib/browser";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import type { OpRequest } from "@simpletab/core/ops";
import {
  ProposalsView,
  type ProposalDecision,
} from "../components/proposals-view";
import { onLocaleChange, t } from "../i18n";
import { TournamentStore } from "../store/tournament-store";

@injectable()
export class ProposalsWidget extends ReactWidget {
  static readonly ID = "simpletab.proposals";

  private readonly disposables = new DisposableCollection();

  constructor(@inject(TournamentStore) private readonly store: TournamentStore) {
    super();
    this.id = ProposalsWidget.ID;
    this.title.label = t("proposals.widgetLabel");
    this.title.caption = t("proposals.widgetLabel");
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass("simpletab-proposals-widget");
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
        this.title.label = t("proposals.widgetLabel");
        this.title.caption = t("proposals.widgetLabel");
        this.update();
      }),
    );
    this.toDispose.push(this.disposables);
    this.update();
  }

  private readonly decide = (decision: ProposalDecision) => {
    const request: OpRequest =
      decision.kind === "accept"
        ? {
            type: "proposal.accept",
            payload: { proposalId: decision.proposalId },
          }
        : {
            type: "proposal.reject",
            payload:
              decision.reason !== undefined
                ? { proposalId: decision.proposalId, reason: decision.reason }
                : { proposalId: decision.proposalId },
          };
    return this.store.submit(request);
  };

  protected override render(): React.ReactNode {
    const { state } = this.store.getSnapshot();
    return <ProposalsView state={state} onDecide={this.decide} />;
  }
}
