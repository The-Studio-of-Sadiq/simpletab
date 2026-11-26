import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The host's runtime record is bundled in here too; it is shared through globalThis, not the module.
await esbuild.build({
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: true,
  logLevel: "info",
  external: ["@theia/*", "electron", "better-sqlite3", "jsonc-parser"],
  entryPoints: {
    "node/extensions-backend-module": path.join(packageDir, "src/node/extensions-backend-module.ts"),
  },
  outdir: path.join(packageDir, "lib"),
});
