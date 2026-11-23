# AGENTS.md

Rules for anyone (person or AI) changing this repository. The full design is [docs/designs/simpletab.md](docs/designs/simpletab.md). Where this file and the code disagree, the code is the source of truth; where the code and the approved design disagree, raise it before changing either.

## Architecture rules

1. **Only the host decides.** Every change to tournament data is a typed operation applied by the host, in order. Nothing else writes tournament state.
2. **One set of rules.** Types, validation, permissions and wire formats live once, in `@simpletab/core`. Other packages import them; they do not copy them.
3. **Core is portable.** `packages/core/src` (tests excepted) may not import Node, React, Electron, Next.js or Firebase, and may not read browser globals. `npm run lint` and `npm run port-check` enforce this.
4. **Online features are optional.** The ballot portal, publishing and registration must never block tabbing. No operation may wait on the network.
5. **No secrets in tournament data.** Credentials stay in the host's secure storage (electron-main). They never go into SQLite, handover files, the changelog, logs or extensions.
6. **Formats:** BP and two-team only.

## Working on the code

- Tournament logic came from CrabbyTab with its tests. Keep those tests' assertions unchanged; rewriting their imports is fine.
- Draws must stay deterministic for the same inputs and seed. Never relax a hard constraint to produce a result.
- Add or update tests for every change to tournament logic. Run `npm test`, `npm run lint` and `npm run port-check` before calling work done.
- Do not add dependencies to core without updating the allowed list in `tools/port-check.mjs` and the design's library table.
- Do not commit, push or open pull requests unless asked.
- Tabbycat (AGPL-3.0, third party) is a reference only. Do not copy its code.
