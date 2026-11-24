import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  acceptsSchema,
  parseAck,
  parseHead,
  parseInboxPage,
  parseKeyRequest,
  parsePermitUpload,
  parseStatusResponse,
  parseSubmission,
} from "./messages";

const VALID_ULID = "01JDF4Z7N0P9Q8R7S6T5V4W3X2";
const VALID_LOOKUP_ID = "aabcdefghjkmn";
const VALID_HEX64 = "0123456789abcdef".repeat(4);
const VALID_TS = "2026-11-23T14:00:00.000Z";

function expectFieldError(
  result: { ok: boolean; errors?: string[] },
  prefix: string,
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors?.some((e) => e.startsWith(prefix))).toBe(true);
  }
}

describe("wire schema version helper", () => {
  it("accepts only schema 1 while SCHEMA_VERSION is 1", () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(acceptsSchema(1)).toBe(true);
    expect(acceptsSchema(0)).toBe(false);
    expect(acceptsSchema(2)).toBe(false);
    expect(acceptsSchema("1")).toBe(false);
  });
});

describe("wire message parsers", () => {
  it("parses valid PermitUpload and ignores extra fields", () => {
    const input = {
      schema: 1,
      roundId: "round-1",
      version: 3,
      open: true,
      ballotDeadline: VALID_TS,
      feedbackDeadline: "2026-11-23T15:00:00.000Z",
      timeZone: "Asia/Dhaka",
      entries: [
        {
          lookupId: VALID_LOOKUP_ID,
          verifier: VALID_HEX64,
          roomId: "room-101",
          forms: ["ballot", "feedback"],
          ignoredEntryField: 42,
        },
      ],
      ignoredTopField: "hello",
    };

    const parsed = parsePermitUpload(input);
    expect(parsed).toEqual({
      ok: true,
      value: {
        schema: 1,
        roundId: "round-1",
        version: 3,
        open: true,
        ballotDeadline: VALID_TS,
        feedbackDeadline: "2026-11-23T15:00:00.000Z",
        timeZone: "Asia/Dhaka",
        entries: [
          {
            lookupId: VALID_LOOKUP_ID,
            verifier: VALID_HEX64,
            roomId: "room-101",
            forms: ["ballot", "feedback"],
          },
        ],
      },
    });
  });

  it("parses PermitUpload with UTC timeZone and no optional deadlines", () => {
    const parsed = parsePermitUpload({
      schema: 1,
      roundId: "round-2",
      version: 1,
      open: false,
      timeZone: "UTC",
      entries: [
        {
          lookupId: "t23456789abcd",
          verifier: VALID_HEX64,
          roomId: "room-2",
          forms: ["checkin"],
        },
      ],
    });
    expect(parsed.ok).toBe(true);
  });

  it("accepts an optional non-negative scanned watermark on InboxPage and rejects bad ones", () => {
    expect(parseInboxPage({ schema: 1, items: [], next: null, scanned: 40 })).toEqual({
      ok: true,
      value: { schema: 1, items: [], next: null, scanned: 40 },
    });
    expect(parseInboxPage({ schema: 1, items: [], next: null, scanned: 0 }).ok).toBe(true);
    expect(parseInboxPage({ schema: 1, items: [], next: null, scanned: -1 }).ok).toBe(false);
    expect(parseInboxPage({ schema: 1, items: [], next: null, scanned: 2.5 }).ok).toBe(false);
  });

  it("parses valid InboxPage with items and null or positive integer next", () => {
    const withNext = parseInboxPage({
      schema: 1,
      items: [
        {
          rowid: 12,
          submissionId: VALID_ULID,
          type: "ballot",
          roundId: "round-1",
          lookupId: VALID_LOOKUP_ID,
          payload: { room: "R1", ranks: [1, 2, 3, 4] },
          receivedAt: VALID_TS,
        },
      ],
      next: 12,
    });
    expect(withNext.ok).toBe(true);

    const endPage = parseInboxPage({
      schema: 1,
      items: [],
      next: null,
    });
    expect(endPage).toEqual({
      ok: true,
      value: { schema: 1, items: [], next: null },
    });
  });

  it("parses valid Ack, Head, Submission, StatusResponse, and KeyRequest", () => {
    expect(parseAck({ schema: 1, through: 50 })).toEqual({
      ok: true,
      value: { schema: 1, through: 50 },
    });

    expect(
      parseHead({ schema: 1, seq: 100, headHash: VALID_HEX64 }),
    ).toEqual({
      ok: true,
      value: { schema: 1, seq: 100, headHash: VALID_HEX64 },
    });

    expect(
      parseSubmission({
        schema: 1,
        slug: "wudc-2027",
        submissionId: VALID_ULID,
        type: "ballot",
        roundId: "round-1",
        lookupId: "spqrstuvwxyz2",
        authKey: "base64url-auth-key",
        proof: "base64url-hmac-proof",
        payload: { ranks: [1, 2, 3, 4] },
        extra: true,
      }),
    ).toEqual({
      ok: true,
      value: {
        schema: 1,
        slug: "wudc-2027",
        submissionId: VALID_ULID,
        type: "ballot",
        roundId: "round-1",
        lookupId: "spqrstuvwxyz2",
        authKey: "base64url-auth-key",
        proof: "base64url-hmac-proof",
        payload: { ranks: [1, 2, 3, 4] },
      },
    });

    expect(
      parseStatusResponse({
        schema: 1,
        items: [{ submissionId: VALID_ULID, server: true, tabRoom: false }],
        shareLeft: 950,
      }),
    ).toEqual({
      ok: true,
      value: {
        schema: 1,
        items: [{ submissionId: VALID_ULID, server: true, tabRoom: false }],
        shareLeft: 950,
      },
    });

    expect(
      parseKeyRequest({
        schema: 1,
        slug: "wudc-2027",
        contact: "tab@example.org",
        note: "",
      }),
    ).toEqual({
      ok: true,
      value: {
        schema: 1,
        slug: "wudc-2027",
        contact: "tab@example.org",
        note: "",
      },
    });
  });

  it("rejects schema 2 across parsers with a SCHEMA_UNSUPPORTED-style message", () => {
    const parsers: Array<(input: unknown) => { ok: boolean; errors?: string[] }> = [
      parsePermitUpload,
      parseInboxPage,
      parseAck,
      parseHead,
      parseSubmission,
      parseStatusResponse,
      parseKeyRequest,
    ];

    const payloads = [
      { schema: 2, roundId: "r1", version: 1, open: true, timeZone: "UTC", entries: [] },
      { schema: 2, items: [], next: null },
      { schema: 2, through: 1 },
      { schema: 2, seq: 1, headHash: VALID_HEX64 },
      {
        schema: 2,
        slug: "s",
        submissionId: VALID_ULID,
        type: "ballot",
        roundId: "r1",
        lookupId: VALID_LOOKUP_ID,
        authKey: "k",
        proof: "p",
        payload: {},
      },
      { schema: 2, items: [] },
      { schema: 2, slug: "s", contact: "c", note: "" },
    ];

    for (let i = 0; i < parsers.length; i++) {
      const res = parsers[i]!(payloads[i]);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors?.[0]).toMatch(/^schema:.*SCHEMA_UNSUPPORTED/);
      }
    }
  });

  it("rejects bad field values with clear JSON-path messages", () => {
    // Bad ULID (invalid Crockford char 'I', wrong length)
    expectFieldError(
      parseSubmission({
        schema: 1,
        slug: "wudc-2027",
        submissionId: "01JDF4Z7N0P9Q8R7S6T5V4W3XI",
        type: "ballot",
        roundId: "r1",
        lookupId: VALID_LOOKUP_ID,
        authKey: "k",
        proof: "p",
        payload: {},
      }),
      "submissionId:",
    );

    // Bad payload (array and null)
    expectFieldError(
      parseSubmission({
        schema: 1,
        slug: "wudc-2027",
        submissionId: VALID_ULID,
        type: "ballot",
        roundId: "r1",
        lookupId: VALID_LOOKUP_ID,
        authKey: "k",
        proof: "p",
        payload: [],
      }),
      "payload:",
    );
    expectFieldError(
      parseInboxPage({
        schema: 1,
        items: [
          {
            rowid: 1,
            submissionId: VALID_ULID,
            type: "ballot",
            roundId: "r1",
            lookupId: VALID_LOOKUP_ID,
            payload: null,
            receivedAt: VALID_TS,
          },
        ],
        next: null,
      }),
      "items[0].payload:",
    );

    // Bad lookupId (wrong role letter and excluded alphabet char 'i')
    expectFieldError(
      parsePermitUpload({
        schema: 1,
        roundId: "r1",
        version: 1,
        open: true,
        timeZone: "UTC",
        entries: [
          {
            lookupId: "xabcdefghjkmn",
            verifier: VALID_HEX64,
            roomId: "r1",
            forms: ["ballot"],
          },
        ],
      }),
      "entries[0].lookupId:",
    );
    expectFieldError(
      parsePermitUpload({
        schema: 1,
        roundId: "r1",
        version: 1,
        open: true,
        timeZone: "UTC",
        entries: [
          {
            lookupId: "aabcdefghjkmi",
            verifier: VALID_HEX64,
            roomId: "r1",
            forms: ["ballot"],
          },
        ],
      }),
      "entries[0].lookupId:",
    );

    // Bad verifier (uppercase / wrong length) and bad forms
    expectFieldError(
      parsePermitUpload({
        schema: 1,
        roundId: "r1",
        version: 1,
        open: true,
        timeZone: "UTC",
        entries: [
          {
            lookupId: VALID_LOOKUP_ID,
            verifier: "A".repeat(64),
            roomId: "r1",
            forms: ["ballot", "invalid_form"],
          },
        ],
      }),
      "entries[0].verifier:",
    );
    expectFieldError(
      parsePermitUpload({
        schema: 1,
        roundId: "r1",
        version: 1,
        open: true,
        timeZone: "UTC",
        entries: [
          {
            lookupId: VALID_LOOKUP_ID,
            verifier: VALID_HEX64,
            roomId: "r1",
            forms: ["ballot", "invalid_form"],
          },
        ],
      }),
      "entries[0].forms[1]:",
    );

    // Bad timestamps & timeZone
    expectFieldError(
      parsePermitUpload({
        schema: 1,
        roundId: "r1",
        version: 1,
        open: true,
        ballotDeadline: "2026-02-30T14:00:00.000Z",
        feedbackDeadline: "2026-11-23T14:00:00Z",
        timeZone: "EST",
        entries: [],
      }),
      "ballotDeadline:",
    );
    expectFieldError(
      parsePermitUpload({
        schema: 1,
        roundId: "r1",
        version: 1,
        open: true,
        feedbackDeadline: "2026-11-23T14:00:00Z",
        timeZone: "EST",
        entries: [],
      }),
      "feedbackDeadline:",
    );
    expectFieldError(
      parsePermitUpload({
        schema: 1,
        roundId: "r1",
        version: 1,
        open: true,
        timeZone: "EST",
        entries: [],
      }),
      "timeZone:",
    );

    // Bad rowid, through, seq, headHash, next
    expectFieldError(
      parseInboxPage({
        schema: 1,
        items: [
          {
            rowid: 0,
            submissionId: VALID_ULID,
            type: "ballot",
            roundId: "r1",
            lookupId: VALID_LOOKUP_ID,
            payload: {},
            receivedAt: "2026-11-23T14:00:00+00:00",
          },
        ],
        next: -5,
      }),
      "items[0].rowid:",
    );
    expectFieldError(
      parseInboxPage({
        schema: 1,
        items: [],
        next: 1.5,
      }),
      "next:",
    );
    expectFieldError(parseAck({ schema: 1, through: 0 }), "through:");
    expectFieldError(
      parseHead({ schema: 1, seq: -1, headHash: "abc" }),
      "seq:",
    );
    expectFieldError(
      parseHead({ schema: 1, seq: 1, headHash: "abc" }),
      "headHash:",
    );

    // Bad StatusResponse item and shareLeft
    expectFieldError(
      parseStatusResponse({
        schema: 1,
        items: [{ submissionId: "bad", server: "yes", tabRoom: false }],
        shareLeft: -1,
      }),
      "items[0].submissionId:",
    );
    expectFieldError(
      parseStatusResponse({
        schema: 1,
        items: [{ submissionId: VALID_ULID, server: "yes", tabRoom: false }],
        shareLeft: -1,
      }),
      "items[0].server:",
    );
    expectFieldError(
      parseStatusResponse({
        schema: 1,
        items: [],
        shareLeft: -1,
      }),
      "shareLeft:",
    );

    // Bad KeyRequest
    expectFieldError(
      parseKeyRequest({ schema: 1, slug: "", contact: "", note: 123 }),
      "slug:",
    );
    expectFieldError(
      parseKeyRequest({ schema: 1, slug: "s", contact: "", note: 123 }),
      "contact:",
    );
    expectFieldError(
      parseKeyRequest({ schema: 1, slug: "s", contact: "c", note: 123 }),
      "note:",
    );
  });
});
