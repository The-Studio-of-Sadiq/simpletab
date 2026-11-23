import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { injectable } from "@theia/core/shared/inversify";
import { app, safeStorage } from "@theia/electron/shared/electron";
import {
  CREDENTIAL_NAMES,
  type CredentialName,
  type CredentialStatusEntry,
  type CredentialTestResult,
  type CredentialsService,
} from "../common/credentials-protocol";

interface CredentialMetaRecord {
  testedAt?: string;
  ok?: boolean;
}

type CredentialMetadataMap = Partial<Record<CredentialName, CredentialMetaRecord>>;

function assertCredentialName(name: string): asserts name is CredentialName {
  if (!CREDENTIAL_NAMES.includes(name as CredentialName)) {
    throw new Error(`Unknown credential name: "${name}".`);
  }
}

@injectable()
export class ElectronCredentialsService implements CredentialsService {
  private smokeQuitScheduled = false;

  async status(): Promise<CredentialStatusEntry[]> {
    const metadata = this.readMetadata();
    const entries: CredentialStatusEntry[] = CREDENTIAL_NAMES.map((name) => {
      const hasSecret = existsSync(this.blobPath(name));
      const record = metadata[name];
      return {
        name,
        set: hasSecret,
        ...(record?.testedAt !== undefined ? { testedAt: record.testedAt } : {}),
        ...(record?.ok !== undefined ? { ok: record.ok } : {}),
      };
    });

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

    return entries;
  }

  async set(name: CredentialName, value: string): Promise<void> {
    assertCredentialName(name);
    if (value.length === 0) {
      throw new Error("Credential value must not be empty.");
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Electron safeStorage encryption is unavailable on this host.");
    }
    this.ensureStorageDir();
    const encrypted = safeStorage.encryptString(value);
    writeFileSync(this.blobPath(name), encrypted, { mode: 0o600 });

    const metadata = this.readMetadata();
    delete metadata[name];
    this.writeMetadata(metadata);
  }

  async clear(name: CredentialName): Promise<void> {
    assertCredentialName(name);
    rmSync(this.blobPath(name), { force: true });
    const metadata = this.readMetadata();
    if (name in metadata) {
      delete metadata[name];
      this.writeMetadata(metadata);
    }
  }

  async test(name: CredentialName): Promise<CredentialTestResult> {
    assertCredentialName(name);
    const blobFile = this.blobPath(name);
    if (!existsSync(blobFile)) {
      return { ok: false, error: "Credential is not set." };
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: "Electron safeStorage encryption is unavailable." };
    }

    const testedAt = new Date().toISOString();
    try {
      const encrypted = readFileSync(blobFile);
      const decrypted = safeStorage.decryptString(encrypted);
      const ok = decrypted.length > 0;
      const result: CredentialTestResult = ok
        ? { ok: true }
        : { ok: false, error: "Stored credential is empty." };
      this.recordTestResult(name, testedAt, result.ok);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordTestResult(name, testedAt, false);
      return { ok: false, error: message };
    }
  }

  private storageDir(): string {
    return path.join(app.getPath("userData"), "credentials");
  }

  private blobPath(name: CredentialName): string {
    return path.join(this.storageDir(), `${name}.enc`);
  }

  private metadataPath(): string {
    return path.join(this.storageDir(), "metadata.json");
  }

  private ensureStorageDir(): void {
    mkdirSync(this.storageDir(), { recursive: true });
  }

  private readMetadata(): CredentialMetadataMap {
    const file = this.metadataPath();
    if (!existsSync(file)) {
      return {};
    }
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as CredentialMetadataMap;
      return parsed ?? {};
    } catch {
      return {};
    }
  }

  private writeMetadata(metadata: CredentialMetadataMap): void {
    this.ensureStorageDir();
    writeFileSync(this.metadataPath(), JSON.stringify(metadata, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  private recordTestResult(name: CredentialName, testedAt: string, ok: boolean): void {
    const metadata = this.readMetadata();
    metadata[name] = { testedAt, ok };
    this.writeMetadata(metadata);
  }
}
