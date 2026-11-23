import { CommandService, DisposableCollection } from "@theia/core/lib/common";
import { Message } from "@theia/core/lib/browser";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import {
  getLocale,
  onLocaleChange,
  setLocale,
  t,
  type SupportedLocale,
} from "../i18n";
import { stateHasPermission } from "../lib/permissions";
import { TournamentStore } from "../store/tournament-store";

export const SIMPLETAB_OPEN_SETUP_COMMAND = "simpletab.setup.open";
export const SIMPLETAB_OPEN_PARTICIPANTS_COMMAND = "simpletab.participants.open";
export const SIMPLETAB_OPEN_CHECKIN_COMMAND = "simpletab.checkin.open";
export const SIMPLETAB_OPEN_DRAW_COMMAND = "simpletab.draw.open";
export const SIMPLETAB_OPEN_ALLOCATION_COMMAND = "simpletab.allocation.open";
export const SIMPLETAB_OPEN_MOTIONS_COMMAND = "simpletab.motions.open";
export const SIMPLETAB_OPEN_RESULTS_COMMAND = "simpletab.results.open";
export const SIMPLETAB_OPEN_FEEDBACK_COMMAND = "simpletab.feedback.open";
export const SIMPLETAB_OPEN_STATUS_COMMAND = "simpletab.status.open";

@injectable()
export class SimpleTabNavWidget extends ReactWidget {
  static readonly ID = "simpletab-nav-widget";

  private readonly disposables = new DisposableCollection();

  constructor(
    @inject(TournamentStore) private readonly store: TournamentStore,
    @inject(CommandService) private readonly commandService: CommandService,
  ) {
    super();
    this.id = SimpleTabNavWidget.ID;
    this.title.label = t("nav.viewLabel");
    this.title.caption = t("nav.viewLabel");
    this.title.closable = false;
    this.node.tabIndex = -1;
    this.addClass("simpletab-nav-widget");
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
        this.title.label = t("nav.viewLabel");
        this.title.caption = t("nav.viewLabel");
        this.update();
      }),
    );
    this.toDispose.push(this.disposables);
    this.update();
  }

  protected override render(): React.ReactNode {
    const { status, state } = this.store.getSnapshot();
    const canViewFeedback =
      state === null || stateHasPermission(state, "feedback.view");
    const locale = getLocale();
    const summaryText =
      status.open && status.slug
        ? t("nav.tournamentSummary", {
            slug: status.slug,
            seq: status.headSeq ?? 0,
          })
        : t("nav.noTournament");

    return (
      <div className="simpletab-sidebar">
        <div role="status">{summaryText}</div>

        <nav className="simpletab-nav-list" aria-label={t("nav.containerTitle")}>
          <button
            type="button"
            className="theia-button secondary simpletab-nav-btn"
            onClick={() => {
              void this.commandService.executeCommand(SIMPLETAB_OPEN_SETUP_COMMAND);
            }}
          >
            {t("nav.openSetup")}
          </button>
          <button
            type="button"
            className="theia-button secondary simpletab-nav-btn"
            onClick={() => {
              void this.commandService.executeCommand(
                SIMPLETAB_OPEN_PARTICIPANTS_COMMAND,
              );
            }}
          >
            {t("nav.openParticipants")}
          </button>
          <button
            type="button"
            className="theia-button secondary simpletab-nav-btn"
            onClick={() => {
              void this.commandService.executeCommand(
                SIMPLETAB_OPEN_CHECKIN_COMMAND,
              );
            }}
          >
            {t("nav.openCheckin")}
          </button>
          <button
            type="button"
            className="theia-button secondary simpletab-nav-btn"
            onClick={() => {
              void this.commandService.executeCommand(SIMPLETAB_OPEN_DRAW_COMMAND);
            }}
          >
            {t("nav.openDraw")}
          </button>
          <button
            type="button"
            className="theia-button secondary simpletab-nav-btn"
            onClick={() => {
              void this.commandService.executeCommand(
                SIMPLETAB_OPEN_ALLOCATION_COMMAND,
              );
            }}
          >
            {t("nav.openAllocation")}
          </button>
          <button
            type="button"
            className="theia-button secondary simpletab-nav-btn"
            onClick={() => {
              void this.commandService.executeCommand(
                SIMPLETAB_OPEN_MOTIONS_COMMAND,
              );
            }}
          >
            {t("nav.openMotions")}
          </button>
          <button
            type="button"
            className="theia-button secondary simpletab-nav-btn"
            onClick={() => {
              void this.commandService.executeCommand(
                SIMPLETAB_OPEN_RESULTS_COMMAND,
              );
            }}
          >
            {t("nav.openResults")}
          </button>
          {canViewFeedback ? (
            <button
              type="button"
              className="theia-button secondary simpletab-nav-btn"
              onClick={() => {
                void this.commandService.executeCommand(
                  SIMPLETAB_OPEN_FEEDBACK_COMMAND,
                );
              }}
            >
              {t("nav.openFeedback")}
            </button>
          ) : null}
          <button
            type="button"
            className="theia-button secondary simpletab-nav-btn"
            onClick={() => {
              void this.commandService.executeCommand(SIMPLETAB_OPEN_STATUS_COMMAND);
            }}
          >
            {t("nav.openStatus")}
          </button>
        </nav>

        <div className="simpletab-field">
          <label htmlFor="simpletab-locale-select">
            {t("nav.languageLabel")}
          </label>
          <select
            id="simpletab-locale-select"
            value={locale}
            onChange={(e) => setLocale(e.target.value as SupportedLocale)}
          >
            <option value="en">{t("nav.localeEn")}</option>
            <option value="bn">{t("nav.localeBn")}</option>
          </select>
        </div>
      </div>
    );
  }
}
