# SimpleTab concepts brief: Goldfish review report

- **Date:** 2026-11-18
- **Document reviewed:** [concepts_brief.md](concepts_brief.md)
- **Method:** EGM Goldfish review. Three reviewers from three vendors each read only the brief (and, for two of them, the CrabbyTab source), never the conversation that produced it.
- **Synthesis:** Claude (Elephant). Claude checked the claims against the CrabbyTab code where possible; see "Checked".

| Reviewer | Lenses |
|---|---|
| ChatGPT (GPT-6, Codex) | Free-tier cost and quota (checked on the web with sources), YAGNI, long-term maintenance |
| Gemini 4 Argon (gemini.google.com) | Debate-tab domain fit, inventive transforms, architecture coherence |
| Claude (fresh subagent) | Tab-room UX, failure handling and visibility, security and privacy |

**Verdict from all three:** not ready to draft yet. The overall shape holds: one offline host as the source of truth, a static public site and a thin online inbox. But the seams between the parts have gaps, and three of them are security or data-loss problems.

## 1. Free-tier facts (ChatGPT, checked 2026-11-18)

| Service | Free limit | Source |
|---|---|---|
| Cloudflare Workers | 100,000 requests/day; 10 ms CPU per request. Static assets do not count. | developers.cloudflare.com/workers/platform/limits |
| Cloudflare D1 (SQLite) | 5M rows read/day, 100k rows written/day, 5 GB storage per account (500 MB per database, 10 databases). Queries fail after the cap until midnight UTC. | developers.cloudflare.com/d1/platform/limits |
| Cloudflare KV | 100k reads/day, **1,000 writes/day** | developers.cloudflare.com/kv/platform/limits |
| Cloudflare Pages | Static requests free and unlimited; 500 builds/month; 20,000 files per site | developers.cloudflare.com/pages/platform/limits |
| Upstash Redis | 500,000 commands/month, 256 MB | upstash.com/pricing/redis |
| Turso | 5 GB storage, 500M rows read and 10M rows written per month | turso.tech/pricing |
| GitHub Pages | Soft 100 GB/month bandwidth, soft 10 builds/hour, 1 GB site; policy says it is not meant for SaaS | docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits |
| GitHub Releases | No total bandwidth limit; 2 GiB per file | docs.github.com/en/repositories/releasing-projects-on-github/about-releases |

**Load for one WUDC-size tournament** (1,300 people, 100 rooms, 9 rounds): about 5,400 to 7,200 submissions over the whole tournament, plus registration, check-in and host sync. On Cloudflare Workers, the shared service could carry roughly 13 to 18 such tournaments on the same day before the request cap. D1's 5 GB storage is the limit that "never delete" will eventually hit. KV's 1,000 writes/day rules it out as a write store. Redis is the first monthly limit to run out.

## 2. Findings raised by two or three reviewers

| # | Finding | Raised by | Claude's assessment | Proposed resolution |
|---|---|---|---|---|
| C1 | **Every staff laptop gets a full copy, including feedback, private keys, emails and registration data.** That breaks the brief's own rules ("Equity sees no feedback"). With Theia's terminal and file explorer, anyone can open the local SQLite file. A removed device keeps its copy. | Claude (critical), Argon (critical), ChatGPT | Valid. | The host sends each laptop only what its role may read. Only tab-director laptops get the full copy, and only they can be promoted. Local copies are encrypted with the device key and wiped when the device is removed or the tournament is finished. |
| C2 | **Host promotion strands the credentials.** Secrets are only on the dead host, so a promoted laptop cannot pull ballots, publish or raise the host number until someone re-enters keys, and those keys may only have existed on the dead machine. If the host also ran the hotspot, the staff network dies with it. | Claude (critical), Argon (major), ChatGPT (major) | Valid; conflicts with the rule "only the host has credentials". | **Author decision D2.** |
| C3 | **Per-participant encrypted files are weak and hard to publish.** A 12-character link is about 59 bits, which can be cracked offline when the files sit in a public repo. Old ciphertext stays in git history after links are regenerated. About 1,700 files per release is slow on GitHub Pages builds. The brief also does not say how a phone finds its file. | Claude (critical), Argon (critical), ChatGPT (major) | Valid. Checked: the alphabet has 31 characters, not 30 as the brief says. | One **round bundle** file per round instead of 1,700 files. Rows are found by a hash of a lookup ID, and each row is encrypted with a separate key of at least 128 bits, kept in the URL fragment (never sent to the server). Publish to a branch that is replaced on every publish, so no history is kept. Unreleased motions are never in any file. |
| C4 | **"Never delete" against 5 GB free storage and erasure requests.** The shared database fills up eventually, and nothing reads the archive. Registration data may include minors, and many laws give a right to erasure. | All three | Valid. | **Author decision D1.** |
| C5 | **Paper-ballot assistants depend on the internet.** Paper is the fallback for when the internet is down, but assistants were to type paper ballots into the online site. | Claude, Argon | Valid. | Assistants use the desktop app in "assistant" mode on the tab-room network. That needs no internet and no plain HTTP, because the connection is TLS pinned by the connect code. The online assistant link stays as an extra option. |
| C6 | **The changelog is not truly tamper-evident.** Checked in CrabbyTab's `auditLog.ts`: the hash covers only sequence, time, category, action and summary, not the actor or the data, and the chain is re-sorted and rebuilt on every check. The host could rewrite history and the check would still pass. The "AI" mark is not covered. | Claude, Argon | Valid (checked in code). | Changelog format v2. Each entry hashes the actor type (human or AI), a pseudonymous actor ID, and a salted hash of the change itself. The current chain head goes into every public publish, so outside copies anchor it. Private details stay private, but they can still be checked in an audit. |
| C7 | **The first release is too big.** Theia plus extensions, git, terminal and AI, three repos and live collaboration. Each brings upgrades, security work and support. Extensions are unrestricted Node.js code, so their "scopes" are a promise, not something the app enforces. | ChatGPT (major), Claude (major) | Partly valid. Theia is the author's decision; the question is what ships first. | **Author decision D4.** |
| C8 | **Registration is unspecified.** There is no spam protection before private links exist, no quota model and no privacy handling, and it contradicts "the internet only for ballots and feedback". | ChatGPT, Argon | Valid. | Registration opens only through an invite link per institution, issued by the host. It is rate-limited and collects the minimum fields. It counts against the tournament's own key budget. |
| C9 | **Redis adds a second always-on dependency with the smallest free limit.** Duplicate checks can use the database's unique IDs, and rate limits can use the edge. | ChatGPT (major) | Valid, but Redis was the author's choice. | **Author decision D3.** |

## 3. Single-reviewer findings worth adopting

| # | Finding | Raised by | Proposed resolution |
|---|---|---|---|
| S1 | **Check-in is missing.** At WUDC scale, electronic check-in before every round is how the tab finds no-shows and sends swings in. | Argon | Self check-in through private links, about 1,300 writes per round. That is affordable: Argon's "blows the budget" is an overstatement, since D1 allows 100k writes/day. Add staff scanning of QR badges on the tab-room network, and delegation-level check-in for institution heads. |
| S2 | **Swing teams and late swaps.** A chair's cached ballot shows the old team after a swap. | Argon | The server checks only tournament, round, room and adjudicator link, not team IDs. The ballot has a "substitution or swing in this room" flag, and the host reconciles the change when it pulls. |
| S3 | **Allocation swaps involve two rooms.** Five people editing the allocation at once will leave rooms with two chairs if version checks cover one room at a time. | Argon | A swap is one operation covering both rooms. Show live "holding Judge Y" markers on every laptop. |
| S4 | **No status panel.** The tab cannot tell "judges are slow" from "the sync is stuck". | Claude | A permanent status bar and panel showing: online/offline, last push and pull, ballots in versus expected per room, quota left, host number, whether the CDN publish is live (checked by reading the manifest back), and queued staff edits. Shown with text labels, not colour alone. |
| S5 | **The phone's "retry after reset" fails once the tab is closed, and anyone can fake a QR ballot.** | Claude, Argon | The phone shows three states: "Saved on this phone only, don't leave", "Received by server", "Received by tab room". QR ballots carry a code signed with the judge's link secret. Any assistant's device can scan them, not just the host's camera. A "copy ballot code" option lets a judge send it through a messaging app. |
| S6 | **The connect code sits on the Credentials page, is long to type, and grants a role to whoever reads it first.** | Claude | A separate Devices page. Short 8-digit codes using a password-authenticated key exchange (PAKE), valid for 5 minutes. The host approves each join on screen. |
| S7 | **The AI in the terminal can bypass the permission system** by editing SQLite directly, and can be steered by text in team names or feedback. | Claude | The AI gets only the CLI, which goes through the same permission checks as staff laptops. AI changes to draws, results and allocations are proposals that a person accepts. The app checks on every start that the database matches the changelog. |
| S8 | **Three repos can drift apart** (schema mismatch during an event). | ChatGPT | Versioned wire formats, a stated oldest-supported desktop version, and a release checklist that pins `@simpletab/core` across all three repos. |
| S9 | **One operator is a single point of failure** for key approval and service recovery. | ChatGPT | Approve keys at least 48 hours before an event, which the app warns about. Automatic database backups with a tested restore. A second admin who can approve keys. |
| S10 | **Shared quota.** A second tournament can use up the day's limit mid-round for the first. | ChatGPT | Each approved key gets a reserved daily share. Requests over that share are refused only for that tournament, which then falls back to QR or paper. |
| S11 | **GitHub Pages limits and policy.** | ChatGPT, Claude | Cloudflare Pages is the documented default (unlimited static requests). GitHub Pages is an option. Publishes are batched to stay under build limits. |
| S12 | **Auto-update trust** for an unsigned app. | ChatGPT, Claude | Update files are checked against hashes published separately from the release. Release credentials are protected, and there is a rollback procedure. |
| S13 | **Two-team speakers:** reply speeches, iron-person and squad rotation. | Argon | CrabbyTab already handles these (ghost and reply-speaker rules). The ballot schema in `@simpletab/core` keeps them, and the phone ballot lets the chair choose who spoke in each position. |
| S14 | **First-run setup is heavy** (key approval, CDN repo, SMTP). | Claude | A setup checklist with a "test" button for each credential, and a clear "approval pending" state. |
| S15 | **The 8-device hotspot limit** is tight for a large tab team. | Claude | A router is the default for large tournaments; the hotspot is the fallback. Display screens can follow a read-only stream. |

## 4. Corrected or rejected

- **Argon F4, "drop panellist sheets for BP":** misread. In CrabbyTab, individual sheets apply only to voting ballots (two-team formats). BP panels confer and the chair submits one ballot. The brief will say this explicitly; no feature is dropped.
- **Argon transform: "each tournament runs its own Cloudflare worker".** This conflicts with the author's decision (one shared service) and is already covered as the optional "own keys". Not adopted as the default.
- **Argon transform: "phones post to the host over the venue LAN first".** This conflicts with the author's rule that ballots never travel over the local network. Rejected.
- **ChatGPT F6, "defer live collaboration".** The author requires multiple tab directors. The promotion risks are handled by C1 and D2 instead.

## 5. Decisions the author must make

- **D1. Retention.** "Never delete" collides with the 5 GB free storage and with erasure requests (C4). One option keeps "never delete" in spirit: the host already holds every record, so the online copy could move into an archive encrypted with a key only the host holds. The online copy could then be removed from the shared database after the host confirms it has everything, and erased on a legal request.
- **D2. Credentials for a promoted host.** The current rule is that only the host has credentials (C2). How should a promoted tab director get the service key and CDN token at 3 AM? Two options came up: an encrypted credential bundle copied to tab-director laptops and opened with a recovery passphrase only during promotion, or a printed recovery sheet made at setup.
- **D3. Redis.** Keep Redis in the online service (author's original stack), or start without it and use database unique IDs and edge rate limits (C9)?
- **D4. First-release scope.** Theia stays. Which of extensions, git panel, terminal/AI and live collaboration ship in the first release, and which come later (C7)?
- **D5. Registration.** Is invite-only registration (one link per institution, issued by the host) acceptable, rather than open sign-up (C8)?
