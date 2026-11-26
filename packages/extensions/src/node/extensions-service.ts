import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getExtensionsRuntime } from "@simpletab/host/src/node/extensions-runtime";
import { PairingStore } from "@simpletab/host/src/node/device/pairing-store";
import type {
  ExtensionsErrorCode,
  ExtensionsLoadingReason,
  ExtensionsResult,
  ExtensionsService,
  ExtensionsStatus,
} from "../common/extensions-protocol";
import { vsixFileName, type CuratedExtension } from "./curated-list";
import { readDeveloperMode } from "./developer-mode-setting";
import { readOffIds, scanStore, writeOffIds } from "./extension-store";
import { decideLoading } from "./loading-rule";

/** What the service needs from the laptop; tests give their own. */
export interface ExtensionsServiceOptions {
  list: readonly CuratedExtension[];
  extensionsDir: string;
  configDir(): Promise<string>;
  pairedAsStaffDevice(): boolean;
  /** Loaded in this run (id@version) and the start-up rule; from the start-up participant. */
  loaded(): readonly string[];
  startupReason(): ExtensionsLoadingReason | null;
  /** Downloads a file; the default uses `fetch`. */
  download?(url: string): Promise<Uint8Array>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function failure(code: ExtensionsErrorCode, message: string): ExtensionsResult {
  return { ok: false, code, errors: [message] };
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Installs, removes and turns on or off the extensions on SimpleTab's list (design section 11,
 * item 6). Every file is kept only after its SHA-256 matches the list. Nothing here loads or
 * unloads an extension: that happens at the next start, when the loading rule decides again.
 */
export class ExtensionsServiceImpl implements ExtensionsService {
  constructor(private readonly options: ExtensionsServiceOptions) {}

  async status(): Promise<ExtensionsStatus> {
    const { list, extensionsDir } = this.options;
    const scan = scanStore(extensionsDir, list);
    const decision = decideLoading({
      pairedAsStaffDevice: this.options.pairedAsStaffDevice(),
      developerMode: readDeveloperMode(await this.options.configDir()),
      verified: scan.verified,
      off: scan.off,
    });
    const loaded = new Set(this.options.loaded());
    const off = new Set(scan.off.map((id) => id.toLowerCase()));
    const installed = new Set(scan.verified.map((entry) => entry.id));
    const wouldLoad = new Set(decision.load.map((entry) => `${entry.id}@${entry.version}`));
    const restartNeeded =
      wouldLoad.size !== loaded.size || [...wouldLoad].some((key) => !loaded.has(key));
    return {
      extensions: list.map((entry) => ({
        id: entry.id,
        version: entry.version,
        name: entry.name,
        purpose: entry.purpose,
        license: entry.license,
        installed: installed.has(entry.id),
        on: !off.has(entry.id.toLowerCase()),
        loaded: loaded.has(`${entry.id}@${entry.version}`),
      })),
      reason: decision.reason,
      startupReason: this.options.startupReason(),
      restartNeeded,
      ignoredFiles: scan.rejected,
    };
  }

  async install(id: string): Promise<ExtensionsResult> {
    const entry = this.entry(id);
    if (entry === undefined) return failure("NOT_LISTED", `${id} is not on SimpleTab's extension list.`);
    let bytes: Uint8Array;
    try {
      bytes = await (this.options.download ?? fetchBytes)(entry.url);
    } catch (error) {
      return failure("DOWNLOAD_FAILED", `Could not download ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.keep(entry, bytes);
  }

  async installFromFile(filePath: string): Promise<ExtensionsResult> {
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(filePath);
    } catch (error) {
      return failure("FILE_UNREADABLE", `Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    // A file is matched by its checksum, so a renamed file still installs and a changed one never does.
    const hash = sha256(bytes);
    const entry = this.options.list.find((item) => item.sha256 === hash);
    if (entry === undefined) {
      return failure("HASH_MISMATCH", `${path.basename(filePath)} is not a version on SimpleTab's extension list (its checksum matches none).`);
    }
    return this.keep(entry, bytes);
  }

  async remove(id: string): Promise<ExtensionsResult> {
    const entry = this.entry(id);
    if (entry === undefined) return failure("NOT_LISTED", `${id} is not on SimpleTab's extension list.`);
    const file = path.join(this.options.extensionsDir, vsixFileName(entry));
    if (!existsSync(file)) return failure("NOT_INSTALLED", `${entry.name} is not installed.`);
    rmSync(file, { force: true });
    writeOffIds(this.options.extensionsDir, readOffIds(this.options.extensionsDir).filter((item) => item.toLowerCase() !== entry.id.toLowerCase()));
    return { ok: true, status: await this.status() };
  }

  async setOn(id: string, on: boolean): Promise<ExtensionsResult> {
    const entry = this.entry(id);
    if (entry === undefined) return failure("NOT_LISTED", `${id} is not on SimpleTab's extension list.`);
    if (!existsSync(path.join(this.options.extensionsDir, vsixFileName(entry)))) {
      return failure("NOT_INSTALLED", `${entry.name} is not installed.`);
    }
    const others = readOffIds(this.options.extensionsDir).filter((item) => item.toLowerCase() !== entry.id.toLowerCase());
    writeOffIds(this.options.extensionsDir, on ? others : [...others, entry.id]);
    return { ok: true, status: await this.status() };
  }

  private entry(id: string): CuratedExtension | undefined {
    return this.options.list.find((item) => item.id.toLowerCase() === id.toLowerCase());
  }

  /** Writes the file only if its SHA-256 matches, through a temporary name so a half-written file never counts. */
  private async keep(entry: CuratedExtension, bytes: Uint8Array): Promise<ExtensionsResult> {
    if (sha256(bytes) !== entry.sha256) {
      return failure("HASH_MISMATCH", `The file for ${entry.name} ${entry.version} does not match SimpleTab's checksum, so it was not installed.`);
    }
    mkdirSync(this.options.extensionsDir, { recursive: true });
    const target = path.join(this.options.extensionsDir, vsixFileName(entry));
    const partial = `${target}.partial`;
    writeFileSync(partial, bytes);
    renameSync(partial, target);
    return { ok: true, status: await this.status() };
  }
}

/** The running app's options: SimpleTab's folder, Theia's config folder, the saved pairing. */
export function defaultServiceOptions(
  list: readonly CuratedExtension[],
  extensionsDir: string,
  configDir: () => Promise<string>,
  startupReason: () => ExtensionsLoadingReason | null,
): ExtensionsServiceOptions {
  return {
    list,
    extensionsDir,
    configDir,
    pairedAsStaffDevice: () => new PairingStore().load() !== undefined,
    loaded: () => getExtensionsRuntime()?.loaded ?? [],
    startupReason,
  };
}
