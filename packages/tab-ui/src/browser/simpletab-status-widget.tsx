import type { HostStatus } from "@simpletab/host/lib/common/host-protocol";
import {
  CommandService,
  DisposableCollection,
  Emitter,
  type Event,
} from "@theia/core/lib/common";
import { Message } from "@theia/core/lib/browser";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import { onLocaleChange, t } from "./i18n";
import {
  TournamentStore,
  type TournamentStoreSnapshot,
} from "./store/tournament-store";
import "./style/simpletab-status.css";

export const SIMPLETAB_CREATE_DEMO_COMMAND_ID = "simpletab.createDemoTournament";

@injectable()
export class SimpleTabStatusWidget extends ReactWidget {
  static readonly ID = "simpletab-status-widget";

  private readonly disposables = new DisposableCollection();
  private readonly onDidUpdateStatusEmitter = new Emitter<HostStatus>();

  readonly onDidUpdateStatus: Event<HostStatus> =
    this.onDidUpdateStatusEmitter.event;

  constructor(
    @inject(TournamentStore) private readonly store: TournamentStore,
    @inject(CommandService) private readonly commandService: CommandService,
  ) {
    super();
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
    const status = snapshot.status;
    const tournamentLabel = snapshot.loading
      ? t("status.loading")
      : status.open
        ? t("status.open")
        : t("status.closed");

    const integrityLabel = !status.open
      ? t("status.integrityNa")
      : status.integrityOk
        ? t("status.integrityOk")
        : t("status.integrityFailed");

    const syncLabel = !status.open
      ? t("status.syncNa")
      : status.canSync
        ? t("status.syncOk")
        : t("status.syncBlocked");

    return (
      <div>
        <div className="simpletab-status-header">
          <h2 className="simpletab-status-title">{t("status.title")}</h2>
          <div className="simpletab-status-actions">
            <button
              type="button"
              className="theia-button secondary"
              onClick={() => {
                void this.refresh();
              }}
            >
              {t("status.refresh")}
            </button>
            <button
              type="button"
              className="theia-button"
              onClick={() => {
                void this.commandService.executeCommand(
                  SIMPLETAB_CREATE_DEMO_COMMAND_ID,
                );
              }}
            >
              {t("status.createDemo")}
            </button>
          </div>
        </div>

        <div className="simpletab-status-grid">
          <div className="simpletab-status-label">
            {t("status.tournamentState")}
          </div>
          <div className="simpletab-status-value">{tournamentLabel}</div>

          <div className="simpletab-status-label">{t("status.slug")}</div>
          <div className="simpletab-status-value">
            {status.open && status.slug ? status.slug : t("common.none")}
          </div>

          <div className="simpletab-status-label">{t("status.headSeq")}</div>
          <div className="simpletab-status-value">
            {status.open && status.headSeq !== undefined
              ? String(status.headSeq)
              : t("common.none")}
          </div>

          <div className="simpletab-status-label">{t("status.integrity")}</div>
          <div className="simpletab-status-value">{integrityLabel}</div>

          <div className="simpletab-status-label">{t("status.onlineSync")}</div>
          <div className="simpletab-status-value">{syncLabel}</div>

          <div className="simpletab-status-label">
            {t("status.activeLocks")}
          </div>
          <div className="simpletab-status-value">
            {status.locks.length > 0 ? (
              <ul className="simpletab-status-locks">
                {status.locks.map((lock) => (
                  <li key={lock.lockId}>
                    {t("status.lockItem", {
                      opType: lock.opType,
                      actorRef: lock.actorRef,
                    })}
                  </li>
                ))}
              </ul>
            ) : (
              t("status.noLocks")
            )}
          </div>
        </div>

        {snapshot.error !== null ? (
          <div className="simpletab-status-error" role="alert">
            {t("status.hostError", { message: snapshot.error })}
          </div>
        ) : null}
      </div>
    );
  }
}
