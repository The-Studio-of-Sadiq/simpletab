import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const hostDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreSrcDir = path.resolve(hostDir, "../core/src");

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

const commonOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: true,
  logLevel: "info",
  external: [
    "@theia/*",
    "electron",
    "better-sqlite3",
    "fflate",
    "papaparse",
  ],
  plugins: [simpletabCoreAliasPlugin],
};

await esbuild.build({
  ...commonOptions,
  entryPoints: {
    "common/host-protocol": path.join(hostDir, "src/common/host-protocol.ts"),
    "common/credentials-protocol": path.join(hostDir, "src/common/credentials-protocol.ts"),
    "common/projector-protocol": path.join(hostDir, "src/common/projector-protocol.ts"),
    "node/host-backend-module": path.join(hostDir, "src/node/host-backend-module.ts"),
    "node/engine/long-op-worker": path.join(hostDir, "src/node/engine/long-op-worker.ts"),
    "electron-main/host-main-module": path.join(hostDir, "src/electron-main/host-main-module.ts"),
  },
  outdir: path.join(hostDir, "lib"),
});

const assets = [
  ["src/node/db/schema.sql", "lib/node/db/schema.sql"],
  [
    "src/node/db/migrations/002_replay_and_host_meta.sql",
    "lib/node/db/migrations/002_replay_and_host_meta.sql",
  ],
  [
    "src/node/engine/long-op-worker-bootstrap.mjs",
    "lib/node/engine/long-op-worker-bootstrap.mjs",
  ],
];

for (const [srcRel, destRel] of assets) {
  const srcPath = path.join(hostDir, srcRel);
  const destPath = path.join(hostDir, destRel);
  mkdirSync(path.dirname(destPath), { recursive: true });
  copyFileSync(srcPath, destPath);
}
