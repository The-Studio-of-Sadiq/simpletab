/**
 * Which organiser-installed extensions this process loaded at start-up (design section 11, item
 * 6). `@simpletab/extensions` decides and records it; the host reads it before this laptop opens
 * or creates a tournament. The record lives on `globalThis` under a registered symbol because each
 * SimpleTab package is bundled on its own, so a plain module variable would not be shared.
 */
export interface ExtensionsRuntime {
  /** Extensions loaded in this process (id@version); they stay loaded until a restart. */
  loaded: string[];
  /** Developer mode now, read from the user's settings file. */
  developerModeNow(): boolean;
}

const KEY = Symbol.for("simpletab.extensions.runtime");

type WithRuntime = typeof globalThis & { [KEY]?: ExtensionsRuntime };

export function setExtensionsRuntime(runtime: ExtensionsRuntime | undefined): void {
  (globalThis as WithRuntime)[KEY] = runtime;
}

export function getExtensionsRuntime(): ExtensionsRuntime | undefined {
  return (globalThis as WithRuntime)[KEY];
}

/** Thrown when this laptop would become the host while extensions are loaded and developer mode is off. */
export class ExtensionsLoadedError extends Error {
  constructor(loaded: readonly string[]) {
    super(
      `Extensions are loaded (${loaded.join(", ")}). Restart SimpleTab to unload them before this laptop opens or creates a tournament, or turn on developer mode.`,
    );
    this.name = "ExtensionsLoadedError";
  }
}

/** The becoming-host rule: refuses while extensions are loaded unless developer mode is on now. */
export function assertMayHostWithExtensions(): void {
  const runtime = getExtensionsRuntime();
  if (runtime === undefined || runtime.loaded.length === 0) return;
  if (runtime.developerModeNow()) return;
  throw new ExtensionsLoadedError(runtime.loaded);
}
