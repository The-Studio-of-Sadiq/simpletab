# SimpleTab: concepts brief

- **Status:** Done. The approved design is simpletab.md (revision 3).
- **Author:** Golam Kuadir Khan Prince
- **Date:** 2026-11-18
- **Method:** Elephant-Goldfish Model (EGM). Claude drafts with the full conversation in mind (Elephant). Gemini 4 Argon and ChatGPT review this brief later without that conversation (Goldfish).

## 1. Problem

Running a debate tournament needs tab software that keeps working when the venue's internet is bad. It also has to cost close to nothing. CrabbyTab v1 (Next.js + Firebase) showed where the cost and the complexity come from:

- Firestore charges per document read and write. A 1,000-team BP tournament's first upload uses about half of the free daily write quota. Much of v1's code exists only to save reads: delta sync, `syncVersion` checks, synthetic index fields and tombstones.
- Several browsers edit the same data and merge it later. Releasing a draw touched two sync paths, and a co-director could see a draw before they could publish it (`docs/live-collaboration.md`).
- Every ballot field was defined twice, in TypeScript and again in `firestore.rules`.

SimpleTab is a new product. The architecture is new, but it reuses CrabbyTab's tested domain logic and product behaviour. One laptop holds the tournament and decides every change. The internet is used only to publish results and to collect ballots and feedback.

## 2. Working hypothesis

SimpleTab is three separate repositories:

1. **simpletab (desktop):** a Windows desktop app built on Eclipse Theia. It has an activity bar, command palette, terminal, file explorer, extensions and git. It runs every tab operation offline (draw, allocation, results, standings, break) on a SQLite database on the host laptop. That laptop is the only source of truth. When it has a connection, it pushes published data online and pulls in submitted ballots and feedback. A **Credentials** section at the very top holds the secrets it uses to reach outside services: the per-tournament key for the shared service, the tournament's own CDN credentials, email (SMTP) and other APIs. Only the host holds them. The same page shows the connect code that lets staff laptops join.
2. **simpletab-public (read-only site):** shows published draws, results, standings, motions and participants. It can only read. Pages are static files on a free CDN, so a page view never reaches a database.
3. **simpletab-ballots (online ballots and feedback):** an internet website, one shared service that you run for every tournament, at zero cost. Adjudicators, teams and speakers open their private links on their phones, over mobile data or venue Wi-Fi, to submit ballots and feedback. Submissions are stored in SQLite with Redis in front, and held until the host pulls them. Each one is checked against the draw the host last pushed.

Formats: **BP and two-team** (Australs, WSDC and the other two-team presets CrabbyTab already supports).

## 3. Decisions made by the author

| Topic | Decision |
|---|---|
| Name | SimpleTab. CrabbyTab and Tabbycat are reference material. |
| Domain logic and behaviour | Reuse CrabbyTab's logic and its tests; where CrabbyTab already answers a product question, follow it. |
| Repos | Three separate repositories. |
| Desktop shell | Eclipse Theia, with terminal, command palette, extensions, activity bar, file explorer and git. |
| Credentials | A Credentials section at the very top of the desktop app, with text fields for database and other secrets. |
| Platform and languages | Windows first. English and Bangla, fully i18n. |
| Source of truth | The host laptop only. |
| Host failure | Export the tournament to a file, import it on another laptop and carry on there (plus promoting a connected laptop; see section 6). |
| Ballots and feedback | Online over the internet, through an HTTPS website; not the local network. |
| Online service | One shared service run by the author, at zero cost. |
| Scale and network | Several thousand users, on poor Wi-Fi or mobile data. |
| Formats | BP and two-team. |
| Change history | Tamper-evident changelog like CrabbyTab's, used to track and edit changes. |
| Old data | Start clean, with no migration from CrabbyTab's Firebase. |
| Credentials holder | Only the host has credentials. |
| Live collaboration | A connect code on the Credentials page lets tab directors and other staff join the host and edit live together, like Google Docs, without seeing any credentials. |
| Retention | Never delete. After a tournament, its ballots and feedback stay in the online database but are no longer served by any online endpoint, and never appear in the public repo. |
| Free-tier overflow | A tournament can optionally plug in its own free-tier keys; by default it inherits the global (shared service) settings. Paying for usage above the free limit: never. |
| Roles | Tab directors are admins. Other staff get roles from a role-based permission system. |

## 4. Carried over from CrabbyTab (no question needed)

| Area | Behaviour SimpleTab keeps | CrabbyTab source |
|---|---|---|
| Ballot lifecycle | States: Missing, Entered, Awaiting check, Disputed, Confirmed. Online ballots need tab-room confirmation by default; a "chair confirms" option exists. Double entry with review or blind modes. A judge may resubmit until the debate is confirmed or the round is locked; later submissions are kept unconfirmed for review. Panellists' individual sheets are merged, and conflicting fields are flagged for the tab room. | `src/lib/privateBallot.ts`, `privateIndividualBallots.ts`, `docs/ballot-intake.md` |
| Private links | `team_`, `adj_`, `spk_` prefix plus 12 characters from an unambiguous 31-character alphabet, with an optional 12-character passcode. Delivered by printed QR slips, email templates or copy. Rate limits per link and per IP. "Regenerate all" revokes every link. Team links cannot submit ballots; trainee judges cannot vote. | `src/lib/privateUrls.ts`, `passcode.ts`, `docs/wiki/Private-URLs-and-Portals.md` |
| Feedback privacy | Never public. Only admins and assistants granted "see feedback" may read it. Anonymous participants are shown as "Redacted". | `firestore.rules`, `src/lib/publicView/projection.ts` |
| Public pages | Per tournament, read from a published snapshot. Release gates for each round (draw to teams, draw to public, panels, motions, results) and for each tab (team, speaker, replies, categories, adjudicators, brackets, motion statistics). | `src/lib/publicView/`, `docs/wiki/Public-Pages-and-Releases.md` |
| Staff roles | Owner, admin, data-entry assistant with permission groups (enter ballots, confirm others' ballots, intake, feedback entry, check-ins). | `docs/wiki/Staff-and-Roles.md` |
| Audit log | Hash chain, SHA-256 over `prefix + previous hash + canonical event`, starting at 64 zeros. Anyone can check it on a public page. Actor IDs stay private. | `src/lib/auditLog.ts` |
| Backup and restore | Full JSON backup; restore on another device with Merge or Replace and a safety backup taken first. DebateXML and CSV exports. | `tournamentBackup.ts`, `docs/data-import-export.md` |
| API scopes | `read:public`, `read:<area>`, `write:<area>`. Tokens are stored hashed and can never read private keys, passcodes or emails. | `src/lib/apiScopes.ts`, `apiTokens.ts` |

## 5. Defaults Claude has taken (author can override; not asked)

These are gaps in CrabbyTab, or answers that follow from the decisions above.

1. **Handover is CrabbyTab's backup and restore, plus a host number.** Each export for handover raises a host number. The online service accepts pushes only from the highest number it has seen, so an old host that comes back online cannot overwrite the new one. It is told to import the latest file.
2. **Undo.** CrabbyTab's log is append-only and has no undo. SimpleTab keeps the chain append-only: undoing a change adds a new "reverted event N" entry instead of deleting history. That gives "edit with ease" without breaking tamper evidence.
3. **Git.** The hash-chained changelog versions tournament data. Theia's git panel versions files in the workspace: scripts, extensions, CSV imports and exported reports.
4. **Extensions get API scopes.** Extensions declare the same scopes as CrabbyTab's API tokens. They can never see private keys, passcodes, emails or credentials, and need `write:` scopes to change anything. CrabbyTab had no extension system.
5. **Retention (author's rule, mechanism by Claude).** When the host marks the tournament finished, the online service closes every private link and ballot endpoint for it and keeps the rows in an archive table that no endpoint reads. Only the author's own admin tools can read the archive. Free database storage is limited (a few GB), so archived tournaments will slowly use it up; this needs a check once a year.
6. **Shared code without a fourth repo.** The domain types and file formats live in the desktop repo and are published from there as an npm package (`@simpletab/core`) that the other two repos install. That keeps three repos.
7. **Secrets are never in tournament data.** The Credentials section stores secrets in Windows Credential Manager (through Electron `safeStorage`), not in SQLite, so backups, handover files, the changelog and extensions never contain them.
8. **Bad mobile data.** The ballot page is a small page that saves the ballot on the phone and resends it until the server confirms. Every submission carries an ID made on the phone, so a resend is never counted twice.

## 6. Proposal: live collaboration with a connect code

**Two networks, kept apart.**

- The **tab room network** is small and private: the host laptop's own Windows hotspot, or a cheap router the tab team brings. It carries only staff laptops. Windows' 8-device hotspot limit fits a tab room.
- **Participants** never touch it. Their phones use mobile data to reach the online ballots site.

This keeps the venue's bad Wi-Fi and thousands of phones away from the staff connection.

**How joining works.**

1. The host shows a connect code on the Credentials page, as text and as a QR code. The code holds the host's local address, a one-time pairing secret, the role being granted and a fingerprint of the host's encryption certificate.
2. A staff member enters or scans the code in their own copy of SimpleTab. The two apps pair, and the joining laptop gets its own device key. The connect code then expires.
3. All traffic between the laptops is encrypted (TLS). The joining app checks the host's certificate against the fingerprint in the code, so no internet or certificate authority is needed.
4. The host can see every connected device and remove any of them at any time.

**How editing works (host decides, everyone sees it live).**

- Each laptop keeps a full live copy of the tournament and shows changes as they happen, with presence: who is looking at or editing which round, debate or allocation.
- An edit is sent to the host as an operation, for example "move adjudicator A to debate 7, based on version 41 of that debate". The host checks permissions and versions, applies the edits one at a time, writes them to the changelog, and sends the result to everyone.
- If two people change the same thing, the first one wins. The second person's screen shows the conflict and the current value, and nothing is merged silently.
- Large one-person actions (generate a draw, run the allocator, compute the break) take a short lock that everyone can see ("Rafi is generating Round 4"), so two people cannot start them at once. The host can override any lock or edit at any stage.
- If a laptop loses the connection briefly, its edits wait in a queue and are sent when it reconnects; conflicts are shown as above.

**Host failure gets better too.** Every connected laptop already has a full copy, up to the last change the host confirmed. If the host dies, a tab director can promote their own laptop to host:

- The host number goes up, and the online service will refuse the old host from then on.
- The other laptops reconnect to the new host with a fresh connect code.
- The promoted laptop has no credentials, because credentials never leave the host. The tab director re-enters them once on the new host.
- Export and import by file stays as the fallback when no laptop was connected.

**Staff without the desktop app.** Data-entry assistants who only type in paper ballots do not need the desktop app. They sign in to the online ballots site with an assistant link from the host, and their entries arrive like any other ballot.

## 7. Proposal: staying under the free limits (better than refusing ballots)

1. **Spend almost nothing per participant.**
   - The ballot and feedback pages are static files on the free CDN, which does not count against request limits.
   - Each participant's view (their room, side, panel and motion once released) is also published as a small static file. It is encrypted with a key taken from their private link, and that part of the link never reaches the server.
   - Only sending a ballot or feedback form calls the server. That is about one request per ballot or form, not dozens per visit.
2. **Redis only where it is needed.** Free Redis has the tightest monthly limit. Use it for rate limits and duplicate-submission checks, or use the CDN's built-in cache instead. Never use it for page views.
3. **A budget per tournament.** The service knows the daily free limit and the tournaments scheduled that day. It warns the host before a round if the remaining requests look too few.
4. **If the limit is still reached:**
   - The phone keeps the ballot and retries automatically after the daily reset.
   - It also shows the ballot as a QR code. The tab room scans that QR with the host laptop's camera, and the ballot enters exactly as the judge filled it in, with no retyping and no network.
   - Paper is only the last fallback.
5. **Optional own keys.** A tournament can add its own free-tier keys (inherited from the global settings by default). Requests then count against that tournament's own allowance.

## 8. Proposal: roles and permissions

Tab directors are admins. The other roles are permission groups, built on CrabbyTab's staff groups. Every permission is checked on the host for each operation, not only hidden in the screen.

| Role | Can do |
|---|---|
| Host owner | Everything, including credentials, connect codes, promoting a host, and finishing the tournament. |
| Tab director (admin) | All tab work: setup, draws, allocation, results, releases, break, roles. No credentials. |
| Adjudication core | Adjudicator allocation, conflicts, adjudicator scores, read feedback. No draws or results. |
| Equity | Conflicts and read access to allocations. No feedback scores. |
| Tab assistant | Enter ballots and feedback, check-ins, room availability. Can confirm other people's ballots only if granted. |
| Display | Read-only screens for a projector or noticeboard. |
| Custom | Any combination of the permissions above, named by the tournament. |

Participants (adjudicators, teams, speakers) are not roles. They act only through their private links.

## 9. Weak points still open (critique first)

1. **The ballots service is the one part that must always be up.** If it fails during a round, thousands of phones fail at once. Paper ballots typed in on the host are the fallback.
2. **Zero cost is a hard ceiling.** Free tiers have daily limits that cover the whole shared service, not one tournament; section 7 keeps usage low, and the exact limits still need checking.
3. **The host laptop holds every secret.** Whatever is typed into Credentials can be read by anyone with access to the host's Windows account, so the host should have its own Windows account and screen lock.
4. **Reused logic and licences.** CrabbyTab is AGPL-3.0 and yours, so reusing it is fine. Tabbycat (AGPL-3.0, someone else's) stays read-only reference.
5. **The tab room network is a new piece of kit.** If the host laptop's hotspot is used, its Wi-Fi card serves the tab room and cannot also join the venue Wi-Fi on some laptops. The host then reaches the internet over a phone's USB tethering or a second adapter.
6. **Encrypted per-participant files are a new security surface.** The private link must carry enough randomness to protect the file key, and regenerating links must re-encrypt and republish those files.

## 10. Further decisions (round 5)

| Topic | Answer | What it means for the design |
|---|---|---|
| Precedence | The host's decision always wins, at any stage. | The host can override any lock or edit by another staff laptop; the overridden person sees what replaced their change. |
| Publishing | The host alone pushes public files. | Publishing credentials live in the host's Credentials page. (Each tournament uses its own CDN; see section 11.) |
| Offline motion release | Projector slide, as in CrabbyTab. | The host shows the motion on a projector screen; the online copy goes up when the host is next online. |
| Install and update | From GitHub. | Releases on GitHub with auto-update from there. The app is unsigned, so Windows shows a SmartScreen warning on first install; the install guide explains it. |
| Terminal | Mainly for an AI assistant helping the tab. | SimpleTab ships a command-line tool that talks to the host. An AI in the terminal is a staff member with its own role and permissions, and every change it makes is marked "AI" in the changelog. |
| Extensions | From a repo or marketplace built later. | First release: install from a file or a git repo. Marketplace later. |
| Size | Current WSDC and similar large tournaments on one device. | Design target: about 400 teams, 500 adjudicators and 100 rooms on one laptop (WUDC-size BP, larger than WSDC), with draw and allocation finishing within seconds. |
| Languages | Fully i18n, with a template for adding any language. | All text in locale files for all three apps; English and Bangla first; a documented template for new languages. |
| Licence | AGPL-3.0. | All three repos AGPL-3.0. Theia (EPL-2.0) is used as a library; its licence allows that. |
| Registration | Purely through the online site. | Registration runs on the shared service; the host pulls the registrations in. Personal data is online, so the retention rule applies. |

## 11. Further decisions (round 6)

| Topic | Answer | What it means for the design |
|---|---|---|
| Access to the shared service | A per-tournament key, approved by the author. | A host requests access from inside SimpleTab. The author approves it in an admin tool, and the service issues a key that works only for that tournament. The host stores the key in Credentials. The key can be revoked, and has its own share of the daily free limit. The database password never leaves the author's service. |
| Public pages | Each tournament uses its own CDN. | The host stores that tournament's own free CDN credentials (for example a GitHub Pages repo) in Credentials and publishes there directly. No host can touch another tournament's pages. The author's service holds no public files. |

## 12. Review outcomes (after the Goldfish review)

Full review: [review_report.md](review_report.md).

### Author decisions

| # | Decision | Accepted risk, and the cheap guard Claude adds |
|---|---|---|
| AD1 | Keep everything online, as decided before. No encrypted archive and no removal. | The shared database will eventually reach the 5 GB free storage, and erasure requests have no tool. Guard: the author's admin tool shows storage use and warns at 70%. |
| AD2 | No credential bundle or recovery sheet. A promoted host re-enters credentials. | If the credentials existed only on the dead laptop, online work stops until the author issues a new key. Guard: the admin tool can reissue a tournament's key in one step, which also raises the host number. |
| AD3 | Claude's choice: **no Redis in the first release.** | Duplicate submissions are blocked by unique IDs made on the phone, enforced by the database. Rate limits are counters in the database per link and per minute. Redis is added only if measured load shows the need. |
| AD4 | Shell features ship in this order: 1 git panel, 2 live collaboration, 3 terminal, 4 file explorer, 5 command palette, then the rest (extensions, AI tooling). | Assumption: the tab features themselves (setup, draw, allocation, ballots, standings, break, publishing) are the core of the first release, and this order applies to the Theia shell features around them. |
| AD5 | Open registration first; invite-only (one link per institution) later. | Open sign-up lets bots spend the shared free limit. Guard: free Cloudflare Turnstile on the form, a registration window the host opens and closes, a per-tournament cap, and registrations counted against that tournament's own share. |

### Review findings adopted (author can veto any)

- **C1:** each staff laptop receives only what its role may read. Only tab-director laptops hold the full copy, and only they can be promoted. Local copies are encrypted with the device key and wiped when the device is removed.
- **C3:** one encrypted round bundle per round replaces per-participant files. Rows are found by a hash of a lookup ID, with a separate key of at least 128 bits in the URL fragment. The publish branch is replaced on every publish, and unreleased motions are never published.
- **C5:** paper-ballot assistants use the desktop app in assistant mode on the tab-room network; the online assistant link stays as an extra option.
- **C6:** changelog format v2 hashes the actor type, a pseudonymous actor ID and a salted hash of each change. The chain head is included in every public publish.
- **C8 / S1–S15:** check-in (S1), swing and substitution flag (S2), two-room swap operations (S3), status panel (S4), phone ballot states and signed QR ballots (S5), Devices page with short codes (S6), AI only through the CLI with proposals (S7), versioned wire formats (S8), second admin and backups for the service (S9), a reserved daily share per key (S10), Cloudflare Pages as the default CDN (S11), hash-checked updates (S12), two-team speaker rules kept (S13), setup checklist (S14), router as the default for large events (S15).
