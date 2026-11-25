import type { HostStatus } from "@simpletab/host/lib/common/host-protocol";
import type { FrontendApplicationContribution } from "@theia/core/lib/browser";
import { MessageService } from "@theia/core/lib/common/message-service";
import { inject, injectable } from "@theia/core/shared/inversify";
import { TerminalService } from "@theia/terminal/lib/browser/base/terminal-service";
import { t } from "./i18n";
import { TournamentStore } from "./store/tournament-store";

/**
 * Design section 6, "AI actor": the UI warns whenever the integrated terminal is opened on the host
 * itself. A program run in that terminal (an AI agent, a script) works directly on this laptop's
 * tournament files and certificate, so it bypasses proposals, roles and the changelog that a
 * paired device or the `simpletab` CLI on a staff laptop goes through.
 *
 * Every laptop that is not a staff device of another host counts as the host, even before a
 * tournament is opened: it keeps tournament files and can open one at any time.
 */
export function isHostLaptop(status: HostStatus): boolean {
  return status.device === undefined;
}

@injectable()
export class TerminalHostWarningContribution implements FrontendApplicationContribution {
  @inject(TerminalService)
  protected readonly terminalService!: TerminalService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  @inject(TournamentStore)
  protected readonly store!: TournamentStore;

  onStart(): void {
    this.terminalService.onDidCreateTerminal(() => {
      if (!isHostLaptop(this.store.getStatus())) return;
      // A notification, not a modal: the warning must not block someone who knows what they are doing.
      void this.messageService.warn(t("terminal.hostWarning"));
    });
  }
}
