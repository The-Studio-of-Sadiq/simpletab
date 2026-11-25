# `simpletab` for AI agents

`simpletab` is a second device for a SimpleTab tournament. One laptop is the host. It owns the tournament and applies every change. This tool pairs with that host once. Each command then connects, does one thing, prints, and exits.

The CLI is usually paired with the **AI** role. In that role, a change you send is a **proposal**. It is not applied until a person accepts it in the SimpleTab app. The CLI does not accept its own proposals. A person can also pair the CLI with a human role, such as Tab director. Then `proposals accept` and `proposals reject` work.

JSON results go to stdout. Human messages go to stderr.

## Pairing

A person must do the first two steps on the host:

1. On the host, open the **Devices** page. Turn on devices.
2. Issue an **AI pairing code** for an AI agent (or a human role for a person).
3. Run `simpletab pair <address> <code>`. The address is shown on the Devices page, for example `192.168.1.20:47820`.
4. The CLI prints six words. Compare them with the six words on the host. If they match, approve this device on the host.

```sh
simpletab pair 192.168.1.20:47820 12345678 --name "AI agent"
```

The CLI prints:

```text
Check that the host shows these six words, then approve this device there:
apple bridge calm delta early fox
Paired with wss://192.168.1.20:47820 as "AI agent" (role: AI).
```

And on stdout:

```json
{
  "paired": true,
  "url": "wss://192.168.1.20:47820",
  "deviceId": "dev-7f3a",
  "deviceName": "AI agent",
  "role": { "id": "ai", "name": "AI" }
}
```

Pairing is stored in `~/.simpletab/cli` by default. Set `SIMPLETAB_CLI_DIR` or pass `--dir <path>` to use a different folder. The app's own device pairing is separate. Every command accepts `--dir <path>` and `--timeout <seconds>` anywhere on the command line. The default timeout is 15 seconds.

## Reading state

`status` shows the host, your role, the sequence number and the number of pending proposals.

```sh
simpletab status
```

```json
{
  "url": "wss://192.168.1.20:47820",
  "deviceName": "AI agent",
  "role": { "id": "ai", "name": "AI", "proposalsOnly": true },
  "connected": true,
  "seq": 42,
  "tournament": { "name": "Example Open", "slug": "example-open" },
  "pendingProposals": 1
}
```

`show <area>` prints one part of the host's role-filtered view. Areas: `tournament`, `rounds`, `teams`, `adjudicators`, `institutions`, `venues`, `draw`, `motions`, `results`, `feedback`, `break`, `proposals`, `state`. `debates` means `draw`, `ballots` means `results`, and `breakCategories` means `break`. Add `--round <roundId>` to keep only items with that round id.

```sh
simpletab show teams
simpletab show draw --round r-1
simpletab show state
```

Each prints the matching JSON value. For example:

```json
[
  { "id": "team-og", "name": "Open University", "shortName": "OU" }
]
```

Read `show` before you propose a change. The view is filtered for your role. It is the state the host has committed.

## Proposing a change

An AI can propose changes to the draw, allocation, results, the break and releases. Other areas are refused. For example, `team.update` is refused for an AI device; a person must make that change.

```sh
simpletab op release.set_gate --json '{"gate":"tab_team","released":true}'
```

The CLI waits until the host's snapshot has arrived. It then prints the result:

```json
{
  "ok": true,
  "seq": 43,
  "writes": ["proposal:proposal-5b1e…"],
  "committedPayload": {
    "id": "proposal-5b1e…",
    "op": { "type": "release.set_gate", "payload": { "gate": "tab_team", "released": true } },
    "createdAt": "2026-11-25T09:00:00.000Z"
  }
}
```

`committedPayload.id` is the proposal's id. On stderr:

```text
Proposal proposal-5b1e… is waiting for a person to accept it in the app.
```

You can read JSON from a file with `--file payload.json`, or from stdin with `--json -`.

### Safe edits with `--expect`

`--expect <recordKey>=<version>` says which version of a record you read. The option can be repeated. For an AI device the versions are kept inside the proposal and checked when a person accepts it: if the record has changed since, the host refuses to apply it (`VERSION_CONFLICT`) and the proposal stays pending until someone rejects it. Record versions are in `simpletab show state` under `versions`, with keys such as `tournament:t-1` or `team:team-og`.

```sh
simpletab op release.set_gate --json '{"gate":"tab_team","released":true}' --expect tournament:t-1=42
```

Never retry a refused change blindly. Read the state again and decide what to do.

## Proposals

`proposals list` shows pending proposals, oldest first. `proposals list --all` shows every proposal, including accepted and rejected ones.

```sh
simpletab proposals list --all
```

```json
[
  {
    "id": "p-1",
    "status": "accepted",
    "type": "release.set_gate",
    "payload": { "gate": "tab_team", "released": true },
    "proposedBy": "device:dev-7f3a",
    "createdAt": "2026-11-25T09:00:00.000Z",
    "resolvedBy": "host-owner"
  },
  {
    "id": "p-2",
    "status": "rejected",
    "type": "release.set_gate",
    "payload": { "gate": "tab_team", "released": false },
    "proposedBy": "device:dev-7f3a",
    "createdAt": "2026-11-25T09:05:00.000Z",
    "resolvedBy": "device:dev-91c2",
    "reason": "Wait for the round to finish"
  }
]
```

A CLI paired with a human role can resolve a proposal. An AI CLI refuses locally, without connecting.

```sh
simpletab proposals accept p-1
simpletab proposals reject p-2 --reason "Wait for the round to finish"
```

Both print the `SubmitResult` JSON, as `op` does.

## Leaving and help

```sh
simpletab leave
simpletab help
simpletab --help
```

`leave` clears this CLI's pairing. A person must issue a new code to pair again.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | The host refused the change, or it failed. |
| 2 | Bad arguments, unknown command or area, or invalid JSON. |
| 3 | Not paired, host unreachable within the timeout, change not sent, or the host removed this device (its pairing is then cleared). |

`simpletab help` and `--help` print usage on stdout and exit 0. With no arguments, usage goes to stderr and the exit code is 2.

## Tips for agents

- Read `show` first. Propose against the state you saw.
- Keep proposals small. One clear change is easier for a person to check.
- Use `--expect` when the change depends on a record staying the same.
- Do not retry a refused op without reading the state again. The host's refusal is printed on stderr.
- If a proposal is pending, tell the person its id. They must accept it in the app.
