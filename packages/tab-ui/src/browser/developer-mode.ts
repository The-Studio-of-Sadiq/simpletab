import type {
  CommandContribution,
  CommandRegistry,
} from "@theia/core/lib/common/command";
import { MessageService } from "@theia/core/lib/common/message-service";
import { FileUri } from "@theia/core/lib/common/file-uri";
import type {
  PreferenceContribution,
  PreferenceSchema,
} from "@theia/core/lib/common/preferences/preference-schema";
import { PreferenceScope } from "@theia/core/lib/common/preferences/preference-scope";
import { PreferenceService } from "@theia/core/lib/common/preferences/preference-service";
import type URI from "@theia/core/lib/common/uri";
import type { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import type { OpenHandler } from "@theia/core/lib/browser/opener-service";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { inject, injectable } from "@theia/core/shared/inversify";
import { EditorManager } from "@theia/editor/lib/browser/editor-manager";
import { t } from "./i18n";
import { GuardedFileService } from "./tournament-file-guard";

/**
 * Developer mode (a per-laptop setting, off by default). Without it the code editor never opens:
 * tournament staff work in SimpleTab's own pages, the explorer opens files in the laptop's own
 * app (a CSV in the spreadsheet program, for example), and anything that only the code editor
 * can show, such as Git's view of a change, says it needs developer mode. The explorer, terminal
 * and Git panel stay available either way.
 */
export const DEVELOPER_MODE_PREFERENCE = "simpletab.developerMode";
export const TOGGLE_DEVELOPER_MODE_COMMAND_ID = "simpletab.developerMode.toggle";

export const developerModePreferenceSchema: PreferenceSchema = {
  scope: PreferenceScope.User,
  properties: {
    [DEVELOPER_MODE_PREFERENCE]: {
      type: "boolean",
      default: false,
      description: t("developerMode.preferenceDescription"),
    },
  },
};

export const developerModePreferenceContribution: PreferenceContribution = {
  schema: developerModePreferenceSchema,
};

/** What happens to a URI that would open in the code editor while developer mode is off. */
export type EditorlessAction = "system-app" | "needs-developer-mode";

export function editorlessAction(uri: URI): EditorlessAction {
  return uri.scheme === "file" ? "system-app" : "needs-developer-mode";
}

/** Above every editor, custom editor and notebook handler, so the code editor is never chosen. */
export const EDITORLESS_OPEN_PRIORITY = 100_000;

/** URI schemes the code editor shows that have no other viewer in the app. */
const EDITOR_SCHEMES: ReadonlySet<string> = new Set(["file", "diff", "untitled", "git", "gitfs"]);

interface ElectronCore {
  openWithSystemApp(location: string): void;
}

function electronCore(): ElectronCore | undefined {
  const candidate: unknown = (globalThis as { electronTheiaCore?: unknown }).electronTheiaCore;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as { openWithSystemApp?: unknown }).openWithSystemApp === "function"
  ) {
    return candidate as ElectronCore;
  }
  return undefined;
}

@injectable()
export class DeveloperMode {
  @inject(PreferenceService)
  protected readonly preferences!: PreferenceService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  isOn(): boolean {
    return this.preferences.get<boolean>(DEVELOPER_MODE_PREFERENCE, false) === true;
  }

  async toggle(): Promise<void> {
    await this.preferences.set(DEVELOPER_MODE_PREFERENCE, !this.isOn(), PreferenceScope.User);
  }

  /** Opens a URI the way it is opened without the code editor. */
  openWithoutEditor(uri: URI): void {
    const core = electronCore();
    if (editorlessAction(uri) === "system-app" && core !== undefined) {
      core.openWithSystemApp(FileUri.fsPath(uri));
      return;
    }
    void this.messages.info(t("developerMode.editorHidden"));
  }
}

/** Claims every file before the code editor can, while developer mode is off. */
@injectable()
export class EditorlessOpenHandler implements OpenHandler {
  readonly id = "simpletab.editorless-open";
  readonly label = "SimpleTab";

  @inject(DeveloperMode)
  protected readonly developerMode!: DeveloperMode;

  @inject(GuardedFileService)
  protected readonly guard!: GuardedFileService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  canHandle(uri: URI): number {
    if (this.developerMode.isOn() || !EDITOR_SCHEMES.has(uri.scheme)) return 0;
    return EDITORLESS_OPEN_PRIORITY;
  }

  open(uri: URI): undefined {
    // The live database and the host key are never handed to another app (a database tool could
    // write to the database while SimpleTab has it open).
    if (this.guard.protectedMessage(uri) !== null) {
      void this.messages.info(t("developerMode.tournamentFileNotOpened", { name: uri.path.base }));
      return undefined;
    }
    this.developerMode.openWithoutEditor(uri);
    return undefined;
  }
}

@injectable()
export class DeveloperModeContribution
  implements FrontendApplicationContribution, CommandContribution
{
  @inject(DeveloperMode)
  protected readonly developerMode!: DeveloperMode;

  @inject(EditorManager)
  protected readonly editors!: EditorManager;

  @inject(ApplicationShell)
  protected readonly shell!: ApplicationShell;

  @inject(PreferenceService)
  protected readonly preferences!: PreferenceService;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(
      {
        id: TOGGLE_DEVELOPER_MODE_COMMAND_ID,
        label: t("developerMode.toggleCommand"),
      },
      { execute: () => this.developerMode.toggle() },
    );
  }

  onStart(): void {
    // A safety net for code that opens the editor directly (a plugin, for example) rather than
    // through the opener: the editor is closed again and the file opened the editorless way.
    this.editors.onCreated((editor) => {
      if (this.developerMode.isOn()) return;
      const uri = editor.getResourceUri();
      void this.shell.closeWidget(editor.id, { save: false }).then(() => {
        if (uri !== undefined) this.developerMode.openWithoutEditor(uri);
      });
    });
    this.preferences.onPreferenceChanged((change) => {
      if (change.preferenceName === DEVELOPER_MODE_PREFERENCE && !this.developerMode.isOn()) {
        void this.closeAllEditors();
      }
    });
  }

  onDidInitializeLayout(): Promise<void> {
    // Editors restored from the last session close too when developer mode is off.
    return this.developerMode.isOn() ? Promise.resolve() : this.closeAllEditors();
  }

  /** Unsaved changes prompt the person, as when they close an editor themselves. */
  protected async closeAllEditors(): Promise<void> {
    const open = this.editors.all;
    if (open.length > 0) await this.shell.closeMany(open);
  }
}
