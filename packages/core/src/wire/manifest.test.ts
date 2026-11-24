import {
  getCurrentRound,
  parseFormsFile,
  parseManifest,
  parseMotionsFile,
  resolveCdnUrl,
  SCHEMA_VERSION,
  type FormsFile,
  type MotionsFile,
  type TournamentManifest,
} from "./index";

describe("manifest, forms, and motions wire contracts", () => {
  const validManifest: TournamentManifest = {
    schema: SCHEMA_VERSION,
    slug: "wudc-2027",
    tournamentName: "WUDC 2027",
    timeZone: "Asia/Dhaka",
    publishedAt: "2026-11-24T10:00:00.000Z",
    ballotCollectionMode: "online_and_qr",
    usesPasscodes: false,
    defaultLanguage: "en",
    currentRoundSeq: 1,
    headHash: "a".repeat(64),
    rounds: [
      {
        roundId: "r-1",
        roundSeq: 1,
        roundName: "Round 1",
        stage: "preliminary",
        open: true,
        buckets: {
          "0": "rounds/1/0.abcd1234.bin",
          "31": "rounds/1/31.ef567890.bin",
        },
        formsFile: "forms/1.12345678.json",
        motionsFile: "motions/1.87654321.json",
        ballotDeadline: "2026-11-24T12:00:00.000Z",
        feedbackDeadline: "2026-11-24T13:00:00.000Z",
      },
    ],
  };

  it("parses valid manifests and rejects malformed modes, schemas, timestamps, and paths", () => {
    const parsed = parseManifest(validManifest);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual(validManifest);
      expect(getCurrentRound(parsed.value)?.roundId).toBe("r-1");
    }

    const minimal = parseManifest({
      schema: SCHEMA_VERSION,
      slug: "mini",
      tournamentName: "Mini",
      timeZone: "UTC",
      publishedAt: "2026-11-24T10:00:00.000Z",
      ballotCollectionMode: "qr_only",
      currentRoundSeq: 0,
      rounds: [],
    });
    expect(minimal.ok).toBe(true);
    if (minimal.ok) {
      expect(getCurrentRound(minimal.value)).toBeNull();
    }

    const bad = parseManifest({
      ...validManifest,
      schema: 99,
      ballotCollectionMode: "online_qr",
      rounds: [
        {
          ...validManifest.rounds[0],
          formsFile: "../secret.json",
          motionsFile: "https://evil.example/m.json",
          ballotDeadline: "not-a-date",
          buckets: { "0": "ok.bin", "1": "bad\\path.bin" },
        },
      ],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.length).toBeGreaterThanOrEqual(5);
    }
  });

  it("resolves safe relative CDN URLs and rejects traversal or protocols", () => {
    expect(resolveCdnUrl("wudc2027.pages.dev", "/forms/1.abc.json")).toBe(
      "https://wudc2027.pages.dev/forms/1.abc.json",
    );
    expect(() =>
      resolveCdnUrl("wudc2027.pages.dev", "../outside.json"),
    ).toThrow(/Invalid CDN relative path/);
    expect(() =>
      resolveCdnUrl("wudc2027.pages.dev", "https://other.host/x.json"),
    ).toThrow(/Invalid CDN relative path/);
  });

  it("parses valid forms and motions files and rejects invalid entries", () => {
    const validForms: FormsFile = {
      schema: SCHEMA_VERSION,
      roundId: "r-1",
      roundSeq: 1,
      format: "bp",
      stage: "preliminary",
      preferences: { minSpeakerScore: 68, maxSpeakerScore: 84 },
      forms: {
        "ballot-d1": {
          id: "ballot-d1",
          kind: "ballot",
          mode: "consensus",
          sides: {
            OG: {
              teamId: "t1",
              teamName: "Team 1",
              speakers: [{ id: "s1", name: "Alice" }],
            },
          },
        },
        "fb-d1": {
          id: "fb-d1",
          kind: "feedback",
          targetType: "adjudicator",
          targets: [{ id: "a1", name: "Chair A", role: "chair" }],
          questions: [],
        },
        "checkin-r1": {
          id: "checkin-r1",
          kind: "checkin",
          roundId: "r-1",
          roundName: "Round 1",
        },
      },
    };
    expect(parseFormsFile(validForms).ok).toBe(true);
    expect(
      parseFormsFile({
        ...validForms,
        format: "invalid_format",
        forms: { bad: { id: "bad", kind: "unknown" } },
      }).ok,
    ).toBe(false);

    const validMotions: MotionsFile = {
      schema: SCHEMA_VERSION,
      roundId: "r-1",
      roundSeq: 1,
      motions: [
        { id: "m1", text: "THBT ...", infoSlide: "Context" },
        { id: "m2", text: "THW ..." },
      ],
    };
    const parsedMotions = parseMotionsFile(validMotions);
    expect(parsedMotions.ok).toBe(true);
    if (parsedMotions.ok) {
      expect(parsedMotions.value.motions).toHaveLength(2);
    }

    expect(
      parseMotionsFile({
        ...validMotions,
        motions: [{ id: "", text: "Missing id" }],
      }).ok,
    ).toBe(false);
  });
});
