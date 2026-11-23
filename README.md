# SimpleTab

SimpleTab is a debate-tournament tabulation system for British Parliamentary and two-team formats. One laptop (the host) runs the whole tournament offline. Participants can optionally submit ballots online, and results can be published as static websites.

This repository is the desktop app and the shared tournament logic (`@simpletab/core`). The ballots service and the public site live in their own repositories (`simpletab-ballots`, `simpletab-public`).

**Status:** milestone M0 in progress. The design is in [docs/designs/simpletab.md](docs/designs/simpletab.md).

## Layout

| Path | What it is |
|---|---|
| `packages/core` | `@simpletab/core`: draws, adjudicator allocation, ballots, standings, break, CSV, public projection and permissions. Ported from CrabbyTab with its tests. It runs in Electron, Workers and browsers, so it has no Node, DOM or React code outside tests. |
| `tools/port-from-crabbytab.mjs` | The one-time script that copied CrabbyTab's logic into core. It refuses to run again unless given `--force`, because core has been edited since. |
| `tools/port-check.mjs` | Checks that core imports nothing from outside itself, apart from allowed packages. |
| `docs/designs/` | The approved design and its review records. |

## Commands

Node 22 or newer.

```sh
npm install
npm test            # Vitest
npm run lint        # ESLint architecture rules + TypeScript type check
npm run port-check
```

## Licence

AGPL-3.0-or-later. See [LICENSE](LICENSE). Portions are derived from CrabbyTab.
