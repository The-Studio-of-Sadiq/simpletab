import type {
  FrontendApplication,
  FrontendApplicationContribution,
} from "@theia/core/lib/browser";
import type {
  ContributionFilterRegistry,
  FilterContribution,
} from "@theia/core/lib/common";
import { injectable } from "@theia/core/shared/inversify";

/**
 * View/container IDs contributed by @theia/plugin-ext and its transitive
 * dependencies that are intentionally hidden in M2 so the shell stays focused
 * on SimpleTab and Source Control (Git):
 * - "plugins" (Plugins management view -> deferred to M9)
 * - "files" / "explorer-view-container" (File Explorer / Navigator -> deferred to M7)
 * - "search-in-workspace" / "search-view-container" (Search view -> transitive dep of plugin-ext)
 * - "debug" / "debug-console" (Debug views -> transitive dep of plugin-ext)
 * - "test-tree-widget" / "test-view-container" / test run/result/output (Testing -> transitive dep of plugin-ext)
 */
export const HIDDEN_VIEW_IDS: ReadonlySet<string> = new Set([
  "plugins",
  "files",
  "explorer-view-container",
  "search-in-workspace",
  "search-view-container",
  "debug",
  "debug-console",
  "test-tree-widget",
  "test-view-container",
  "test-run-view-widget",
  "test-result-view-widget",
  "test-output-view-widget",
]);

export const HIDDEN_TOGGLE_COMMAND_IDS: ReadonlySet<string> = new Set([
  "pluginsView:toggle",
  "fileNavigator:toggle",
  "search-in-workspace.toggle",
  "debug:toggle",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isHiddenViewContribution(contrib: object): boolean {
  if (!isRecord(contrib)) {
    return false;
  }
  if (
    typeof contrib.viewId === "string" &&
    HIDDEN_VIEW_IDS.has(contrib.viewId)
  ) {
    return true;
  }
  if (
    typeof contrib.effectiveWidgetId === "string" &&
    HIDDEN_VIEW_IDS.has(contrib.effectiveWidgetId)
  ) {
    return true;
  }
  const toggleCommand = contrib.toggleCommand;
  if (
    isRecord(toggleCommand) &&
    typeof toggleCommand.id === "string" &&
    HIDDEN_TOGGLE_COMMAND_IDS.has(toggleCommand.id)
  ) {
    return true;
  }
  return false;
}

/**
 * Matches @theia/terminal's TerminalFrontendContribution (pulled in transitively
 * by @theia/plugin-ext) without importing @theia/terminal in tab-ui.
 * Integrated terminal UI is deferred to M6.
 */
function isTerminalFrontendContribution(contrib: object): boolean {
  if (!isRecord(contrib)) {
    return false;
  }
  return (
    typeof contrib.openTerminal === "function" &&
    typeof contrib.toggleTerminal === "function" &&
    typeof contrib.getDefaultShell === "function"
  );
}

/**
 * Returns true if the contribution should be filtered out in M2.
 * Always keeps SimpleTab and Source Control (SCM / Git) contributions active.
 */
export function shouldFilterShellContribution(contrib: object): boolean {
  return (
    isHiddenViewContribution(contrib) || isTerminalFrontendContribution(contrib)
  );
}

export function isHiddenShellWidgetId(widgetId: string): boolean {
  return HIDDEN_VIEW_IDS.has(widgetId) || widgetId.startsWith("terminal-");
}

@injectable()
export class SimpleTabShellFilterContribution
  implements FilterContribution, FrontendApplicationContribution
{
  registerContributionFilters(registry: ContributionFilterRegistry): void {
    registry.addFilters("*", [
      (contrib: object) => !shouldFilterShellContribution(contrib),
    ]);
  }

  onDidInitializeLayout(app: FrontendApplication): void {
    const areas = ["left", "right", "bottom"] as const;
    for (const area of areas) {
      for (const widget of app.shell.getWidgets(area)) {
        if (isHiddenShellWidgetId(widget.id)) {
          widget.close();
        }
      }
    }
  }
}
