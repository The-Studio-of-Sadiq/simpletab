import { copyFileSync, cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreSrcDir = path.resolve(uiDir, "../core/src");

function resolveCoreTarget(subpath) {
  const base = path.join(coreSrcDir, subpath);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

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
  entryPoints: {
    "browser/tab-ui-frontend-module": path.join(uiDir, "src/browser/tab-ui-frontend-module.ts"),
  },
  outdir: path.join(uiDir, "lib"),
  bundle: true,
  platform: "browser",
  format: "esm",
  sourcemap: true,
  jsx: "transform",
  logLevel: "info",
  external: [
    "@theia/*",
    "@simpletab/host/*",
    "@simpletab/extensions/*",
    "react",
    "react-dom",
    "intl-messageformat",
    "papaparse",
    "./style/*",
  ],
  plugins: [simpletabCoreAliasPlugin],
});

const assets = [
  ["src/browser/style/simpletab-status.css", "lib/browser/style/simpletab-status.css"],
  ["src/browser/style/simpletab.css", "lib/browser/style/simpletab.css"],
  ["src/browser/style/simpletab-brand.css", "lib/browser/style/simpletab-brand.css"],
  ["src/browser/style/simpletab-projector.css", "lib/browser/style/simpletab-projector.css"],
  ["src/browser/projector.html", "lib/browser/projector.html"],
];

for (const [srcRel, destRel] of assets) {
  const srcPath = path.join(uiDir, srcRel);
  if (!existsSync(srcPath)) {
    continue;
  }
  const destPath = path.join(uiDir, destRel);
  mkdirSync(path.dirname(destPath), { recursive: true });
  copyFileSync(srcPath, destPath);
}

// The brand stylesheet loads Inter from ./fonts (with its licence), so the folder ships next to it.
const fontsSrc = path.join(uiDir, "src/browser/style/fonts");
if (existsSync(fontsSrc)) {
  cpSync(fontsSrc, path.join(uiDir, "lib/browser/style/fonts"), { recursive: true });
}
