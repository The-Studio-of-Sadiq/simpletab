import "reflect-metadata";
import { createHash, randomBytes } from "node:crypto";
import { PemConverter, X509CertificateGenerator } from "@peculiar/x509";
import type { CertFingerprint } from "../../common/collab-protocol";

/**
 * Self-signed P-256 X.509 certificates and SHA-256 DER fingerprints for LAN collaboration
 * (design section 4, amendment 7).
 */

export interface CollabCertificate {
  certPem: string;
  keyPem: string;
  fingerprint: CertFingerprint;
}

export interface GenerateCertificateOptions {
  commonName: string;
  now?: Date;
  validityDays?: number;
}

const DEFAULT_VALIDITY_DAYS = 365;
const CLOCK_SKEW_MARGIN_MS = 5 * 60_000;
const MS_PER_DAY = 86_400_000;

function positiveSerialHex(): string {
  const bytes = randomBytes(16);
  // ASN.1 INTEGER is signed; clear the high bit and avoid an all-zero leading byte.
  bytes[0] = (bytes[0]! & 0x7f) || 0x01;
  return bytes.toString("hex");
}

/**
 * Generates an extractable ECDSA P-256 key pair and a self-signed X.509 certificate suitable for
 * Node's `tls` and `https` modules.
 */
export async function generateSelfSignedCertificate(
  opts: GenerateCertificateOptions,
): Promise<CollabCertificate> {
  const commonName = opts.commonName.trim();
  if (commonName.length === 0) {
    throw new Error("Certificate common name must not be empty.");
  }

  const validityDays = opts.validityDays ?? DEFAULT_VALIDITY_DAYS;
  if (!Number.isFinite(validityDays) || validityDays <= 0) {
    throw new Error("Certificate validityDays must be a positive number.");
  }

  const nowMs = (opts.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("Certificate creation date must be valid.");
  }

  const keys = await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );

  const notBefore = new Date(nowMs - CLOCK_SKEW_MARGIN_MS);
  const notAfter = new Date(nowMs + validityDays * MS_PER_DAY);

  const cert = await X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: positiveSerialHex(),
      name: [{ CN: [commonName] }],
      keys,
      notBefore,
      notAfter,
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    },
    globalThis.crypto,
  );

  const pkcs8 = await globalThis.crypto.subtle.exportKey("pkcs8", keys.privateKey);
  const keyPem = PemConverter.encode(pkcs8, PemConverter.PrivateKeyTag);
  const certPem = cert.toString("pem");
  const fingerprint = certFingerprint(new Uint8Array(cert.rawData));

  return { certPem, keyPem, fingerprint };
}

/**
 * Computes the lowercase hex SHA-256 fingerprint of an X.509 certificate's DER bytes.
 * Accepts either a PEM string or raw DER bytes.
 */
export function certFingerprint(cert: string | Uint8Array): CertFingerprint {
  let der: Uint8Array;
  if (typeof cert === "string") {
    let blocks: ReturnType<typeof PemConverter.decodeWithHeaders>;
    try {
      blocks = PemConverter.decodeWithHeaders(cert);
    } catch {
      throw new Error("Certificate PEM is not valid.");
    }
    const certBlock = blocks.find(
      (block) => block.type === PemConverter.CertificateTag && block.rawData.byteLength > 0,
    );
    if (certBlock === undefined) {
      throw new Error("Certificate PEM does not contain a CERTIFICATE block.");
    }
    der = new Uint8Array(certBlock.rawData);
  } else {
    if (cert.byteLength === 0) {
      throw new Error("Certificate DER bytes must not be empty.");
    }
    der = cert;
  }

  return createHash("sha256").update(der).digest("hex");
}
