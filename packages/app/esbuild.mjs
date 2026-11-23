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
    plugins: [
        simpletabCoreAliasPlugin,
        ...(browserOptions.plugins ?? []),
    ],
};

const customNodeOptions = {
    ...nodeOptions,
    external: [
        ...(nodeOptions.external ?? []),
        'better-sqlite3',
    ],
    plugins: [
        simpletabCoreAliasPlugin,
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
