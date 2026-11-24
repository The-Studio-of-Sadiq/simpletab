import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  CREDENTIAL_NAMES,
  CredentialsFetchError,
  type CredentialName,
  type CredentialStatusEntry,
  type CredentialTestResult,
  type CredentialsFetchName,
  type CredentialsFetchRequest,
  type CredentialsFetchResponse,
  type CredentialsService,
  type SmtpCredentialPayload,
} from "../common/credentials-protocol";

export interface CredentialsStorageBackend {
  getStorageDir(): string;
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
  fetchImpl?: typeof fetch;
  defaultServiceBaseUrl?: string;
}

interface CredentialMetaRecord {
  testedAt?: string;
  ok?: boolean;
  error?: string;
}

type CredentialMetadataMap = Partial<Record<CredentialName, CredentialMetaRecord>>;

const TOKEN_MIN_LENGTH = 16;
const GITHUB_TOKEN_RE = /^[A-Za-z0-9_-]{16,}$/;
const EMAIL_ADDRESS_RE = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
const DISPLAY_EMAIL_RE = /^[^<>]+<\s*([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)\s*>$/;
const DEFAULT_BALLOTS_BASE_URL = "https://ballots.simpletab.org";
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const ALLOWED_HTTP_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);

function resolveServiceUrl(
  baseUrlInput: string | undefined,
  reqPath: string,
): string {
  if (
    typeof reqPath !== "string" ||
    !reqPath.startsWith("/") ||
    reqPath.startsWith("//") ||
    /[\r\n\0]/.test(reqPath)
  ) {
    throw new CredentialsFetchError(
      "INVALID_REQUEST",
      "Service request path must start with a single '/'.",
    );
  }
  const rawBase =
    baseUrlInput && baseUrlInput.trim().length > 0
      ? baseUrlInput.trim()
      : process.env.SIMPLETAB_BALLOTS_URL ?? DEFAULT_BALLOTS_BASE_URL;

  let parsedBase: URL;
  try {
    parsedBase = new URL(rawBase);
  } catch {
    throw new CredentialsFetchError(
      "INVALID_REQUEST",
      "Invalid ballots service base URL.",
    );
  }

  const isLocalDev =
    parsedBase.protocol === "http:" &&
    (parsedBase.hostname === "localhost" ||
      parsedBase.hostname === "127.0.0.1" ||
      parsedBase.hostname === "[::1]");
  if (parsedBase.protocol !== "https:" && !isLocalDev) {
    throw new CredentialsFetchError(
      "INVALID_REQUEST",
      "Ballots service URL must use https:.",
    );
  }
  if (parsedBase.username !== "" || parsedBase.password !== "") {
    throw new CredentialsFetchError(
      "INVALID_REQUEST",
      "Ballots service URL must not contain credentials.",
    );
  }

  const origin = parsedBase.origin;
  const target = new URL(reqPath, `${origin}/`);
  if (target.origin !== origin) {
    throw new CredentialsFetchError(
      "INVALID_REQUEST",
      "Service request path must not change target origin.",
    );
  }
  return target.toString();
}

function assertCredentialName(name: string): asserts name is CredentialName {
  if (!CREDENTIAL_NAMES.includes(name as CredentialName)) {
    throw new Error(`Unknown credential name: "${name}".`);
  }
}

function isValidEmailAddress(value: string): boolean {
  const trimmed = value.trim();
  if (EMAIL_ADDRESS_RE.test(trimmed)) {
    return true;
  }
  const match = DISPLAY_EMAIL_RE.exec(trimmed);
  return match !== null && EMAIL_ADDRESS_RE.test(match[1] ?? "");
}

function validateSmtpCredential(decrypted: string): CredentialTestResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypted);
  } catch {
    return { ok: false, error: "SMTP configuration is not valid JSON." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "SMTP configuration must be an object." };
  }
  const smtp = parsed as Partial<SmtpCredentialPayload>;
  if (
    typeof smtp.host !== "string" ||
    smtp.host.trim().length === 0 ||
    /\s/.test(smtp.host.trim())
  ) {
    return { ok: false, error: "SMTP host must be a non-empty hostname." };
  }
  if (
    typeof smtp.port !== "number" ||
    !Number.isInteger(smtp.port) ||
    smtp.port < 1 ||
    smtp.port > 65535
  ) {
    return { ok: false, error: "SMTP port must be an integer between 1 and 65535." };
  }
  if (typeof smtp.user !== "string" || smtp.user.trim().length === 0) {
    return { ok: false, error: "SMTP username must not be empty." };
  }
  if (typeof smtp.password !== "string" || smtp.password.length === 0) {
    return { ok: false, error: "SMTP password must not be empty." };
  }
  if (typeof smtp.from !== "string" || !isValidEmailAddress(smtp.from)) {
    return { ok: false, error: "SMTP From address must be a valid email address." };
  }
  return { ok: true };
}

/**
 * Validates stored credential format offline without making network calls or echoing secrets.
 */
export function validateCredentialFormat(
  name: CredentialName,
  decrypted: string,
): CredentialTestResult {
  if (decrypted.length === 0) {
    return { ok: false, error: "Stored credential is empty." };
  }
  if (name === "smtp") {
    return validateSmtpCredential(decrypted);
  }
  const trimmed = decrypted.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Stored credential must not be blank." };
  }
  if (/\s/.test(trimmed)) {
    return { ok: false, error: "Token must not contain whitespace." };
  }
  if (trimmed.length < TOKEN_MIN_LENGTH) {
    return {
      ok: false,
      error: `Token appears too short (minimum ${TOKEN_MIN_LENGTH} characters).`,
    };
  }
  if (name === "githubToken" && !GITHUB_TOKEN_RE.test(trimmed)) {
    return {
      ok: false,
      error: "GitHub token must use letters, digits, hyphens, or underscores.",
    };
  }
  return { ok: true };
}

export class CredentialsVault implements CredentialsService {
  constructor(private readonly backend: CredentialsStorageBackend) {}

  async status(): Promise<CredentialStatusEntry[]> {
    const metadata = this.readMetadata();
    return CREDENTIAL_NAMES.map((name) => {
      const hasSecret = existsSync(this.blobPath(name));
      const record = metadata[name];
      return {
        name,
        set: hasSecret,
        ...(record?.testedAt !== undefined ? { testedAt: record.testedAt } : {}),
        ...(record?.ok !== undefined ? { ok: record.ok } : {}),
        ...(record?.error !== undefined ? { error: record.error } : {}),
      };
    });
  }

  async set(name: CredentialName, value: string): Promise<void> {
    assertCredentialName(name);
    if (value.length === 0) {
      throw new Error("Credential value must not be empty.");
    }
    if (!this.backend.isEncryptionAvailable()) {
      throw new Error("Electron safeStorage encryption is unavailable on this host.");
    }
    this.ensureStorageDir();
    const encrypted = this.backend.encryptString(value);
    writeFileSync(this.blobPath(name), encrypted, { mode: 0o600 });

    const metadata = this.readMetadata();
    delete metadata[name];
    this.writeMetadata(metadata);
  }

  async clear(name: CredentialName): Promise<void> {
    assertCredentialName(name);
    rmSync(this.blobPath(name), { force: true });
    const metadata = this.readMetadata();
    if (name in metadata) {
      delete metadata[name];
      this.writeMetadata(metadata);
    }
  }

  async test(name: CredentialName): Promise<CredentialTestResult> {
    assertCredentialName(name);
    const blobFile = this.blobPath(name);
    const testedAt = new Date().toISOString();
    if (!existsSync(blobFile)) {
      const result: CredentialTestResult = {
        ok: false,
        error: "Credential is not set.",
      };
      this.recordTestResult(name, testedAt, result);
      return result;
    }
    if (!this.backend.isEncryptionAvailable()) {
      const result: CredentialTestResult = {
        ok: false,
        error: "Electron safeStorage encryption is unavailable.",
      };
      this.recordTestResult(name, testedAt, result);
      return result;
    }

    try {
      const encrypted = readFileSync(blobFile);
      const decrypted = this.backend.decryptString(encrypted);
      const result = validateCredentialFormat(name, decrypted);
      this.recordTestResult(name, testedAt, result);
      return result;
    } catch {
      const result: CredentialTestResult = {
        ok: false,
        error: "Unable to decrypt stored credential.",
      };
      this.recordTestResult(name, testedAt, result);
      return result;
    }
  }

  async fetch(
    name: CredentialsFetchName,
    req: CredentialsFetchRequest,
  ): Promise<CredentialsFetchResponse> {
    if (name !== "tournamentKey") {
      throw new CredentialsFetchError(
        "INVALID_REQUEST",
        `Unsupported credential fetch target: "${String(name)}".`,
      );
    }
    if (!ALLOWED_HTTP_METHODS.has(req.method)) {
      throw new CredentialsFetchError(
        "INVALID_REQUEST",
        `Unsupported HTTP method: "${String(req.method)}".`,
      );
    }

    const url = resolveServiceUrl(
      req.baseUrl ?? this.backend.defaultServiceBaseUrl,
      req.path,
    );

    const headers: Record<string, string> = {};
    if (req.headers !== undefined) {
      for (const [key, value] of Object.entries(req.headers)) {
        if (key.toLowerCase() === "authorization") {
          continue;
        }
        headers[key] = value;
      }
    }

    if (req.hostHeaders !== undefined) {
      headers["X-Host-Number"] = String(req.hostHeaders.hostNumber);
      headers["X-Host-Id"] = req.hostHeaders.hostId;
      headers["X-Host-Rank"] = String(req.hostHeaders.hostRank);
      if (
        typeof req.hostHeaders.requestId === "string" &&
        req.hostHeaders.requestId.length > 0
      ) {
        headers["X-Request-Id"] = req.hostHeaders.requestId;
      }
    }

    if (req.authenticated !== false) {
      const secret = this.readDecryptedSecret(name).trim();
      if (secret.length === 0) {
        throw new CredentialsFetchError(
          "CREDENTIAL_NOT_SET",
          "Tournament key is empty.",
        );
      }
      headers.Authorization = `Bearer ${secret}`;
    }

    const fetchImpl = this.backend.fetchImpl ?? globalThis.fetch;
    const timeoutMs =
      typeof req.timeoutMs === "number" &&
      Number.isFinite(req.timeoutMs) &&
      req.timeoutMs > 0
        ? req.timeoutMs
        : DEFAULT_FETCH_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }

    try {
      const response = await fetchImpl(url, {
        method: req.method,
        headers,
        ...(req.body !== undefined ? { body: req.body } : {}),
        signal: controller.signal,
      });
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key.toLowerCase()] = value;
      });
      const body = await response.text();
      return {
        status: response.status,
        headers: responseHeaders,
        body,
      };
    } catch (error) {
      if (error instanceof CredentialsFetchError) {
        throw error;
      }
      const message =
        error instanceof Error && error.name === "AbortError"
          ? `Request timed out after ${timeoutMs} ms.`
          : error instanceof Error
            ? error.message
            : "Network request failed.";
      throw new CredentialsFetchError("NETWORK_ERROR", message);
    } finally {
      clearTimeout(timer);
    }
  }

  private readDecryptedSecret(name: CredentialName): string {
    const blobFile = this.blobPath(name);
    if (!existsSync(blobFile)) {
      throw new CredentialsFetchError(
        "CREDENTIAL_NOT_SET",
        `Credential "${name}" is not set.`,
      );
    }
    if (!this.backend.isEncryptionAvailable()) {
      throw new CredentialsFetchError(
        "ENCRYPTION_UNAVAILABLE",
        "Electron safeStorage encryption is unavailable.",
      );
    }
    try {
      const encrypted = readFileSync(blobFile);
      return this.backend.decryptString(encrypted);
    } catch {
      throw new CredentialsFetchError(
        "DECRYPT_FAILED",
        `Unable to decrypt stored credential "${name}".`,
      );
    }
  }

  private blobPath(name: CredentialName): string {
    return path.join(this.backend.getStorageDir(), `${name}.enc`);
  }

  private metadataPath(): string {
    return path.join(this.backend.getStorageDir(), "metadata.json");
  }

  private ensureStorageDir(): void {
    mkdirSync(this.backend.getStorageDir(), { recursive: true });
  }

  private readMetadata(): CredentialMetadataMap {
    const file = this.metadataPath();
    if (!existsSync(file)) {
      return {};
    }
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as CredentialMetadataMap;
      return parsed ?? {};
    } catch {
      return {};
    }
  }

  private writeMetadata(metadata: CredentialMetadataMap): void {
    this.ensureStorageDir();
    writeFileSync(this.metadataPath(), JSON.stringify(metadata, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  private recordTestResult(
    name: CredentialName,
    testedAt: string,
    result: CredentialTestResult,
  ): void {
    const metadata = this.readMetadata();
    metadata[name] = {
      testedAt,
      ok: result.ok,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
    this.writeMetadata(metadata);
  }
}
