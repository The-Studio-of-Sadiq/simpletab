/** Design section 11, item 6: the Extensions page talks to the backend through this service. */
export const EXTENSIONS_SERVICE_PATH = "/services/simpletab-extensions";
/** Relaunching the whole app (backend included) lives in Electron's main process. */
export const EXTENSIONS_RESTART_PATH = "/services/simpletab-extensions-restart";

export const ExtensionsService = Symbol("SimpleTabExtensionsService");
export const ExtensionsRestartService = Symbol("SimpleTabExtensionsRestartService");

/** Why extensions do or do not load on this laptop (`decideLoading`). */
export type ExtensionsLoadingReason = "staff-device" | "developer-mode" | "may-host";

export interface ExtensionEntryStatus {
  id: string;
  version: string;
  name: string;
  purpose: string;
  license: string;
  /** A verified file for this version is in SimpleTab's folder. */
  installed: boolean;
  /** Not turned off by the organiser. */
  on: boolean;
  /** Loaded in this run of the app. */
  loaded: boolean;
}

export interface ExtensionsStatus {
  extensions: ExtensionEntryStatus[];
  /** The rule as it applies now (pairing and developer mode read again). */
  reason: ExtensionsLoadingReason;
  /** The rule that applied at start-up, when the loaded extensions were chosen. */
  startupReason: ExtensionsLoadingReason | null;
  /** What loads after a restart differs from what is loaded now. */
  restartNeeded: boolean;
  /** Files in the folder that are not on the list, or whose checksum does not match. */
  ignoredFiles: Array<{ file: string; reason: "not-listed" | "hash-mismatch" }>;
}

/** Every change returns the new status, or a reason the page shows as it is. */
export type ExtensionsResult =
  | { ok: true; status: ExtensionsStatus }
  | { ok: false; code: ExtensionsErrorCode; errors: string[] };

export type ExtensionsErrorCode =
  | "NOT_LISTED"
  | "HASH_MISMATCH"
  | "DOWNLOAD_FAILED"
  | "NOT_INSTALLED"
  | "FILE_UNREADABLE";

export interface ExtensionsService {
  status(): Promise<ExtensionsStatus>;
  /** Downloads the pinned file from Open VSX and keeps it only if its SHA-256 matches. */
  install(id: string): Promise<ExtensionsResult>;
  /** Copies a `.vsix` the organiser chose, if its SHA-256 matches a listed extension. */
  installFromFile(filePath: string): Promise<ExtensionsResult>;
  remove(id: string): Promise<ExtensionsResult>;
  setOn(id: string, on: boolean): Promise<ExtensionsResult>;
}

export interface ExtensionsRestartService {
  /** Quits and starts SimpleTab again, so the backend decides afresh which extensions load. */
  relaunch(): Promise<void>;
}
