/**
 * Private participant link creation, serialization, and strict parsing
 * (design section 8).
 *
 * Link format:
 *   https://<ballots-domain>/t/<slug>#<cdnHost>~<lookupId>.<secret>
 *
 * Security notes:
 * - Everything after `#` stays in the browser fragment and is never sent to
 *   the ballots server or CDN in HTTP requests.
 * - `secret` provides 128 bits of cryptographic entropy from WebCrypto CSPRNG,
 *   encoded as 26 lowercase RFC 4648 base32 characters.
 * - `cdnHost` is strictly validated as a bare DNS hostname (no path, port,
 *   userinfo, query, or IP literal) so a crafted fragment cannot redirect the
 *   phone app to an arbitrary URL path or credentialed origin.
 * - `lookupId` reuses CrabbyTab's 31-character generator (`generatePrivateKey`)
 *   prefixed with the single role letter (`a`, `t`, or `s`).
 */

import { generatePrivateKey } from "@/lib/privateUrls";
import { base32Decode, base32Encode } from "./encoding";

/**
 * Matches CrabbyTab's unambiguous 31-character alphabet in `lib/privateUrls.ts`
 * (which is not exported from that file).
 */
export const LOOKUP_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export const LINK_SECRET_BYTE_LENGTH = 16;
export const LINK_SECRET_BASE32_LENGTH = 26;
export const LOOKUP_ID_LENGTH = 13;

export type LinkRole = "adjudicator" | "team" | "speaker";
export type LinkRoleLetter = "a" | "t" | "s";

export const ROLE_TO_LETTER: Readonly<Record<LinkRole, LinkRoleLetter>> = {
  adjudicator: "a",
  team: "t",
  speaker: "s",
};

export const LETTER_TO_ROLE: Readonly<Record<LinkRoleLetter, LinkRole>> = {
  a: "adjudicator",
  t: "team",
  s: "speaker",
};

export type LinkErrorCode =
  | "INVALID_URL"
  | "INVALID_PROTOCOL"
  | "INVALID_ORIGIN"
  | "INVALID_PATH"
  | "INVALID_SLUG"
  | "INVALID_FRAGMENT"
  | "INVALID_CDN_HOST"
  | "INVALID_LOOKUP_ID"
  | "INVALID_ROLE"
  | "INVALID_SECRET";

export class LinkError extends Error {
  readonly code: LinkErrorCode;

  constructor(code: LinkErrorCode, message: string) {
    super(message);
    this.name = "LinkError";
    this.code = code;
  }
}

export interface ParsedLink {
  slug: string;
  cdnHost: string;
  lookupId: string;
  role: LinkRole;
  secret: Uint8Array;
}

export interface GeneratedLink extends ParsedLink {
  url: string;
}

export interface BuildLinkUrlParams {
  ballotsOrigin: string;
  slug: string;
  cdnHost: string;
  lookupId: string;
  secret: Uint8Array;
}

export type ParseLinkResult =
  | { ok: true; value: ParsedLink }
  | { ok: false; error: LinkError };

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const DNS_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ALL_DIGITS_REGEX = /^[0-9]+$/;
const LOOKUP_ID_SUFFIX_SET = new Set(LOOKUP_ID_ALPHABET);

function validateSlug(slug: string): LinkError | null {
  if (typeof slug !== "string" || !SLUG_REGEX.test(slug)) {
    return new LinkError(
      "INVALID_SLUG",
      "Tournament slug must be 1–64 lowercase ASCII letters, digits, or hyphens, starting and ending with an alphanumeric character.",
    );
  }
  return null;
}

function validateCdnHost(cdnHost: string): LinkError | null {
  if (
    typeof cdnHost !== "string" ||
    cdnHost.length === 0 ||
    cdnHost.length > 253
  ) {
    return new LinkError(
      "INVALID_CDN_HOST",
      "CDN host must be a non-empty DNS hostname up to 253 characters.",
    );
  }

  // Reject path, port, userinfo, query, fragment, whitespace, and trailing dot.
  if (/[/:?#@\s\\]/.test(cdnHost) || cdnHost.endsWith(".")) {
    return new LinkError(
      "INVALID_CDN_HOST",
      "CDN host must be a bare hostname with no path, port, or userinfo.",
    );
  }

  const labels = cdnHost.split(".");
  if (labels.length < 2) {
    return new LinkError(
      "INVALID_CDN_HOST",
      "CDN host must contain at least two DNS labels.",
    );
  }

  for (const label of labels) {
    if (!DNS_LABEL_REGEX.test(label)) {
      return new LinkError(
        "INVALID_CDN_HOST",
        `Invalid DNS label "${label}" in CDN host.`,
      );
    }
  }

  // Disallow IPv4 literals (all-numeric TLD per RFC 3696 §2).
  if (ALL_DIGITS_REGEX.test(labels[labels.length - 1]!)) {
    return new LinkError(
      "INVALID_CDN_HOST",
      "CDN host must be a DNS hostname, not an IP address.",
    );
  }

  // Cross-check with the URL parser to ensure canonical hostname round-trip.
  try {
    const check = new URL(`https://${cdnHost}`);
    if (
      check.hostname !== cdnHost ||
      check.port !== "" ||
      check.username !== "" ||
      check.password !== "" ||
      check.pathname !== "/" ||
      check.search !== "" ||
      check.hash !== ""
    ) {
      return new LinkError(
        "INVALID_CDN_HOST",
        "CDN host is not a canonical bare hostname.",
      );
    }
  } catch {
    return new LinkError("INVALID_CDN_HOST", "CDN host failed URL validation.");
  }

  return null;
}

function validateBallotsOrigin(
  ballotsOrigin: string,
): { origin: string; error: null } | { origin: null; error: LinkError } {
  if (typeof ballotsOrigin !== "string" || ballotsOrigin.trim() !== ballotsOrigin) {
    return {
      origin: null,
      error: new LinkError("INVALID_ORIGIN", "Ballots origin must be a valid HTTPS origin."),
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(ballotsOrigin);
  } catch {
    return {
      origin: null,
      error: new LinkError("INVALID_ORIGIN", "Ballots origin is not a valid URL."),
    };
  }

  if (parsed.protocol !== "https:") {
    return {
      origin: null,
      error: new LinkError("INVALID_PROTOCOL", "Ballots origin must use https:."),
    };
  }

  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== "/" ||
    parsed.hostname.length === 0
  ) {
    return {
      origin: null,
      error: new LinkError(
        "INVALID_ORIGIN",
        "Ballots origin must not include userinfo, path, query, or fragment.",
      ),
    };
  }

  // Reject extra path segments like "https://example.com//"
  const normalized = parsed.origin;
  if (ballotsOrigin !== normalized && ballotsOrigin !== `${normalized}/`) {
    return {
      origin: null,
      error: new LinkError(
        "INVALID_ORIGIN",
        "Ballots origin must be a bare https:// origin.",
      ),
    };
  }

  return { origin: normalized, error: null };
}

function parseLookupId(
  lookupId: string,
): { role: LinkRole; error: null } | { role: null; error: LinkError } {
  if (typeof lookupId !== "string" || lookupId.length !== LOOKUP_ID_LENGTH) {
    return {
      role: null,
      error: new LinkError(
        "INVALID_LOOKUP_ID",
        `Lookup ID must be exactly ${LOOKUP_ID_LENGTH} characters.`,
      ),
    };
  }

  const prefix = lookupId[0] as LinkRoleLetter;
  const role = LETTER_TO_ROLE[prefix];
  if (!role) {
    return {
      role: null,
      error: new LinkError(
        "INVALID_LOOKUP_ID",
        "Lookup ID must start with role letter 'a', 't', or 's'.",
      ),
    };
  }

  for (let i = 1; i < lookupId.length; i++) {
    if (!LOOKUP_ID_SUFFIX_SET.has(lookupId[i]!)) {
      return {
        role: null,
        error: new LinkError(
          "INVALID_LOOKUP_ID",
          "Lookup ID contains characters outside the allowed 31-character alphabet.",
        ),
      };
    }
  }

  return { role, error: null };
}

/**
 * Serializes validated private-link components into the canonical section 8 URL.
 * Throws `LinkError` if any component fails strict validation.
 */
export function buildLinkUrl(params: BuildLinkUrlParams): string {
  const originCheck = validateBallotsOrigin(params.ballotsOrigin);
  if (originCheck.error) throw originCheck.error;

  const slugError = validateSlug(params.slug);
  if (slugError) throw slugError;

  const cdnError = validateCdnHost(params.cdnHost);
  if (cdnError) throw cdnError;

  const lookupCheck = parseLookupId(params.lookupId);
  if (lookupCheck.error) throw lookupCheck.error;

  if (
    !(params.secret instanceof Uint8Array) ||
    params.secret.byteLength !== LINK_SECRET_BYTE_LENGTH
  ) {
    throw new LinkError(
      "INVALID_SECRET",
      `Link secret must be a ${LINK_SECRET_BYTE_LENGTH}-byte Uint8Array.`,
    );
  }

  const encodedSecret = base32Encode(params.secret);
  return `${originCheck.origin}/t/${params.slug}#${params.cdnHost}~${params.lookupId}.${encodedSecret}`;
}

/**
 * Generates a fresh private link with a 128-bit CSPRNG secret and a
 * role-prefixed lookup ID.
 * Throws `LinkError` if `role`, `cdnHost`, `ballotsOrigin`, or `slug` is invalid.
 */
export function newLink(
  role: LinkRole,
  cdnHost: string,
  ballotsOrigin: string,
  slug: string,
): GeneratedLink {
  const roleLetter = ROLE_TO_LETTER[role];
  if (!roleLetter) {
    throw new LinkError(
      "INVALID_ROLE",
      `Unsupported link role "${String(role)}".`,
    );
  }

  const secret = new Uint8Array(new ArrayBuffer(LINK_SECRET_BYTE_LENGTH));
  globalThis.crypto.getRandomValues(secret);

  const lookupId = `${roleLetter}${generatePrivateKey()}`;
  const url = buildLinkUrl({
    ballotsOrigin,
    slug,
    cdnHost,
    lookupId,
    secret,
  });

  return {
    url,
    slug,
    cdnHost,
    lookupId,
    role,
    secret,
  };
}

/**
 * Strictly parses and validates a section 8 private link URL.
 * Returns `{ ok: true, value }` or `{ ok: false, error }` with a typed `LinkError`.
 */
export function parseLink(url: string): ParseLinkResult {
  if (typeof url !== "string" || url.length === 0 || url.trim() !== url) {
    return {
      ok: false,
      error: new LinkError("INVALID_URL", "Link must be a non-empty URL string without surrounding whitespace."),
    };
  }

  // Reject ASCII control characters anywhere in the raw URL string.
  for (let i = 0; i < url.length; i++) {
    const code = url.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return {
        ok: false,
        error: new LinkError("INVALID_URL", "Link contains control characters."),
      };
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      error: new LinkError("INVALID_URL", "Link is not a valid URL."),
    };
  }

  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      error: new LinkError("INVALID_PROTOCOL", "Private links must use https:."),
    };
  }

  if (parsed.username !== "" || parsed.password !== "") {
    return {
      ok: false,
      error: new LinkError("INVALID_ORIGIN", "Private links must not contain userinfo."),
    };
  }

  if (parsed.search !== "") {
    return {
      ok: false,
      error: new LinkError("INVALID_PATH", "Private links must not contain query parameters."),
    };
  }

  const pathSegments = parsed.pathname.split("/");
  if (
    pathSegments.length !== 3 ||
    pathSegments[0] !== "" ||
    pathSegments[1] !== "t"
  ) {
    return {
      ok: false,
      error: new LinkError("INVALID_PATH", "Private link path must match /t/<slug>."),
    };
  }

  const slug = pathSegments[2]!;
  const slugError = validateSlug(slug);
  if (slugError) {
    return { ok: false, error: slugError };
  }

  if (!parsed.hash.startsWith("#") || parsed.hash.length <= 1) {
    return {
      ok: false,
      error: new LinkError("INVALID_FRAGMENT", "Private link is missing its fragment."),
    };
  }

  const fragment = parsed.hash.slice(1);
  const tildeParts = fragment.split("~");
  if (tildeParts.length !== 2) {
    return {
      ok: false,
      error: new LinkError(
        "INVALID_FRAGMENT",
        "Fragment must have format <cdnHost>~<lookupId>.<secret>.",
      ),
    };
  }

  const cdnHost = tildeParts[0]!;
  const cdnError = validateCdnHost(cdnHost);
  if (cdnError) {
    return { ok: false, error: cdnError };
  }

  const credentialParts = tildeParts[1]!.split(".");
  if (credentialParts.length !== 2) {
    return {
      ok: false,
      error: new LinkError(
        "INVALID_FRAGMENT",
        "Fragment credential part must have format <lookupId>.<secret>.",
      ),
    };
  }

  const lookupId = credentialParts[0]!;
  const lookupCheck = parseLookupId(lookupId);
  if (lookupCheck.error) {
    return { ok: false, error: lookupCheck.error };
  }

  const secretEncoded = credentialParts[1]!;
  if (secretEncoded.length !== LINK_SECRET_BASE32_LENGTH) {
    return {
      ok: false,
      error: new LinkError(
        "INVALID_SECRET",
        `Encoded secret must be exactly ${LINK_SECRET_BASE32_LENGTH} base32 characters.`,
      ),
    };
  }

  const secret = base32Decode(secretEncoded);
  if (!secret || secret.byteLength !== LINK_SECRET_BYTE_LENGTH) {
    return {
      ok: false,
      error: new LinkError(
        "INVALID_SECRET",
        "Secret is not valid canonical lowercase base32.",
      ),
    };
  }

  return {
    ok: true,
    value: {
      slug,
      cdnHost,
      lookupId,
      role: lookupCheck.role,
      secret,
    },
  };
}
