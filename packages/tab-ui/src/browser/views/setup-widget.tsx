import { DisposableCollection } from "@theia/core/lib/common";
import { Message } from "@theia/core/lib/browser";
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, optional, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import { FileDialogService } from "@theia/filesystem/lib/browser/file-dialog";
import { SetupView } from "../components/setup-view";
import { onLocaleChange, t } from "../i18n";
import { TournamentStore } from "../store/tournament-store";

@injectable()
export class SetupWidget extends ReactWidget {
  static readonly ID = "simpletab-setup-widget";

  private readonly disposables = new DisposableCollection();

  constructor(
    @inject(TournamentStore) private readonly store: TournamentStore,
    @inject(FileDialogService)
    @optional()
    private readonly fileDialogService?: FileDialogService,
  ) {
    super();
    this.id = SetupWidget.ID;
    this.title.label = t("setup.widgetLabel");
    this.title.caption = t("setup.widgetLabel");
    this.title.closable = true;
    this.node.tabIndex = -1;
    this.addClass("simpletab-setup-widget");
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
        this.title.label = t("setup.widgetLabel");
        this.title.caption = t("setup.widgetLabel");
        this.update();
      }),
    );
    this.toDispose.push(this.disposables);
    this.update();
  }

  private async pickDirectory(): Promise<string | undefined> {
    if (this.fileDialogService === undefined) {
      return undefined;
    }
    const uri = await this.fileDialogService.showOpenDialog({
      title: t("setup.directoryLabel"),
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
    });
    return uri?.path.fsPath();
  }

  private async pickDbFile(): Promise<string | undefined> {
    if (this.fileDialogService === undefined) {
      return undefined;
    }
    const uri = await this.fileDialogService.showOpenDialog({
      title: t("setup.openExisting"),
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { SimpleTab: ["db"] },
    });
    return uri?.path.fsPath();
  }

  protected override render(): React.ReactNode {
    const snapshot = this.store.getSnapshot();
    return (
      <SetupView
        state={snapshot.state}
        status={snapshot.status}
        onCreateTournament={(params) => this.store.createTournament(params)}
        onOpenTournament={(dbPath) => this.store.openTournament(dbPath)}
        onSubmitOp={(request) => this.store.submit(request)}
        onPickDirectory={
          this.fileDialogService ? () => this.pickDirectory() : undefined
        }
        onPickDbFile={
          this.fileDialogService ? () => this.pickDbFile() : undefined
        }
      />
    );
  }
}
