import { FileUri } from "@theia/core/lib/common/file-uri";
import URI from "@theia/core/lib/common/uri";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "./i18n";

// The real editor manager, shell and file service need CSS or browser globals that tests lack.
vi.mock("./tournament-file-guard", () => ({ GuardedFileService: class {} }));
vi.mock("@theia/editor/lib/browser/editor-manager", () => ({ EditorManager: class {} }));
vi.mock("@theia/core/lib/browser/shell/application-shell", () => ({ ApplicationShell: class {} }));

const {
  DEVELOPER_MODE_PREFERENCE,
  DeveloperMode,
  DeveloperModeContribution,
  EDITORLESS_OPEN_PRIORITY,
  EditorlessOpenHandler,
  developerModePreferenceSchema,
  editorlessAction,
} = await import("./developer-mode");

type Listener<T> = (value: T) => void;

function makeDeveloperMode(on: boolean) {
  const prefs = new Map<string, unknown>([[DEVELOPER_MODE_PREFERENCE, on]]);
  const changeListeners: Array<Listener<{ preferenceName: string }>> = [];
  const infos: string[] = [];
  const preferences = {
    get: <T,>(name: string, fallback: T): T => (prefs.has(name) ? (prefs.get(name) as T) : fallback),
    set: vi.fn(async (name: string, value: unknown) => {
      prefs.set(name, value);
      for (const listener of changeListeners) listener({ preferenceName: name });
    }),
    onPreferenceChanged: (listener: Listener<{ preferenceName: string }>) => {
      changeListeners.push(listener);
    },
  };
  const mode = new DeveloperMode();
  Object.assign(mode, {
    preferences,
    messages: { info: (message: string) => { infos.push(message); return Promise.resolve(undefined); } },
  });
  return { mode, preferences, infos };
}

const csv = FileUri.create("/t/bp/teams.csv");
const diff = new URI("diff:/t/bp/teams.csv");

describe("developer mode", () => {
  afterEach(() => {
    delete (globalThis as { electronTheiaCore?: unknown }).electronTheiaCore;
  });

  it("is a per-laptop setting that is off by default", () => {
    const property = developerModePreferenceSchema.properties[DEVELOPER_MODE_PREFERENCE];
    expect(property).toMatchObject({ type: "boolean", default: false });
    expect(makeDeveloperMode(false).mode.isOn()).toBe(false);
  });

  it("toggles the user-scope setting", async () => {
    const { mode, preferences } = makeDeveloperMode(false);
    await mode.toggle();
    expect(mode.isOn()).toBe(true);
    expect(preferences.set).toHaveBeenCalledWith(DEVELOPER_MODE_PREFERENCE, true, expect.anything());
  });

  it("opens files in the laptop's own app and explains everything else", () => {
    const opened: string[] = [];
    (globalThis as { electronTheiaCore?: unknown }).electronTheiaCore = {
      openWithSystemApp: (location: string) => { opened.push(location); },
    };
    const { mode, infos } = makeDeveloperMode(false);
    expect(editorlessAction(csv)).toBe("system-app");
    expect(editorlessAction(diff)).toBe("needs-developer-mode");

    mode.openWithoutEditor(csv);
    mode.openWithoutEditor(diff);
    expect(opened).toEqual([FileUri.fsPath(csv)]);
    expect(infos).toEqual([t("developerMode.editorHidden")]);
  });

  it("claims editor URIs ahead of the code editor only while developer mode is off", () => {
    const off = new EditorlessOpenHandler();
    Object.assign(off, { developerMode: makeDeveloperMode(false).mode, guard: { protectedMessage: () => null } });
    expect(off.canHandle(csv)).toBe(EDITORLESS_OPEN_PRIORITY);
    expect(off.canHandle(diff)).toBe(EDITORLESS_OPEN_PRIORITY);
    expect(off.canHandle(new URI("https://example.org"))).toBe(0);

    const on = new EditorlessOpenHandler();
    Object.assign(on, { developerMode: makeDeveloperMode(true).mode });
    expect(on.canHandle(csv)).toBe(0);
  });

  it("never hands the open tournament's own files to another app", () => {
    const { mode } = makeDeveloperMode(false);
    const openWithoutEditor = vi.spyOn(mode, "openWithoutEditor").mockImplementation(() => undefined);
    const infos: string[] = [];
    const handler = new EditorlessOpenHandler();
    const db = FileUri.create("/t/bp/bp.simpletab.db");
    Object.assign(handler, {
      developerMode: mode,
      guard: { protectedMessage: (uri: URI) => (uri.isEqual(db) ? "protected" : null) },
      messages: { info: (message: string) => { infos.push(message); return Promise.resolve(undefined); } },
    });

    handler.open(db);
    handler.open(csv);
    expect(infos).toEqual([t("developerMode.tournamentFileNotOpened", { name: "bp.simpletab.db" })]);
    expect(openWithoutEditor).toHaveBeenCalledTimes(1);
    expect(openWithoutEditor).toHaveBeenCalledWith(csv);
  });

  it("closes editors that open anyway, and all editors when developer mode is turned off", async () => {
    const created: Array<Listener<{ id: string; getResourceUri(): URI | undefined }>> = [];
    const closed: string[] = [];
    const closedMany: string[][] = [];
    const { mode, preferences } = makeDeveloperMode(true);
    const contribution = new DeveloperModeContribution();
    const openEditors = [{ id: "editor-1" }];
    Object.assign(contribution, {
      developerMode: mode,
      preferences,
      editors: {
        onCreated: (listener: Listener<{ id: string; getResourceUri(): URI | undefined }>) => {
          created.push(listener);
        },
        all: openEditors,
      },
      shell: {
        closeWidget: async (id: string) => { closed.push(id); return undefined; },
        closeMany: async (widgets: Array<{ id: string }>) => { closedMany.push(widgets.map((w) => w.id)); return []; },
      },
    });
    const openWithoutEditor = vi.spyOn(mode, "openWithoutEditor").mockImplementation(() => undefined);
    contribution.onStart();

    created[0]!({ id: "editor-2", getResourceUri: () => csv });
    expect(closed).toEqual([]);

    await mode.toggle(); // off
    expect(closedMany).toEqual([["editor-1"]]);

    created[0]!({ id: "editor-3", getResourceUri: () => csv });
    await vi.waitFor(() => expect(openWithoutEditor).toHaveBeenCalledWith(csv));
    expect(closed).toEqual(["editor-3"]);
  });
});
