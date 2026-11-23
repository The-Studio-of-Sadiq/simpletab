/**
 * Worker-thread bootstrapper for `long-op-worker.ts`.
 *
 * When running from compiled JS (`long-op-worker.js` next to this file), imports it directly.
 * When running directly from TypeScript sources (e.g. Vitest), registers a Node `module.registerHooks`
 * resolver/loader that mirrors tsconfig's `@/` and `@simpletab/core/*` aliases and transpiles `.ts`
 * files via `typescript.transpileModule` (handling extensionless imports, parameter properties,
 * and type-only imports without `import type`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const compiledWorkerPath = path.join(thisDir, "long-op-worker.js");

if (fs.existsSync(compiledWorkerPath)) {
  await import(pathToFileURL(compiledWorkerPath).href);
} else {
  const [{ registerHooks }, tsModule] = await Promise.all([
    import("node:module"),
    import("typescript"),
  ]);
  const ts = tsModule.default;
  const coreSrcDir = path.resolve(thisDir, "../../../../core/src");

  const resolveTsFile = (basePath) => {
    const candidates = [
      basePath,
      `${basePath}.ts`,
      `${basePath}.tsx`,
      path.join(basePath, "index.ts"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return pathToFileURL(candidate).href;
      }
    }
    return null;
  };

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith("@/")) {
        const hit = resolveTsFile(path.join(coreSrcDir, specifier.slice(2)));
        if (hit !== null) {
          return { url: hit, shortCircuit: true };
        }
      }
      if (specifier === "@simpletab/core") {
        const hit = resolveTsFile(coreSrcDir);
        if (hit !== null) {
          return { url: hit, shortCircuit: true };
        }
      }
      if (specifier.startsWith("@simpletab/core/")) {
        const hit = resolveTsFile(
          path.join(coreSrcDir, specifier.slice("@simpletab/core/".length)),
        );
        if (hit !== null) {
          return { url: hit, shortCircuit: true };
        }
      }
      if (
        (specifier.startsWith("./") || specifier.startsWith("../")) &&
        context.parentURL !== undefined &&
        context.parentURL.startsWith("file:")
      ) {
        const parentDir = path.dirname(fileURLToPath(context.parentURL));
        const hit = resolveTsFile(path.resolve(parentDir, specifier));
        if (hit !== null) {
          return { url: hit, shortCircuit: true };
        }
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith("file:") && (url.endsWith(".ts") || url.endsWith(".tsx"))) {
        const filePath = fileURLToPath(url);
        const source = fs.readFileSync(filePath, "utf8");
        const { outputText } = ts.transpileModule(source, {
          fileName: filePath,
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
            verbatimModuleSyntax: false,
            esModuleInterop: true,
          },
        });
        return { format: "module", source: outputText, shortCircuit: true };
      }
      if (url.startsWith("file:") && url.endsWith(".json")) {
        const source = fs.readFileSync(fileURLToPath(url), "utf8");
        return { format: "json", source, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });

  await import(pathToFileURL(path.join(thisDir, "long-op-worker.ts")).href);
}
