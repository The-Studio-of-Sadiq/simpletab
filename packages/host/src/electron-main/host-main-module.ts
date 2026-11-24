import { fork, type ForkOptions } from "node:child_process";
import path from "node:path";
import { CredentialsVault } from "./credentials-store";
import { FileUri } from "@theia/core/lib/common/file-uri";
import { ConnectionHandler, RpcConnectionHandler } from "@theia/core/lib/common/messaging";
import { ElectronSecurityToken } from "@theia/core/lib/electron-common/electron-token";
import {
  ElectronMainApplication,
  ElectronMainApplicationContribution,
} from "@theia/core/lib/electron-main/electron-main-application";
import { ElectronConnectionHandler } from "@theia/core/lib/electron-main/messaging/electron-connection-handler";
import { inject, injectable } from "@theia/core/shared/inversify";
import { ContainerModule } from "@theia/core/shared/inversify";
import { app, net, safeStorage } from "@theia/electron/shared/electron";
import { isCredentialsFetchIpcRequest } from "../common/credentials-ipc";
import {
  CREDENTIALS_SERVICE_PATH,
  CredentialsService,
} from "../common/credentials-protocol";
import {
  PROJECTOR_SERVICE_PATH,
  type ProjectorServiceClient,
} from "../common/projector-protocol";
import { ElectronCredentialsService } from "./credentials";
import { attachCredentialsIpcHandler } from "./credentials-ipc";
import {
  attachPagesDeployIpcHandler,
  isPagesDeployIpcRequest,
} from "./pages-deploy-ipc";
import { ElectronProjectorService } from "./projector-window";

const BACKEND_MAX_OLD_SPACE_ARG = "--max-old-space-size=2048";
const SMOKE_TIMEOUT_MS = 45_000;

@injectable()
export class SimpleTabElectronMainApplication extends ElectronMainApplication {
  @inject(ElectronCredentialsService)
  protected readonly simpleTabCredentials!: ElectronCredentialsService;

  private detachCredentialsIpc: (() => void) | null = null;
  private detachPagesDeployIpc: (() => void) | null = null;
  private mainVault: CredentialsVault | null = null;

  private mainOnlyVault(): CredentialsVault {
    if (this.mainVault === null) {
      this.mainVault = new CredentialsVault({
        getStorageDir: () => path.join(app.getPath("userData"), "credentials"),
        isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
        encryptString: (plain: string) => safeStorage.encryptString(plain),
        decryptString: (encrypted: Buffer) => safeStorage.decryptString(encrypted),
      });
    }
    return this.mainVault;
  }

  protected override async startBackend(): Promise<number> {
    if (process.argv.includes("--no-cluster")) {
      return super.startBackend();
    }

    process.env.THEIA_ELECTRON_VERSION = process.versions.electron;
    const backendProcess = fork(
      this.globals.THEIA_BACKEND_MAIN_PATH,
      this.processArgv.getProcessArgvWithoutBin(),
      await this.getForkOptions(),
    );

    this.detachIpcHandlers();
    this.detachCredentialsIpc = attachCredentialsIpcHandler(
      backendProcess,
      this.simpleTabCredentials,
    );
    this.detachPagesDeployIpc = attachPagesDeployIpcHandler(backendProcess, {
      // A vault of its own, not the RPC-served credentials service: every public method of that
      // service is callable from the frontend, and the token must never reach it.
      getToken: async () => this.mainOnlyVault().readSecretForElectronMain("cdnToken"),
      // Electron's network stack, so the system proxy settings apply as for the ballots service.
      fetchImpl: (input, init) =>
        net !== undefined && typeof net.fetch === "function"
          ? net.fetch(input, init)
          : globalThis.fetch(input, init),
    });

    return new Promise<number>((resolve, reject) => {
      let portResolved = false;

      const onMessage = (raw: unknown): void => {
        if (isCredentialsFetchIpcRequest(raw) || isPagesDeployIpcRequest(raw)) {
          return;
        }
        if (
          raw !== null &&
          typeof raw === "object" &&
          typeof (raw as { port?: unknown }).port === "number"
        ) {
          if (!portResolved) {
            portResolved = true;
            backendProcess.off("message", onMessage);
            resolve((raw as { port: number }).port);
          }
        }
      };

      backendProcess.on("message", onMessage);
      backendProcess.on("error", (error) => {
        if (!portResolved) {
          portResolved = true;
          reject(error);
        }
      });
      backendProcess.on("exit", (code) => {
        this.detachIpcHandlers();
        if (!portResolved) {
          portResolved = true;
          reject(new Error(`Backend exited before reporting port (code=${String(code)})`));
        }
      });

      app.on("quit", () => {
        this.detachIpcHandlers();
        if (
          backendProcess.exitCode === null &&
          backendProcess.signalCode === null &&
          backendProcess.pid !== undefined
        ) {
          try {
            process.kill(backendProcess.pid);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
              throw error;
            }
          }
        }
      });
    });
  }

  private detachIpcHandlers(): void {
    this.detachCredentialsIpc?.();
    this.detachCredentialsIpc = null;
    this.detachPagesDeployIpc?.();
    this.detachPagesDeployIpc = null;
  }

  protected override async getForkOptions(): Promise<ForkOptions> {
    const baseOptions = await super.getForkOptions();
    const filteredExecArgv = (baseOptions.execArgv ?? process.execArgv).filter(
      (arg) => !arg.startsWith("--max-old-space-size"),
    );
    const env: NodeJS.ProcessEnv = { ...(baseOptions.env ?? process.env) };
    env[ElectronSecurityToken] = JSON.stringify(this.electronSecurityToken);
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
        new RpcConnectionHandler(CREDENTIALS_SERVICE_PATH, () => {
          const service = ctx.container.get<CredentialsService>(CredentialsService);
          // Expose only status/set/clear/test to the renderer; credentials.fetch stays backend-only.
          return {
            status: () => service.status(),
            set: (name, value) => service.set(name, value),
            clear: (name) => service.clear(name),
            test: (name) => service.test(name),
          } satisfies CredentialsService;
        }),
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
