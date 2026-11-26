import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "jsonc-parser";

/** The preference the frontend sets (`tab-ui/src/browser/developer-mode.ts`). */
export const DEVELOPER_MODE_PREFERENCE = "simpletab.developerMode";

/**
 * Developer mode as saved in the user's settings file (`settings.json` in Theia's config folder).
 * The backend reads it at start-up, before any window exists. Missing or unreadable means off.
 */
export function readDeveloperMode(configDir: string): boolean {
  const file = path.join(configDir, "settings.json");
  if (!existsSync(file)) return false;
  try {
    const settings = parse(readFileSync(file, "utf8")) as unknown;
    return (
      typeof settings === "object" &&
      settings !== null &&
      (settings as Record<string, unknown>)[DEVELOPER_MODE_PREFERENCE] === true
    );
  } catch {
    return false;
  }
}
