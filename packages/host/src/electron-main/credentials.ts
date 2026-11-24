import path from "node:path";
import { injectable } from "@theia/core/shared/inversify";
import { app, net, safeStorage } from "@theia/electron/shared/electron";
import type {
  CredentialName,
  CredentialStatusEntry,
  CredentialTestResult,
  CredentialsFetchClient,
  CredentialsFetchName,
  CredentialsFetchRequest,
  CredentialsFetchResponse,
  CredentialsService,
} from "../common/credentials-protocol";
import { CredentialsVault } from "./credentials-store";

@injectable()
export class ElectronCredentialsService
  implements CredentialsService, CredentialsFetchClient
{
  private smokeQuitScheduled = false;
  private demoQuitScheduled = false;
  private readonly vault = new CredentialsVault({
    getStorageDir: () => path.join(app.getPath("userData"), "credentials"),
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plain: string) => safeStorage.encryptString(plain),
    decryptString: (encrypted: Buffer) => safeStorage.decryptString(encrypted),
    fetchImpl: (input, init) =>
      net !== undefined && typeof net.fetch === "function"
        ? net.fetch(input instanceof URL ? input.toString() : input, init)
        : globalThis.fetch(input, init),
  });

  async status(): Promise<CredentialStatusEntry[]> {
    const entries = await this.vault.status();

    if (process.env.SIMPLETAB_SMOKE === "1" && !this.smokeQuitScheduled) {
      this.smokeQuitScheduled = true;
      setTimeout(() => {
        app.quit();
        const forceExitTimer = setTimeout(() => {
          app.exit(0);
        }, 3000);
        forceExitTimer.unref();
      }, 2000);
    }
    if (process.env.SIMPLETAB_DEMO === "1" && !this.demoQuitScheduled) {
      this.demoQuitScheduled = true;
      setTimeout(() => {
        app.quit();
        const forceExitTimer = setTimeout(() => {
          app.exit(0);
        }, 5000);
        forceExitTimer.unref();
      }, 5000);
    }

    return entries;
  }

  async set(name: CredentialName, value: string): Promise<void> {
    await this.vault.set(name, value);
  }

  async clear(name: CredentialName): Promise<void> {
    await this.vault.clear(name);
  }

  async test(name: CredentialName): Promise<CredentialTestResult> {
    return this.vault.test(name);
  }

  async fetch(
    name: CredentialsFetchName,
    req: CredentialsFetchRequest,
  ): Promise<CredentialsFetchResponse> {
    return this.vault.fetch(name, req);
  }
}
