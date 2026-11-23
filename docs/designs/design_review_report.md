# SimpleTab design: Goldfish review report

- **Date:** 2026-11-18
- **Document reviewed:** [simpletab.md](simpletab.md) (status: Proposed)
- **Method:** the EGM design review. Four stages, each run by a fresh reviewer that saw only the documents, never the conversation.
- **Synthesis:** Claude (Elephant). Claims about code and packages were spot-checked; see "Checked" below.

| Stage | Persona | Reviewer | Result |
|---|---|---|---|
| 5. Zoom out | Skeptical Architect (YAGNI, reuse) | ChatGPT (GPT-6) | 8 Major, 2 Nit |
| 6. Comprehension | Fresh reader (document only) | Claude subagent | 13 Major, 2 Nit |
| 7. Design critique | Design Critic | Gemini 3.8 Flash-high (Antigravity). Gemini 4 Argon dropped the request twice in the browser, so the stage was reassigned under the playbook. | 3 Blocker, 8 Major, 1 Nit |
| 9. Implementation readiness | Zero-Decision Rule, plus code and package checks | Claude subagent (checked the CrabbyTab code and npm) | 3 Blocker, 12 Major |

**Verdict from all stages:** not ready to implement. M0 (porting the core logic) could start after the port list is fixed. M1 and later need the changes below.

**Checked:**

- `@theia/git` is deprecated on npm. Its latest version is 1.60.2, while `@theia/core` is 1.77.0.
- CrabbyTab's `src/lib/passcode.ts` imports `node:crypto`.
- `privateIndividualBallots.ts` imports `@/lib/privateSync`, which the port plan excludes.
- CrabbyTab's `tsconfig.json` does not set `noUncheckedIndexedAccess`.

## 1. Author decisions needed

| # | Problem | Raised by | Options |
|---|---|---|---|
| **A** | **Goal 4 (10 WUDC-size tournaments a day on the free tier) cannot be met.** Claude's own count for one tournament-day (about 4 rounds, not 9): check-in 5,200 + feedback ≈ 3,200 + ballots 400 + host pulls ≈ 3,000–5,000 ≈ **12–14k requests**, and roughly 3 D1 rows written per submission ≈ 26k rows. Ten such tournaments come to about 130k requests (Worker limit 100k) and 260k rows (D1 limit 100k). | Design critic F1 (Blocker), readiness #13, comprehension #10 | (1) Lower the goal to about **3 WUDC-size tournaments, or about 15 tournaments of 100 teams, per day**, and cut writes: check-in per team and by staff scan instead of per person; host pulls every 30 s; rate limits held in memory at the edge instead of D1 counters. (2) Keep the goal, but large tournaments must bring their own free-tier keys (already an option). (3) Both. |
| **B** | **The git panel (milestone M2) is built on a deprecated package.** `@theia/git` is no longer maintained and does not work with current Theia. The supported replacement is the built-in VS Code Git extension, which needs Theia's plugin host, and that host was scheduled for later. | Readiness #1 (Blocker), verified | (1) Bring the plugin host in at M2 to run only the built-in Git extension, keeping the extension UI hidden until the extensions milestone. (2) Build a small SimpleTab git panel on `dugite`. (3) Move the git panel later. |
| **C** | **Offline promotion can create two hosts.** With no internet, a promoted laptop cannot raise the host number at the service. If the old host is only frozen, not dead, and comes back, both keep accepting edits, and there is no way to merge them. | Design critic F2 (Blocker), comprehension #5, #6 | (1) Promotion is allowed offline, but every staff laptop that sees a higher host number refuses the old host and tells it to stop. A returning old host becomes read-only and shows "Replaced by host N". Edits it took while cut off are exported for manual review. (2) Promotion requires internet confirmation from the service, which is safe but impossible offline. (3) Promotion requires the host owner to confirm on the new laptop. |
| **D** | **"Never delete" hits D1's hard limits:** 500 MB per database, 10 databases per account, and database bindings that cannot be added at runtime. After roughly 15–20 large tournaments, the service stops accepting writes. | Design critic F10, all reviewers on storage | (1) Keep everything online, but when a tournament closes, move its rows from D1 to **Cloudflare R2** (10 GB free, still online and kept for good) as one compressed file. D1 then only holds active tournaments. (2) Leave it as is and accept the wall. |

Decision D2 (no credential recovery bundle) was raised again by the design critic (F7). It remains an accepted risk; the author has already decided it, so it is not asked again.

## 2. Fixes Claude will apply (no decision needed)

**Integration gaps**

| # | Finding | Fix |
|---|---|---|
| 1 | The phone cannot find the tournament's CDN from the link alone. | The link fragment carries the CDN origin: `#<cdnOrigin>/<lookupId>.<secret>`. No extra request is needed. |
| 2 | "Received by tab room" has three different mechanisms. The public `acks/<n>.json` leaks who has submitted and is slowed by CDN caching. | One mechanism: the phone asks `GET /v1/status` for its own submission when the user opens the ballot, which is one request. `acks/` is removed. |
| 3 | `safeStorage`, the projector window and the updater cannot run in Theia's backend process. | Add an `electronMain` Theia extension (`src/electron-main/`) for these, with a defined RPC between it and the backend that returns status only, never secret values. |
| 4 | Draw and allocation would block Node's event loop for up to 15 s, which drops WebSocket heartbeats. | Long operations run in `worker_threads`. The main thread stays free for the network and the UI. |
| 5 | Registration could use up the quota that ballots need. | Registration gets its own counter and limit, and running out only disables registration. |

**Correctness**

| # | Finding | Fix |
|---|---|---|
| 6 | Undo of an older op is unsafe when later ops touched the same records. | Undo is allowed only if no later op wrote any record the op wrote. Otherwise the UI lists the later ops that block it. |
| 7 | The integrity check misses edits made inside a snapshot. | Each snapshot stores a state hash in its changelog entry. Startup checks the snapshot hash and then replays from it. A full replay from op 0 runs in the background after startup. |
| 8 | "Past publishes anchor the history" is false, because publishes overwrite files. | Each publish also sends the head hash to the shared service, which keeps every head forever (one row per publish). The public site warns if a new head does not extend the last one it saw. |

**Port and build**

| # | Finding | Fix |
|---|---|---|
| 9 | The port list is missing imported modules, and some listed modules use Node, DOM or React code. | Port the full import closure: list every file with a status of ported, stubbed or rewritten. Rewrite `passcode.ts` with WebCrypto. Pass the origin into `privateUrls.ts`. Move `useBarcodeCamera.ts` to tab-ui. Port `tools/tabbycat-diff` as a dev tool. |
| 10 | "Tests pass unchanged" is impossible, and `noUncheckedIndexedAccess` is wrong. | "Assertions unchanged; imports may be rewritten." List the poly-team tests to delete. Leave the flag off, matching CrabbyTab. Keep the `@/` alias. Use Vitest `test.projects`. |
| 11 | `better-sqlite3` must be rebuilt for Electron's ABI. | Rebuild through `@electron/rebuild` in the build script. |

**Simplification**

| # | Finding | Fix |
|---|---|---|
| 12 | CPace and SPAKE2 libraries are stale and unaudited, and adding them on top of mutual TLS is extra machinery. | Pairing by code plus fingerprint: the 8-digit code (5 minutes, one use) opens a TLS session. Both screens show the same 6-word fingerprint, and the host approves the join on screen. No PAKE library. |
| 13 | Translation strings were all inside `@simpletab/core`. | Each app keeps its own catalogs. Only domain labels are shared. Convert CrabbyTab's en/bn TypeScript catalogs. |
| 14 | One round bundle is about 0.5–1.3 MB, sent to every phone. | Split it into 32 buckets by row-ID prefix, so each phone downloads about 20–40 KB. |

**Precision**

| # | Finding | Fix |
|---|---|---|
| 15 | Many things are undefined: link secrets versus credentials, `hostNumber`, "confirmed", release gates, role permissions, changelog visibility, host override, offline edits, "author decision D1" (which collides with the D1 database name). | Add a glossary. Rename author decisions to AD1–AD5. Add a role and permission table, a release-gate table, and a visibility rule (per op type). |
| 16 | The plan still leaves decisions to the implementer. | Add a schema appendix: SQLite tables, wire fields, bundle layout, HKDF salts and info strings, QR payload, error codes, quota defaults, and per-route write counts with the arithmetic. Also an op table (type, payload, permission, guards reusing CrabbyTab's `stateGuards.ts` and related code, inverse, lock), named libraries and versions, and a milestone column for each file with its own checkpoint commands. |
| 17 | Milestone ordering. | Stub the public-site bundle for M1–M3. Use workspace-linked `@simpletab/core` until M3's first npm publish. Rename "usable first release" to M0–M5, because QR scanning by assistants needs collaboration (M5). |
| 18 | The update hash check is weak. | Publish `SHA256SUMS` in the separate `simpletab-public` release feed, and verify `downloadedFile` before installing (`autoInstallOnAppQuit=false`). |
| 19 | 8 GB laptops may run short of memory. | Cap the backend heap at 2 GB, and benchmark the whole stack under memory pressure in the performance test. |

## 3. Not adopted

- **Zoom out #1, #2: "drop the op log and the declarative op engine; use plain SQLite state plus audit rows."** Not adopted. The op log is what makes host-ordered collaboration, undo, the tamper-evident changelog and recovery after promotion all work from one mechanism. Without it, each would need its own. Fix 6 narrows the risk the reviewers raised about undo.
- **Zoom out #10: "move file-level detail into issues."** Not adopted. The EGM implementation-readiness standard requires a zero-decision plan, and the readiness reviewer asked for more detail, not less.
- **Design critic F2 recommendation: a Raft-style quorum lease on the local network.** Not adopted: too heavy for a tab room. Option C1 above handles the same risk.
- **Design critic F7: an offline credential recovery envelope.** Already rejected by the author (AD2).

## 4. Quick re-review of revision 2 (2026-11-21)

Two reviewers ran: GitHub Copilot (zoom out and design critique) and a fresh Claude subagent (implementation readiness, checked against the CrabbyTab code and npm). Gemini 4 Argon (Antigravity: out of credits) and ChatGPT (usage limit until 2026-11-23) were unavailable.

- **Resolved in revision 2:** decisions A–D; CDN discovery; worker threads; anchoring; the git panel; 15 of the 19 fixes. The reviewers checked all 64 Appendix A guard names and every Appendix F path; they exist.
- **Fixed in revision 3:**

| Finding | Fix in revision 3 |
|---|---|
| D1 writes undercounted (both reviewers) | The redundant `(slug, rowid)` index is dropped, so a submission writes 2 rows. Section 13 now has a per-route write table, a 10k registration reserve and an 80k cap on shares. The default share now covers a full day. |
| Split-brain when two laptops promote, and ops lost on a laptop that is behind (both) | Succession list with ranks; catch-up from reachable tab-director devices before promoting; tie-break on rank; the service accepts a lower rank at an equal number. |
| Host stuck after key reissue; import `hostId` | Reissue clears `host_id`; `HOST_STALE` carries the stored number; import makes a new `hostId`. |
| `importer.ts` → `download.ts`; long-op apply logic had no source; helper locations; missing poly tests; import mapping | Appendix F edited: `draws.ts` and `allocation.ts` added to `domain/guards`, the import-mapping table and `rewrite-imports.mjs` added, `draw.restore` and `allocation.restore` added as inverses. |
| Visibility gates incomplete | A gate table per op group in Appendix A. |
| Bundle overflow rows undefined | Form definitions moved to `forms/<n>.json`; rows hold IDs only and have a hard 512-byte cap. |
| GitHub Pages links could not work; bundled Wrangler risk | Cloudflare Pages only in the first release; Wrangler runs on Electron's own Node (`ELECTRON_RUN_AS_NODE`). |
| No certificate library; word derivation; credentials RPC | `@peculiar/x509` with P-256 and a 1-year lifetime; 66 bits as 6 × 11; typed RPC in which electron-main makes the requests itself, so secrets never leave it. |
| Core not installable before npm publish | Pre-releases are published to npm from M0. |
| Approximate counters across isolates; archive not atomic; rate-limit failure mode; storage terminal state; QR fragments; HTTP statuses; test runtime mismatch | Additive UPSERT plus a documented ±10%; an archive state machine; the binding fails open while the share stays hard; key approvals stop at 90%; a fragment header; an HTTP status table; `@cloudflare/vitest-pool-workers`. |
| Scope: M0–M5 too big for a first release (Copilot) | Kept: it is the author's order. The host can scan QR codes from M3, so tournaments do not depend on M5 for the fallback. |
