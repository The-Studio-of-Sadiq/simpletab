import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Role } from "@simpletab/core/permissions";
import type { CertFingerprint, HostIdentity } from "../../common/collab-protocol";
import type { CollabCertificate } from "../collab/tls";

/**
 * Where a staff device keeps its pairing with a host (design section 4.1): the host address, the
 * pinned host certificate fingerprint, its own certificate and private key, its id and role.
 *
 * It lives outside any tournament workspace (default `~/.simpletab/devices`, or
 * `SIMPLETAB_DEVICE_DIR`), so the git panel never sees the private key. The file is written with
 * owner-only permissions where the platform supports them. A laptop holds one pairing at a time.
 */

export const PAIRING_FILE_NAME = "pairing.json";
/** The best host this laptop has seen (number, then rank). Kept across leaving and re-pairing. */
export const BEST_HOST_FILE_NAME = "best-host.json";

export interface StoredPairing {
  version: 1;
  /** `wss://host:port` */
  url: string;
  deviceId: string;
  deviceName: string;
  role: Role;
  hostFingerprint: CertFingerprint;
  host: HostIdentity;
  certificate: CollabCertificate;
  pairedAt: string;
}

export function defaultDeviceDir(): string {
  const override = process.env.SIMPLETAB_DEVICE_DIR;
  return override !== undefined && override.trim().length > 0
    ? override
    : path.join(os.homedir(), ".simpletab", "devices");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStoredPairing(value: unknown): value is StoredPairing {
  if (!isRecord(value) || value.version !== 1) return false;
  const cert = value.certificate;
  const host = value.host;
  const role = value.role;
  return (
    typeof value.url === "string" &&
    value.url.startsWith("wss://") &&
    typeof value.deviceId === "string" &&
    typeof value.deviceName === "string" &&
    typeof value.hostFingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(value.hostFingerprint) &&
    typeof value.pairedAt === "string" &&
    isRecord(cert) &&
    typeof cert.certPem === "string" &&
    typeof cert.keyPem === "string" &&
    typeof cert.fingerprint === "string" &&
    isRecord(host) &&
    typeof host.hostNumber === "number" &&
    typeof host.hostId === "string" &&
    typeof host.hostRank === "number" &&
    isRecord(role) &&
    typeof role.id === "string" &&
    Array.isArray(role.permissions)
  );
}

export class PairingStore {
  constructor(private readonly dir: string = defaultDeviceDir()) {}

  get directory(): string {
    return this.dir;
  }

  loadBestHost(): HostIdentity | undefined {
    const file = path.join(this.dir, BEST_HOST_FILE_NAME);
    if (!existsSync(file)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (
        isRecord(parsed) &&
        typeof parsed.hostNumber === "number" &&
        typeof parsed.hostRank === "number" &&
        typeof parsed.hostId === "string" &&
        typeof parsed.certFingerprint === "string"
      ) {
        return parsed as unknown as HostIdentity;
      }
    } catch {
      // A damaged file is treated as no knowledge.
    }
    return undefined;
  }

  saveBestHost(host: HostIdentity): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(path.join(this.dir, BEST_HOST_FILE_NAME), JSON.stringify(host), "utf8");
  }

  private get file(): string {
    return path.join(this.dir, PAIRING_FILE_NAME);
  }

  load(): StoredPairing | undefined {
    if (!existsSync(this.file)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return isStoredPairing(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  save(pairing: StoredPairing): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file, JSON.stringify(pairing), { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // Windows ignores POSIX modes; the folder is in the user's own profile.
    }
  }

  /** Deletes the pairing (leaving a host, or told by the host that this device was removed). */
  clear(): void {
    rmSync(this.file, { force: true });
  }
}
