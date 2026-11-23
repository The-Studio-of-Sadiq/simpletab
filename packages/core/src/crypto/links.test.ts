import { describe, expect, it } from "vitest";
import { base32Encode } from "./encoding";
import {
  LINK_SECRET_BASE32_LENGTH,
  LINK_SECRET_BYTE_LENGTH,
  LOOKUP_ID_ALPHABET,
  LOOKUP_ID_LENGTH,
  LinkError,
  ROLE_TO_LETTER,
  buildLinkUrl,
  newLink,
  parseLink,
  type LinkRole,
} from "./links";

describe("private links", () => {
  const cdnHost = "wudc2027.pages.dev";
  const ballotsOrigin = "https://ballots.simpletab.org";
  const slug = "wudc-2027";

  it("generates and round-trips links for all three participant roles", () => {
    const roles: LinkRole[] = ["adjudicator", "team", "speaker"];
    const alphabetSet = new Set(LOOKUP_ID_ALPHABET);

    for (const role of roles) {
      const generated = newLink(role, cdnHost, ballotsOrigin, slug);
      expect(generated.role).toBe(role);
      expect(generated.slug).toBe(slug);
      expect(generated.cdnHost).toBe(cdnHost);
      expect(generated.secret).toBeInstanceOf(Uint8Array);
      expect(generated.secret.byteLength).toBe(LINK_SECRET_BYTE_LENGTH);
      expect(generated.lookupId.length).toBe(LOOKUP_ID_LENGTH);
      expect(generated.lookupId[0]).toBe(ROLE_TO_LETTER[role]);
      for (const ch of generated.lookupId.slice(1)) {
        expect(alphabetSet.has(ch)).toBe(true);
      }

      const encodedSecret = generated.url.split(".")[generated.url.split(".").length - 1]!;
      expect(encodedSecret.length).toBe(LINK_SECRET_BASE32_LENGTH);

      const parsed = parseLink(generated.url);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.slug).toBe(slug);
        expect(parsed.value.cdnHost).toBe(cdnHost);
        expect(parsed.value.lookupId).toBe(generated.lookupId);
        expect(parsed.value.role).toBe(role);
        expect(parsed.value.secret).toEqual(generated.secret);
      }
    }
  });

  it("buildLinkUrl normalizes trailing slash on origin and round-trips", () => {
    const secret = Uint8Array.from([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    const lookupId = "abcdefghjkmnp";
    const url = buildLinkUrl({
      ballotsOrigin: `${ballotsOrigin}/`,
      slug,
      cdnHost,
      lookupId,
      secret,
    });
    expect(url).toBe(
      `${ballotsOrigin}/t/${slug}#${cdnHost}~${lookupId}.${base32Encode(secret)}`,
    );

    const parsed = parseLink(url);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({
        slug,
        cdnHost,
        lookupId,
        role: "adjudicator",
        secret,
      });
    }
  });

  it("rejects malformed URLs, protocols, origins, paths, and slugs", () => {
    const valid = newLink("adjudicator", cdnHost, ballotsOrigin, slug);
    const fragment = valid.url.slice(valid.url.indexOf("#"));

    const invalidCases: Array<[string, string]> = [
      ["", "INVALID_URL"],
      ["not a url", "INVALID_URL"],
      [` ${valid.url}`, "INVALID_URL"],
      [`${valid.url}\n`, "INVALID_URL"],
      [`http://ballots.simpletab.org/t/${slug}${fragment}`, "INVALID_PROTOCOL"],
      [
        `https://user:pass@ballots.simpletab.org/t/${slug}${fragment}`,
        "INVALID_ORIGIN",
      ],
      [
        `https://ballots.simpletab.org/t/${slug}?foo=bar${fragment}`,
        "INVALID_PATH",
      ],
      [`https://ballots.simpletab.org/x/${slug}${fragment}`, "INVALID_PATH"],
      [
        `https://ballots.simpletab.org/t/${slug}/extra${fragment}`,
        "INVALID_PATH",
      ],
      [`https://ballots.simpletab.org/t/UpperCase${fragment}`, "INVALID_SLUG"],
      [`https://ballots.simpletab.org/t/-bad${fragment}`, "INVALID_SLUG"],
      [`https://ballots.simpletab.org/t/${slug}`, "INVALID_FRAGMENT"],
      [`https://ballots.simpletab.org/t/${slug}#`, "INVALID_FRAGMENT"],
    ];

    for (const [badUrl, expectedCode] of invalidCases) {
      const result = parseLink(badUrl);
      expect(result.ok, `Expected failure for ${badUrl}`).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(LinkError);
        expect(result.error.code).toBe(expectedCode);
      }
    }
  });

  it("strictly validates cdnHost against path, port, userinfo, IP, and malformed labels", () => {
    const valid = newLink("team", cdnHost, ballotsOrigin, slug);
    const credPart = valid.url.split("~")[1]!;
    const base = `${ballotsOrigin}/t/${slug}#`;

    const badHosts = [
      "wudc2027.pages.dev/path",
      "wudc2027.pages.dev:8443",
      "user@wudc2027.pages.dev",
      "user:pass@wudc2027.pages.dev",
      "WUDC2027.pages.dev",
      "wudc2027.pages.dev.",
      "localhost",
      "127.0.0.1",
      "[::1]",
      "-bad.pages.dev",
      "a..b.dev",
      "bad_host.pages.dev",
    ];

    for (const badHost of badHosts) {
      const parsed = parseLink(`${base}${badHost}~${credPart}`);
      expect(parsed.ok, `Expected bad cdnHost "${badHost}" to fail`).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe("INVALID_CDN_HOST");
      }
      expect(() =>
        newLink("team", badHost, ballotsOrigin, slug),
      ).toThrow(LinkError);
    }
  });

  it("strictly validates lookupId and canonical base32 secret", () => {
    const secret = new Uint8Array(16).fill(0xab);
    const secretB32 = base32Encode(secret);
    const base = `${ballotsOrigin}/t/${slug}#${cdnHost}~`;

    // Invalid role letter
    const badRole = parseLink(`${base}xbcdefghjkmnp.${secretB32}`);
    expect(badRole.ok).toBe(false);
    if (!badRole.ok) expect(badRole.error.code).toBe("INVALID_LOOKUP_ID");

    // Excluded characters from CrabbyTab's 31-char alphabet: i, l, o, 0, 1
    for (const forbidden of ["i", "l", "o", "0", "1", "A"]) {
      const badLookup = parseLink(
        `${base}a${forbidden}cdefghjkmnp.${secretB32}`,
      );
      expect(badLookup.ok).toBe(false);
      if (!badLookup.ok) expect(badLookup.error.code).toBe("INVALID_LOOKUP_ID");
    }

    // Wrong lookupId length
    const shortLookup = parseLink(`${base}abcdefgh.${secretB32}`);
    expect(shortLookup.ok).toBe(false);
    if (!shortLookup.ok) expect(shortLookup.error.code).toBe("INVALID_LOOKUP_ID");

    // Uppercase base32 secret
    const upperSecret = parseLink(
      `${base}abcdefghjkmnp.${secretB32.toUpperCase()}`,
    );
    expect(upperSecret.ok).toBe(false);
    if (!upperSecret.ok) expect(upperSecret.error.code).toBe("INVALID_SECRET");

    // Wrong secret length / padding
    const paddedSecret = parseLink(
      `${base}abcdefghjkmnp.${secretB32.slice(0, 25)}=`,
    );
    expect(paddedSecret.ok).toBe(false);
    if (!paddedSecret.ok) expect(paddedSecret.error.code).toBe("INVALID_SECRET");

    // Non-canonical trailing bits: 26 base32 chars = 130 bits, so the last 2
    // bits of the final char must be 0. Flipping the final char to 'b' (00001)
    // sets a non-zero trailing bit.
    const nonCanonical = `${secretB32.slice(0, 25)}b`;
    const badTrailing = parseLink(`${base}abcdefghjkmnp.${nonCanonical}`);
    expect(badTrailing.ok).toBe(false);
    if (!badTrailing.ok) expect(badTrailing.error.code).toBe("INVALID_SECRET");
  });
});
