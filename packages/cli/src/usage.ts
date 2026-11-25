/** The `simpletab` usage text, shared by `--help`, `help` and the no-arguments error. */

/** The areas `show` accepts, canonical names only (aliases are listed in `AREA_ALIASES`). */
export const AREA_NAMES: readonly string[] = [
  "tournament",
  "rounds",
  "teams",
  "adjudicators",
  "institutions",
  "venues",
  "draw",
  "motions",
  "results",
  "feedback",
  "break",
  "proposals",
  "state",
];

export function usageText(): string {
  return `simpletab — pair with a SimpleTab tournament host, read its state and propose changes

Usage:
  simpletab pair <address> <code> [--name <device name>]
  simpletab leave
  simpletab status
  simpletab show <area> [--round <roundId>]
  simpletab op <type> (--json <payload> | --json - | --file <path>) [--expect <recordKey>=<version>]...
  simpletab proposals list [--all]
  simpletab proposals accept <id>
  simpletab proposals reject <id> [--reason <text>]
  simpletab help

Options (allowed anywhere):
  --dir <path>         pairing folder (default $SIMPLETAB_CLI_DIR, else ~/.simpletab/cli)
  --timeout <seconds>  how long to wait for the host (default 15)
  -h, --help           print this help

Areas for show:
  ${AREA_NAMES.join(", ")}
  Aliases: debates = draw, ballots = results, breakCategories = break.

JSON goes to stdout; human messages go to stderr.

Exit codes:
  0  success
  1  the host refused the change, or it failed
  2  bad arguments
  3  not paired, host unreachable, change not sent, or this device was removed
`;
}
