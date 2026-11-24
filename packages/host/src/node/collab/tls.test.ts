import * as nodeCrypto from "node:crypto";
import tls from "node:tls";
import { describe, expect, it } from "vitest";
import { certFingerprint, generateSelfSignedCertificate } from "./tls";

describe("collab TLS certificates", () => {
  it("generates a P-256 self-signed certificate whose fingerprint matches Node's X509Certificate", async () => {
    const fixedNow = new Date("2026-06-01T12:00:00.000Z");
    const generated = await generateSelfSignedCertificate({
      commonName: "Host, Tab #1 = Test",
      now: fixedNow,
      validityDays: 30,
    });

    expect(generated.certPem).toContain("-----BEGIN CERTIFICATE-----");
    expect(generated.keyPem).toContain("-----BEGIN PRIVATE KEY-----");
    expect(generated.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const parsed = new nodeCrypto.X509Certificate(generated.certPem);
    const nodeFingerprint = parsed.fingerprint256.replaceAll(":", "").toLowerCase();

    expect(generated.fingerprint).toBe(nodeFingerprint);
    expect(certFingerprint(generated.certPem)).toBe(generated.fingerprint);
    expect(certFingerprint(new Uint8Array(parsed.raw))).toBe(generated.fingerprint);

    expect(parsed.subject).toBe("CN=Host\\, Tab #1 = Test");
    expect(parsed.validFromDate.getTime()).toBe(fixedNow.getTime() - 5 * 60_000);
    expect(parsed.validToDate.getTime()).toBe(fixedNow.getTime() + 30 * 86_400_000);
  });

  it("works with a real node:tls server and client handshake", async () => {
    const serverCert = await generateSelfSignedCertificate({ commonName: "host" });
    const clientCert = await generateSelfSignedCertificate({ commonName: "device" });

    let serverObservedClientFp: string | undefined;

    const server = tls.createServer(
      {
        cert: serverCert.certPem,
        key: serverCert.keyPem,
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
      },
      (socket) => {
        const peer = socket.getPeerCertificate(true);
        if (peer.raw && peer.raw.byteLength > 0) {
          serverObservedClientFp = certFingerprint(peer.raw);
        }
        socket.end("ok");
      },
    );

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected numeric port");
      }

      const { clientObservedServerFp, payload } = await new Promise<{
        clientObservedServerFp: string;
        payload: string;
      }>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let observed = "";
        const socket = tls.connect(
          {
            host: "127.0.0.1",
            port: address.port,
            cert: clientCert.certPem,
            key: clientCert.keyPem,
            rejectUnauthorized: false,
            minVersion: "TLSv1.3",
            checkServerIdentity: () => undefined,
          },
          () => {
            const peer = socket.getPeerCertificate(true);
            observed = certFingerprint(peer.raw);
          },
        );
        socket.on("data", (chunk) => chunks.push(chunk));
        socket.on("end", () => {
          resolve({
            clientObservedServerFp: observed,
            payload: Buffer.concat(chunks).toString("utf8"),
          });
        });
        socket.on("error", reject);
      });

      expect(payload).toBe("ok");
      expect(clientObservedServerFp).toBe(serverCert.fingerprint);
      expect(serverObservedClientFp).toBe(clientCert.fingerprint);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects invalid certificate inputs", async () => {
    await expect(generateSelfSignedCertificate({ commonName: "   " })).rejects.toThrow();
    await expect(
      generateSelfSignedCertificate({ commonName: "host", validityDays: 0 }),
    ).rejects.toThrow();
    expect(() => certFingerprint("not a pem")).toThrow();
    expect(() => certFingerprint(new Uint8Array())).toThrow();
  });
});
