import { ConnectionHandler, RpcConnectionHandler } from "@theia/core/lib/common/messaging";
import { ElectronConnectionHandler } from "@theia/core/lib/electron-main/messaging/electron-connection-handler";
import { ContainerModule } from "@theia/core/shared/inversify";
import { app } from "@theia/electron/shared/electron";
import { EXTENSIONS_RESTART_PATH, type ExtensionsRestartService } from "../common/extensions-protocol";

/**
 * Theia's own "Restart" reopens the window but keeps the backend, so extensions would stay as
 * they were. SimpleTab relaunches the whole app; quitting normally lets Theia stop the backend.
 */
const restartService: ExtensionsRestartService = {
  async relaunch(): Promise<void> {
    app.relaunch();
    app.quit();
  },
};

export default new ContainerModule((bind) => {
  bind<ConnectionHandler>(ElectronConnectionHandler)
    .toDynamicValue(() => new RpcConnectionHandler(EXTENSIONS_RESTART_PATH, () => restartService))
    .inSingletonScope();
});
