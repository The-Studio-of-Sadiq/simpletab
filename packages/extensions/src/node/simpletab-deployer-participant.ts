import path from "node:path";
import {
  setExtensionsRuntime,
  type ExtensionsRuntime,
} from "@simpletab/host/src/node/extensions-runtime";
import { PairingStore } from "@simpletab/host/src/node/device/pairing-store";
import type {
  PluginDeployerParticipant,
  PluginDeployerStartContext,
} from "@theia/plugin-ext/lib/common/plugin-protocol";
import { PluginTheiaDeployerParticipant } from "@theia/plugin-ext/lib/main/node/plugin-theia-deployer-participant";
import { EnvVariablesServer } from "@theia/core/lib/common/env-variables";
import { FileUri } from "@theia/core/lib/common/file-uri";
import { inject, injectable } from "@theia/core/shared/inversify";
import { CURATED_EXTENSIONS, curatedListProblems, vsixFileName, type CuratedExtension } from "./curated-list";
import { readDeveloperMode } from "./developer-mode-setting";
import { defaultExtensionsDir, scanStore } from "./extension-store";
import { decideLoading, type LoadingDecision } from "./loading-rule";

export interface StartupInputs {
  configDir: string;
  extensionsDir: string;
  list: readonly CuratedExtension[];
  pairedAsStaffDevice: boolean;
}

/** What to load at start-up, and the runtime record the host checks later. */
export function planStartup(inputs: StartupInputs): {
  decision: LoadingDecision;
  entries: string[];
  rejected: ReturnType<typeof scanStore>["rejected"];
  runtime: ExtensionsRuntime;
} {
  const problems = curatedListProblems(inputs.list);
  if (problems.length > 0) {
    // A broken list loads nothing rather than guessing which entries to trust.
    throw new Error(`SimpleTab's extension list is invalid: ${problems.join("; ")}`);
  }
  const scan = scanStore(inputs.extensionsDir, inputs.list);
  const decision = decideLoading({
    pairedAsStaffDevice: inputs.pairedAsStaffDevice,
    developerMode: readDeveloperMode(inputs.configDir),
    verified: scan.verified,
    off: scan.off,
  });
  const entries = decision.load.map((entry) =>
    FileUri.create(path.join(inputs.extensionsDir, vsixFileName(entry))).withScheme("local-file").toString(),
  );
  return {
    decision,
    entries,
    rejected: scan.rejected,
    runtime: {
      loaded: decision.load.map((entry) => `${entry.id}@${entry.version}`),
      developerModeNow: () => readDeveloperMode(inputs.configDir),
    },
  };
}

/**
 * Replaces Theia's VS Code deployer participant, which would load everything in
 * `~/.theia/deployedPlugins` and every drop-in `.vsix` in `~/.theia/extensions`. Only verified,
 * listed extensions from SimpleTab's own folder are added, and only when the loading rule allows.
 * Built-in plugins (`theiaPlugins`) are system entries and are not touched.
 */
@injectable()
export class SimpleTabDeployerParticipant implements PluginDeployerParticipant {
  @inject(EnvVariablesServer)
  protected readonly envVariables!: EnvVariablesServer;

  async onWillStart(context: PluginDeployerStartContext): Promise<void> {
    // Anything another participant added for the user is dropped: SimpleTab decides alone.
    context.userEntries.length = 0;
    try {
      const configDir = FileUri.fsPath(await this.envVariables.getConfigDirUri());
      const plan = planStartup({
        configDir,
        extensionsDir: defaultExtensionsDir(),
        list: CURATED_EXTENSIONS,
        pairedAsStaffDevice: new PairingStore().load() !== undefined,
      });
      context.userEntries.push(...plan.entries);
      setExtensionsRuntime(plan.runtime);
      console.info(
        `SimpleTab extensions: ${plan.decision.reason}; loading ${plan.runtime.loaded.length} (${plan.runtime.loaded.join(", ") || "none"}); ignored ${plan.rejected.length} file(s).`,
      );
    } catch (error) {
      setExtensionsRuntime(undefined);
      console.error("SimpleTab extensions: none loaded.", error);
    }
  }
}

/** Replaces Theia's own deployer participant, which adds `~/.theia/plugins` as user plugins. */
@injectable()
export class NoUserPluginsParticipant extends PluginTheiaDeployerParticipant {
  override async onWillStart(): Promise<void> {
    // Nothing: Theia-style user plugins are not on SimpleTab's list.
  }
}
