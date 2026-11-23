# `@simpletab/app`

SimpleTab desktop application shell built on **Eclipse Theia 1.77.0** (Electron **44.9.1**).

## Commands

Run from the repository root:

```powershell
# 1. Build @simpletab/host, @simpletab/tab-ui, and the Theia Electron app
npm run build -w packages/app

# 2. Rebuild native addons (including better-sqlite3) for Electron 44.9.1
npm run rebuild -w packages/app

# 3. Start the Electron app
npm run start -w packages/app

# 4. Run the 3-process smoke test (auto-creates demo tournament, logs SIMPLETAB_SMOKE_OK, quits after ~2s)
$env:SIMPLETAB_SMOKE="1"; npm run start -w packages/app; Remove-Item Env:SIMPLETAB_SMOKE

# 5. Restore native addons for host Node ABI before running Vitest
npm run rebuild:node -w packages/app
npm test
```

## Module Resolution (`@/` and `@simpletab/core/*`)

Eclipse Theia 1.77.0 removed Webpack (since 1.75.0) and uses **esbuild** (`packages/app/esbuild.mjs` + generated `gen-esbuild.*.mjs`) with ESM output (`format: 'esm'`) for the backend and electron-main processes.

- **`packages/host`**:
  - `tsc -p tsconfig.build.json --noEmit` typechecks all host TypeScript sources against `packages/core/src`.
  - `tsc -p tsconfig.common.json` emits `lib/common/{host-protocol,credentials-protocol}.{js,d.ts}` for `@simpletab/tab-ui`.
  - `node scripts/build.mjs` bundles `node/host-backend-module.js`, `node/engine/long-op-worker.js`, and `electron-main/host-main-module.js` with `esbuild`, resolving `@/*` and `@simpletab/core/*` to `packages/core/src/*` while keeping `@theia/*`, `electron`, `better-sqlite3`, `fflate`, and `papaparse` external, and copies SQL migrations and `long-op-worker-bootstrap.mjs` into `lib/node/`.
- **`packages/app/esbuild.mjs`**:
  - Registers `simpletabCoreAliasPlugin` on both `browserOptions` and `nodeOptions` so `@/*` and `@simpletab/core/*` resolve to `packages/core/src/*`.
  - Marks `better-sqlite3` as `external` in `nodeOptions` so Node loads the native addon from `node_modules/better-sqlite3`.
  - Copies `schema.sql`, `migrations/002_replay_and_host_meta.sql`, `long-op-worker-bootstrap.mjs`, and `long-op-worker.js` into `packages/app/lib/backend/` alongside `main.js` so `import.meta.url`-relative lookups work at runtime.
  - Note: `packages/host/src/electron-main/host-main-module.ts` rebinds `ElectronMainApplication` (`SimpleTabElectronMainApplication`) to launch the backend process with `--max-old-space-size=2048`.

## Native Module ABI (`better-sqlite3` + Electron 44.9.1)

Electron 44.9.1 and Node 24 have different N-API / V8 module ABIs, so `better-sqlite3` (and Theia's native addons `native-keymap`, `drivelist`, `keytar`) must match whichever runtime executes them:

- **`npm run rebuild -w packages/app`** runs `theia rebuild:electron --modules native-keymap drivelist keytar better-sqlite3`, which snapshots the Node-ABI copies into `packages/app/.browser_modules` and runs `@electron/rebuild` for Electron 44.9.1.
- **`npm run rebuild:node -w packages/app`** runs `theia rebuild:browser --modules native-keymap drivelist keytar better-sqlite3`, restoring the cached Node-ABI binaries so root `npm test` (Vitest on Node) continues to pass.
