import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreSrcDir = path.resolve(cliDir, "../core/src");

function resolveCoreTarget(subpath) {
  const base = path.join(coreSrcDir, subpath);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

// The same alias rule as the host's build: core is consumed as TypeScript source, never from a
// built copy, so the CLI and the app always run the one set of rules.
const simpletabCoreAliasPlugin = {
  name: "simpletab-core-alias",
  setup(build) {
    build.onResolve({ filter: /^(@\/|@simpletab\/core($|\/))/ }, (args) => {
      let subpath = "";
      if (args.path.startsWith("@/")) {
        subpath = args.path.slice(2);
      } else if (args.path.startsWith("@simpletab/core/")) {
        subpath = args.path.slice("@simpletab/core/".length);
      }
      const resolved = resolveCoreTarget(subpath);
      if (resolved !== null) {
        return { path: resolved };
      }
      return undefined;
    });
  },
};

await esbuild.build({
  entryPoints: { simpletab: path.join(cliDir, "src/main.ts") },
  outdir: path.join(cliDir, "lib"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  // Optional native pieces of `ws` and the host's database driver are never needed by the CLI.
  external: ["bufferutil", "utf-8-validate", "better-sqlite3"],
  // Some bundled dependencies are CommonJS; the banner gives them a `require` in an ESM file.
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  plugins: [simpletabCoreAliasPlugin],
});
