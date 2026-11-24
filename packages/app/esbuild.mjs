/**
 * This file can be edited to adjust the ESBuild build process.
 * To reset, delete this file and rerun theia build again.
 */
import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';
import { copy } from 'esbuild-plugin-copy';
import { __dirname, browserOptions, join, watch } from './gen-esbuild.browser.mjs';
import { nodeOptions } from './gen-esbuild.node.mjs';
import { electronOptions } from './gen-esbuild.electron.mjs';

const coreSrcDir = path.resolve(__dirname, '..', 'core', 'src');

function resolveCorePath(subpath) {
    const base = path.join(coreSrcDir, subpath);
    const candidates = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        path.join(base, 'index.ts'),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    }
    return undefined;
}

/**
 * Resolves `@/*` and `@simpletab/core/*` imports directly to `packages/core/src/*`.
 * @type {import('esbuild').Plugin}
 */
const simpletabCoreAliasPlugin = {
    name: 'simpletab-core-alias',
    setup(build) {
        build.onResolve({ filter: /^(@\/|@simpletab\/core($|\/))/ }, (args) => {
            let subpath = '';
            if (args.path.startsWith('@/')) {
                subpath = args.path.slice(2);
            } else if (args.path.startsWith('@simpletab/core/')) {
                subpath = args.path.slice('@simpletab/core/'.length);
            }
            const resolved = resolveCorePath(subpath);
            return resolved ? { path: resolved } : undefined;
        });
    },
};

const customBrowserOptions = {
    ...browserOptions,
    entryPoints: {
        ...browserOptions.entryPoints,
        'projector': path.resolve(__dirname, '..', 'tab-ui', 'src', 'browser', 'projector-entry.tsx'),
    },
    plugins: [
        simpletabCoreAliasPlugin,
        ...(browserOptions.plugins ?? []),
        copy({
            assets: [
                {
                    from: join(__dirname, '..', 'tab-ui', 'src', 'browser', 'projector.html'),
                    to: join(__dirname, 'lib', 'frontend'),
                },
                {
                    from: join(__dirname, '..', 'tab-ui', 'src', 'browser', 'style', 'simpletab-projector.css'),
                    to: join(__dirname, 'lib', 'frontend'),
                },
            ],
        }),
    ],
};

/**
 * `@vscode/windows-ca-certs` is an optional dependency of `@vscode/proxy-agent`
 * that may be absent on Windows (for example when its native addon is skipped on Node 24).
 * When missing, mark it external before `@theia/bundle-plugin` tries to resolve its `.node` binary;
 * `@vscode/proxy-agent` falls back to Node's built-in root certificates at runtime.
 * @type {import('esbuild').Plugin}
 */
const optionalWindowsCaCertsPlugin = {
    name: 'simpletab-optional-windows-ca-certs',
    setup(build) {
        build.onResolve({ filter: /^@vscode\/windows-ca-certs$/ }, () => {
            const candidate = path.resolve(
                __dirname,
                '..',
                '..',
                'node_modules',
                '@vscode',
                'windows-ca-certs',
                'build',
                'Release',
                'crypt32.node',
            );
            if (!fs.existsSync(candidate)) {
                return { path: '@vscode/windows-ca-certs', external: true };
            }
            return undefined;
        });
    },
};

const customNodeOptions = {
    ...nodeOptions,
    external: [
        ...(nodeOptions.external ?? []),
        'better-sqlite3',
    ],
    plugins: [
        simpletabCoreAliasPlugin,
        optionalWindowsCaCertsPlugin,
        ...(nodeOptions.plugins ?? []),
        copy({
            assets: [
                {
                    from: join(__dirname, '..', 'host', 'src', 'node', 'db', 'schema.sql'),
                    to: join(__dirname, 'lib', 'backend'),
                },
                {
                    from: join(__dirname, '..', 'host', 'src', 'node', 'db', 'migrations', '002_replay_and_host_meta.sql'),
                    to: join(__dirname, 'lib', 'backend', 'migrations'),
                },
                {
                    from: join(__dirname, '..', 'host', 'src', 'node', 'engine', 'long-op-worker-bootstrap.mjs'),
                    to: join(__dirname, 'lib', 'backend'),
                },
                {
                    from: join(__dirname, '..', 'host', 'lib', 'node', 'engine', 'long-op-worker.js'),
                    to: join(__dirname, 'lib', 'backend'),
                },
            ],
        }),
    ],
};

const browserContext = await esbuild.context(customBrowserOptions);
const nodeContext = await esbuild.context(customNodeOptions);
const electronContext = await esbuild.context(electronOptions);

if (watch) {
    await Promise.all([
        browserContext.watch(),
        nodeContext.watch(),
        electronContext.watch(),
    ]);
} else {
    try {
        await browserContext.rebuild();
        await browserContext.dispose();
        await nodeContext.rebuild();
        await nodeContext.dispose();
        await electronContext.rebuild();
        await electronContext.dispose();
    } catch {
        process.exit(1);
    }
}
