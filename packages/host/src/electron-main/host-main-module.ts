import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { appendFileSync } from "node:fs";
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
  attachGitHubArchiveIpcHandler,
  isGitHubArchiveIpcRequest,
} from "./github-archive-ipc";
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
  private detachGitHubArchiveIpc: (() => void) | null = null;
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
    const forkOptions = await this.getForkOptions();
    const backendProcess = fork(
      this.globals.THEIA_BACKEND_MAIN_PATH,
      this.processArgv.getProcessArgvWithoutBin(),
      {
        ...forkOptions,
        // Theia's backend exits when the process named here is gone. Started from `theia start`,
        // this process inherits the CLI's id; after "Restart SimpleTab" relaunches the app (design
        // section 11, item 6), that process no longer exists and the new backend would quit within
        // seconds. The backend's real parent is this process.
        env: { ...forkOptions.env, THEIA_PARENT_PID: String(process.pid) },
        // Pipes that this process drains, so SIMPLETAB_BACKEND_LOG can copy the backend's output.
        silent: true,
      },
    );
    forwardBackendOutput(backendProcess);

    this.detachIpcHandlers();
    this.detachCredentialsIpc = attachCredentialsIpcHandler(
      backendProcess,
      this.simpleTabCredentials,
    );
    // Electron's network stack, so the system proxy settings apply as for the ballots service.
    const mainFetch = (input: string, init: RequestInit): Promise<Response> =>
      net !== undefined && typeof net.fetch === "function"
        ? net.fetch(input, init)
        : globalThis.fetch(input, init);
    this.detachPagesDeployIpc = attachPagesDeployIpcHandler(backendProcess, {
      // A vault of its own, not the RPC-served credentials service: every public method of that
      // service is callable from the frontend, and the token must never reach it.
      getToken: async () => this.mainOnlyVault().readSecretForElectronMain("cdnToken"),
      fetchImpl: mainFetch,
    });
    this.detachGitHubArchiveIpc = attachGitHubArchiveIpcHandler(backendProcess, {
      getToken: async () => this.mainOnlyVault().readSecretForElectronMain("githubToken"),
      fetchImpl: mainFetch,
    });

    return new Promise<number>((resolve, reject) => {
      let portResolved = false;

      const onMessage = (raw: unknown): void => {
        if (
          isCredentialsFetchIpcRequest(raw) ||
          isPagesDeployIpcRequest(raw) ||
          isGitHubArchiveIpcRequest(raw)
        ) {
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
    this.detachGitHubArchiveIpc?.();
    this.detachGitHubArchiveIpc = null;
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

/**
 * Copies the backend's output to this process's output, and to `SIMPLETAB_BACKEND_LOG` when set
 * (a relaunched or packaged app has no console to read it in). A failed copy never reaches the
 * backend: its pipes are always drained.
 */
function forwardBackendOutput(child: ChildProcess): void {
  const forward = (from: NodeJS.ReadableStream | null, to: NodeJS.WriteStream): void => {
    if (from === null) return;
    // A failed write to this process's own output is log loss only; it must not stop the app.
    to.on("error", () => undefined);
    from.on("data", (chunk: Buffer) => {
      try {
        if (to.writable) to.write(chunk);
      } catch {
        // Same: the chunk is dropped, the backend keeps running.
      }
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  // For diagnosing a backend that has no console (a relaunched or packaged app).
  const logFile = process.env.SIMPLETAB_BACKEND_LOG;
  if (logFile !== undefined && logFile.trim().length > 0) {
    const append = (chunk: Buffer): void => {
      try {
        appendFileSync(logFile, chunk);
      } catch {
        // Diagnostics only.
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("exit", (code, signal) => append(Buffer.from(`
[backend exited: code=${String(code)} signal=${String(signal)}]
`)));
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
