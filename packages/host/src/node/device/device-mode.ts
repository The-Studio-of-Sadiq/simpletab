import os from "node:os";
import { COLLAB_DEFAULT_PORT, PAIRING_CODE_DIGITS } from "../../common/collab-protocol";
import type { JoinHostParams, JoinProgress } from "../../common/host-protocol";
import { CollabClient, type CollabPairOptions, type CollabPairResult } from "../collab/device-client";
import { generateSelfSignedCertificate } from "../collab/tls";
import { PairingStore, type StoredPairing } from "./pairing-store";
import { RemoteHost, type RemoteHostDeps } from "./remote-host";

/**
 * Device mode (design section 4.1): pairing with a host, then running as its staff device.
 * A laptop is either a host of its own tournaments or a device of one host, never both at once.
 */

export interface DeviceModeDeps {
  store?: PairingStore;
  pair?: (opts: CollabPairOptions) => Promise<CollabPairResult>;
  remoteDeps?: Partial<Omit<RemoteHostDeps, "pairing" | "onChange" | "onRemoved">>;
  now?: () => Date;
  onChange?: () => void;
}

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

function plainPairFailure(reason: string): string {
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

export class DeviceMode {
  private readonly store: PairingStore;
  private readonly pairImpl: (opts: CollabPairOptions) => Promise<CollabPairResult>;
  private readonly now: () => Date;
  private readonly deps: DeviceModeDeps;
  private remote: RemoteHost | null = null;
  private progress: JoinProgress = { state: "idle" };
  private joining = false;

  constructor(deps: DeviceModeDeps = {}) {
    this.deps = deps;
    this.store = deps.store ?? new PairingStore();
    this.pairImpl = deps.pair ?? ((opts) => CollabClient.pair(opts));
    this.now = deps.now ?? (() => new Date());
  }

  /** Resumes a stored pairing at start-up. Returns whether this laptop is a device. */
  resume(): boolean {
    if (this.remote !== null) return true;
    const pairing = this.store.load();
    if (pairing === undefined) return false;
    this.startRemote(pairing);
    return true;
  }

  active(): RemoteHost | null {
    return this.remote;
  }

  joinProgress(): JoinProgress {
    return { ...this.progress, ...(this.progress.words !== undefined ? { words: [...this.progress.words] } : {}) };
  }

  /** Starts pairing in the background; poll `joinProgress` for the words and the outcome. */
  async startJoin(params: JoinHostParams): Promise<JoinProgress> {
    if (this.remote !== null) throw new Error("This laptop is already joined to a host. Leave it first.");
    if (this.joining) return this.joinProgress();
    const address = parseHostAddress(params.address);
    if (!address.ok) throw new Error(address.error);
    const code = params.code.replace(/\s+/g, "");
    if (!new RegExp(`^\\d{${PAIRING_CODE_DIGITS}}$`).test(code)) {
      throw new Error(`The code has ${PAIRING_CODE_DIGITS} digits, as shown on the host's Devices page.`);
    }
    const deviceName = params.deviceName.trim() || os.hostname();
    if (deviceName.length > 60 || /[\u0000-\u001f\u007f]/.test(deviceName)) {
      throw new Error("Use a device name of at most 60 characters.");
    }

    this.joining = true;
    this.progress = { state: "connecting" };
    this.deps.onChange?.();
    void (async () => {
      try {
        const certificate = await generateSelfSignedCertificate({ commonName: deviceName, now: this.now() });
        const result = await this.pairImpl({
          url: address.url,
          certificate,
          code,
          deviceName,
          onWords: (words) => {
            this.progress = { state: "waiting", words: [...words] };
            this.deps.onChange?.();
          },
        });
        if (!result.ok) {
          this.progress = { state: "failed", error: plainPairFailure(result.reason) };
          return;
        }
        const pairing: StoredPairing = {
          version: 1,
          url: address.url,
          deviceId: result.deviceId,
          deviceName,
          role: result.role,
          hostFingerprint: result.hostFingerprint,
          host: result.host,
          certificate,
          pairedAt: this.now().toISOString(),
        };
        this.store.save(pairing);
        this.startRemote(pairing);
        this.progress = { state: "joined" };
      } catch (error) {
        this.progress = {
          state: "failed",
          error: `Pairing failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        this.joining = false;
        this.deps.onChange?.();
      }
    })();
    return this.joinProgress();
  }

  /** Leaves the host: closes the connection and deletes the pairing and this laptop's copy. */
  leave(): void {
    this.remote?.stop();
    this.remote = null;
    this.store.clear();
    this.progress = { state: "idle" };
    this.deps.onChange?.();
  }

  dispose(): void {
    this.remote?.stop();
    this.remote = null;
  }

  private startRemote(pairing: StoredPairing): void {
    const remote = new RemoteHost({
      ...(this.deps.remoteDeps ?? {}),
      pairing,
      onChange: () => this.deps.onChange?.(),
      onRemoved: () => {
        this.store.clear();
        this.deps.onChange?.();
      },
    });
    this.remote = remote;
    remote.start();
  }
}
