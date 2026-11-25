import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { effectiveSuccession } from "@simpletab/core/ops";
import { PAIRING_CODE_DIGITS } from "../../common/collab-protocol";
import type { JoinHostParams, JoinProgress } from "../../common/host-protocol";
import { CollabClient, type CollabPairOptions, type CollabPairResult } from "../collab/device-client";
import { generateSelfSignedCertificate } from "../collab/tls";
import { PairingStore, type StoredPairing } from "./pairing-store";
import { parseHostAddress, plainPairFailure } from "./pairing-text";

export { parseHostAddress } from "./pairing-text";
import { RemoteHost, type RemoteHostDeps } from "./remote-host";
import { ReplicaStore } from "./replica-store";
import { chooseNewerCopy, promoteReplica, type PromoteResult } from "./promote";

export const REPLICA_DIR_NAME = "replica";

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
    this.replicaFor(undefined).clear();
    this.store.clear();
    this.progress = { state: "idle" };
    this.deps.onChange?.();
  }

  dispose(): void {
    this.remote?.stop();
    this.remote = null;
  }

  /** Rank of this laptop in the succession list, and the names of better-ranked ones. */
  successionInfo(): { rank: number; betterRanked: string[] } | undefined {
    const remote = this.remote;
    if (remote === null) return undefined;
    const pairing = remote.getPairing();
    if (pairing.role.id !== "tab_director") return undefined;
    const state = remote.getState();
    if (state === null) return { rank: 1, betterRanked: [] };
    const devices = (state as unknown as { devices?: Array<{ id: string; name: string; role: { id: string } }> }).devices ?? [];
    const succession = (state as unknown as { succession?: string[] }).succession;
    const order = effectiveSuccession({
      devices: devices as never,
      ...(succession !== undefined ? { succession } : {}),
    });
    const index = order.indexOf(pairing.deviceId);
    const rank = index >= 0 ? index + 1 : order.length + 1;
    const betterRanked = order
      .slice(0, Math.max(0, index >= 0 ? index : order.length))
      .map((id) => devices.find((d) => d.id === id)?.name ?? id);
    return { rank, betterRanked };
  }

  /** Saves this laptop's full copy as a `.simpletab` file another laptop can promote from. */
  async exportCopy(directory: string): Promise<string> {
    const remote = this.requireDirector();
    await remote.settleCopy();
    const replica = this.replicaFor(remote.getPairing());
    if (!replica.exists()) throw new Error("This laptop has no full copy yet. Connect to the host first.");
    const bytes = await replica.buildHandover();
    const slug = remote.getState()?.tournament.slug ?? "tournament";
    const file = path.join(directory, `${slug}.copy-${replica.lastSeq()}.simpletab`);
    writeFileSync(file, bytes);
    return file;
  }

  /**
   * Promotes this laptop to host (design section 4): builds the new host database from this
   * laptop's copy (or a newer copy saved on another tab director's laptop), with host number one
   * above the best host seen and this laptop's succession rank. The device pairing is then left.
   */
  async promote(params: { directory: string; newerCopyPath?: string }): Promise<PromoteResult> {
    const remote = this.requireDirector();
    if (remote.isConnected()) {
      throw new Error("The host is still reachable. Promote only when the host laptop is down for good.");
    }
    await remote.settleCopy();
    const replica = this.replicaFor(remote.getPairing());
    if (!replica.exists()) throw new Error("This laptop has no full copy to promote from.");
    let handover = await replica.buildHandover();
    if (params.newerCopyPath !== undefined && params.newerCopyPath.trim().length > 0) {
      const chosen = await chooseNewerCopy(handover, readFileSync(params.newerCopyPath));
      handover = chosen.handover;
    }
    const slug = remote.getState()?.tournament.slug ?? remote.getPairing().deviceId;
    const targetDbPath = path.join(params.directory, `${slug}.simpletab.db`);
    if (existsSync(targetDbPath)) {
      throw new Error(`${targetDbPath} already exists. Choose an empty folder.`);
    }
    const best = this.store.loadBestHost() ?? remote.getPairing().host;
    const rank = this.successionInfo()?.rank ?? 1;
    const result = await promoteReplica({ handover, targetDbPath, rank, minHostNumber: best.hostNumber + 1 });
    this.store.saveBestHost({
      hostNumber: result.hostNumber,
      hostId: result.hostId,
      hostRank: result.hostRank,
      certFingerprint: "",
      promotedFromSeq: result.promotedFromSeq,
    });
    this.leave();
    return result;
  }

  private requireDirector(): RemoteHost {
    const remote = this.remote;
    if (remote === null) throw new Error("This laptop is not joined to a host.");
    if (remote.getPairing().role.id !== "tab_director") {
      throw new Error("Only a tab director's laptop keeps a full copy and can be promoted.");
    }
    return remote;
  }

  private replicaFor(pairing: StoredPairing | undefined): ReplicaStore {
    const key = pairing?.certificate.keyPem ?? this.store.load()?.certificate.keyPem ?? "";
    return new ReplicaStore(path.join(this.store.directory, REPLICA_DIR_NAME), key);
  }

  private startRemote(pairing: StoredPairing): void {
    const remote = new RemoteHost({
      ...(this.deps.remoteDeps ?? {}),
      pairing,
      bestHost: { load: () => this.store.loadBestHost(), save: (host) => this.store.saveBestHost(host) },
      ...(pairing.role.id === "tab_director" ? { replica: this.replicaFor(pairing) } : {}),
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
