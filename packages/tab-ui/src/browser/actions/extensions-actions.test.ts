import type {
  ExtensionEntryStatus,
  ExtensionsResult,
  ExtensionsStatus,
} from "@simpletab/extensions/lib/common/extensions-protocol";
import { describe, expect, it } from "vitest";
import { t } from "../i18n";
import type { ActionPrompts, ActionServices } from "./action";
import {
  EXTENSIONS_ACTIONS,
  installExtensionAction,
  installExtensionFromFileAction,
  removeExtensionAction,
  restartSimpleTabAction,
  setExtensionOnAction,
} from "./extensions-actions";
import {
  fakeExtensionEntry,
  fakeExtensionsRestartService,
  fakeExtensionsService,
  fakeExtensionsStatus,
  fakeStore,
  scriptedPrompts,
  testContext,
} from "./test-context";

const unavailable = (): { ok: false; errors: string[] } => ({
  ok: false,
  errors: [t("extensions.unavailable")],
});

function context(
  answers: unknown[],
  services: ActionServices = {},
): ReturnType<typeof testContext> {
  return testContext(
    fakeStore(null).store,
    scriptedPrompts(answers),
    async () => undefined,
    services,
  );
}

interface PickCall {
  items: ReadonlyArray<{
    label: string;
    description?: string;
    detail?: string;
    value: unknown;
  }>;
  placeholder: string;
}

function recordingPrompts(answers: unknown[]): {
  prompts: ActionPrompts;
  picks: PickCall[];
  files: Array<{ title: string; extensions: readonly string[] }>;
  confirms: Array<{ title: string; message: string }>;
} {
  const base = scriptedPrompts(answers);
  const picks: PickCall[] = [];
  const files: Array<{ title: string; extensions: readonly string[] }> = [];
  const confirms: Array<{ title: string; message: string }> = [];
  const prompts: ActionPrompts = {
    ...base,
    pick: async <T,>(
      items: ReadonlyArray<{ label: string; description?: string; detail?: string; value: T }>,
      placeholder: string,
    ): Promise<T | undefined> => {
      picks.push({ items, placeholder });
      return base.pick(items, placeholder);
    },
    pickFile: async (title: string, extensions: readonly string[]) => {
      files.push({ title, extensions });
      return base.pickFile(title, extensions);
    },
    confirm: async (title: string, message: string) => {
      confirms.push({ title, message });
      return base.confirm(title, message);
    },
  };
  return { prompts, picks, files, confirms };
}

function pickContext(
  answers: unknown[],
  status: ExtensionsStatus,
): { ctx: ReturnType<typeof testContext>; calls: ReturnType<typeof recordingPrompts> } {
  const recorded = recordingPrompts(answers);
  const extensions = fakeExtensionsService({ status });
  return {
    ctx: testContext(
      fakeStore(null).store,
      recorded.prompts,
      async () => undefined,
      { extensions: extensions.service },
    ),
    calls: recorded,
  };
}

const notInstalled: ExtensionEntryStatus = fakeExtensionEntry({
  id: "pub.not-installed@1.0.0",
  name: "Not installed",
  version: "1.0.0",
  license: "MIT",
  purpose: "Not installed purpose",
  installed: false,
  on: true,
  loaded: false,
});
const installedOn: ExtensionEntryStatus = fakeExtensionEntry({
  id: "pub.on@2.0.0",
  name: "Installed on",
  version: "2.0.0",
  license: "Apache-2.0",
  purpose: "On purpose",
  installed: true,
  on: true,
  loaded: false,
});
const installedOff: ExtensionEntryStatus = fakeExtensionEntry({
  id: "pub.off@3.0.0",
  name: "Installed off",
  version: "3.0.0",
  license: "BSD-3-Clause",
  purpose: "Off purpose",
  installed: true,
  on: false,
  loaded: false,
});

function mixedStatus(): ExtensionsStatus {
  return fakeExtensionsStatus({ extensions: [notInstalled, installedOn, installedOff] });
}

describe("extensions actions", () => {
  it("installs from the live list of extensions that are not installed", async () => {
    const { ctx, calls } = pickContext([notInstalled.id], mixedStatus());
    expect(await installExtensionAction.prompt(ctx)).toEqual({ id: notInstalled.id });
    expect(calls.picks).toEqual([
      {
        items: [
          {
            label: notInstalled.name,
            description: t("action.extensions.versionLicense", {
              version: notInstalled.version,
              license: notInstalled.license,
            }),
            detail: notInstalled.purpose,
            value: notInstalled.id,
          },
        ],
        placeholder: t("action.extensions.pickInstall"),
      },
    ]);
  });

  it("reads the list again on each prompt instead of using a stale list", async () => {
    let current = fakeExtensionsStatus({ extensions: [notInstalled] });
    const extensions = fakeExtensionsService({ status: async () => current });
    const ctx = testContext(
      fakeStore(null).store,
      scriptedPrompts([notInstalled.id, "pub.later@1.0.0"]),
      async () => undefined,
      { extensions: extensions.service },
    );
    expect(await installExtensionAction.prompt(ctx)).toEqual({ id: notInstalled.id });
    current = fakeExtensionsStatus({
      extensions: [
        fakeExtensionEntry({ id: "pub.later@1.0.0", name: "Later", installed: false }),
      ],
    });
    expect(await installExtensionAction.prompt(ctx)).toEqual({
      id: "pub.later@1.0.0",
    });
    expect(extensions.calls.statusReads).toBe(2);
  });

  it("says so when there is nothing to install and cancels on Escape", async () => {
    const allInstalled = fakeExtensionsStatus({
      extensions: [installedOn, installedOff],
    });
    const empty = pickContext([], allInstalled).ctx;
    await expect(installExtensionAction.prompt(empty)).rejects.toThrow(
      t("action.extensions.nothingToInstall"),
    );

    const escaped = context([undefined], {
      extensions: fakeExtensionsService({ status: mixedStatus() }).service,
    });
    expect(await installExtensionAction.prompt(escaped)).toBeUndefined();
  });

  it("prompts for a VSIX file and cancels on Escape at the file picker", async () => {
    const { prompts, files } = recordingPrompts(["/tmp/example.vsix"]);
    expect(
      await installExtensionFromFileAction.prompt(
        testContext(fakeStore(null).store, prompts, async () => undefined),
      ),
    ).toEqual({ path: "/tmp/example.vsix" });
    expect(files).toEqual([
      { title: t("action.extensions.filePrompt"), extensions: ["vsix"] },
    ]);

    const escaped = recordingPrompts([undefined]);
    expect(
      await installExtensionFromFileAction.prompt(
        testContext(fakeStore(null).store, escaped.prompts, async () => undefined),
      ),
    ).toBeUndefined();
  });

  it("confirms removing an installed extension and cancels on Escape or refusal", async () => {
    const answerYes = pickContext([installedOn.id, true], mixedStatus());
    expect(await removeExtensionAction.prompt(answerYes.ctx)).toEqual({
      id: installedOn.id,
    });
    expect(answerYes.calls.confirms).toEqual([
      {
        title: t("action.extensions.confirmRemoveTitle", { name: installedOn.name }),
        message: t("action.extensions.confirmRemoveMessage"),
      },
    ]);
    expect(answerYes.calls.picks[0]?.items.map((item) => item.value)).toEqual([
      installedOn.id,
      installedOff.id,
    ]);

    const answerNo = pickContext([installedOn.id, false], mixedStatus());
    expect(await removeExtensionAction.prompt(answerNo.ctx)).toBeUndefined();

    const escaped = pickContext([undefined], mixedStatus());
    expect(await removeExtensionAction.prompt(escaped.ctx)).toBeUndefined();
  });

  it("says so when there is nothing installed to remove or change", async () => {
    const noneInstalled = fakeExtensionsStatus({ extensions: [notInstalled] });
    await expect(
      removeExtensionAction.prompt(pickContext([], noneInstalled).ctx),
    ).rejects.toThrow(t("action.extensions.nothingInstalled"));
    await expect(
      setExtensionOnAction.prompt(pickContext([], noneInstalled).ctx),
    ).rejects.toThrow(t("action.extensions.nothingInstalled"));
  });

  it("offers the current on/off state first and cancels on Escape", async () => {
    const turnOff = pickContext([installedOn.id, false], mixedStatus());
    expect(await setExtensionOnAction.prompt(turnOff.ctx)).toEqual({
      id: installedOn.id,
      on: false,
    });
    expect(turnOff.calls.picks[1]?.items.map((item) => item.value)).toEqual([
      true,
      false,
    ]);

    const turnOn = pickContext([installedOff.id, true], mixedStatus());
    expect(await setExtensionOnAction.prompt(turnOn.ctx)).toEqual({
      id: installedOff.id,
      on: true,
    });
    expect(turnOn.calls.picks[1]?.items.map((item) => item.value)).toEqual([
      false,
      true,
    ]);

    const escapedSecond = pickContext([installedOn.id, undefined], mixedStatus());
    expect(await setExtensionOnAction.prompt(escapedSecond.ctx)).toBeUndefined();

    const escapedFirst = pickContext([undefined], mixedStatus());
    expect(await setExtensionOnAction.prompt(escapedFirst.ctx)).toBeUndefined();
  });

  it("confirms restarting SimpleTab and declines cleanly", async () => {
    const accepted = recordingPrompts([true]);
    expect(
      await restartSimpleTabAction.prompt(
        testContext(fakeStore(null).store, accepted.prompts, async () => undefined),
      ),
    ).toEqual({});
    expect(accepted.confirms).toEqual([
      {
        title: t("action.extensions.confirmRestartTitle"),
        message: t("action.extensions.confirmRestartMessage"),
      },
    ]);

    const declined = recordingPrompts([false]);
    expect(
      await restartSimpleTabAction.prompt(
        testContext(fakeStore(null).store, declined.prompts, async () => undefined),
      ),
    ).toBeUndefined();
  });

  it("calls the service for each run and returns its result unchanged", async () => {
    const status = mixedStatus();
    const result: ExtensionsResult = { ok: true, status };
    const extensions = fakeExtensionsService({ status, result });
    const ctx = context([], { extensions: extensions.service });

    expect(await installExtensionAction.run(ctx, { id: "pub.a@1" })).toBe(result);
    expect(await installExtensionFromFileAction.run(ctx, { path: "/tmp/a.vsix" })).toBe(result);
    expect(await removeExtensionAction.run(ctx, { id: "pub.b@1" })).toBe(result);
    expect(await setExtensionOnAction.run(ctx, { id: "pub.c@1", on: false })).toBe(result);
    expect(extensions.calls.installs).toEqual(["pub.a@1"]);
    expect(extensions.calls.installFromFilePaths).toEqual(["/tmp/a.vsix"]);
    expect(extensions.calls.removes).toEqual(["pub.b@1"]);
    expect(extensions.calls.setOns).toEqual([{ id: "pub.c@1", on: false }]);

    const restart = fakeExtensionsRestartService();
    expect(await restartSimpleTabAction.run(context([], { restart: restart.service }), {})).toEqual({
      ok: true,
    });
    expect(restart.calls.relaunches).toBe(1);
  });

  it("returns a service failure result as it is", async () => {
    const failure: ExtensionsResult = {
      ok: false,
      code: "HASH_MISMATCH",
      errors: ["The file does not match the list."],
    };
    const extensions = fakeExtensionsService({ result: failure });
    const ctx = context([], { extensions: extensions.service });
    expect(await removeExtensionAction.run(ctx, { id: "pub.a@1" })).toBe(failure);
  });

  it("reports missing services without throwing", async () => {
    const ctx = context([]);
    await expect(installExtensionAction.run(ctx, { id: "pub.a@1" })).resolves.toEqual(unavailable());
    await expect(
      installExtensionFromFileAction.run(ctx, { path: "/tmp/a.vsix" }),
    ).resolves.toEqual(unavailable());
    await expect(removeExtensionAction.run(ctx, { id: "pub.a@1" })).resolves.toEqual(unavailable());
    await expect(
      setExtensionOnAction.run(ctx, { id: "pub.a@1", on: true }),
    ).resolves.toEqual(unavailable());
    await expect(restartSimpleTabAction.run(ctx, {})).resolves.toEqual(unavailable());
  });

  it("offers every extension command even with no tournament open", () => {
    const snapshot = fakeStore(null).store.getSnapshot();
    for (const action of EXTENSIONS_ACTIONS) {
      expect(action.isEnabled?.(snapshot)).toBe(true);
    }
  });
});
