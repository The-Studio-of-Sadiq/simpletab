import type { ForkOptions } from "node:child_process";
import path from "node:path";
import { FileUri } from "@theia/core/lib/common/file-uri";
import { ConnectionHandler, RpcConnectionHandler } from "@theia/core/lib/common/messaging";
import {
  ElectronMainApplication,
  ElectronMainApplicationContribution,
} from "@theia/core/lib/electron-main/electron-main-application";
import { ElectronConnectionHandler } from "@theia/core/lib/electron-main/messaging/electron-connection-handler";
import { inject, injectable } from "@theia/core/shared/inversify";
import { ContainerModule } from "@theia/core/shared/inversify";
import { app, safeStorage } from "@theia/electron/shared/electron";
import {
  CREDENTIALS_SERVICE_PATH,
  CredentialsService,
} from "../common/credentials-protocol";
import {
  PROJECTOR_SERVICE_PATH,
  type ProjectorServiceClient,
} from "../common/projector-protocol";
import { ElectronCredentialsService } from "./credentials";
import { ElectronProjectorService } from "./projector-window";

const BACKEND_MAX_OLD_SPACE_ARG = "--max-old-space-size=2048";
const SMOKE_TIMEOUT_MS = 45_000;

@injectable()
export class SimpleTabElectronMainApplication extends ElectronMainApplication {
  protected override async getForkOptions(): Promise<ForkOptions> {
    const baseOptions = await super.getForkOptions();
    const filteredExecArgv = (baseOptions.execArgv ?? process.execArgv).filter(
      (arg) => !arg.startsWith("--max-old-space-size"),
    );
    const env: NodeJS.ProcessEnv = { ...(baseOptions.env ?? process.env) };
    const appProjectPath =
      env.THEIA_APP_PROJECT_PATH ?? process.env.THEIA_APP_PROJECT_PATH;
    if (!env.THEIA_DEFAULT_PLUGINS && appProjectPath) {
      const pluginsDir = path.join(appProjectPath, "plugins");
      env.THEIA_DEFAULT_PLUGINS = FileUri.create(pluginsDir)
        .withScheme("local-dir")
        .toString();
    }
    return {
      ...baseOptions,
      env,
      execArgv: [...filteredExecArgv, BACKEND_MAX_OLD_SPACE_ARG],
    };
  }
}

@injectable()
export class HostElectronMainContribution implements ElectronMainApplicationContribution {
  private smokeTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    @inject(CredentialsService)
    private readonly credentialsService: CredentialsService,
    @inject(ElectronProjectorService)
    private readonly projectorService: ElectronProjectorService,
  ) {}

  async onStart(): Promise<void> {
    app.setName("SimpleTab");
    if (process.platform === "win32") {
      app.setAppUserModelId("app.simpletab.desktop");
    }

    if (process.env.SIMPLETAB_SMOKE === "1") {
      console.log(
        `SIMPLETAB_ELECTRON_MAIN safeStorageAvailable=${safeStorage.isEncryptionAvailable()}`,
      );
      this.smokeTimeoutHandle = setTimeout(() => {
        console.error("SIMPLETAB_SMOKE_TIMEOUT waiting for smoke completion");
        app.exit(1);
      }, SMOKE_TIMEOUT_MS);
      this.smokeTimeoutHandle.unref();
    }
  }

  onStop(): void {
    this.projectorService.disposeWindow();
    if (this.smokeTimeoutHandle !== null) {
      clearTimeout(this.smokeTimeoutHandle);
      this.smokeTimeoutHandle = null;
    }
  }
}

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  rebind(ElectronMainApplication)
    .to(SimpleTabElectronMainApplication)
    .inSingletonScope();
  bind(ElectronCredentialsService).toSelf().inSingletonScope();
  bind(CredentialsService).toService(ElectronCredentialsService);
  bind(ElectronProjectorService).toSelf().inSingletonScope();
  bind(HostElectronMainContribution).toSelf().inSingletonScope();
  bind(ElectronMainApplicationContribution).toService(HostElectronMainContribution);
  bind<ConnectionHandler>(ElectronConnectionHandler)
    .toDynamicValue(
      (ctx) =>
        new RpcConnectionHandler(CREDENTIALS_SERVICE_PATH, () =>
          ctx.container.get<CredentialsService>(CredentialsService),
        ),
    )
    .inSingletonScope();
  bind<ConnectionHandler>(ElectronConnectionHandler)
    .toDynamicValue(
      (ctx) =>
        new RpcConnectionHandler<ProjectorServiceClient>(
          PROJECTOR_SERVICE_PATH,
          (client) =>
            ctx.container
              .get(ElectronProjectorService)
              .createClientAdapter(client),
        ),
    )
    .inSingletonScope();
});
