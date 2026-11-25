import { COLLAB_DEFAULT_PORT } from "../../common/collab-protocol";

/**
 * Pairing texts shared by the app's device mode and the `simpletab` CLI. Kept apart from
 * `device-mode.ts` so the CLI can use them without loading the host's database code.
 */

/** Turns what a person types into a `wss://host:port` URL, or explains what is wrong. */
export function parseHostAddress(input: string): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = input.trim().replace(/^wss:\/\//i, "").replace(/\/+$/, "");
  if (trimmed.length === 0) return { ok: false, error: "Enter the host's address, shown on its Devices page." };
  let host: string;
  let port = COLLAB_DEFAULT_PORT;
  const bracketed = /^\[([0-9a-fA-F:.]+)\](?::(\d+))?$/.exec(trimmed);
  if (bracketed !== null) {
    host = `[${bracketed[1]}]`;
    if (bracketed[2] !== undefined) port = Number(bracketed[2]);
  } else {
    const match = /^([A-Za-z0-9.-]+)(?::(\d+))?$/.exec(trimmed);
    if (match === null) return { ok: false, error: "That address is not valid. Use the one shown on the host's Devices page, like 192.168.1.20:47820." };
    host = match[1]!;
    if (match[2] !== undefined) port = Number(match[2]);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "The port must be a number from 1 to 65535." };
  return { ok: true, url: `wss://${host}:${port}` };
}

/** Explains in words why pairing failed. */
export function plainPairFailure(reason: string): string {
  switch (reason) {
    case "BAD_CODE":
      return "The host did not accept that code. Codes work once, for 5 minutes. Ask for a new one.";
    case "LOCKED_OUT":
      return "Too many wrong codes were tried, so the host cancelled its codes. Ask for a new one.";
    case "REJECTED":
      return "The host did not approve this laptop.";
    case "TIMEOUT":
      return "The host did not approve in time. Ask for a new code and try again.";
    case "HOST_UNREACHABLE":
      return "Cannot reach the host. Check the address, that both laptops are on the same network, and that the host allows devices.";
    default:
      return "Pairing failed because the two laptops disagreed on the connection. Ask for a new code and try again.";
  }
}
