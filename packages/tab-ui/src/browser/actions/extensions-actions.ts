import type {
  ExtensionEntryStatus,
  ExtensionsResult,
  ExtensionsService,
  ExtensionsStatus,
} from "@simpletab/extensions/lib/common/extensions-protocol";
import { t } from "../i18n";
import { defineAction, type ActionContext } from "./action";
import { pickYesNo } from "./prompt-helpers";

/** Widget id of the Extensions page (design section 11, item 6). */
export const EXTENSIONS_PAGE = "simpletab-extensions-widget";

/**
 * Shape of the host's refusal, rather than a message shown to the person. The wording comes
 * from the backend protocol; only the translated replacement is displayed.
 */
export const EXTENSIONS_LOADED_ERROR_PREFIX = "Extensions are loaded (";

export function isExtensionsLoadedError(message: string): boolean {
  return message.startsWith(EXTENSIONS_LOADED_ERROR_PREFIX);
}

type NoArgs = Record<string, never>;

export interface InstallExtensionArgs {
  id: string;
}

export interface InstallFromFileArgs {
  path: string;
}

export interface RemoveExtensionArgs {
  id: string;
}

export interface SetExtensionOnArgs {
  id: string;
  on: boolean;
}

/** The service's result is returned unchanged; the extra shape covers a missing service. */
export type ExtensionsActionResult = ExtensionsResult | { ok: false; errors: string[] };

function unavailable(): { ok: false; errors: string[] } {
  return { ok: false, errors: [t("extensions.unavailable")] };
}

function failureFrom(error: unknown): { ok: false; errors: string[] } {
  return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
}

/** Palette prompts read the live list, not a list captured when the action was defined. */
async function currentStatus(ctx: ActionContext): Promise<ExtensionsStatus> {
  const extensions = ctx.services?.extensions;
  if (extensions === undefined) {
    throw new Error(t("extensions.unavailable"));
  }
  return extensions.status();
}

async function pickExtension(
  ctx: ActionContext,
  filter: (entry: ExtensionEntryStatus) => boolean,
  placeholderKey: string,
  emptyKey: string,
): Promise<ExtensionEntryStatus | undefined> {
  const status = await currentStatus(ctx);
  const candidates = status.extensions.filter(filter);
  if (candidates.length === 0) {
    // Said out loud, like pickRestorableRound: an empty quick pick must not look like Escape.
    throw new Error(t(emptyKey));
  }
  const id = await ctx.prompts.pick(
    candidates.map((entry) => ({
      label: entry.name,
      description: t("action.extensions.versionLicense", {
        version: entry.version,
        license: entry.license,
      }),
      detail: entry.purpose,
      value: entry.id,
    })),
    t(placeholderKey),
  );
  if (id === undefined) return undefined;
  const chosen = candidates.find((entry) => entry.id === id);
  if (chosen === undefined) {
    throw new Error(t("action.extensions.notFound"));
  }
  return chosen;
}

async function callService(
  ctx: ActionContext,
  call: (service: ExtensionsService) => Promise<ExtensionsResult>,
): Promise<ExtensionsActionResult> {
  const service = ctx.services?.extensions;
  if (service === undefined) return unavailable();
  try {
    return await call(service);
  } catch (error) {
    return failureFrom(error);
  }
}

export const installExtensionAction = defineAction<InstallExtensionArgs, ExtensionsActionResult>({
  id: "simpletab.extensions.install-extension",
  labelKey: "action.extensions.installExtension",
  page: EXTENSIONS_PAGE,
  isEnabled: () => true,
  async prompt(ctx) {
    const entry = await pickExtension(
      ctx,
      (candidate) => !candidate.installed,
      "action.extensions.pickInstall",
      "action.extensions.nothingToInstall",
    );
    return entry === undefined ? undefined : { id: entry.id };
  },
  async run(ctx, { id }) {
    return callService(ctx, (service) => service.install(id));
  },
});

export const installExtensionFromFileAction = defineAction<
  InstallFromFileArgs,
  ExtensionsActionResult
>({
  id: "simpletab.extensions.install-from-file",
  labelKey: "action.extensions.installFromFile",
  page: EXTENSIONS_PAGE,
  isEnabled: () => true,
  async prompt(ctx) {
    const path = await ctx.prompts.pickFile(t("action.extensions.filePrompt"), ["vsix"]);
    return path === undefined ? undefined : { path };
  },
  async run(ctx, { path }) {
    return callService(ctx, (service) => service.installFromFile(path));
  },
});

export const removeExtensionAction = defineAction<RemoveExtensionArgs, ExtensionsActionResult>({
  id: "simpletab.extensions.remove-extension",
  labelKey: "action.extensions.removeExtension",
  page: EXTENSIONS_PAGE,
  isEnabled: () => true,
  async prompt(ctx) {
    const entry = await pickExtension(
      ctx,
      (candidate) => candidate.installed,
      "action.extensions.pickInstalled",
      "action.extensions.nothingInstalled",
    );
    if (entry === undefined) return undefined;
    const confirmed = await ctx.prompts.confirm(
      t("action.extensions.confirmRemoveTitle", { name: entry.name }),
      t("action.extensions.confirmRemoveMessage"),
    );
    return confirmed ? { id: entry.id } : undefined;
  },
  async run(ctx, { id }) {
    return callService(ctx, (service) => service.remove(id));
  },
});

export const setExtensionOnAction = defineAction<SetExtensionOnArgs, ExtensionsActionResult>({
  id: "simpletab.extensions.set-on",
  labelKey: "action.extensions.setOn",
  page: EXTENSIONS_PAGE,
  isEnabled: () => true,
  async prompt(ctx) {
    const entry = await pickExtension(
      ctx,
      (candidate) => candidate.installed,
      "action.extensions.pickInstalled",
      "action.extensions.nothingInstalled",
    );
    if (entry === undefined) return undefined;
    const on = await pickYesNo(ctx, t("action.extensions.pickOn", { name: entry.name }), entry.on);
    return on === undefined ? undefined : { id: entry.id, on };
  },
  async run(ctx, { id, on }) {
    return callService(ctx, (service) => service.setOn(id, on));
  },
});

export const restartSimpleTabAction = defineAction<
  NoArgs,
  { ok: true } | { ok: false; errors: string[] }
>({
  id: "simpletab.extensions.restart-simpletab",
  labelKey: "action.extensions.restart",
  page: EXTENSIONS_PAGE,
  isEnabled: () => true,
  async prompt(ctx) {
    const confirmed = await ctx.prompts.confirm(
      t("action.extensions.confirmRestartTitle"),
      t("action.extensions.confirmRestartMessage"),
    );
    return confirmed ? {} : undefined;
  },
  async run(ctx) {
    const restart = ctx.services?.restart;
    if (restart === undefined) return unavailable();
    try {
      await restart.relaunch();
      return { ok: true };
    } catch (error) {
      return failureFrom(error);
    }
  },
});

/** One command per extension operation; the page and the palette share them. */
export const EXTENSIONS_ACTIONS = [
  installExtensionAction,
  installExtensionFromFileAction,
  removeExtensionAction,
  setExtensionOnAction,
  restartSimpleTabAction,
] as const;
