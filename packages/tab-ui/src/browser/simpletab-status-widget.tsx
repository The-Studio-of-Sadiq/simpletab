import type { HostStatus } from "@simpletab/host/lib/common/host-protocol";
import { HostService } from "@simpletab/host/lib/common/host-protocol";
import { CommandService, Emitter, type Event } from "@theia/core/lib/common";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import "./style/simpletab-status.css";

export const SIMPLETAB_CREATE_DEMO_COMMAND_ID = "simpletab.createDemoTournament";

@injectable()
export class SimpleTabStatusWidget extends ReactWidget {
  static readonly ID = "simpletab-status-widget";
  static readonly LABEL = "SimpleTab Status";

  private hostStatus: HostStatus | null = null;
  private loading = true;
  private errorMessage: string | null = null;
  private readonly onDidUpdateStatusEmitter = new Emitter<HostStatus>();

  readonly onDidUpdateStatus: Event<HostStatus> = this.onDidUpdateStatusEmitter.event;

  constructor(
    @inject(HostService) private readonly hostService: HostService,
    @inject(CommandService) private readonly commandService: CommandService,
  ) {
    super();
    this.id = SimpleTabStatusWidget.ID;
    this.title.label = SimpleTabStatusWidget.LABEL;
    this.title.caption = SimpleTabStatusWidget.LABEL;
    this.title.closable = true;
    this.addClass("simpletab-status-widget");
  }

  @postConstruct()
  protected init(): void {
    this.toDispose.push(this.onDidUpdateStatusEmitter);
    this.update();
    void this.refresh();
  }

  applyStatus(status: HostStatus): void {
    this.hostStatus = status;
    this.loading = false;
    this.errorMessage = null;
    this.onDidUpdateStatusEmitter.fire(status);
    this.update();
  }

  async refresh(): Promise<HostStatus | null> {
    this.loading = true;
    this.errorMessage = null;
    this.update();
    try {
      const nextStatus = await this.hostService.status();
      this.applyStatus(nextStatus);
      return nextStatus;
    } catch (error) {
      this.loading = false;
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.update();
      return null;
    }
  }

  protected override render(): React.ReactNode {
    const status = this.hostStatus;
    const tournamentLabel = this.loading
      ? "Loading host status"
      : status?.open
        ? "Tournament open"
        : "No tournament open";

    const integrityLabel =
      status === null || !status.open
        ? "Not applicable"
        : status.integrityOk
          ? "Verified (OK)"
          : "Blocked (Integrity failed)";

    const syncLabel =
      status === null || !status.open
        ? "Not applicable"
        : status.canSync
          ? "Eligible to sync"
          : "Sync blocked";

    return (
      <div>
        <div className="simpletab-status-header">
          <h2 className="simpletab-status-title">SimpleTab Status</h2>
          <div className="simpletab-status-actions">
            <button
              type="button"
              className="theia-button secondary"
              onClick={() => {
                void this.refresh();
              }}
            >
              Refresh status
            </button>
            <button
              type="button"
              className="theia-button"
              onClick={() => {
                void this.commandService.executeCommand(SIMPLETAB_CREATE_DEMO_COMMAND_ID);
              }}
            >
              Create demo tournament
            </button>
          </div>
        </div>

        <div className="simpletab-status-grid">
          <div className="simpletab-status-label">Tournament state</div>
          <div className="simpletab-status-value">{tournamentLabel}</div>

          <div className="simpletab-status-label">Slug</div>
          <div className="simpletab-status-value">
            {status?.open && status.slug ? status.slug : "None"}
          </div>

          <div className="simpletab-status-label">Head sequence</div>
          <div className="simpletab-status-value">
            {status?.open && status.headSeq !== undefined ? String(status.headSeq) : "None"}
          </div>

          <div className="simpletab-status-label">Integrity check</div>
          <div className="simpletab-status-value">{integrityLabel}</div>

          <div className="simpletab-status-label">Online sync</div>
          <div className="simpletab-status-value">{syncLabel}</div>

          <div className="simpletab-status-label">Active locks</div>
          <div className="simpletab-status-value">
            {status && status.locks.length > 0 ? (
              <ul className="simpletab-status-locks">
                {status.locks.map((lock, index) => (
                  <li key={`${lock.opType}-${lock.actorRef}-${index}`}>
                    {lock.opType} (actor: {lock.actorRef})
                  </li>
                ))}
              </ul>
            ) : (
              "No active locks"
            )}
          </div>
        </div>

        {this.errorMessage !== null ? (
          <div className="simpletab-status-error">Host error: {this.errorMessage}</div>
        ) : null}
      </div>
    );
  }
}
