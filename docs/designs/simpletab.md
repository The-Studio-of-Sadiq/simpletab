# SimpleTab

*   **Author:** Golam Kuadir Khan Prince
*   **Status:** Approved (revision 3, approved by the author on 2026-11-21; amendment 1 on 2026-11-23 adds the permanent GitHub archive, section 10.1; amendment 2 on 2026-11-23 adds per-round ballot deadlines, section 8.1; amendment 3 on 2026-11-23 makes every online feature optional and non-blocking, section 1.1; amendment 4 on 2026-11-23 adds the 1000-team benchmark level, QR-only ballots and bubble-sheet ballots, sections 8.2 and 8.3; amendment 5 on 2026-11-24 splits the R2 archive into small parts to fit the free plan's 10 ms CPU limit, adds the inbox `scanned` position, and raises the default request share, sections 7, 7.1 and 13; amendment 6 on 2026-11-25 replaces the bundled Wrangler with Cloudflare's Pages upload API, section 10; amendment 7 on 2026-11-25 fixes the collaboration wire protocol and how staff devices run, section 4.1)
*   **Date:** 2026-11-23
*   **Predecessors:** [concepts_brief.md](concepts_brief.md), [review_report.md](review_report.md) (concept review), [design_review_report.md](design_review_report.md) (design review)

--------------------------------------------------------------------------------

## Overview

SimpleTab is a debate-tournament tabulation system for British Parliamentary (BP) and two-team formats (Australs, WSDC and similar). It replaces CrabbyTab v1. It keeps CrabbyTab's tested tournament logic (draws, adjudicator allocation, ballots, standings, break) and replaces the architecture around it.

SimpleTab is three repositories:

1. **`simpletab`:** a Windows desktop app built on Eclipse Theia. One laptop, the **host**, holds the whole tournament in SQLite and decides every change. It works with no internet. Other staff laptops join it over a private tab-room network and edit live.
2. **`simpletab-ballots`:** one shared online service, run by the author at zero cost on Cloudflare's free tier. Participants use it from their phones, through private links, to submit ballots, feedback and check-ins, and to register. The host pulls those submissions in when it has a connection.
3. **`simpletab-public`:** a read-only public website made of static files. Each tournament's host publishes it to that tournament's own free CDN account.

The internet is used only to publish, and to collect what participants submit. Every tab decision is made offline, on the host.

## The Problem

Tournament organisers need tab software that:

- keeps working when venue Wi-Fi and mobile data are poor;
- handles very large events (WUDC-size BP: about 400 teams, 500 adjudicators, 100 rooms);
- costs nothing to run.

CrabbyTab v1 (Next.js + Firebase) showed three costs of a cloud-first design:

- **Metered reads and writes.** Firestore charges per document, and much of v1's code exists only to save reads.
- **Merging between browsers.** Several browsers edit the same data and merge it later. Releasing a draw touched two sync paths, so a co-director could see a draw before they could publish it.
- **Rules written twice.** Every ballot field was defined in TypeScript and again in `firestore.rules`.

**Proposed solution:** one laptop is the only source of truth and orders every change, so nothing needs merging. What participants and spectators read is static files, which are free to serve. The only server is a small online inbox, and a phone needs about one request per form.

## Glossary

| Term | Meaning |
|---|---|
| **Host** | The one laptop that holds the tournament and applies every change. |
| **Staff device** | Another laptop running SimpleTab, paired with the host, acting under one role. |
| **Op (operation)** | One typed change request, for example `allocation.swap_rooms`. Appendix A lists all of them. |
| **Seq** | The position the host gives an op when it applies it (1, 2, 3, …). |
| **Committed op** | An op the host has applied and written to its op log. Only committed ops exist. |
| **Op log** | The host's append-only list of committed ops. It is the source of truth; the state tables are rebuilt from it. |
| **Snapshot** | A saved copy of the state at some seq, so that replay can start there. |
| **Changelog** | The hash-chained record of every committed op (section 5). Its public part is published. |
| **Head hash** | The hash of the latest changelog entry. |
| **Host number** | A counter that says which laptop is the current host. It starts at 1 and rises at every promotion, handover import or key reissue. The online service and staff devices refuse anyone with a lower number. |
| **Promotion** | A staff tab-director laptop taking over as host. |
| **Handover file** | A `.simpletab` file holding the whole tournament (op log, snapshot and link secrets, but no credentials), for moving it to another laptop. |
| **Credentials** | Secrets for outside services: the tournament key, the CDN token, SMTP settings and optional own free-tier keys. They are stored only in the host's Windows secure storage. |
| **Tournament key** | The per-tournament secret that the author issues, letting the host use the shared service. |
| **Private link** | A participant's personal URL (section 8). It contains a lookup ID, which the server sees, and a secret, which the server never sees. |
| **Link secret** | The 128-bit secret in a private link. It is tournament data, stored in the host's database and included in handover files. It is not a credential. |
| **Round bundle** | Encrypted static files on the tournament's CDN. Each phone decrypts its own row of them: its room, panel and ballot form. |
| **Release gate** | A switch that makes something visible to participants or the public, for example "draw released" or "team tab". Appendix B lists them. |
| **Role projection** | The part of the tournament data that a given role is allowed to read (section 6). |
| **Share** | The number of requests and database writes per day that the shared service reserves for one tournament. |
| **AD1–AD5** | The author's decisions after the concept review (see the concepts brief, section 12). |
| **Decisions A–D** | The author's decisions after the design review (capacity target, git panel, offline promotion, R2 archive); see [design_review_report.md](design_review_report.md), section 1. |
| **Succession list** | The ordered list of tab-director devices the host owner sets, saying which laptop should take over first if the host fails. A device's position in it is its **rank** (1 = first). |

## Goals

1.  **Run a WUDC-size tournament from one laptop with no internet in the tab room.** (A 1000-team level, `--size xl`, is benchmarked from M1 too. Its targets are set from the first measurement, and until then 1000 teams is supported but not guaranteed to meet Goal 2.) 400 BP teams, 500 adjudicators, 100 rooms, 9 preliminary rounds and elimination rounds, all on one Windows 11 laptop with 4 cores and 8 GB of RAM.
2.  **Fast tab operations at that size.** On that laptop:
    - draw generation ≤ 5 s;
    - automatic adjudicator allocation ≤ 15 s;
    - standings and break ≤ 2 s;
    - startup integrity check ≤ 3 s.

    The UI and staff connections stay responsive while these run.
3.  **Same results as CrabbyTab.** The ported logic passes CrabbyTab's tests (same assertions) and its golden comparisons against Tabbycat. The same inputs and seed always give the same draw.
4.  **Zero running cost.** The shared service stays inside Cloudflare's free tier. Its capacity target is **3 WUDC-size tournaments, or 15 tournaments of 100 teams, on the same UTC day**, worked out in section 13. A larger tournament can bring its own free-tier keys. No paid plan, ever.
5.  **Ballots survive bad mobile data.**
    - Submitting a form takes one server request.
    - A resend is never counted twice.
    - A form stays on the phone until the server confirms it, and the phone shows which of three states it is in.
6.  **Live collaboration in the tab room.** Up to 15 staff devices on the tab-room network see each other's committed changes within 1 s (95th percentile). The host's decision always wins.
7.  **Recovery from a lost host.**
    - A connected tab-director laptop can become host within 5 minutes.
    - Every op that reached at least one *reachable* tab-director laptop survives promotion: before taking over, the promoting laptop collects any ops it is missing from the others.
    - Ops the old host committed but never sent out may be lost; this is stated, not hidden.
    - A returning old host can never overwrite the new one.
8.  **Tamper-evident history.** Every committed op, whether from a person or the AI, is in the changelog. Every published head hash is also recorded on the shared service, so a rewritten history is detectable.
9.  **Role-based access.** The host checks every op. Each staff device receives only its role projection.
10. **Public pages cost nothing to serve.** They are static files on the tournament's own CDN and read no database.
10a. **Tournament records last forever.** The host can publish a permanent archive of the public site, with downloadable exports, to a GitHub repository served by GitHub Pages. Every archive publish is a new commit, so the history is kept (section 10.1).
11. **Fully translatable.** All user-facing text in all three repos lives in locale files. English and Bangla ship complete, with a template for adding a language.
11a. **Online features are optional.** The tournament runs fully with the ballot portal, publishing and registration switched off or broken (section 1.1).
12. **Shell features ship in the author's order:**
    1. git panel (VS Code's built-in Git, running in Theia's plugin host);
    2. live collaboration;
    3. terminal;
    4. file explorer;
    5. command palette commands.

    General extensions and AI tooling come after.

## Non-Goals

*   macOS and Linux in the first release. The code must not block them later.
*   Assistant tab directors working over the internet.
*   Formats other than BP and two-team.
*   Moving CrabbyTab v1 tournaments into SimpleTab. CrabbyTab backups cannot be imported.
*   Paid tiers or code-signing certificates.
*   Native mobile apps, SMS or push notifications.
*   General extensions, and an extension marketplace, before milestone M9.
*   Deleting online data (AD1). Closed tournaments are moved to R2 storage, not deleted.
*   Participant ballots sent over the venue's local network.
*   Redis (AD3).
*   Consensus protocols (such as Raft) between laptops.
*   Copying Tabbycat code (AGPL-3.0, third party; it is a reference only).

## Open Questions

*   **First tournament and deadline:** which event and date will SimpleTab first be used for? This sets the cut line for M0–M6.
*   **Second service admin:** who besides the author can approve keys?
*   **Reference laptop:** confirm that "4 cores, 8 GB RAM, Windows 11" is the minimum host.

## Critical User Journeys (CUJs)

### CUJ 1: Run a round with no internet

*   **Given**: The host has the tournament set up and no internet.
*   **When**: The tab director runs check-in, generates the draw, runs allocation, adjusts it, and releases the draw and motion on the projector.
*   **Then**:
    - Each step meets the Goal 2 targets, and staff devices stay connected throughout.
    - Every change is in the changelog.
    - When the host next gets internet, it pushes the round state and publishes the release.

### CUJ 2: A judge submits a ballot on bad mobile data

*   **Given**: Round 3's bundle is published. A chair opens their private link on a phone with weak signal.
*   **When**: They submit the ballot, and the connection drops twice.
*   **Then**:
    - The phone shows "Saved on this phone only, don't leave" and keeps retrying.
    - When the server accepts the ballot, the phone shows "Received by server".
    - When the chair reopens the link after the host has pulled the ballot, the phone shows "Received by tab room". It learns this from one `GET /v1/status` request.
    - The ballot is stored exactly once.

### CUJ 3: A second tab director joins and edits live

*   **Given**: The host is running and the tab-room network is up.
*   **When**:
    1. The host creates an 8-digit code for the Tab director role on the Devices page.
    2. A colleague enters it in SimpleTab on their laptop.
    3. Both screens show the same 6 words, and the host approves the join.
*   **Then**:
    - The colleague receives the tab-director projection, along with live changes and presence.
    - Their edits (for example `allocation.swap_rooms`) are applied by the host in order, and every device sees them within 1 s.

### CUJ 4: The host laptop dies mid-round

*   **Given**: The host's disk fails during round 5. A tab director's laptop is connected and holds the full copy.
*   **When**: The tab director chooses "Promote this laptop to host".
*   **Then**:
    - The laptop becomes host with host number N+1, starting from the last op it received. Staff devices re-pair and from then on refuse the old host.
    - When it has internet, the new host re-enters the credentials. If they are lost, the author reissues the key.
    - The online service accepts N+1 and refuses N.
    - If the old host was only frozen and comes back, any device or the service tells it about N+1. It becomes read-only, shows "Replaced by host N+1", and exports any ops it took while cut off to a file for manual review.

### CUJ 5: Publish results

*   **Given**: Round 5 results are confirmed, and the results and team-tab release gates are open.
*   **When**: The tab director presses Publish.
*   **Then**:
    - The host builds the static files and uploads them to the tournament's CDN.
    - It sends the new head hash to the shared service.
    - It reads `manifest.json` back from the CDN, and the status panel shows the publish as live.

### CUJ 6: The tournament's share runs out

*   **Given**: This tournament's daily share is used up.
*   **When**: A chair submits a ballot.
*   **Then**:
    - The phone keeps the ballot and shows it as a signed QR code and as a copyable text code.
    - Any assistant-mode device on the tab-room network scans the QR or pastes the code.
    - The ballot enters the host exactly as the judge filled it in, and a forged code is rejected.

### CUJ 7: Open registration

*   **Given**: The host has opened a registration window with a cap.
*   **When**: Teams and adjudicators register online. The form is protected by Cloudflare Turnstile.
*   **Then**:
    - Registrations count against this tournament's separate registration limit, so they never use up its ballot share.
    - The host pulls them in, and the tab director accepts each one (`registration.accept`).

### CUJ 8: Archive the tournament for good

*   **Given**: The tournament is over. Its final tabs are released, and the host owner has saved a GitHub token for the tournament's archive repository.
*   **When**: The tab director presses "Archive to GitHub" on the Releases page, or answers Yes when closing the tournament.
*   **Then**:
    - The host builds the released public site, the exports and a README, and commits them to the repository's `gh-pages` branch, keeping earlier commits.
    - It turns on GitHub Pages for the repository if it is off.
    - It shows the archive address, for example `https://<owner>.github.io/<repo>/`, and confirms that `manifest.json` can be read there.

### CUJ 9: The ballot deadline passes

*   **Given**: The tab director set round 2's ballot deadline to 2:00 PM, tournament time (for example Asia/Dhaka).
*   **When**: A chair opens their link at 1:45 PM, and another chair tries to submit at 2:03 PM.
*   **Then**:
    - The first chair's phone shows "Ballots close at 2:00 PM (Dhaka time), 15 minutes left", and the ballot is accepted.
    - The second phone shows "Ballot submission for round 2 closed at 2:00 PM. Give your ballot to the Tab director." The online form is locked, and the service refuses the submission with `DEADLINE_PASSED`.
    - A tab assistant on the host cannot enter round 2 ballots either, by hand or by QR scan.
    - Only a Tab director (or the Host owner) can enter it. That ballot is marked "late entry by <name>" on the ballot and in the changelog.

--------------------------------------------------------------------------------

## Technical Plan (Architecture)

### 1. The whole system

```text
                 TAB ROOM (router by default; host hotspot as fallback; TLS)
   ┌──────────────────────────────────────────────────────────────────────┐
   │  Staff device (role projection)        Staff device (assistant mode) │
   │        │ ops ▲ committed ops (filtered)        │ ops ▲               │
   │  ┌─────▼─────┴────────────────────────────────▼─────┴─────────────┐  │
   │  │ HOST: SimpleTab (Theia: electron-main · backend · frontend)    │  │
   │  │  backend: op engine (+ worker threads) · SQLite (op log,        │  │
   │  │           state, changelog, snapshots) · collab server (wss)   │  │
   │  │           sync client · publisher · CLI server                 │  │
   │  │  electron-main: safeStorage credentials · projector · updater  │  │
   │  └────────────────────────────────────────────────────────────────┘  │
   └──────────────┬───────────────────────────────────┬───────────────────┘
     push round permits / pull inbox / send heads    publish static files
     (HTTPS · tournament key · host number)          (HTTPS · tournament's CDN token)
                  ▼                                   ▼
   ┌───────────────────────────────┐     ┌───────────────────────────────────┐
   │ simpletab-ballots (shared)    │     │ Tournament's own CDN               │
   │ Worker + D1 (active data)     │     │ Cloudflare Pages                   │
   │ R2 (closed tournaments)       │     │ (the only CDN in the first release)│
   │ Pages: phone web app          │     │  public site · round bundles ·     │
   │ admin page (Cloudflare Access)│     │  motions · manifest                │
   └──────────────▲────────────────┘     └───────────────▲───────────────────┘
       1 POST per form; 1 GET per status check   static GETs (free, cached)
                  └──────────── Participant phones ──────┘
```

The same three rules hold everywhere:

1. **Only the host decides.** Staff devices, the CLI, the AI and the shared service all send requests. Only the host applies changes.
2. **Static wherever possible.** Only writes reach a server.
3. **One set of rules.** Types, validation, permissions and wire formats are defined once, in `@simpletab/core`.
4. **Online features are optional and can never stop the tournament** (amendment 3, below).

### 1.1 The online portal is an optional add-on (amendment 3)

The private ballot portal is an add-on. It covers ballots, feedback, check-in and registration through private links, plus the shared service behind them. Live publishing and the GitHub archive are optional add-ons as well. A tournament must run from start to finish with all of them switched off or broken.

- **Off by default.** A new tournament starts in offline mode, with no tournament key, no CDN and no internet. Settings → Online has independent switches for "Private ballot portal", "Live public site", "GitHub archive" and "Online registration". Each can be turned on or off at any time, even mid-round.
- **No op waits on the network.** Pushing, pulling, publishing and archiving run in a background queue in the host backend. Tab ops never wait for that queue, and no guard calls the network.
- **Failures only pause the add-on:**
  - service down, timeouts, `QUOTA_EXHAUSTED`, `KEY_REVOKED`, a pending key approval;
  - a CDN or GitHub error;
  - no internet at all.

  Each of these only shows a status ("Portal paused: service unreachable since 14:02"). Tabbing, results entry at the tab room, standings, the break and the projector carry on unchanged.
- **The tab room can always enter results.** Paper ballots, typed entry and QR scanning work whether the portal is on, off or broken. Results never depend on anything the service holds: when the portal is turned off, any ballots still waiting on the service are pulled once if possible, and otherwise they are entered from paper.
- **Deadlines belong to the portal.** A round's ballot deadline (section 8.1) applies only while the portal is on. If the portal is turned off, or is unreachable during a round, the deadline rule is lifted for that round, and assistants can enter ballots again. That avoids a situation where nobody but the Tab director can enter results because the service is down.
- **The service can never make the host read-only.** A `HOST_STALE` answer from the service only pauses this laptop's online sync, and shows "Another laptop is registered as host online". The only thing that demotes a host is local evidence from a staff device that has seen a winning host (section 4).
- **Registration is optional too.** Participants can always be added by CSV import or by hand. Online registration only adds a way in.
- **Integrity-check failures** (section 3) block the add-ons (publishing and sync) but never tabbing.
- **Verification:** `npm run e2e:offline` runs a full scripted 9-round tournament on the host with the network disabled, and again with the service mocked to return errors and timeouts on every call. Every round must complete, with no UI freeze and no blocked op.

### 2. Repositories and packages

| Repo | Contents | Licence |
|---|---|---|
| `simpletab` | An npm-workspaces monorepo:<br>• `packages/core`, published as `@simpletab/core`;<br>• `packages/host`, the Theia backend and electron-main extension;<br>• `packages/tab-ui`, the Theia frontend extension;<br>• `packages/cli`;<br>• `packages/app`, the Theia Electron app and installer;<br>• `tools/tabbycat-diff`. | AGPL-3.0 |
| `simpletab-ballots` | The Cloudflare Worker (API and admin page) and the phone web app (Pages). | AGPL-3.0 |
| `simpletab-public` | The static public site (React + Vite), released as a versioned zip that the desktop app bundles. | AGPL-3.0 |

**`@simpletab/core`** contains:

- the ported CrabbyTab domain logic (Appendix F) with its tests;
- the op catalogue (Appendix A), release gates (Appendix B), permissions and role projections (Appendix C);
- the changelog format (section 5), wire schemas (Appendix E), crypto and bundle formats (section 8), and the public projection.

It runs in Electron, Workers and browsers. It has no Node, DOM or React imports outside test files.

**Translations** live with each app (section 12). Only shared domain labels (side names, metric names, error codes) are in core.

**Compatibility:**

- Every wire message and published file carries `schema: 1`. Each receiver accepts its own version and the one before it.
- A release checklist pins one `@simpletab/core` version across the three repos.
- From M0 on, every tagged core build is published to npm as a pre-release (`0.x.y`, dist-tag `next`). The other repos pin an exact version.

### 3. Host storage

The database is `better-sqlite3` 13.2.0, rebuilt for Theia's Electron with `@electron/rebuild` 4.2.1, in WAL mode. There is one file per tournament, `<workspace>/<slug>.simpletab.db`. The schema is in Appendix D.

- **Entity tables** keep each record as JSON in CrabbyTab's own types, so the ported logic runs unchanged. Each row also has `version`, `last_seq` and indexed lookup columns.
- **`ops`** is the source of truth. The state tables are a cache that can be rebuilt by replaying it.
- **Snapshots** are taken every 2,000 ops and at every round completion. A snapshot is the gzip of the canonical state, together with its `state_hash`. The changelog entry of the op at that seq records the same `state_hash`.
- **Startup integrity check**, in two steps:
  1. **Fast (blocks startup, ≤ 3 s).** Recompute the latest snapshot's hash and compare it with the hash recorded in the changelog. Replay the ops after the snapshot, then compare the state hash with the live tables.
  2. **Full (in the background).** Replay from op 1 and check every snapshot hash along the way.

  If either step fails, publishing and syncing are blocked and an error is shown. A consistent forgery of both the op log and the changelog is caught only through the published head hashes (section 5).
- **Undo** of op *k* is allowed only if no later op wrote any record that op *k* wrote. Otherwise the UI lists the later ops that block it. Undo is applied as an inverse op, appended with `inverse_of = k`.
- **Handover file `.simpletab`** is a zip made with `fflate` 0.8.3. It contains:
  - `manifest.json`: schema, slug, host number, last seq, head hash and created-at;
  - `ops.ndjson`;
  - `snapshot.json.gz`: the latest snapshot;
  - `links.json`.

  On import, the host checks the manifest, replays from the snapshot, verifies the chain and sets host number to the imported value plus 1. Credentials are never included.

### 4. Ops, live collaboration and promotion

**The engine.** All ops go through one queue in the host backend. For each op:

1. Check the actor's permission.
2. Check the versions the op expects for the records it reads.
3. Run its guards (Appendix A reuses CrabbyTab's guard functions).
4. Apply it in one SQLite transaction.
5. Append the op and its changelog entry.
6. Broadcast it to staff devices through each device's role projection.

**Long ops** (`draw.generate`, `allocation.auto`, `break.compute`, `allocation.preformed_autofill`, `round.set_prelim_count`, `settings.resave_ballots`, `private_urls.regenerate`) work as follows:

- The op takes a named lock that every device can see.
- It computes its result in a `worker_threads` worker from a read-only copy of the state, then applies the result in step 4.
- The main thread keeps serving the UI, WebSocket heartbeats and sync while the worker runs.

**Host precedence.** Ops submitted by the Host owner role are forced: they skip version checks and apply against current values. Two things follow:

- Any queued op that expected an older version of a record the forced op wrote is rejected with the code `OVERRIDDEN_BY_HOST`. Its sender sees what replaced their change.
- The Host owner can cancel a running long op. The worker is ended, nothing is applied, the lock is released and the lock holder is told.

**Pairing (no PAKE library):**

1. The host makes a self-signed X.509 certificate per tournament, with an ECDSA P-256 key generated by WebCrypto and a 1-year lifetime, using `@peculiar/x509` 3.1.0. Each device makes its own P-256 key and self-signed certificate the same way.
2. On the Devices page, which sits below Credentials, the host creates an **8-digit code** for one role. The code is valid for 5 minutes, works once, and is cancelled after 5 wrong attempts.
3. The joining device connects with `wss` to the host address (from the QR, or typed) and sends `{code, deviceName, devicePublicKey}`.
4. Both screens show 6 words from the BIP39 English list. They come from `h = SHA-256(hostCertFingerprint ‖ deviceCertFingerprint ‖ code)`: the first 66 bits of `h`, split into six 11-bit indices. The words match only if nobody is in the middle.
5. The host user compares the words and approves the join. The device pins the host certificate, and the host stores the device key and its role.
6. Later connections use mutual TLS with the pinned certificate and the device key. The host can remove a device; the removed device then wipes its local copy.

**Staff device data.**

- A device receives its role projection as a snapshot, then a stream of filtered committed ops.
- Only Tab director devices receive the full state. It is stored encrypted under a key derived from the device key, and only these devices can be promoted.
- Devices with other roles keep their projection in memory only.

**Offline staff edits.** When a device is disconnected, its edits wait in an outbox, together with the versions they expect. The UI shows them as "pending" on top of the device's copy, marked as unconfirmed. When the device reconnects, the host either commits each op, and the device's copy updates from the broadcast, or rejects it, and the pending change disappears and the conflict is shown.

**Succession list.** The host owner sets an ordered list of tab-director devices (Devices page). Every tab-director device keeps a copy of it. A host that never set one gets a default list in pairing order.

**Promotion and the host number:**

1. A tab director chooses "Promote this laptop to host".
2. **Catch up.** The laptop asks every reachable tab-director device for its last seq. If any is ahead, it fetches the missing committed ops from that device and applies them first.
3. **Respect the order.** If a device with a better (lower) rank is reachable, promotion is refused, and the UI says which laptop should promote instead. If none is reachable, promotion goes ahead.
4. The laptop sets its host number to (highest number it has seen) + 1 and generates a new random `hostId`. Its `hostRank` is its rank.
5. It becomes host from its last committed op, and shows a new pairing code. Devices that re-pair store the new number and rank.
6. **Who wins.** Hosts are ordered by host number, then by rank (lower wins). Any device refuses a host that loses this comparison against one it already knows, and tells that host about the winner. This settles two laptops that promoted at the same time while cut off from each other: once any device has seen both, the lower rank wins.
7. A host that learns of a winner becomes read-only and shows "Replaced by host N". Every op it committed after the fork point (the last seq both hosts share) is written to `<slug>.divergent.simpletab`, for manual review.
8. When the new host is online, it re-enters credentials (AD2) and sends `X-Host-Number`, `X-Host-Id` and `X-Host-Rank` to the service. The service accepts a request when:
   - the number is higher than the stored one; or
   - the number is equal and the `hostId` matches; or
   - the number is equal, the stored `host_id` is empty, or the request's rank is lower than the stored rank.

   It then stores the number, `hostId` and rank. It refuses everything else with `HOST_STALE`, and that response carries the stored number.
9. **Key reissue.** The author's admin page can reissue a tournament's key. Reissuing raises the stored host number by one and clears the stored `host_id`. The first request made with the new key claims it. When the host owner enters a new key and gets `HOST_STALE`, the host adopts the stored number from the response and retries once.
10. **Handover import** sets the host number to the imported value + 1, generates a new `hostId`, and sets rank 1. Importing the same file on two laptops is a mistake that the service catches: the second laptop is refused, because its number is equal and its `hostId` differs. The import screen warns about this.

**Assistant mode** is a staff device with the Tab assistant role. It shows ballot entry, the QR and code scanner and the check-in screen.

#### 4.1 Wire protocol and staff devices (amendment 7)

**Transport.** The host runs a `wss` server (`ws` 8.23.0 on Node's `https`, default port 47820). Both sides present their self-signed P-256 certificate. The host asks for the client certificate but checks it itself: it compares the certificate's SHA-256 fingerprint (of the DER bytes) with the one stored in the device's `device.approve` record. A paired device refuses any host certificate other than the one it pinned. Messages are JSON text frames with `schema: 1`; the types live in `packages/host/src/common/collab-protocol.ts`.

**Pairing handshake.**

1. The device connects with its certificate and sends `pair_request {code, deviceName}` within 10 s.
2. A wrong, expired or used code is refused with `BAD_CODE`. After 5 wrong attempts every active code is cancelled (`LOCKED_OUT`).
3. Otherwise the host sends `pair_pending {words}`. The words come from SHA-256 of the host fingerprint's 32 bytes, the device fingerprint's 32 bytes and the code's UTF-8 bytes. The device computes the same words from the host certificate it sees and shows them.
4. The host user approves within 2 minutes. The host commits `device.approve` (the device record's `publicKey` holds `sha256:<fingerprint>`) and answers `pair_result {deviceId, role, host}`. The device stores the pinned host fingerprint, its id and role.
5. Later connections send `hello {deviceId, lastSeq, knownHost?}` and get `welcome` or `refused` (`UNKNOWN_DEVICE`, `REMOVED`, `KEY_MISMATCH`).

**How a staff device runs.** A staff device is the same desktop app opened in device mode. Its backend implements the same `HostService` the tab screens already use, but backed by the connection instead of a local engine: `getState` returns the role projection it holds, `submit` sends the op to the host, and committed changes arrive as events. So every tab screen works on a device unchanged, limited by its role's permissions.

**What a device receives (step b).**

- Tab directors receive the committed op records themselves, apply them to a full local copy (encrypted at rest), and can serve them to a laptop that is catching up before promotion.
- Every other role receives its projection as a snapshot, then deltas. After each batch of commits (at most every 100 ms) the host computes `project(state, role)` once per role and sends each device of that role the records that changed since its last delta. A release can change what a role may see without writing the records it reveals, which is why the host diffs projections instead of filtering single ops.

**As built (step b).**

- A device joins from the no-tournament screen ("Join a host as a device": address, code, name) and shows the six words while the host decides. Its pairing (address, pinned host fingerprint, its own certificate and key, id, role) is kept in `~/.simpletab/devices` (or `SIMPLETAB_DEVICE_DIR`), outside every workspace, and it reconnects to that host at start-up. A laptop is either a host or a device, never both; host-only actions (opening or creating tournaments, online settings, publishing, archiving, the Devices page) are refused on a device with a plain message.
- Every role, tab directors included, currently receives its projection as snapshot plus deltas (`common/state-delta.ts`); the op-record stream that lets a tab director be promoted comes with step c.
- Requests from a device run as actor `device:<deviceId>` with the device's role, never with host precedence (`forced` is dropped). After a successful submit or undo the host sends the delta first and the response second, so the device's own change is on screen when its save returns.
- **Hidden fields are kept.** Many ops carry a whole record (`team.update {team}`), and a device edits from its role's view, which leaves out fields the role may not see. Before committing a device's op, the host copies back every field that is in the stored record, absent from the role's projection and absent from the payload, matching nested records (speakers) by id (`collab/hidden-fields.ts`). Visible fields stay exactly as sent.
- **Outbox.** While the host is out of reach, edits wait in order and the save returns `QUEUED`; after reconnecting and receiving a fresh snapshot the device sends them one at a time. Edits the host refuses are listed on the device with the host's reasons, never retried silently. The outbox is in memory, so closing the app on a device loses unsent edits (the banner says how many are waiting). Pending edits are not yet drawn on top of the device's copy; the copy changes when the host commits them. If the connection drops after the host committed an edit but before the device got the answer, the device sends it again on reconnect; ops that carry expected versions are then refused as a conflict, others may apply twice.
- Presence: the allocation, draw and results screens report the open screen and show who else is on it, in words.

**Milestone steps.** M5 is built in steps: (a) certificates, words, pairing codes, the `wss` server and the device client with pairing and reconnects; (b) the projection stream, device mode, submissions with the outbox, presence and locks, and the Devices page; (c) succession, catch-up, promotion, demotion and the divergent export; (d) assistant mode with the webcam scanner; (e) `npm run e2e:collab`.

### 5. Changelog v2

Each committed op produces one entry:

```text
entry = { v: 2, seq, ts, actorType: "human"|"ai"|"system"|"service", actorRef,
          opType, category, summary, visibility: "public"|"private",
          payloadCommit, stateHash? }
payloadCommit = base64url( SHA-256( salt ‖ JCS(op.payload) ) )     salt = 16 random bytes
entryHash     = hex( SHA-256( "simpletab-changelog-v2\n" ‖ prevHash ‖ "\n" ‖ JCS(entry) ) )
```

- **`JCS`** is RFC 8785 canonical JSON, implemented in core. **`ts`** is ISO 8601 UTC with milliseconds.
- The first entry follows 64 zeros. Entries are chained by `seq` and never re-sorted.
- **`stateHash`** is present only on snapshot entries.
- **Visibility depends only on the op type**, as listed in Appendix A:
  - Public types publish their header always. Their payload and salt are published once the release gate tied to the op type is open (for example, a `ballot.confirm` payload after that round's results are released).
  - Private types publish their header only.
  - An auditor can be shown a private payload and its salt later, to prove it.
- **Anchoring.** Every publish also sends `{seq, headHash}` to `POST /v1/host/head`, and the service keeps every head for good. The public site's Verify page:
  - checks the published chain;
  - asks the service (only when someone presses Verify) for the list of earlier heads, and checks that each of them is part of the current chain;
  - warns if the head this browser saw last is not part of the current chain.

### 6. Roles, permissions and projections

Permissions reuse CrabbyTab's 14 staff permissions and add new ones (Appendix C has the full list and the role table). The roles are:

- **Host owner:** everything.
- **Tab director:** everything except `credentials.manage` and `host.promote_others`.
- **Adjudication core**, **Equity**, **Tab assistant**: CrabbyTab's staff groups, as in Appendix C.
- **Display:** read-only; sees only released data.
- **AI:** may submit only proposals.
- **Custom:** any set of permissions.

`project(state, role)` and `projectOp(op, role)` in core are pure functions. These rules are fixed:

- Feedback needs `feedback.view`.
- Contact details need `participants.contact`.
- Link secrets need `links.manage`.
- Unreleased data needs one of `draw.display`, `motions.display` or `standings.view` for its area.

Credentials are never part of the state.

**AI actor.** The CLI pairs as a device with the AI role. An op it submits on draw, allocation, results, break or release becomes a `proposal`. A person with the needed permission accepts it, and the change is committed with `actorType: "ai"`, or rejects it. The UI warns whenever the integrated terminal is opened on the host itself.

### 7. Host ↔ shared service

The shared service is an inbox and a validator. It never decides outcomes.

**Every host request** carries:

- `Authorization: Bearer <tournament key>` (the service stores only its SHA-256);
- `X-Host-Number`, `X-Host-Id` and `X-Host-Rank` (section 4);
- `X-Request-Id`, so a retry returns the stored response.

**The host routes** are below. Their fields are in Appendix E.

| Route | Purpose |
|---|---|
| `POST /v1/host/permits` | Upload one round's permit. It is one compact row: which lookup IDs may submit which forms for which room, their verifiers, and whether the round is open. One D1 row is written per round. |
| `GET /v1/host/inbox?after=<rowid>&limit=500` | Fetch new submissions in order. |
| `POST /v1/host/ack {through: <rowid>}` | Mark everything up to `through` as received by the tab room. One row is written. |
| `POST /v1/host/head` | Record a published head hash. |
| `POST /v1/host/registration` | Set the registration window and cap. |
| `POST /v1/host/close` | Close the tournament (section 7.1). |
| `POST /v1/host/key-request` | Ask the author for a tournament key. This route needs no key. |

**Pull schedule:**

- Every 30 s while any round is open on the service.
- Every 5 minutes otherwise.
- Immediately when the tab director presses "Pull now".

**Participant routes:**

- `POST /v1/submit`: ballot, feedback, check-in or QR fallback. The service checks:
  1. the permit for that round;
  2. the HMAC proof (section 8);
  3. that the form is allowed for that link and round;
  4. the schema;
  5. the rate limits (the Workers rate-limiting binding, so no D1 writes). The binding is best-effort: if it errors, the request is allowed and the share check below still applies. `/v1/submit`, `/v1/status` and `/v1/register` each have their own limiter keys;
  6. the tournament's share (the hard limit). The admin page also has an emergency "pause this tournament" switch, which refuses every participant request for it.

  It checks tournament, round, room and link, never team IDs, so a late swing-team swap never blocks a ballot. The ballot carries a "substitution in this room" flag. The `submissionId` is the primary key, so a resend returns `{status: "already_received"}`.
- `GET /v1/status?slug&lookupId&ids=…`: per submission, says whether it was received by the server and by the tab room (by comparing with the tournament's `acked_through`). It writes nothing. When called with the tournament key (by the host), the response also includes `shareLeft`.
- `POST /v1/register`: needs a Turnstile token, an open window and the cap not reached. It has its own counters and never uses the ballot share.

**Shares and counters.**

- Each Worker isolate keeps in-memory counters per tournament and flushes them at most once a minute, with an additive `UPSERT … SET requests = requests + ?`, so isolates never overwrite each other.
- The check against the share uses the flushed total plus this isolate's unflushed count, so it is **approximate**: a tournament may go up to about 10% over before it is refused. To cover this, the admin page refuses to approve shares whose total exceeds 90% of the free limits.
- A tournament over its share gets `QUOTA_EXHAUSTED`, which affects that tournament only.
- The admin page sets each share, and section 13 gives the default formula.

**7.1 Closing and archiving (AD1, decision D).**

1. `POST /v1/host/close` sets `status = closed`, so its links stop working.
2. A cron Worker archives each closed tournament as a state machine that can resume after a crash at any step (amendment 5). On the free plan each cron run gets only **10 ms of CPU**; waiting on D1 and R2 does not count, but building JSON, gzip and hashing do. A WUDC-size tournament is about 20 MB, so one object per tournament cannot be made in one run. Instead the cron runs **every 10 minutes** and each run does one small step for one tournament:
   1. **`closed` → `archiving`**, once `closed_at` is at least 1 hour old (in-memory usage counters flush within a minute).
   2. **Export, one part per run.** Up to 200 rows and 128 KB of NDJSON from one table (permits, heads, usage, then submissions, in key order), gzipped and written as `archive/<slug>/part-NNNNN.ndjson.gz` with R2's SHA-256 check, so R2 itself rejects a damaged upload. An existing part is never overwritten; after a crash it is accepted only if its stored SHA-256 matches. Each part is listed in `archive_parts`.
   3. **Manifest and verify.** `archive/<slug>.v1.manifest.json` lists each table's row count and each part's size and SHA-256. Verify checks that every part exists in R2 with a matching checksum (without reading the parts back) and that the D1 counts equal the manifest, then records the result in `archives` and sets **`archived`**.
   4. **Delete.** One batch of at most 500 rows per run and at most 5,000 rows a day across the service. permits, heads and usage go first; submissions are then walked by a rowid cursor up to the highest exported rowid, so each row is read about once. A count above the manifest, or a submission newer than the archive, stops the job with an error on the admin page and is never deleted. The newest row of the whole submissions table is never deleted either: SQLite would reuse its rowid for the next submission, behind hosts' pull positions (section 7).
3. Nothing is deleted from storage, and the `tournaments` row stays. D1 holds only active tournaments, so a single D1 database is enough and there is no sharding.
4. **Storage limits:**
   - At 70% of D1's 500 MB or R2's 10 GB, the admin page warns.
   - At 90%, it refuses new key approvals. Tournaments already active carry on, and nothing is lost or deleted.
   - Going beyond the limit needs the author to act; a paid tier is still never used.

**Inbox position (amendment 5).** Each inbox page carries `scanned`, the highest submission rowid the service examined. The host starts its next pull there, so a quiet host does not re-read other tournaments' rows on every pull (without it, 15 tournaments whose rounds start 6 minutes apart would read about 10.6 million rows a day, twice the free limit). The position is kept only on the host, so moving it costs no service writes, and it moves only after a pull that applied cleanly. The service finds a host by key through an index on `key_hash`, written only when a key is approved, reissued or revoked.

**Admin page** (`/admin`, protected by Cloudflare Access): approve, revoke or reissue keys; set shares; view usage and storage; add a second admin.

### 8. Private links, round bundles and phone forms

**Link format:**

```text
https://<ballots-domain>/t/<slug>#<cdnHost>~<lookupId>.<secret>
  cdnHost  = the tournament CDN's host name with no path, e.g. wudc2027.pages.dev
             or a custom domain (Cloudflare Pages serves sites at the root)
  lookupId = role letter (a|t|s) + 12 characters from CrabbyTab's 31-character alphabet
  secret   = 128 random bits, base32 (26 characters)
```

The part after `#` is never sent to any server. The phone loads the static app from the ballots domain, then reads the round bundle from `https://<cdnHost>/`.

**Keys** come from HKDF-SHA-256 with 32-byte outputs:

- `ikm = secret ‖ UTF-8(passcode or "")`;
- `salt = UTF-8("simpletab/v1/" + slug)`;
- `info` is `"auth"`, `"file"`, `"lookup"` or `"qr"`, giving `authKey`, `fileKey`, `lookupKey` and `qrKey`.

Passcodes are optional, as in CrabbyTab, and a wrong passcode simply gives wrong keys.

**Proof:**

- The host's permit stores `verifier = SHA-256(authKey)`.
- The phone sends `authKey` itself, over TLS, together with `proof = HMAC(authKey, submissionId ‖ "." ‖ SHA-256(JCS(payload)))`. The server checks `SHA-256(authKey) == verifier` and then checks the proof.
- `fileKey`, `lookupKey` and `qrKey` never leave the phone.

**Round bundle.**

- The files are `rounds/<n>/<b>.<hash>.bin`, in 32 buckets.
- A row's ID is `rowId = HMAC(lookupKey, roundId)[0..16]`, and its bucket is `b = rowId[0] >> 3`.
- Each row is AES-256-GCM under `fileKey`. Its plaintext is padded to exactly 512 bytes, and each bucket is padded with dummy rows to a multiple of 8, so a bucket shows neither exact counts nor content.
- The binary layout is in Appendix E. A phone downloads one bucket of about 20–40 KB.
- A row holds only IDs and short names: room, side, teammates, panel, and which forms this person fills in, given as form IDs. It never holds form contents.
- **The form definitions** are in one unencrypted file per round, `forms/<n>.<hash>.json`. It contains the ballot form (BP consensus, or two-team voting sheet with reply and iron-person rules), the feedback questions and the check-in form. Form contents are not secret, so this keeps rows small.
- **A row has a hard limit of 512 bytes.** Bundle generation fails with a clear error naming the person if a row would exceed it. With names capped at 80 characters, the largest row (a chair on a 7-person panel) is about 400 bytes.
- **Motions are never in a bundle before their release.** At release, the host publishes `motions/<n>.json`. If the host is offline, the motion is shown on the projector slide and published later.

**Phone app.** A static TypeScript app with no framework, under 100 KB, installable as a PWA.

- It keeps drafts and an outbox in IndexedDB, and shows three states:
  1. "Saved on this phone only, don't leave";
  2. "Received by server";
  3. "Received by tab room", read from `GET /v1/status` when the link is opened or the user taps Refresh.
- **QR fallback** (Appendix E): the submission is compressed, encoded and signed with `HMAC(qrKey, …)`. The host knows the secret and can check the signature, so a forged code fails. If the data is too large for one QR code, it is split across two.
- Individual panellist sheets exist only for voting ballots (two-team). In BP, the chair submits one consensus ballot.

#### 8.1 Ballot deadline per round (amendment 2)

**Setting it.**

- The tournament has a time zone, `tournament.timeZone` (an IANA name such as `Asia/Dhaka`). Setup suggests the host's Windows time zone.
- A Tab director can set a **ballot deadline** for any round with `round.set_ballot_deadline`, entered as a local date and time (for example round 2, 2:00 PM). It is stored as a UTC instant, together with the time zone, and the UI always shows it in tournament time.
- The deadline can be moved later or earlier, or removed, at any time. A round with no deadline behaves as before: open until the round is locked.
- An optional **feedback deadline** works the same way and is off by default. Check-in is never affected.

**Whose clock counts.** The online service's clock (Cloudflare) decides, never the phone's, because a phone clock can be changed. A ballot counts as on time if the service *receives* it before the deadline. Saving it on the phone earlier does not count.

**On the phone:**

- The round's permit carries `ballotDeadline` (UTC) and `timeZone`.
- The phone shows the closing time in tournament time, with a countdown in the last 30 minutes.
- If a ballot is still saved on the phone only and the deadline is under 10 minutes away, the phone says so in large text.
- After the deadline, the online form is locked, and any unsent ballot is shown as its signed QR code and text code, with the message "Give this to the Tab director".

**When the rule applies.** Only while the portal is on and reachable (section 1.1).

**On the service.** `POST /v1/submit` refuses a ballot whose receive time is at or after the round's `ballotDeadline`, with `DEADLINE_PASSED` (409). Feedback is refused the same way only if a feedback deadline is set.

**On the host.** The deadline is checked again on the host, so it holds even if the permit was late:

- `ballot.receive_online` from the inbox: the host compares the service's `receivedAt` with the deadline. A late item is not applied; it appears in a "Late online submissions" list for the Tab director.
- Any ballot entered on the host after the deadline (typed by hand, scanned from a QR code, or accepted from the late list) needs the permission `results.enter_late`. Only the Tab director and Host owner roles have it; Tab assistants do not.
- Every such ballot carries `late: true` and the entering person, and its changelog summary says "late entry by <name>".
- The host checks its own clock against the service's `Date` header on every sync. If they differ by more than 2 minutes, the status panel shows a warning, because the late check for entries on the host uses the host clock.
- Changing a deadline is a public op (`round.*`), so the changelog shows when it was moved and by whom.

#### 8.2 QR-only ballots: no service needed (amendment 4)

A tournament can collect ballots with **no online service at all**. Settings → Online → Ballot collection has three choices:

1. **Online:** the portal from section 8, with the QR code as a fallback.
2. **Online + QR:** the same, plus a "Show QR instead" button on every ballot.
3. **QR only:** the shared service is never contacted, and no tournament key is needed.

**How QR only works:**

- The phone app (static files, served for free) and the round's encrypted bundle still load from the tournament's CDN. So phones need some connection *once per round* to fetch them: mobile data, venue Wi-Fi, or a reload at the briefing. Static files use no quota.
- The judge fills in the ballot, and the Submit button becomes **Show ballot QR**. The phone never calls the service. The QR code is the signed format in Appendix E.
- Any staff device on the tab-room network scans it: an assistant-mode laptop webcam, the host's webcam, or a **USB 2D barcode scanner** (about the price of a mouse; it types the QR text into the scan box). The host checks the signature and enters the ballot.
- A judge without a phone uses paper, either typed in or read as a bubble sheet (section 8.3).

**Optional auto-confirm** ("Trust signed ballots", off by default):

- A QR ballot that passes validation is confirmed automatically by the `system` actor, with no tab-room check.
- In BP this means the chair's signature.
- In two-team voting rounds, the individual sheets must all be in and merged with no conflicting fields.
- Each auto-confirmed ballot is marked "auto-confirmed (signed by <chair>)" in the changelog.
- A ballot with any validation problem or conflict still waits for a person.

**Deadlines** (section 8.1) are a portal rule, so they don't apply in QR-only mode. The tab room controls timing by when it collects.

**Cost:** no service requests or writes. The only traffic is free static downloads.

#### 8.3 Bubble-sheet ballots (OMR, amendment 4, milestone M11)

Paper ballots that the host reads by itself, like MCQ answer sheets. This needs no phones, no internet and no typing.

**The sheet:**

- SimpleTab prints one A4 sheet per room per round (per voting judge in two-team rounds) from any printer, using Electron's `printToPDF` on an HTML template.
- Four corner markers let the software straighten the image.
- A QR code holds the tournament, round, room, sheet type and a sheet ID, signed with an HMAC key that only the host has, so photocopies of other rooms' sheets are caught.
- Pre-printed team and speaker names.
- For each speech, bubble rows for **tens**, **units** and **half point**. The score range comes from the tournament's settings, and rows outside the range are left out.
- BP ranks (1st–4th) or the two-team winner, plus a speaker-order section for two-team formats (who spoke in which position, reply speaker, iron-person).
- Boxed **handwritten team totals**, used only as a cross-check.

**Reading it:**

- **Image sources:** a staff webcam; phone photos, taken by a runner and imported on a staff laptop from a USB or shared folder; or a document scanner saving into a **watched folder**, including multi-page PDFs.
- **Processing** runs in a worker thread with `@techstark/opencv-js` 4.5.2 (OpenCV compiled to WebAssembly, no native install). The steps are: find the markers, correct the perspective, decode the QR (with `jsqr`), then sample each bubble's darkness against the sheet's own light and dark reference squares.
- **A ballot goes in without review only if all of these hold:**
  - exactly one bubble is filled in every required row;
  - every mark is clearly dark or clearly empty, with no in-between;
  - the scores, ranks and winner agree with each other (CrabbyTab's ballot validation);
  - the bubble totals match the handwritten totals, which are read only when the "require totals" option is on, and otherwise left to a person.
- **Anything else** goes to a **Review queue**. It shows the straightened photo with the questionable rows highlighted, and a person fixes them in one click per row.
- **Confirmation** follows the tournament's normal setting (tab-room confirmation by default). The "Trust clean bubble sheets" option, off by default, auto-confirms sheets that passed every check.
- **The same sheet scanned twice** is detected through the sheet ID and ignored.

**Accuracy gate** (M11 checkpoint):

- On the fixture set (synthetic and real scans; rotated, shadowed, low-resolution, light and heavy pens), at least 99.5% of rows are read correctly.
- **No silent errors:** every misread row must have been sent to review.

### 9. Credentials, electron-main and setup

Theia runs three processes:

- **electron-main** holds `safeStorage` (Windows DPAPI), the projector window and the updater.
- **backend** holds everything in section 3, section 4 and section 7.
- **frontend** holds the UI.

The backend asks electron-main through a fixed RPC. **Secret values never leave electron-main.**

```text
credentials.status(): { name: CredentialName; set: boolean; testedAt?: string; ok?: boolean }[]
credentials.set(name: CredentialName, value: string): void        // called only from the Credentials page
credentials.clear(name: CredentialName): void
credentials.test(name: CredentialName): { ok: boolean; error?: string }
credentials.fetch(name: "tournamentKey", req: { method, path, headers, body? })
    : { status: number; headers: Record<string,string>; body: string }   // electron-main adds the secret header and makes the HTTPS request itself
credentials.runPublish(name: "cdnToken", args: PublishArgs): { ok: boolean; log: string }  // electron-main uploads through Cloudflare's Pages API with the token (amendment 6)
credentials.sendMail(name: "smtp", msg: MailBatch): { sent: number; failed: { to: string; error: string }[] }
credentials.archiveToGitHub(name: "githubToken", args: ArchiveArgs): { ok: boolean; commitSha?: string; pagesUrl?: string; error?: string }  // section 10.1
CredentialName = "tournamentKey" | "cdnToken" | "smtp" | "ownWorkerToken" | "githubToken"
```

Secret values never reach the backend, the frontend or any log.

- **The Credentials page** (Host owner only) holds the tournament key, the CDN choice and token, SMTP settings and optional own free-tier keys.
- **The setup checklist** covers: requesting the key ("pending since …"), connecting the CDN, connecting SMTP, a test publish, and optionally connecting the GitHub archive repository (checks that it is public and that the token can write to it). Each step has a Test button. The checklist warns to request the key at least 48 hours before the event.

### 10. Publishing

1. **Build.** The host builds the public projection (ported from CrabbyTab; only what the release gates allow; never feedback; anonymous people redacted). It writes:
   - content-hashed JSON chunks;
   - the pinned `simpletab-public` assets;
   - `motions/`, the bundle files in `rounds/`, and the form definitions in `forms/`;
   - `manifest.json`, holding the schema, publish time, head hash and public chain.
2. **Upload (amendment 6).** electron-main uploads the built directory through Cloudflare's Pages Direct Upload API with `fetch`, the same steps `wrangler pages deploy` takes: an upload token, `check-missing`, `upload` of only the missing files (batches of at most 40 MiB and 1,000 files), `upsert-hashes`, then the deployment with a manifest of every file. Asset keys are Wrangler's (the first 32 hex characters of BLAKE3 of the base64 contents plus the extension), computed with `@noble/hashes`. Bundling Wrangler was dropped: its CLI needs the workerd and esbuild native binaries even for a static upload, about 220 MB. It uses the tournament's own Cloudflare API token, scoped to "Pages: Edit" on that account; the token never leaves electron-main and is scrubbed from every error. The M4 checkpoint runs this on the reference laptop. Cloudflare Pages is the only CDN in the first release; GitHub Pages is a future option (its project sites live under a path, which the link format does not carry).
3. **Confirm.** The host sends the head to the service, then confirms the publish by fetching `manifest.json` from the CDN.

Publishes are batched to at most one every 30 s.

#### 10.1 Permanent archive on GitHub (amendment 1)

The live site stays on the tournament's Cloudflare Pages project. The archive is a second, permanent copy, meant to be read for years after the event. It uses a GitHub repository that the tournament owns, served by GitHub Pages, which is free for public repositories.

**What goes in.** Only material that is already public:

- the public site, built from the same public projection and release gates as the live site;
- `manifest.json`, the public changelog chain, and every head hash;
- `exports/`:
  - CSVs of the released tabs (team, speaker, replies, categories, break) and of the results;
  - a DebateXML file. CrabbyTab's DebateXML export already leaves out emails, private keys, passcodes and feedback comments, and the archive applies the release gates on top of that;
- a generated `README.md` with the tournament name, dates, format, champions and links to the pages.

**What never goes in:** round bundles (`rounds/`), `forms/`, unreleased motions, feedback, link secrets, contact details, or anything behind a closed gate.

**How it publishes** (electron-main, through `credentials.archiveToGitHub`):

- It uses GitHub's REST API directly with `fetch`, so no git binary is needed:
  1. create one blob for each new or changed file (unchanged files reuse their blob SHA);
  2. create a tree;
  3. create a commit whose parent is the current `gh-pages` head;
  4. move `refs/heads/gh-pages` forward.
- It never force-pushes, so every archive publish stays in the history. Because each commit carries that publish's `manifest.json`, the git history is also a public record of every head hash.
- If Pages is off, it turns it on (`POST /repos/{owner}/{repo}/pages`, source `gh-pages` at `/`), then reads `manifest.json` back from the Pages address to confirm.
- **Token:** a fine-grained GitHub token for that single repository, with Contents: read and write and Pages: read and write. It is stored in Credentials as `githubToken`. The repository must be public, because Pages is free only for public repositories; the setup checklist checks this.
- **Limits:** GitHub's 5,000 API requests an hour is enough for about 1,000 changed files per publish. The 1 GB site limit and the soft 100 GB/month bandwidth limit are far above what a tournament archive needs.

**When it publishes:**

- "Archive to GitHub" on the Releases page, at any time.
- A prompt when the tournament is closed (`POST /v1/host/close`), which is the recommended moment.
- Optionally, "Mirror every publish to the archive", off by default. When it is on, each live publish is followed by an archive commit; mirror commits are batched to at most one every 10 minutes.

**Paths.** GitHub project sites are served under `/<repo>/`. So the `simpletab-public` app is built with relative asset paths (Vite `base: './'`) and hash-based routing (`#/draw/3`), and it works the same at a domain root (Cloudflare Pages) or under a sub-path (GitHub Pages).

**As built (M4).** The repository is set as `owner/name` in Online settings (`githubRepo`), next to the `githubArchive` switch; the mirror switch is `githubArchiveMirror`. The archive is built in `<workspace>/archive` from the same public projection as the live site (`archive-build.ts`), so the exports carry only released, redacted fields. DebateXML is skipped, with the reason in the README, when the released data cannot form a valid file (for example no released venues). An archive whose tree matches the current `gh-pages` commit makes no commit. A landed commit counts as done even when GitHub Pages has not served it yet or could not be turned on with the token; the status says so in words. Not yet built: the prompt when the tournament is closed (it waits for the close flow), and the setup checklist's public-repository check.

**Verify page in the archive.** It checks the chain from the archived `manifest.json`. Asking the shared service for its recorded heads stays optional, because the service may be gone years later. The repository's commit history then serves as the independent record of earlier heads.

### 11. Desktop shell (Theia 1.77.0)

- **Theia Electron app.** All `@theia/*` packages are pinned to 1.77.0, and Electron 44.9.1 (the version `@theia/electron` requires) is used. The modules ship in the author's order:
  1. **Git panel (M2):** `@theia/plugin-ext` and `@theia/plugin-ext-vscode`, running only the built-in `vscode.git` and `vscode.git-base` plugins. They are pinned to the versions in Theia 1.77.0's example app `theiaPlugins`. The extensions view stays hidden until M9.
  2. **Live collaboration (M5):** SimpleTab's own extension.
  3. **Terminal (M6):** `@theia/terminal`.
  4. **File explorer (M7):** `@theia/navigator`. If the git plugins need it, it is included at M2 with its view hidden.
  5. **Command palette commands (M8):** every SimpleTab action is registered as a command.
- **Tab screens** are React 19 widgets inside Theia. They use Theia's own CSS variables and widget styles, with no Tailwind and no extra UI kit. The screens' behaviour follows CrabbyTab's matching pages.
- **Status bar and panel:** online or offline; last push, pull and publish; ballots in versus expected per room; share left; host number; queued ops; devices. Every state has a text label.
- **Memory.** The backend runs with `--max-old-space-size=2048`, and Theia modules that are not needed are left out.
- **Updates.** `electron-updater` 6.8.11 uses the GitHub provider with `autoInstallOnAppQuit=false`. Before installing, it checks the downloaded file's SHA-256 against `SHA256SUMS`, which is published in a separate `simpletab/update-hashes` GitHub release. That release is uploaded by a second CI job using a different token. The app is unsigned, and the install guide explains SmartScreen.

### 12. Internationalisation

- Each repo keeps its own catalogs in `locales/<lang>/*.json`, written in ICU MessageFormat and formatted with `intl-messageformat` 12.2.0.
- CrabbyTab's TypeScript catalogs (`src/lib/i18n/messages`) are converted once by a script to make the starting English and Bangla files.
- `locales/TEMPLATE/` holds every key with an empty value, and `docs/adding-a-language.md` explains how to add a language.
- CI fails if a shipped language is missing a key or has an extra one.
- Numbers and dates follow the locale (for example, Bangla digits where the locale asks for them).

### 13. Free-tier budget (decision A)

**Limits** (Cloudflare free tier, checked 2026-11-18):

- 100,000 Worker requests a day;
- D1: 100,000 rows written and 5,000,000 rows read a day;
- D1 counts index updates as rows written.

**One WUDC-size tournament-day:** 4 rounds, 100 rooms, 400 teams, 500 adjudicators.

| Traffic | Requests / day | D1 rows written / day |
|---|---|---|
| Check-in: 1 per team (any speaker) + 1 per adjudicator, × 4 rounds = 3,600 | 3,600 | 7,200 (the row + its `UNIQUE(submission_id)` index; the table has no other index, see Appendix D) |
| Ballots: BP consensus, 100 × 4 | 400 | 800 |
| Feedback: per room, 4 team forms + about 4 panel forms = 8 × 100 × 4 | 3,200 | 6,400 |
| Status checks: about 0.3 per form | 2,200 | 0 |
| Host pulls (30 s for 10 h, plus idle) + acks | 1,300 | 1,200 |
| Permits, heads, registration settings | 150 | 150 |
| Usage flushes (≤ 1 a minute per active isolate) | 0 | 1,000 |
| **Total** | **≈ 10,850** | **≈ 16,750** |

**Writes per route** (rows, including indexes):

| Route | Rows written |
|---|---|
| `submit` | 2 |
| `status` | 0 |
| `ack` | 1 |
| `permits` | 1 per round |
| `head` | 1 |
| `register` | 2 |
| usage flush | 1 per tournament per isolate-minute |
| archive delete | at most 5,000 rows a day across the service, in batches of 500 (amendment 5) |

**The budget.** Of D1's 100,000 writes a day:

- 10,000 are reserved for registration, across the whole service;
- **at most 80,000** go to the approved tournament shares (the admin page enforces the total);
- the rest is margin for the approximate counters.

**The capacity check:**

- One WUDC-size day is about 16,750 writes, so **3 of them** use 50,250, or 63% of the 80,000.
- A 100-team tournament (about 25 rooms and 225 participants) uses about 4,200 writes, so **15 of them** use about 63,000, or 79%.
- Requests are not the binding limit: 3 × 10,850 = 32,550 of 100,000.

**Default share** for a tournament with P participants (teams + adjudicators). It is sized to cover one full tournament-day:

- `requests = 2,000 + 12 × P` (amendment 5: host polling every 30 s does not shrink with tournament size, and a measured 100-team day uses about 4,100 requests);
- `writes = 1,000 + 18 × P`.

For WUDC, P = 900, which gives 12,800 requests and 17,200 writes, against a measured 11,350 and 15,890. For a 100-team tournament, P = 225, which gives 4,700 and 5,050, against a measured 4,090 and 4,774; fifteen of those total 75,750 writes, which fits under 80,000. The author can change any share from the admin page.

**Registration** has its own default limits per tournament: a cap of 1.5 × expected participants, and 5,000 writes in total. All tournaments together share the global 10,000 registration writes a day.

`scripts/budget.mjs` replays this traffic against the final SQL schema and counts rows, indexes included. Measured results and assumptions are in `simpletab-ballots/docs/free-tier-budget.md`.

**A 1000-team BP tournament** (≈250 rooms, ≈1,250 adjudicators, P ≈ 2,250) needs about 27,000 requests and 42,000 writes a day. That fits **only on a day it has to itself**, with its share raised to about 42,000 writes (the default formula gives 41,500). Running it in QR-only mode (section 8.2) uses no service traffic at all.

**Ways to save writes:**

- Check-in can be done by staff scanning on the tab-room network, which uses 0 service writes.
- Feedback can be turned off for some paths.
- A tournament can bring its own free-tier keys.

--------------------------------------------------------------------------------

## Alternatives Considered

### A. Use Tabbycat as it is (self-hosted)
*   **Pros:** mature; known by tab teams.
*   **Cons:** it needs a running server (Django, PostgreSQL, Redis) all tournament, so it cannot run offline; every page view hits the database.
*   **Reason for rejection:** Rejected by author: the goals are offline tabbing and zero running cost.

### B. Keep CrabbyTab's cloud-first architecture
*   **Pros:** it exists; nothing to install.
*   **Cons:** metered reads; merging between browsers; rules written twice; offline support needs heavy browser mirrors.
*   **Reason for rejection:** Rejected by author: start clean with one host. CrabbyTab's logic is reused, but not its sync.

### C. Fork VS Code OSS
*   **Pros:** every editor feature; the team knows the pipeline.
*   **Cons:** a huge fork to rebase every month; tab screens would all live in webviews.
*   **Reason for rejection:** Rejected by author in favour of Theia.

### D. A custom Electron shell
*   **Pros:** smallest app.
*   **Cons:** terminal, git, file explorer, command palette and extensions would all have to be built and maintained.
*   **Reason for rejection:** Rejected by author.

### E. Merge-based collaboration (CRDT)
*   **Pros:** no single host; offline edits merge later.
*   **Cons:** tab data has rules that span many records (one chair per room, no team in two debates). Merges can break them, and merged results are hard to explain at a disputed break.
*   **Reason for rejection:** the author requires one host whose decision wins.

### F. Ballots served by the host over the venue network
*   **Pros:** no internet needed; no quota used.
*   **Cons:** poor venue Wi-Fi; plain HTTP exposes ballots; local HTTPS needs certificates that phones distrust; a hotspot allows 8 devices.
*   **Reason for rejection:** Rejected by author: participant traffic goes over the internet only.

### G. Bluetooth or Wi-Fi Direct for phones
*   **Pros:** no infrastructure.
*   **Cons:** phone browsers support neither for loading pages.
*   **Reason for rejection:** not technically possible.

### H. Each tournament runs its own service
*   **Pros:** no shared quota.
*   **Cons:** heavy setup for every tab team.
*   **Reason for rejection:** Rejected by author: one shared service. Own free-tier keys remain an option.

### I. Redis in front of the database
*   **Pros:** the author's original stack; fast counters.
*   **Cons:** a second always-on dependency, with the smallest free limit.
*   **Reason for rejection:** deferred (AD3). Counters live in memory and in the Workers rate-limiting binding.

### J. One encrypted file per participant
*   **Pros:** simple.
*   **Cons:** about 1,700 files per release; weak 59-bit link keys; history kept in git.
*   **Reason for rejection:** replaced by 32-bucket round bundles with 128-bit secrets.

### K. Delete or encrypt-and-drop online data after a tournament
*   **Pros:** a small database; supports erasure requests.
*   **Cons:** more moving parts.
*   **Reason for rejection:** Rejected by author (AD1). Closed tournaments move to R2 and are kept.

### L. A credential recovery bundle for promotion
*   **Pros:** promotion would not need the author.
*   **Cons:** spreads secrets.
*   **Reason for rejection:** Rejected by author (AD2). The design review raised it again, and it remains an accepted risk.

### M. One monorepo for all three apps
*   **Pros:** no package publishing.
*   **Cons:** mixes three release cycles.
*   **Reason for rejection:** Rejected by author.

### N. Rewrite the domain logic
*   **Pros:** a clean break.
*   **Cons:** loses tested and golden-checked logic.
*   **Reason for rejection:** Rejected by author.

### O. Invite-only registration first
*   **Pros:** no bot traffic.
*   **Cons:** institutions must be set up on the host before anyone can register.
*   **Reason for rejection:** Rejected by author for now (AD5): open registration ships at M10, invite-only later.

### P. Turso or Upstash instead of D1
*   **Pros:** larger monthly limits.
*   **Cons:** a second vendor.
*   **Reason for rejection:** D1 and R2 keep everything on one free platform. Turso stays the fallback if D1's terms change.

### Q. Plain SQLite state with audit rows, and no op log
*   **Pros:** less machinery (raised by the Zoom-out reviewer).
*   **Cons:** collaboration ordering, undo, the changelog and promotion would each need their own mechanism.
*   **Reason for rejection:** one op log serves all four.

### R. CPace or SPAKE2 pairing
*   **Pros:** cryptographic protection for short codes.
*   **Cons:** the available JS libraries are stale and unaudited.
*   **Reason for rejection:** replaced by a short code plus 6 matching words and host approval.

### S. `@theia/git` for the git panel
*   **Pros:** a native Theia module.
*   **Cons:** deprecated at 1.60.2 and incompatible with Theia 1.77.
*   **Reason for rejection:** VS Code's built-in Git runs in the plugin host instead (decision B).

### T. A quorum lease (Raft) between laptops
*   **Pros:** automatic, safe leader election.
*   **Cons:** heavy for a tab room.
*   **Reason for rejection:** the host-number rule and the read-only demotion handle the risk (decision C).

### U. Simpler portal: the Worker serves each person's view from a plain "round sheet"
*   **Pros:** no round bundles, buckets, padding, `forms/` files or CDN address in links; a much smaller M3. Capacity still holds (about 21,000 requests per WUDC-size day).
*   **Cons:** about twice the Worker requests; the shared service would see rooms and panels before they are public.
*   **Reason for rejection:** Rejected by author (2026-11-23): keep the encrypted round bundles, so that the service never sees draws before release.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Security and privacy:**
    - Credentials are stored and used only in electron-main (`safeStorage`; section 9's RPC makes the requests there). They never reach the backend, the frontend, logs or disk.
    - The host checks every op.
    - Each staff device gets only its projection; a removed device wipes its copy.
    - Link secrets and file keys never reach a server.
    - The service stores only hashes of keys and verifiers.
    - Feedback is never published, and the GitHub archive (section 10.1) holds only gate-released public material, never round bundles, forms or link secrets.
    - The AI acts only through proposals.
*   **Performance:** the Goal 2 targets. Long ops run in worker threads.
*   **Operations:**
    - The status panel shows sync, share and publish health.
    - The admin page shows usage and storage.
    - D1 has Time Travel (30-day restore) on the free plan, and R2 archives are never deleted.
*   **Rollout and rollback:**
    - Receivers accept the current wire schema and the previous one.
    - A desktop rollback means installing the previous GitHub release. SQLite migrations run forward only, after an automatic backup file.
    - The service rolls back with `wrangler rollback`. D1 migrations add things only (no destructive changes).

--------------------------------------------------------------------------------

### Additional Resources

*   CrabbyTab: `../crabbytab/src/lib`, `../crabbytab/src/features/tournament/application`, `../crabbytab/tools/tabbycat-diff`
*   Tabbycat (reference only): `../simpletab-ref/tabbycat`
*   Elephant-Goldfish Model: https://github.com/google/elephant-goldfish-model
*   Free-tier limits with sources: [review_report.md](review_report.md), section 1

### Future Improvements

*   VS Code extensions in general, and a SimpleTab marketplace (after M9).
*   An AI assistant panel inside the app.
*   Invite-only registration.
*   GitHub Pages as the live CDN, which would need a path prefix in the link format. (A permanent archive on GitHub Pages is already in scope: section 10.1.)
*   macOS and Linux builds.
*   Assistant tab directors working over the internet.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Milestones and checkpoints

Every milestone ends with its checkpoint commands passing on CI and on the reference laptop.

| M | Delivers | Checkpoint (all must pass) |
|---|---|---|
| M0 | `@simpletab/core`: the CrabbyTab port (Appendix F), ops (Appendix A), permissions (Appendix C), changelog, crypto, wire formats | `npm test -w @simpletab/core`; `npm run port-check`; `npm run tabbycat-diff`; `npm run lint` |
| M1 | Host app, offline tabbing end to end: setup → check-in → draw → allocation → motions → results → standings → break; changelog, undo, handover, projector, credentials, status panel. Public-site bundle stubbed. | M0, plus `npm test -w @simpletab/host -w @simpletab/tab-ui`; `npm run bench` (Goal 2); `npm run package:win` opens and runs the scripted demo tournament |
| M2 | Git panel | M1, plus a manual check (stage, commit and diff a CSV in the workspace), recorded in `docs/checks/M2.md` |
| M3 | `simpletab-ballots`: Worker, phone app, permits, inbox, status, QR fallback, shares, admin, R2 archive; host sync | In `simpletab-ballots`: `npm test` (Miniflare); `npm run budget` (section 13). In `simpletab`: `npm run e2e:sync` |
| M4 | `simpletab-public` and publishing (Cloudflare Pages), head witness, permanent GitHub archive (section 10.1) | In `simpletab-public`: `npm test`. In `simpletab`: `npm run e2e:publish` against a test Pages project; `npm run e2e:archive` against a test GitHub repository |
| M5 | Live collaboration: Devices page, pairing, projections, outbox, promotion, assistant mode | `npm run e2e:collab` (15 clients, p95 ≤ 1 s, Equity never receives feedback, promotion keeps every broadcast op, the old host is demoted) |
| M6 | Terminal and CLI; AI proposals | `npm test -w @simpletab/cli`; `npm run e2e:cli` |
| M7 | File explorer | manual check recorded in `docs/checks/M7.md` |
| M8 | Command palette commands for every action | `npm run e2e:commands` (every widget action is reachable as a command) |
| M9 | General extensions (plugin UI shown) | out of scope for this design; to be designed separately |
| M10 | Open registration | `simpletab-ballots`: `npm test -- register`; `simpletab`: `npm run e2e:registration` |
| M11 | Bubble-sheet (OMR) ballots (section 8.3) | `npm test -w @simpletab/host -- omr`; `npm run omr:accuracy` (≥ 99.5% of rows read correctly and no silent errors on the fixture set); a manual 3-round paper rehearsal recorded in `docs/checks/M11.md` |

**The first usable release is M0–M5.** From M3, the host itself can scan QR ballots with its own webcam; scanning on assistant devices comes with M5.

### Libraries and versions (pinned)

| Purpose | Package and version |
|---|---|
| Desktop shell | `@theia/core`, `@theia/electron`, `@theia/workspace`, `@theia/preferences`, `@theia/messages`, `@theia/plugin-ext`, `@theia/plugin-ext-vscode`, `@theia/terminal`, `@theia/navigator`, `@theia/cli`: all **1.77.0**. Electron **44.9.1** (required by `@theia/electron`). |
| SQLite | `better-sqlite3` 13.2.0; `@electron/rebuild` 4.2.1 |
| WebSocket | `ws` 8.23.0 |
| Email | `nodemailer` 10.6.0 |
| CSV | `papaparse` 5.7.1 |
| Zip / gzip | `fflate` 0.8.3 |
| QR code generation | `qrcode-generator` 2.0.4 (replaces CrabbyTab's own `lib/qr/qrcode.ts`, which stays as reference) |
| QR code scanning | `jsqr` 1.4.0, run on webcam frames (`BarcodeDetector` is not available on Windows desktop Chromium) |
| Translation | `intl-messageformat` 12.2.0 |
| Pairing words | the BIP39 English word list, bundled as JSON (MIT), with no runtime package |
| Certificates | `@peculiar/x509` 3.1.0 (self-signed P-256 certificates for pairing) |
| Cloudflare Pages publishing | Cloudflare's Pages Direct Upload API over `fetch` from electron-main; `@noble/hashes` 2.4.0 for BLAKE3 asset keys (amendment 6) |
| Updates and installer | `electron-updater` 6.8.11; `electron-builder` 26.18.0 |
| UI | `react` 19.3.1, `react-dom` 19.3.1 |
| Service | `wrangler` 4.165.0; `@cloudflare/workers-types` 5.20261119.1; `@cloudflare/vitest-pool-workers` 0.23.0 for tests (it uses the same workerd runtime as the pinned Wrangler) |
| Public site | `vite` 8.3.8; `@vitejs/plugin-react` 6.3.0 |
| Tooling | `typescript` 5.9.3 (CrabbyTab uses 5.x); `vitest` 5.1.1 (`test.projects`, no `vitest.workspace.ts`); `@testing-library/react` 16.3.3; `eslint` 9.39.5 with `typescript-eslint` 8.73.0 (flat config); `@xmldom/xmldom` 0.9.x (tabbycat-diff only) |

TypeScript keeps CrabbyTab's settings: `strict` on and `noUncheckedIndexedAccess` off. The `@/*` path alias is kept inside `packages/core`, mapped to `packages/core/src/*`.

### Repo 1: `simpletab`

| # | File(s) | M | Create / Modify | What and why |
|---|---|---|---|---|
| 1 | `package.json`, `package-lock.json` | M0 | Create | Workspaces `packages/*` and `tools/*`.<br>Scripts:<br>• `build`, `test`, `lint`;<br>• `port-check`, `tabbycat-diff`, `bench`, `package:win`;<br>• `e2e:offline`, `e2e:sync`, `e2e:publish`, `e2e:archive`, `e2e:collab`, `e2e:cli`, `e2e:commands`, `e2e:registration`;<br>• `i18n:check`.<br>Node 22. |
| 2 | `tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts` | M0 | Create | Settings as above.<br>ESLint `no-restricted-imports` forbids in `packages/core/src/**` except `*.test.ts`: `node:*`, `react`, `electron`, and DOM globals (`no-restricted-globals`: `window`, `document`, `localStorage`, `indexedDB`). |
| 3 | `LICENSE` (AGPL-3.0), `README.md`, `AGENTS.md`, `docs/designs/*` | M0 | Create | `AGENTS.md` carries SimpleTab's rules: only the host decides; one set of rules in core; no secrets in state. The design documents move here. |
| 4 | `packages/core/package.json` | M0 | Create | ESM, exports per folder (`domain`, `ops`, `permissions`, `projection`, `changelog`, `wire`, `crypto`, `bundle`, `publicView`, `labels`). Dependency: `papaparse`. Published to npm from M3 onwards. |
| 5 | `packages/core/src/domain/**` | M0 | Create (port) | The modules in Appendix F, with their tests. Imports are rewritten by the mapping table in Appendix F. Assertions stay unchanged. |
| 6 | `packages/core/src/domain/types.ts` | M0 | Create (port) | CrabbyTab `src/types/index.ts` without `syncVersion` and without Firebase-only types. |
| 7 | `packages/core/src/labels/**` | M0 | Create | Shared domain labels (side names, metrics, error codes) as `intl-messageformat` keys. `sideNames.ts` and `preferenceValidation.ts` take a translate function as a parameter instead of importing CrabbyTab's i18n module. |
| 8 | `packages/core/src/ops/{types,catalog,engine-core,inverse}.ts` + tests | M0 | Create | Each op is an `OpDef` with `type`, `permission`, `reads`, `writes`, `guards`, `apply`, `inverse`, `lock`, `visibility` and `releaseGate?`. The catalogue is Appendix A. Guards call the ported CrabbyTab functions named there.<br>Tests:<br>• apply → inverse gives the same state;<br>• guards reject invalid states;<br>• a version mismatch is detected;<br>• the undo rule (section 3) holds. |
| 9 | `packages/core/src/permissions/{catalog,roles}.ts`, `projection/project.ts` + tests | M0 | Create | Appendix C, plus the projection rules in section 6.<br>Tests: each role against a fixture state, at the field level. |
| 10 | `packages/core/src/changelog/{v2,jcs,verify}.ts` + tests | M0 | Create | Section 5 and RFC 8785.<br>Tests:<br>• RFC 8785 test vectors;<br>• tampering with any field, the order, the actor type or the payload fails verification;<br>• a revealed private entry verifies. |
| 11 | `packages/core/src/wire/*.ts` + tests | M0 | Create | Appendix E schemas, with hand-written `parseX(unknown) → Result` functions. |
| 12 | `packages/core/src/crypto/{links,keys,qr}.ts`, `bundle/{format,seal,open}.ts` + tests | M0 | Create | Section 8 and Appendix E, with WebCrypto only.<br>Tests:<br>• known-answer vectors;<br>• a wrong passcode fails;<br>• a forged QR code fails;<br>• a row can't be read without its secret;<br>• bucket padding holds. |
| 13 | `packages/core/src/publicView/**` | M0 | Create (port) | The public projection and release gates (Appendix B). |
| 14 | `tools/tabbycat-diff/**` | M0 | Create (port) | CrabbyTab's `tools/tabbycat-diff` (fixtures, golden, harness, `known-differences.json`). It imports `draws.ts` and `allocation.ts` from core (`domain/guards`); only `debateXmlImport.ts` is ported into the tool's own `harness/adapters/` folder. Dev dependency: `@xmldom/xmldom`. |
| 15 | `tools/port-check.mjs`, `tools/rewrite-imports.mjs` | M0 | Create | Computes the import closure of `packages/core/src` and fails if it reaches anything outside core or any forbidden import. It also checks that every CrabbyTab test listed in Appendix F exists in core. |
| 16 | `tools/convert-locales.mjs` | M1 | Create | A one-time conversion of CrabbyTab's `src/lib/i18n/messages/**` (en, bn) into ICU JSON for each app. |
| 17 | `packages/host/package.json` | M1 | Create | `theiaExtensions: [{ "backend": "lib/node/host-backend-module", "electronMain": "lib/electron-main/host-main-module" }]`.<br>Dependencies: `better-sqlite3`, `ws`, `nodemailer`, `fflate`, `@peculiar/x509`, `@simpletab/core`. |
| 18 | `packages/host/src/electron-main/{host-main-module,credentials,projector-window,updater}.ts` | M1 | Create | The `safeStorage` credentials RPC (section 9), the projector `BrowserWindow`, and the updater (section 11). |
| 19 | `packages/host/src/node/db/{schema.sql,migrations/*.sql,database.ts}` | M1 | Create | Appendix D. Forward-only migrations, each run after an automatic backup file. |
| 20 | `packages/host/src/node/engine/{engine,locks,workers,long-op-worker}.ts` | M1 | Create | Section 4: queue, versions, forced host ops, locks, a `worker_threads` pool (size = CPU count − 1, at least 1) for long ops, and cancel. |
| 21 | `packages/host/src/node/engine/{integrity,snapshots,state-hash}.ts` | M1 | Create | Section 3: the fast and full checks; snapshots every 2,000 ops and at round completion. The state hash is the SHA-256 of the per-table SHA-256s, in Appendix D's table order, of the JCS of rows sorted by `id`. |
| 22 | `packages/host/src/node/handover/{export,import,divergent}.ts` | M1 | Create | Section 3's handover format; section 4's divergent-op export. |
| 23 | `packages/host/src/node/links/{links,slips}.ts` | M1 | Create | Generates and regenerates links (the `private_urls.regenerate` op); prints QR slips with `qrcode-generator`. |
| 24 | `packages/host/src/node/email/smtp.ts` | M1 | Create | Sends private-link emails through the host's SMTP with `nodemailer`, at most 100 recipients a batch, using CrabbyTab's template variables `{{private_url}}` and `{{passcode}}`. |
| 25 | `packages/host/src/node/sync/{service-client,scheduler,inbox-to-ops}.ts` | M3 | Create | Section 7's routes and schedule. Inbox items become `ballot.receive_online`, `feedback.receive_online`, `checkin.self_checkin` or `registration.receive` ops. |
| 26 | `packages/host/src/node/publish/{publisher,projection-build,bundle-build,cloudflare-pages,archive-build,verify}.ts` | M4 | Create | Section 10. Before M4, `bundle-build` and `projection-build` are used only by tests. `archive-build.ts` assembles the section 10.1 file set (site, manifest, `exports/`, README) and refuses any path under `rounds/` or `forms/`. |
| 26a | `packages/host/src/electron-main/github-archive.ts` + test | M4 | Create | Section 10.1: blob, tree, commit and ref updates through GitHub's REST API with `fetch`; enabling Pages; read-back check. Tests against a mocked API cover: unchanged files are reused, commits are never forced, and a failed ref update leaves the branch unchanged. |
| 27 | `packages/host/src/node/collab/{server,pairing,words,tls,projection-stream,outbox,promotion,succession,host-number}.ts` | M5 | Create | Section 4. `words.ts` holds the bundled BIP39 list. `promotion.ts` does the catch-up and rank checks. |
| 28 | `packages/host/src/node/cli-server.ts` | M6 | Create | A local endpoint for the CLI, which pairs as an AI-role device; it turns AI ops into proposals. |
| 29 | `packages/host/src/node/**/*.test.ts` | M1–M6 | Create | Tests per file: engine order, conflicts, forced ops and cancel; integrity detection; handover round-trip; sync retry and idempotency; publisher diffing; pairing (wrong code, expired code, word mismatch); ballot deadline (a late inbox item goes to the late list; a tab assistant cannot enter or scan a late ballot; a Tab director can, and it is marked `late`; a clock skew over 2 minutes shows a warning); projection on the wire; promotion and demotion. |
| 30 | `packages/tab-ui/package.json`, `src/browser/tab-ui-frontend-module.ts` | M1 | Create | `theiaExtensions: [{ "frontend": "lib/browser/tab-ui-frontend-module" }]`; widgets, the status bar, and commands (all actions become commands at M8). |
| 31 | `packages/tab-ui/src/browser/views/*.tsx` | M1 (M5 for devices and assistant mode; M10 for registration) | Create | Widgets: credentials, setup checklist, participants, venues, check-in, draw, allocation (drag and drop with `allocation.swap_rooms`; "holding" presence at M5), motions, results (with the per-round ballot deadline setting and the "Late online submissions" list, M3), feedback, standings, break, releases (with "Archive to GitHub" and the mirror switch, M4), links, changelog, status, devices, assistant mode (webcam scanner with `jsqr`), registration, proposals (M6). |
| 32 | `packages/tab-ui/src/browser/locales/{en,bn,TEMPLATE}/*.json`, `i18n.ts` | M1 | Create | Section 12. |
| 33 | `packages/tab-ui/src/browser/**/*.test.tsx` | M1 | Create | Conflict display, status labels, role-hidden actions, pending (unconfirmed) markers. |
| 34 | `packages/cli/**` | M6 | Create | `simpletab pair | status | show <area> | op <type> --json | proposals list|accept|reject` (accept and reject need a human role), plus a README for AI agents. |
| 35 | `packages/app/package.json`, `electron-builder.yml`, `src-gen` config | M1 (plugins at M2) | Create | Theia app with the packages in section 11; `theiaPlugins` lists only `vscode.git` and `vscode.git-base` at M2. Branding: SimpleTab, `app.simpletab.desktop`. NSIS, unsigned, publishing to GitHub Releases. `postinstall`: `electron-rebuild -f -w better-sqlite3`. |
| 36 | `packages/app/resources/public-site/` + `scripts/fetch-public-site.mjs` | M1 (stub) / M4 | Create | M1–M3: a stub site, "Public site not built yet". M4: downloads the pinned `simpletab-public` release zip and checks its SHA-256. |
| 37 | `packages/host/src/electron-main/cloudflare-pages.ts` | M4 | Create | Pages Direct Upload over `fetch` (amendment 6; replaces the bundled Wrangler). |
| 38 | `tools/bench/{generate-wudc.ts,bench.ts}` | M1 | Create | A seeded generator with two sizes: `--size wudc` (400 teams, 500 adjudicators, 100 rooms) and `--size xl` (1000 teams, 1,250 adjudicators, 250 rooms). For `wudc` the benchmark fails if any Goal 2 target is missed. |
| 38a | `packages/host/src/node/omr/{reader,align,bubbles,qr,folder-watch,review-queue}.ts`, `packages/host/src/node/omr/fixtures/**`, tests | M11 | Create | Section 8.3: worker-thread reader (`@techstark/opencv-js` 4.5.2, `jsqr`), the watched folder (scanner output, PDF pages split with `pdf-lib` 1.17.1), and the review queue. `npm run omr:accuracy` runs the fixture set. |
| 38b | `packages/core/src/omr/{sheet-layout,sheet-id}.ts` + tests; `packages/tab-ui/src/browser/views/{omr-print,omr-review}.tsx` | M11 | Create | Sheet layout from tournament settings (score range, format, speakers); signed sheet IDs; printing to PDF; the review screen with the straightened photo and highlighted rows. |
| 38c | `packages/tab-ui/src/browser/views/qr-scan.tsx`, `packages/host/src/node/ballots/{qr-intake,auto-confirm}.ts` + tests | M3 | Create | Section 8.2: scan box for webcam and USB 2D scanners (keyboard input); fragment joining; signature check; optional auto-confirm by the `system` actor; the Ballot collection setting. Tests cover forged, duplicate and conflicting two-team sheets. |
| 39 | `tools/e2e/{offline,sync,publish,archive,collab,cli,commands,registration}.test.ts` | M3–M10 | Create | The checkpoints above. `collab` runs 15 headless clients in one process tree. |
| 40 | `tools/determinism/{fixtures/*.json,draw-hashes.json}` + test | M0 | Create | The draw output hash for each fixture and seed is committed, and CI checks the hashes on both Windows and Ubuntu runners. |
| 41 | `docs/{install,running-a-tournament,collaboration,host-failure,changelog-verification,adding-a-language,cli-and-ai,formats,free-tier-budget}.md`, `docs/checks/` | M1–M8 | Create | User and operator documentation; manual check records. |
| 42 | `.github/workflows/{ci.yml,release.yml,update-hashes.yml}` | M0 / M1 | Create | `ci.yml`: lint, test, `port-check`, `i18n:check` and `tabbycat-diff` on Windows and Ubuntu.<br>`release.yml`, on a tag: the installer, GitHub Release, npm publish of core.<br>`update-hashes.yml`: a separate job with its own token that publishes `SHA256SUMS` to the `update-hashes` release. |

### Repo 2: `simpletab-ballots`

| # | File(s) | M | What and why |
|---|---|---|---|
| 43 | `package.json`, `wrangler.toml`, `tsconfig.json`, `LICENSE`, `README.md`, `AGENTS.md` | M3 | Bindings: `DB` (D1, one database), `ARCHIVE` (R2), `RL_LINK` and `RL_IP` (rate-limiting bindings: 10 requests / 60 s per link; 20 failed requests / 60 s per IP), `TURNSTILE_SECRET` (secret), and a cron every 10 minutes, `*/10 * * * *` (amendment 5). Pages project for `app/`. |
| 44 | `migrations/0001_init.sql` | M3 | Appendix D (service tables). |
| 45 | `src/worker.ts`, `src/routes/{host,submit,status,register,admin}.ts` | M3 (register: M10) | Section 7 routes and Appendix E error codes. |
| 46 | `src/lib/{auth,permits,usage,shares,archive}.ts` + tests | M3 | Key and host-number checks; permit cache per isolate (keyed by slug, round and permit version); in-memory usage with flushes once a minute; the share formula from section 13; the R2 archive cron with a row-count check. |
| 47 | `test/**` (Workers test pool) | M3 | Ballot deadline (accepted 1 s before; `DEADLINE_PASSED` at and after; feedback unaffected unless its own deadline is set), resend idempotency, a stale host number refused, share exhaustion, the registration limit kept separate, archive round-trip, status without writes. |
| 48 | `scripts/budget.mjs` | M3 | Replays the section 13 traffic for 3 WUDC-size tournaments and 15 tournaments of 100 teams against Miniflare, counts requests and writes, and fails above 90% of the free limits. |
| 49 | `app/{index.html,main.ts,link.ts,bundle.ts,outbox.ts,status.ts,fallback.ts,sw.ts,manifest.webmanifest}` | M3 | Section 8 phone app. |
| 50 | `app/forms/{ballot,feedback,checkin,register}.ts` | M3 (register: M10) | Forms built from the bundle row's definitions (two-team reply and iron-person rules; CrabbyTab's 10 feedback question types). |
| 51 | `app/locales/{en,bn,TEMPLATE}/*.json`, `app/i18n.ts` | M3 | Section 12. |
| 52 | `app/**/*.test.ts` | M3 | Deadline display in tournament time and countdown; form locked after the deadline with the QR shown; the outbox's three states; fallback encoding; form validation; service-worker caching (with `vitest` and a fake `caches` object). |
| 53 | `.github/workflows/{ci.yml,deploy.yml}` | M3 | Tests and budget on push; on a tag, `wrangler d1 migrations apply`, then `wrangler deploy`, then Pages deploy. |

### Repo 3: `simpletab-public`

| # | File(s) | M | What and why |
|---|---|---|---|
| 54 | `package.json`, `vite.config.ts`, `tsconfig.json`, `LICENSE`, `README.md`, `AGENTS.md` | M4 | React 19 + Vite 8; pinned `@simpletab/core`. |
| 55 | `src/main.tsx`, `src/data.ts`, `src/pages/*.tsx` | M4 | Built with Vite `base: './'` and hash routing, so it works at a domain root or under `/<repo>/` (section 10.1). Pages: Home, Draw, Results, Team, Speaker, Replies, Category tabs, Break and bracket, Motions and statistics, Participants, Institutions, Adjudicator tab, Verify (section 5). The page set and gates follow CrabbyTab's public site. |
| 56 | `src/sw.ts`, `src/locales/{en,bn,TEMPLATE}/*.json`, `src/i18n.ts` | M4 | Offline cache after the first visit; translations. |
| 57 | `src/**/*.test.tsx` | M4 | Rendering from sample published data; gates honoured; Verify flags a broken or rewound chain. |
| 58 | `.github/workflows/{ci.yml,release.yml}` | M4 | On a tag: build, zip, SHA-256, and attach to the release. |

### Verification Plan

*   **Build:** `npm run build` in each repo; `npm run package:win`; `wrangler deploy --dry-run`.
*   **Unit tests:** `npm test` in each repo. The ported CrabbyTab tests keep their assertions, including the allocator golden tests and the break cutoff-tie tests. `npm run port-check` and `npm run tabbycat-diff` pass.
*   **Static analysis:** `npm run lint`; `npm run i18n:check`.
*   **Determinism:** the committed draw hashes match on Windows and Ubuntu CI.
*   **Performance:** `npm run bench -- --size wudc` passes the Goal 2 targets on the reference laptop. `npm run bench -- --size xl` is recorded every milestone; it must finish with the UI and staff connections responsive, and its timings set the 1000-team targets. The result is recorded in `docs/checks/bench-<date>.md`. The run also checks that the backend stays under its 2 GB heap limit, and that WebSocket heartbeats are never missed while long ops run.
*   **Free tier:** `npm run budget` (`simpletab-ballots`) stays under 90% of the limits for the section 13 targets.
*   **Integration:** `e2e:offline`, `e2e:sync`, `e2e:publish`, `e2e:archive`, `e2e:collab`, `e2e:cli`, `e2e:commands` and `e2e:registration`, as listed in the milestone table.
*   **Security:**
    - A wrong passcode, a forged QR code and a stale host number are all rejected.
    - A direct SQLite edit, or an edited snapshot, is caught at startup.
    - A rewound published chain is flagged on the Verify page.
    - The Equity projection never contains feedback.
*   **Rehearsal (before the first real event):** a mock 40-team BP tournament over 3 rounds, with phones throttled to 3G and one forced host failure. Every form arrives exactly once. The result is recorded in `docs/checks/rehearsal-<date>.md`.

--------------------------------------------------------------------------------

## Appendix A: Operation catalogue

Permission names marked **NEW** are added to CrabbyTab's 14. "Gate" is the release gate (Appendix B) that makes a public op's payload visible. All guard functions live in CrabbyTab: `SG` is `src/features/tournament/application/stateGuards.ts` and `APP` is `src/features/tournament/application/`. Their names were checked against the code.

**Visibility rule:**

- **Public, with the payload published once the gate (of the same round) opens:**

| Op types | Gate |
|---|---|
| `round.*`, `draw.release_teams`, `draw.release`, `draw.unrelease`, `motion.set_round_status`, `release.*` | none: published at once (the payload is only a status or a round name) |
| `draw.generate`, `draw.restore`, `draw.update_debate`, `draw.move_team`, `draw.swap_teams`, `draw.lock`, `draw.unlock`, `swing.*`, `allocation.*` | `draw_released` |
| `ballot.confirm`, `ballot.discard` | `round_results_released` |
| `break.*` | `break_category_published` (of that category) |
| `elimination.advance` | `draw_released` of the next elimination round |

- **Private** (header only, never the payload): everything else. That covers participants, conflicts, venues, check-ins, settings, roles, motions' text, feedback, links, registration, devices, `ballot.enter`, `ballot.receive_online`, `ballot.intake_record`, `host.promote` and proposals.

| Op type | Payload (key fields) | Permission | Guards (reused) | Inverse | Lock |
|---|---|---|---|---|---|
| `settings.update` | preferences (partial) | `settings.edit` NEW | `SG:checkSettingsChange`, `lib/setup/preferenceValidation:preferenceChangeProblems` | `settings.update` (previous) | no |
| `settings.resave_ballots` | changedKeys | `settings.edit` | `SG:checkSettingsChange`, `lib/ballots/resave:recomputeStoredBallots` | none | yes |
| `roles.update` | custom groups | `roles.manage` NEW | `lib/staffPermissions:validateCustomGroups`, `normalizeCustomGroups` | `roles.update` (previous) | no |
| `institution.create` / `.update` / `.delete` | institution fields / id | `participants.edit` | delete: `SG:checkInstitutionDeletion` | delete / update (previous) / create | no |
| `team.create` / `.update` / `.delete` | team with speakers, categories | `participants.edit` | `SG:checkSpeakerRemoval`, `SG:checkTeamDeletion`, `lib/codeNames:withoutRealNameCodeName` | delete / update / create | no |
| `adjudicator.create` / `.update` / `.delete` | adjudicator fields | `participants.edit` | `SG:checkAdjudicatorDeletion` | delete / update / create | no |
| `adjudicator.update_scores` | base, test, breaking, reason | `adjudicators.scores_edit` | `lib/staffPermissions:mayEditAdjudicatorScores`, `lib/feedback/scoreHistory:withScoreHistory` | update_scores (previous) | no |
| `conflict.update_adjudicator` | team/adj/institution ids | `conflicts.edit` | `lib/adjudicators/conflicts:applyConflictSelection` | previous selection | no |
| `conflict.set_team_institutions` | teamId, institutionIds | `conflicts.edit` | none beyond the schema | previous | no |
| `venue.create` / `.update` / `.delete` | venue fields | `venues.edit` NEW | `SG:checkVenueDeletion` | delete / update / create | no |
| `checkin.set_participant` | entity, roundId, available | `checkins.edit` | `lib/roundAvailability:setRoundAvailability` | opposite | no |
| `checkin.set_venue` | venueId, checkedIn | `checkins.edit` | none | opposite | no |
| `checkin.self_checkin` | from the inbox | `service` actor | `lib/selfCheckIn:selfCheckInError` | opposite | no |
| `round.create` / `.update` / `.delete` | round fields | `rounds.manage` NEW | `APP/rounds:roundStageDrawTypeProblem`, `SG:checkRoundUpdate`, `SG:checkRoundDeletion` | delete / update / none | delete: yes |
| `round.set_prelim_count` | count | `rounds.manage` | `SG:checkPreliminaryRoundCount`, `SG:checkRoundCancellation` | previous count | yes |
| `round.set_completion` / `round.cancel` | roundId, flag | `rounds.manage` | `SG:checkRoundCompletion`, `SG:checkRoundReopen`, `SG:checkRoundCancellation` | opposite | no |
| `round.set_ballot_deadline` | roundId, ballotDeadline (UTC or null), feedbackDeadline? (UTC or null), timeZone | `rounds.manage` | the deadline is a valid instant; the time zone is a valid IANA name | `round.set_ballot_deadline` (previous values) | no |
| `draw.generate` | roundId, discardExisting, override? (the committed payload also stores `previous`: the debates it replaced) | `draw.generate` NEW | `SG:checkDrawGeneration`; apply via `APP/draws.ts` | `draw.restore` (puts `previous` back) | yes |
| `draw.restore` | roundId, debates | `draw.generate` | `SG:checkDebateEdits` | `draw.restore` (the debates it replaced) | no |
| `draw.update_debate` / `draw.move_team` / `draw.swap_teams` | debate / pick / target | `draw.generate` | `SG:checkDebateEdits`, `lib/draw/drawEditing:moveTeam` | previous / move back / swap back | no |
| `draw.lock` / `draw.unlock` | roundId | `draw.release` NEW | `SG:checkDrawConfirmation`, `lib/draw/drawStatus:drawStageActions` | unlock / lock | no |
| `draw.release_teams` / `draw.release` / `draw.unrelease` | roundId | `draw.release` | `SG:checkDrawRelease`, `SG:checkConcurrentRoundClashes` | unrelease / release | no |
| `swing.create` / `swing.toggle_round` | name, speakers / teamId, roundId | `participants.edit` | `APP/swingTeams:validateSwingTeam`, `withSwingRound`, `withoutSwingRound` | team.delete / opposite | no |
| `allocation.auto` | roundId, panelSize, settings (the committed payload also stores `previous` panels) | `allocation.edit` | `SG:checkAutoAllocation`; apply via `APP/allocation.ts` | `allocation.restore` | yes |
| `allocation.restore` | roundId, panels | `allocation.edit` | `SG:checkDebateEdits` | `allocation.restore` (the panels it replaced) | no |
| `allocation.assign_manual` | debateId, chair, panellists, trainees | `allocation.edit` | `SG:checkDebateEdits` | previous panel | no |
| `allocation.swap_rooms` | debateA, debateB, adjudicator moves | `allocation.edit` | `SG:checkDebateEdits` (both rooms) | swap back | no |
| `allocation.preformed_save` / `allocation.preformed_autofill` | roundId, panels | `allocation.edit` | `APP/preformedPanels:validatePreformedPanels`, `autoFillPreformedPanels` | previous panels | autofill: yes |
| `motion.create` / `.update` / `.delete` | motion fields | `motions.manage` NEW | `lib/motions/infoSlideMedia:withValidInfoSlideMedia` | delete / previous / create | no |
| `motion.set_round_status` | roundId, status | `motions.manage` | `APP/motionRelease:planMotionsStatusChange` | previous status | no |
| `ballot.enter` | ballot | `results.enter`; also `results.enter_late` once the round's ballot deadline has passed (section 8.1) | `SG:checkBallotSubmission`, `lib/ballots/result:ballotMatchesDebate`, deadline check | `ballot.discard` | no |
| `ballot.receive_online` | from the inbox or a QR code | `service` actor | `SG:remoteBallotSubmissionBlocker`, `SG:isRoundLockedForPortalBallots`, `SG:checkBallotSubmission`, deadline check (late items from the inbox go to the late list; a late QR scan needs `results.enter_late`); merge via `lib/privateIndividualBallots` (with `isTabRoomConfirmed` ported into `domain/ballots/confirmation.ts`) | `ballot.discard` | no |
| `ballot.confirm` | ballotId, override? | `results.confirm_others` | `SG:checkResultChange`, `SG:checkIndependentConfirmation` | `ballot.discard` | no |
| `ballot.discard` | ballotId | `results.confirm_others` | `SG:checkResultChange` | none | no |
| `ballot.intake_record` | sheetCode, roundId | `ballots.intake` | `SG:checkBallotIntake`, `APP/ballotIntake:resolveIntakeScan` | none | no |
| `feedback.enter` | feedback | `feedback.enter` | `lib/feedback/questions:validateFeedbackAnswers`, `APP/feedback:adminFeedbackLinkError` | `feedback.review` ignore | no |
| `feedback.receive_online` | from the inbox | `service` actor | `lib/feedback/questions:validateFeedbackAnswers` | ignore | no |
| `feedback.review` | feedbackId, confirmed/ignored | `feedback.view` | `APP/feedback:reviewFeedbackCommand` | previous flags | no |
| `break.categories_save` | categories | `break.manage` NEW | `SG:checkBreakCategoryDeletion`, `APP/breaks:validateBreakCategoryDraft` | previous | no |
| `break.team_override` | categoryId, teamId, override | `break.manage` | `APP/breaks:withTeamOverride` | previous | no |
| `break.compute` / `break.clear` | categoryId | `break.manage` | `SG:checkBreakGeneration`, `SG:checkBreakClear` | clear / none | compute: yes |
| `elimination.advance` | roundId | `break.manage` | `lib/draw/elimination:getAdvancingTeamIds`, `APP/breaks:proceedToNextEliminationRoundCommand` | none | no |
| `release.set_gate` | gate, released, categoryId? | `releases.manage` NEW | `lib/publicRelease:setRelease` | opposite | no |
| `release.tab_bundle` | breakCategoryIds | `releases.manage` | `lib/setup/presets:tabReleasePreferences` | previous gates | no |
| `private_urls.regenerate` | scope, force | `links.manage` NEW | `APP/privateAccess:regeneratePrivateAccess` (rewritten for the section 8 format) | none | yes |
| `registration.receive` | from the inbox | `service` actor | `lib/registration/validation:parseRegistrationEntry`, `spamSignal` | none | no |
| `registration.accept` | submissionId | `registration.manage` NEW | `APP/registrationApproval:approveRegistration`, `lib/registration/review:buildTeamFromSubmission` | delete the team or adjudicator | no |
| `device.approve` / `device.remove` / `device.set_role` | deviceId, role | `devices.manage` NEW | none (host-local) | remove / approve / previous role | no |
| `host.promote` | newHostNumber, hostId | `host.promote` NEW (tab-director devices) | the section 4 rules | none | no |
| `proposal.accept` / `proposal.reject` | proposalId | the proposed op's permission | as for the proposed op | as for the proposed op | as for the proposed op |

Guard functions under `APP/*` that are not in Appendix F's port list are ported into `packages/core/src/domain/guards/`, along with their import closure. `port-check` enforces this.

## Appendix B: Release gates

The gates are ported from CrabbyTab's `lib/draw/drawStatus.ts`, `APP/motionRelease.ts` and `lib/publicRelease.ts`.

- **Per round:**
  - `draw_teams_released` (teams see their own room through their links);
  - `draw_released` (public draw and panels; online ballots open);
  - `round_motions_info_slides`, `round_motions_released`;
  - `round_results_released`, `round_speaks_released`;
  - `round_adjudicators_revealed`.
- **Per tournament:**
  - tabs: `tab_team`, `tab_speaker`, `tab_replies`, `tab_speaker_categories`, `tab_adjudicator`, `tab_break_categories`, `tab_motions`;
  - results and break: `results_all_rounds`, `break_category_published` (per category);
  - lists: `public_participants`, `public_institutions`, `public_adjudicator_core`, `public_breaking_adjudicators`;
  - ballots: `public_ballots`, `public_private_ballots`;
  - other pages: `public_record_pages`, `public_side_allocations`, `public_bracket`, `public_diversity`, `public_veto_statistics`, `public_feedback_progress`;
  - the bundle switch `tab_release_bundle`.

Gates are changed only by `draw.*` release ops, `motion.set_round_status`, `release.set_gate` and `release.tab_bundle`.

## Appendix C: Permissions and roles

**CrabbyTab's 14 permissions** (`lib/staffPermissions.ts`):

| Group | Permissions |
|---|---|
| Ballots and results | `results.enter`, `results.confirm_others`, `ballots.intake` |
| Feedback | `feedback.enter`, `feedback.view` |
| Participants and check-in | `checkins.edit`, `participants.edit` |
| Draw, motions, standings | `draw.display`, `motions.display`, `standings.view` |
| Conflicts | `conflicts.view`, `conflicts.edit` |
| Adjudicators | `adjudicators.scores_edit`, `allocation.edit` |

**New permissions:**

| Group | Permissions |
|---|---|
| Setup | `settings.edit`, `roles.manage`, `venues.edit`, `rounds.manage` |
| Draw | `draw.generate`, `draw.release` |
| Results | `results.enter_late` (enter ballots after a round's deadline; section 8.1) |
| Motions, break, releases | `motions.manage`, `break.manage`, `releases.manage` |
| Links, contacts, registration | `links.manage`, `participants.contact`, `registration.manage` |
| Devices and host | `devices.manage`, `credentials.manage`, `host.promote`, `host.promote_others`, `publish.run`, `changelog.view_private` |

| Role | Permissions |
|---|---|
| Host owner | all |
| Tab director | all except `credentials.manage` and `host.promote_others` |
| Adjudication core | `feedback.view`, `adjudicators.scores_edit`, `allocation.edit`, `conflicts.view`, `draw.display`, `motions.display`, `standings.view` |
| Equity | `conflicts.view`, `conflicts.edit` |
| Tab assistant | `results.enter`, `results.confirm_others`, `ballots.intake`, `feedback.enter`, `checkins.edit`, `participants.edit`, `draw.display`, `motions.display` |
| Display | none (released data only) |
| AI | proposals only, for draw, allocation, results, break and release ops, plus read access as granted (by default the Adjudication core read set, without `feedback.view`) |
| Custom | any set; CrabbyTab's `ballot_desk`, `check_in_desk` and `feedback_desk` are shipped as presets |

## Appendix D: Storage schemas

**Host SQLite.** Table order for the state hash: `tournament, institutions, teams, adjudicators, venues, rounds, debates, motions, ballots, feedback, break_categories, registrations, links`.

```sql
-- entity tables (same shape for each name above; tournament has one row id='t')
CREATE TABLE teams (id TEXT PRIMARY KEY, version INTEGER NOT NULL, last_seq INTEGER NOT NULL,
                    data TEXT NOT NULL);            -- data = JSON of the CrabbyTab type
-- lookup columns (generated, indexed):
--   debates.round_id, ballots.debate_id, ballots.round_id, feedback.round_id,
--   feedback.adjudicator_id, teams.institution_id, adjudicators.institution_id,
--   links.lookup_id (UNIQUE), links.entity_id
CREATE TABLE ops (seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, actor_ref TEXT NOT NULL,
                  actor_type TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
                  inverse_of INTEGER, host_number INTEGER NOT NULL);
CREATE TABLE changelog (seq INTEGER PRIMARY KEY, entry TEXT NOT NULL, salt BLOB NOT NULL,
                        entry_hash TEXT NOT NULL);
CREATE TABLE snapshots (seq INTEGER PRIMARY KEY, state_hash TEXT NOT NULL, data BLOB NOT NULL);
CREATE TABLE proposals (id TEXT PRIMARY KEY, op TEXT NOT NULL, created_at TEXT NOT NULL,
                        status TEXT NOT NULL, decided_by TEXT);
CREATE TABLE devices (device_id TEXT PRIMARY KEY, name TEXT NOT NULL, role_id TEXT NOT NULL,
                      key_fingerprint TEXT NOT NULL, paired_at TEXT NOT NULL, removed_at TEXT);
CREATE TABLE roles (role_id TEXT PRIMARY KEY, name TEXT NOT NULL, permissions TEXT NOT NULL);
CREATE TABLE staff (actor_ref TEXT PRIMARY KEY, display_name TEXT NOT NULL, role_id TEXT NOT NULL);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- keys: schema_version, slug, host_number, host_id, inbox_after, acked_through,
  --       last_publish, cdn_origin, service_status
```

**Service D1:**

```sql
CREATE TABLE tournaments (slug TEXT PRIMARY KEY, key_hash TEXT, host_number INTEGER NOT NULL DEFAULT 1,
  host_id TEXT, status TEXT NOT NULL,              -- pending|active|closed|archived
  share_requests INTEGER NOT NULL, share_writes INTEGER NOT NULL, cdn_origin TEXT,
  acked_through INTEGER NOT NULL DEFAULT 0, reg_open TEXT, reg_close TEXT, reg_cap INTEGER,
  created_at TEXT NOT NULL);
CREATE TABLE key_requests (id TEXT PRIMARY KEY, slug TEXT NOT NULL, contact TEXT NOT NULL,
  note TEXT, requested_at TEXT NOT NULL, decided_at TEXT, decision TEXT);
CREATE TABLE permits (slug TEXT NOT NULL, round_id TEXT NOT NULL, version INTEGER NOT NULL,
  open INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (slug, round_id));
CREATE TABLE submissions (rowid INTEGER PRIMARY KEY, submission_id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL, round_id TEXT, lookup_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL,
  received_at TEXT NOT NULL);
-- No (slug, rowid) index: the inbox reads `WHERE rowid > ?after ORDER BY rowid LIMIT 2000` and
-- filters by slug, which reads only the rows added since that host's last pull. This saves one
-- written row per submission (section 13).
CREATE TABLE heads (slug TEXT NOT NULL, seq INTEGER NOT NULL, head_hash TEXT NOT NULL,
  published_at TEXT NOT NULL, PRIMARY KEY (slug, seq));
CREATE TABLE usage (slug TEXT NOT NULL, day TEXT NOT NULL, requests INTEGER NOT NULL,
  writes INTEGER NOT NULL, reg_writes INTEGER NOT NULL, PRIMARY KEY (slug, day));
CREATE TABLE archives (slug TEXT PRIMARY KEY, r2_key TEXT NOT NULL, rows INTEGER NOT NULL,
  archived_at TEXT NOT NULL);
CREATE TABLE admins (email TEXT PRIMARY KEY, added_at TEXT NOT NULL);
```

## Appendix E: Wire and file formats

**Wire messages** (all JSON; every one carries `schema: 1`):

| Message | Fields |
|---|---|
| `PermitUpload` | `{schema, roundId, version, open, ballotDeadline?: string (UTC ISO), feedbackDeadline?: string, timeZone: string, entries: [{lookupId, verifier, roomId, forms: ("ballot"|"feedback"|"checkin")[]}]}` |
| `InboxPage` | `{schema, items: [{rowid, submissionId, type, roundId, lookupId, payload, receivedAt}], next}` |
| `Ack` | `{schema, through}` |
| `Head` | `{schema, seq, headHash}` |
| `Submission` | `{schema, slug, submissionId (ULID made on the phone), type, roundId, lookupId, authKey, proof, payload}` |
| `StatusResponse` | `{schema, items: [{submissionId, server: boolean, tabRoom: boolean}], shareLeft?: number}` (`shareLeft` only for host requests) |
| `RegistrationEntry` | CrabbyTab `RegistrationEntry` fields, plus `turnstileToken` |
| `KeyRequest` | `{schema, slug, contact, note}` |

**Error codes:**

| Category | Codes |
|---|---|
| Authentication and host | `AUTH_INVALID`, `KEY_REVOKED`, `HOST_STALE`, `OVERRIDDEN_BY_HOST` (host-local) |
| Round and form | `ROUND_CLOSED`, `DEADLINE_PASSED`, `FORM_NOT_ALLOWED` |
| Schema | `SCHEMA_INVALID`, `SCHEMA_UNSUPPORTED` |
| Limits | `RATE_LIMITED`, `QUOTA_EXHAUSTED` |
| Registration | `REG_CLOSED`, `REG_CAP_REACHED`, `TURNSTILE_FAILED` |
| Other | `NOT_FOUND`, `INTERNAL` |

A resend is not an error: it returns `200 {status: "already_received"}`.

**HTTP status for each code:**

| Status | Codes |
|---|---|
| 400 | `SCHEMA_INVALID`, `TURNSTILE_FAILED` |
| 401 | `AUTH_INVALID` |
| 403 | `KEY_REVOKED`, `FORM_NOT_ALLOWED` |
| 404 | `NOT_FOUND` |
| 409 | `HOST_STALE` (body includes `storedHostNumber`), `ROUND_CLOSED`, `DEADLINE_PASSED` (body includes `deadline` and `timeZone`), `REG_CLOSED`, `REG_CAP_REACHED` |
| 415 | `SCHEMA_UNSUPPORTED` |
| 429 | `RATE_LIMITED`, `QUOTA_EXHAUSTED` (both with `Retry-After`) |
| 500 | `INTERNAL` |

**Round bundle bucket** (little-endian):

```text
"STRB" | u8 version=1 | u16 roundSeq | u16 rowCount (multiple of 8)
rows sorted by rowId: rowId[16] | nonce[12] | ciphertext[512 + 16 tag]
plaintext = JCS(row) padded with 0x00 to exactly 512 bytes; bundle generation fails if JCS(row) is over 512 bytes
dummy rows: random rowId (top 5 bits set to the bucket number), random nonce, 528 random bytes
AES-GCM additional data = "STRB" | version | u16 roundSeq | rowId, so a row cannot be moved to another round or slot
every one of the 32 buckets is always published, with at least 8 rows
row = { room, side?, teammates?: [name], panel?: [{name, role}], forms: [formId], venue }
```

**QR fallback:**

```text
"ST1." + base64url(deflateRaw(JCS({sid, slug, lid, rnd, type, payload})))
       + "." + base64url(HMAC-SHA-256(qrKey, body))[0..22]
```

- The maximum is 1,800 characters per code, encoded as QR byte mode with error correction L.
- Longer data is split into up to 4 fragments:

  ```text
  "ST1F." + sid + "." + index(1..n) + "." + n + "." + totalLength + "." + base64url(SHA-256(fullCode))[0..22]
          + "." + fragmentData
  ```

  `fullCode` is the complete single-code string `"ST1." + body + "." + mac`, which is then cut into fragments. The host collects fragments by `sid`, in any order, ignores exact duplicates and rejects conflicting ones. It joins them only when all `n` are present and the length and SHA-256 match. It then checks the HMAC on the joined body as above.
- Limits: a body of at most 6,000 characters before splitting, and at most 64 KB after decompression.
- The copyable text code is the same string, with fragments joined by newlines.

## Appendix F: Port list (CrabbyTab → `packages/core/src`)

> **As built (M0, 2026-11-23).** Two deliberate differences from the plan below:
>
> 1. **Paths were kept exactly as in CrabbyTab.** Files live in `packages/core/src/lib/…`, `packages/core/src/features/tournament/application/…`, `packages/core/src/types/index.ts` and `packages/core/src/test/tournamentFixtures.ts`, and the `@/` alias points at `packages/core/src`. No import needed rewriting, so the "Import mapping" table below is not applied and there is no `rewrite-imports.mjs`. Moving files into `domain/<area>` can happen later as a pure refactor.
> 2. **CrabbyTab's TypeScript translation catalogs (`lib/i18n/**`, including 25 locale JSON files) were ported as they are**, because `sideNames.ts` and `preferenceValidation.ts` import them. Converting them to ICU JSON and passing in a translate function is moved to M1 (`tools/convert-locales.mjs`).
>
> **Result:**
> - The port copied 201 modules and 124 test files.
> - `exportStandingsToCsv` was removed from `importer.ts`.
> - Two tests were dropped or skipped: `serverOnlyRules.test.ts` (Firebase rules), and one case in `presets.test.ts` that reads Next.js routes.
> - `passcode.ts` (WebCrypto-free constant-time compare) and `privateUrls.ts` (origin passed in) were edited so that core uses no Node or DOM APIs.
> - Tests: 1,267 pass, 1 skipped. `tsc` is clean, and `port-check` and ESLint pass.
>
> **As built (M2, 2026-11-24).** `packages/app` pins `vscode.git` and `vscode.git-base` to `1.95.3` instead of `1.108.2` because Open VSX publishes standalone built-ins only up to `1.95.3` (Theia 1.77's `1.108.2` built-ins exist only inside the all-built-ins bundle).

The list was computed with an import-closure script on 2026-11-19: 108 seed modules and 59 dependencies. `tools/port-check.mjs` repeats the check in CI. Paths below are CrabbyTab's.

**Ported** (with their `*.test.ts`, assertions unchanged):

| Area | Modules |
|---|---|
| Draw | `src/lib/draw/*` (all 31), except the poly-team paths listed below |
| Adjudicators | `src/lib/adjudicators/*`, `src/lib/adjudicators.ts` |
| Ballots and scoring | `src/lib/ballots/*`, `src/lib/scoring/validator.ts`, `src/lib/privateIndividualBallots.ts`, `src/lib/privateBallot.ts` (with `privateBallot.test.ts`), `src/lib/printOptions.ts` |
| Feedback | `src/lib/feedback/*` |
| Standings | `src/lib/standings/*`, `src/lib/motionStatistics.ts`, `src/lib/motionBalance.ts` |
| Break | `src/lib/breakqual/*`, `src/lib/publicBracket.ts` |
| CSV | `src/lib/csv/*`, except `download.ts`. In `importer.ts`, `exportStandingsCsv` (lines 479–482, which calls `downloadCsv`) is removed; callers use `teamStandingsCsv` and save the string themselves (tab-ui does the file save). |
| Setup and venues | `src/lib/setup/{presets,preferenceValidation,configTransfer}.ts`, `src/lib/venues/*` |
| Check-in | `src/lib/checkins/*` except `useBarcodeCamera.ts` (moved to tab-ui); `selfCheckIn.ts`, `roundAvailability.ts` |
| Naming and participants | `codeNames.ts`, `teamNames.ts`, `sideNames.ts`, `speakerCategories.ts`, `teamCategories.ts`, `teamSeeds.ts`, `compositeTeams.ts`, `debateSides.ts`, `scoreDisplay.ts`, `emailAddress.ts`, `phone.ts` |
| Public view and releases | `publicView/{projection,derived,names,hash}.ts`, `publicRelease.ts`, `publicScoreVisibility.ts`, `publicLists.ts`, `publicFeatures.ts`, `publicForms.ts`, `privatePortalBallots.ts` |
| Permissions | `staffPermissions.ts` |
| Motions and media | `motions/{roundMotions,infoSlideMedia}.ts`, `markdown/{safeUrls,youtube}.ts` |
| Schedule and registration | `schedule/events.ts`, `registration/{review,validation,types,access,names}.ts` |
| Application logic | from `src/features/tournament/application/`, into `domain/guards/`: `stateGuards.ts`, `swingTeams.ts`, `breaks.ts`, `motionRelease.ts`, `preformedPanels.ts`, `ballotIntake.ts`, `rounds.ts`, `schedule.ts`, `draws.ts` and `allocation.ts` (the apply logic for `draw.generate` and `allocation.auto`), `settings.ts`, `ballotEntry.ts`, `feedback.ts`, `entities.ts`, `privateAccess.ts`, `registrationApproval.ts`, plus their import closure (`port-check` lists any that are missing). `tools/tabbycat-diff` imports `draws.ts` and `allocation.ts` from core rather than keeping its own copies. |

**Rewritten:**

| Module | Change |
|---|---|
| `passcode.ts` | WebCrypto SHA-256 with a constant-time compare, replacing `node:crypto` |
| `privateUrls.ts` | Keeps the alphabet and generator; `getAbsolutePrivateUrl` is removed and the origin is passed in. The new link format lives in `crypto/links.ts`. |
| `privateSync.ts` | Only `isTabRoomConfirmed` is kept, as `domain/ballots/confirmation.ts`. |
| `i18n/config.ts` and `i18n/messages/**` | Not ported. The modules that import them take a translate function (`labels/`), and the catalogs are converted by `tools/convert-locales.mjs`. |
| `qr/qrcode.ts` | Replaced by `qrcode-generator`. |

**Removed** (two-team and BP only): the tests `polyDraw.test.ts`, `polyStandings.test.ts`, `polyResult.test.ts`, `privateBallotPoly.test.ts` and `setup/polyPresets.test.ts`, and the poly cases inside mixed tests (found with `grep -n "teamsInDebate: [^24]"` and `poly` in each test name). In code, every branch on `teamsInDebate` not equal to 2 or 4 is replaced by a thrown `UnsupportedFormatError`, and the preset list keeps only BP and two-team presets.

**Test fixtures:** `src/test/tournamentFixtures.ts` moves to `packages/core/test/fixtures.ts`.

**Import mapping** (the rewrite rule for every ported file, applied by `tools/rewrite-imports.mjs`):

| CrabbyTab import | Core import |
|---|---|
| `@/types` | `@/domain/types` |
| `@/lib/<x>` (ported) | `@/domain/<area>/<x>`, using the Area column of the Ported table |
| `@/lib/publicView/*`, `@/lib/public*` | `@/publicView/*` |
| `@/lib/staffPermissions` | `@/permissions/catalog` |
| `@/features/tournament/application/<x>` | `@/domain/guards/<x>` |
| `@/test/tournamentFixtures` | `@/../test/fixtures` |
| `@/lib/i18n/*` | removed: a translate function is passed in (`@/labels`) |

`rewrite-imports.mjs` carries the exact per-file table produced by the closure script. It fails on any import it has no mapping for.

**Not ported:** `firebase*`, `*Sync*` (except `isTabRoomConfirmed`), `offline/`, `api/`, `apiTokens.ts`, `email/`, `sms/`, `seo/`, `theme/`, `rehearsal/`, Next.js routes and React components, `firestore.rules`.

--------------------------------------------------------------------------------

*Drafted with EGM*
