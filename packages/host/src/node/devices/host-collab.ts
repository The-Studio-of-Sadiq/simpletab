import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Actor, OpRequest, TournamentState } from "@simpletab/core/ops";
import { BUILT_IN_ROLES, PRESET_ROLES, type Role } from "@simpletab/core/permissions";
import {
  COLLAB_DEFAULT_PORT,
  type CertFingerprint,
  type ConnectedDeviceInfo,
  type HostIdentity,
  type IssuedPairingCode,
  type PendingJoin,
} from "../../common/collab-protocol";
import type { DevicesStatus, PairableRole } from "../../common/host-protocol";
import { PairingCodes } from "../collab/pairing-codes";
import { CollabServer, type DeviceRegistry, type DeviceSession } from "../collab/server";
import { certFingerprint, generateSelfSignedCertificate, type CollabCertificate } from "../collab/tls";

/**
 * Host side of live collaboration (design section 4, amendment 7): owns the tournament's
 * certificate, the pairing codes and the `wss` server, and keeps approved devices in the op log
 * (`device.approve` / `device.remove`), so the Devices page, the changelog and handover all see them.
 *
 * The server listens only while the host user has "Allow devices to connect" on. The certificate's
 * private key lives in `<workspace>/collab/`, which the workspace `.gitignore` excludes, and never
 * enters the tournament database or a handover file.
 */

export const COLLAB_DIR_NAME = "collab";
const CERT_FILE = "host-certificate.json";
const REMOVED_META_KEY = "collab_removed_devices";

/** Roles a device can be paired to (the host owner stays on the host; AI pairs in M6). */
export const PAIRABLE_ROLES: readonly Role[] = [
  BUILT_IN_ROLES.tab_director,
  BUILT_IN_ROLES.adjudication_core,
  BUILT_IN_ROLES.equity,
  BUILT_IN_ROLES.tab_assistant,
  BUILT_IN_ROLES.display,
  PRESET_ROLES.ballot_desk,
  PRESET_ROLES.check_in_desk,
  PRESET_ROLES.feedback_desk,
];

export interface HostCollabEngine {
  getState(): TournamentState | null;
  submit<P>(request: OpRequest<P>, actor: Actor): Promise<{ ok: boolean; error?: { message: string } }>;
  readMeta(key: string): string | undefined;
  writeMeta(key: string, value: string): void;
}

export interface HostCollabDeps {
  engine: HostCollabEngine;
  workspaceDir: string;
  hostOwner: Actor;
  getHostIdentity(): Omit<HostIdentity, "certFingerprint">;
  now?: () => Date;
  /** Called when the Devices page should refresh (a join waits, a device came or went). */
  onChanged?: () => void;
  /** Called for every authenticated device connection (step b streams data through it). */
  onSession?: (session: DeviceSession) => void;
}

function isCertificateFile(value: unknown): value is CollabCertificate {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.certPem === "string" && typeof v.keyPem === "string" && typeof v.fingerprint === "string";
}

/** Non-internal IPv4 addresses, so the Devices page can show where to connect. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) out.push(entry.address);
    }
  }
  return out.sort();
}

export class HostCollab {
  private readonly deps: HostCollabDeps;
  private readonly now: () => Date;
  private readonly codes: PairingCodes;
  private server: CollabServer | null = null;
  private certificate: CollabCertificate | null = null;
  private port: number | undefined;
  private startError: string | undefined;

  constructor(deps: HostCollabDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.codes = new PairingCodes({ now: () => this.now().getTime() });
  }

  /** Loads the tournament's certificate, creating it on first use. */
  async loadCertificate(): Promise<CollabCertificate> {
    if (this.certificate !== null) return this.certificate;
    const dir = path.join(this.deps.workspaceDir, COLLAB_DIR_NAME);
    const file = path.join(dir, CERT_FILE);
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (isCertificateFile(parsed) && certFingerprint(parsed.certPem) === parsed.fingerprint) {
        this.certificate = parsed;
        return parsed;
      }
      throw new Error("The host certificate file is damaged. Remove the collab folder to make a new one; devices will need to pair again.");
    }
    const state = this.deps.engine.getState();
    const created = await generateSelfSignedCertificate({
      commonName: `SimpleTab host ${state?.tournament.slug ?? "tournament"}`,
      now: this.now(),
    });
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(created), { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      // Windows ignores POSIX modes; the folder is inside the user's own workspace.
    }
    this.certificate = created;
    return created;
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  async start(port: number = COLLAB_DEFAULT_PORT, bindHost?: string): Promise<void> {
    if (this.server !== null) return;
    this.startError = undefined;
    const certificate = await this.loadCertificate();
    const server = new CollabServer({
      certificate,
      codes: this.codes,
      registry: this.registry(),
      getHostIdentity: () => ({ ...this.deps.getHostIdentity(), certFingerprint: certificate.fingerprint }),
      onPendingJoin: () => this.deps.onChanged?.(),
      onJoinResolved: () => this.deps.onChanged?.(),
      onDeviceConnected: (session) => {
        this.deps.onSession?.(session);
        this.deps.onChanged?.();
      },
      onDeviceDisconnected: () => this.deps.onChanged?.(),
      now: () => this.now().getTime(),
    });
    try {
      const listening = await server.listen(port, bindHost);
      this.port = listening.port;
      this.server = server;
    } catch (error) {
      await server.close().catch(() => undefined);
      this.startError =
        error instanceof Error && /EADDRINUSE/.test(error.message)
          ? `Port ${port} is already in use. Close the other program or choose another port.`
          : `Could not start the device server: ${error instanceof Error ? error.message : String(error)}`;
      throw new Error(this.startError);
    } finally {
      this.deps.onChanged?.();
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = undefined;
    for (const code of this.codes.active()) this.codes.cancel(code.code);
    if (server !== null) await server.close();
    this.deps.onChanged?.();
  }

  issueCode(roleId: string): IssuedPairingCode {
    if (this.server === null) {
      throw new Error("Turn on \"Allow devices to connect\" first.");
    }
    if (!PAIRABLE_ROLES.some((role) => role.id === roleId)) {
      throw new Error(`Devices cannot be paired with the role "${roleId}".`);
    }
    const issued = this.codes.issue(roleId);
    this.deps.onChanged?.();
    return issued;
  }

  cancelCode(code: string): void {
    this.codes.cancel(code);
    this.deps.onChanged?.();
  }

  async approveJoin(joinId: string): Promise<void> {
    if (this.server === null) throw new Error("The device server is not running.");
    await this.server.approveJoin(joinId);
    this.deps.onChanged?.();
  }

  rejectJoin(joinId: string): void {
    this.server?.rejectJoin(joinId);
    this.deps.onChanged?.();
  }

  /** Removes a paired device: it is disconnected, refused from now on, and told to wipe its copy. */
  async removeDevice(deviceId: string): Promise<void> {
    const result = await this.deps.engine.submit(
      { type: "device.remove", payload: { deviceId } },
      this.deps.hostOwner,
    );
    if (!result.ok) {
      throw new Error(result.error?.message ?? "The device could not be removed.");
    }
    const removed = this.removedIds();
    removed.add(deviceId);
    this.deps.engine.writeMeta(REMOVED_META_KEY, JSON.stringify([...removed].sort()));
    this.server?.disconnect(deviceId);
    this.deps.onChanged?.();
  }

  async status(): Promise<DevicesStatus> {
    const state = this.deps.engine.getState();
    const connected: ConnectedDeviceInfo[] = this.server?.connected() ?? [];
    const pending: PendingJoin[] = this.server?.pendingJoins() ?? [];
    const pairableRoles: PairableRole[] = PAIRABLE_ROLES.map((role) => ({ id: role.id, name: role.name }));
    return {
      running: this.server !== null,
      ...(this.port !== undefined ? { port: this.port } : {}),
      addresses: this.server !== null ? lanAddresses() : [],
      ...(this.certificate !== null ? { hostFingerprint: this.certificate.fingerprint } : {}),
      ...(this.startError !== undefined ? { error: this.startError } : {}),
      codes: this.server !== null ? this.codes.active() : [],
      pendingJoins: pending,
      connected,
      devices: (state?.devices ?? []).map((device) => ({
        deviceId: device.id,
        name: device.name,
        roleId: device.role.id,
        roleName: device.role.name,
        approvedAt: device.approvedAt,
        connected: connected.some((c) => c.deviceId === device.id),
      })),
      succession: [...(state?.succession ?? [])],
      pairableRoles,
    };
  }

  private removedIds(): Set<string> {
    const raw = this.deps.engine.readMeta(REMOVED_META_KEY);
    if (raw === undefined) return new Set();
    try {
      const parsed = JSON.parse(raw) as unknown;
      return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
    } catch {
      return new Set();
    }
  }

  private registry(): DeviceRegistry {
    return {
      approve: async ({ deviceName, roleId, fingerprint }) => {
        const role = PAIRABLE_ROLES.find((candidate) => candidate.id === roleId);
        if (role === undefined) throw new Error(`Unknown role ${roleId}.`);
        const deviceId = `dev-${randomUUID()}`;
        const result = await this.deps.engine.submit(
          {
            type: "device.approve",
            payload: {
              device: {
                id: deviceId,
                name: deviceName,
                role,
                publicKey: `sha256:${fingerprint}`,
                approvedAt: this.now().toISOString(),
              },
            },
          },
          this.deps.hostOwner,
        );
        if (!result.ok) throw new Error(result.error?.message ?? "The device could not be approved.");
        return { deviceId, role };
      },
      lookup: (deviceId) => {
        const device = this.deps.engine.getState()?.devices.find((d) => d.id === deviceId);
        if (device === undefined) {
          return this.removedIds().has(deviceId)
            ? { fingerprint: "" as CertFingerprint, role: BUILT_IN_ROLES.display, removed: true }
            : undefined;
        }
        const fingerprint = device.publicKey.startsWith("sha256:") ? device.publicKey.slice("sha256:".length) : "";
        return { fingerprint, role: device.role, removed: false, name: device.name };
      },
    };
  }
}
