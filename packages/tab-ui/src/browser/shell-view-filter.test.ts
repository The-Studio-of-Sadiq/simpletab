import {
  isHiddenShellWidgetId,
  shouldFilterShellContribution,
  SimpleTabShellFilterContribution,
} from "./shell-view-filter";

describe("SimpleTabShellFilterContribution", () => {
  it("filters out Plugins (M9), Navigator (M7), Terminal (M6), and transitive IDE views", () => {
    expect(
      shouldFilterShellContribution({
        viewId: "plugins",
        toggleCommand: { id: "pluginsView:toggle" },
      }),
    ).toBe(true);

    expect(
      shouldFilterShellContribution({
        viewId: "files",
        effectiveWidgetId: "explorer-view-container",
        toggleCommand: { id: "fileNavigator:toggle" },
      }),
    ).toBe(true);

    expect(
      shouldFilterShellContribution({
        viewId: "search-in-workspace",
        effectiveWidgetId: "search-view-container",
      }),
    ).toBe(true);

    expect(
      shouldFilterShellContribution({
        viewId: "debug",
        toggleCommand: { id: "debug:toggle" },
      }),
    ).toBe(true);

    expect(
      shouldFilterShellContribution({
        viewId: "test-tree-widget",
        effectiveWidgetId: "test-view-container",
      }),
    ).toBe(true);

    expect(
      shouldFilterShellContribution({
        openTerminal: () => undefined,
        toggleTerminal: () => undefined,
        getDefaultShell: () => Promise.resolve(""),
      }),
    ).toBe(true);
  });

  it("keeps SimpleTab and Source Control (SCM / Git) contributions active", () => {
    expect(
      shouldFilterShellContribution({
        viewId: "simpletab-view-container",
        effectiveWidgetId: "simpletab-view-container",
        toggleCommand: { id: "simpletab.container.toggle" },
      }),
    ).toBe(false);

    expect(
      shouldFilterShellContribution({
        viewId: "scm-view",
        effectiveWidgetId: "scm-view-container",
        toggleCommand: { id: "scmView:toggle" },
      }),
    ).toBe(false);
  });

  it("registers a global filter and closes any restored hidden widgets", () => {
    const filter = new SimpleTabShellFilterContribution();
    const added: Array<{ types: unknown; predicates: Array<(c: object) => boolean> }> = [];

    filter.registerContributionFilters({
      addFilters(types: unknown, filters: Array<(c: object) => boolean>) {
        added.push({ types, predicates: filters });
      },
      applyFilters<T extends object>(toFilter: T[]) {
        return toFilter;
      },
    });

    expect(added).toHaveLength(1);
    expect(added[0].types).toBe("*");
    const predicate = added[0].predicates[0];
    expect(predicate({ viewId: "plugins" })).toBe(false);
    expect(predicate({ viewId: "scm-view" })).toBe(true);

    const closed: string[] = [];
    const makeWidget = (id: string) => ({
      id,
      close: () => {
        closed.push(id);
      },
    });

    filter.onDidInitializeLayout({
      shell: {
        getWidgets: (area: string) => {
          if (area === "left") {
            return [
              makeWidget("simpletab-view-container"),
              makeWidget("scm-view-container"),
              makeWidget("plugins"),
              makeWidget("explorer-view-container"),
            ];
          }
          if (area === "bottom") {
            return [makeWidget("terminal-0")];
          }
          return [];
        },
      },
    } as never);

    expect(closed).toEqual([
      "plugins",
      "explorer-view-container",
      "terminal-0",
    ]);
    expect(isHiddenShellWidgetId("scm-view-container")).toBe(false);
    expect(isHiddenShellWidgetId("terminal-1")).toBe(true);
  });
});
