import { ContainerModule } from "@theia/core/shared/inversify";
import { PluginTheiaDeployerParticipant } from "@theia/plugin-ext/lib/main/node/plugin-theia-deployer-participant";
import { PluginVSCodeDeployerParticipant } from "@theia/plugin-ext-vscode/lib/node/plugin-vscode-deployer-participant";
import { NoUserPluginsParticipant, SimpleTabDeployerParticipant } from "./simpletab-deployer-participant";

/**
 * Design section 11, item 6. This package depends on `@theia/plugin-ext-vscode`, so Theia loads
 * this module after the plugin modules and the two participants that add user plugins can be
 * replaced. Their `PluginDeployerParticipant` bindings point at these classes, so rebinding the
 * classes changes what the plugin deployer calls.
 */
export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  bind(SimpleTabDeployerParticipant).toSelf().inSingletonScope();
  rebind(PluginVSCodeDeployerParticipant).toService(SimpleTabDeployerParticipant);
  rebind(PluginTheiaDeployerParticipant).to(NoUserPluginsParticipant).inSingletonScope();
});
