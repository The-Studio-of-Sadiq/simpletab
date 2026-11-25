# The CLI, AI agents and the terminal

This guide is for the people running a tournament. It explains how to let an AI agent help with the tab without letting it change anything on its own. The command reference for the agent itself is [`packages/cli/README.md`](../packages/cli/README.md). Give that file to the agent.

## What the AI can and cannot do

An AI agent works through `simpletab`, a command-line tool that pairs with the host like any staff laptop. Paired with the **AI** role, it can:

- read the tournament as the AI role sees it (`simpletab show …`);
- **propose** changes to the draw, the allocation, results, the break and releases.

It cannot:

- change anything directly. Every change it sends becomes a proposal, and nothing happens until a person accepts it;
- accept or reject proposals, its own or anyone else's;
- undo changes;
- propose changes in any other area, such as teams, participants, motions, rooms or settings. The host refuses these with a reason.

The host enforces these rules. They do not depend on the agent behaving well.

## Setting up the CLI

The CLI is not yet part of the installer. From a copy of this repository:

```sh
npm ci
npm run build -w @simpletab/cli
node packages/cli/bin/simpletab.mjs help
```

To have a `simpletab` command on that laptop, run `npm link -w @simpletab/cli` once.

Run the CLI, and the agent, on a **staff laptop**, not on the host. See [The terminal on the host](#the-terminal-on-the-host).

## Pairing an AI agent

1. On the host, open **Devices** and turn on "Allow devices to connect".
2. Issue a pairing code for the **AI** role.
3. On the staff laptop, run `simpletab pair <address> <code> --name "AI agent"`. The address is on the Devices page.
4. The CLI prints six words. Check that the host shows the same six words, then approve the device on the host. If the words differ, do not approve it.

The pairing is stored in `~/.simpletab/cli` on that laptop, separate from the app's own device pairing. To pair a second agent on the same laptop, give it its own folder with `--dir` or `SIMPLETAB_CLI_DIR`.

To stop an agent, remove its device on the Devices page. Its next command fails with exit code 3 and its pairing is cleared.

## Reviewing proposals

Open **Proposals** in the SimpleTab panel. The button shows how many are waiting, for example "Proposals (2)".

- **Waiting for a decision** lists pending proposals, oldest first. Each shows the change type, who proposed it, when, and the change itself under "Details".
- **Accept** applies the change. You need the same permission as for making that change yourself, for example draw permissions to accept a draw change.
- **Reject** discards it. You can add a reason, which the agent sees with `simpletab proposals list --all`.
- **Decided** lists accepted and rejected proposals, newest first, with who decided and any reason.

Each role sees only proposals whose change it is allowed to see. Display sees none.

Some things to know:

- **Stale proposals are refused.** If the agent said which version of a record it read (`--expect`), and the record has changed since, accepting fails with a version conflict. Reject it, and the agent can read the new state and propose again. A proposal without `--expect` is applied to whatever the record is when you accept it, so read the details first.
- **The changelog shows both people involved.** An accepted change is recorded as made by the person who accepted it. The entry keeps the proposer, with actor type "AI", so you can always see which changes an AI suggested.
- **To undo an accepted change**, use undo in the changelog as for any other change.
- A person can also pair the CLI with a human role, such as Tab director. It can then accept and reject proposals from the command line (`simpletab proposals accept <id>`). That is a person's decision, made with that person's role.

## The terminal on the host

SimpleTab has a built-in terminal (Terminal → New Terminal, or Ctrl+Shift+`). On the host laptop, every terminal you open shows a warning, because programs started there run on the same laptop as the tournament files. They can read and change those files directly. That bypasses proposals, roles and the changelog that keep an AI agent in check.

So:

- run AI agents, and the CLI they use, on a staff laptop paired with the AI role;
- use the host's terminal only for things you would do yourself, such as git.

A staff laptop gets no warning. Its terminal cannot reach the host's files, only its own.

## Known limits

- The CLI is not in the installer yet; it runs from a copy of the repository.
- Proposals do not expire. Reject the ones you do not want, so the list stays short.
- The warning in the host's terminal is a reminder, not a lock. Anyone at the host laptop can still run anything there.
