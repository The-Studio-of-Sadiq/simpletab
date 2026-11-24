import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openRow, type RoundBundleRow } from "@simpletab/core/bundle";
import {
  base32Decode,
  base32Encode,
  deriveKeys,
  newLink,
} from "@simpletab/core/crypto";
import { createTournamentState, type OpRound, type TournamentState } from "@simpletab/core/ops";
import { parseFormsFile, parseManifest, parseMotionsFile } from "@simpletab/core/wire";
import type { Debate } from "@simpletab/core/types";
import { buildRoundFiles } from "./round-files";

function makePublishedState(options: { motionsReleased?: boolean } = {}): {
  state: TournamentState;
  chairSecret: string;
  chairLookupId: string;
  panellistSecret: string;
  panellistLookupId: string;
  ogTeamSecret: string;
  ogTeamLookupId: string;
} {
  const slug = "round-files-test";
  const tournamentId = "t-1";
  const roundId = "r-1";
  const debateId = "d-1";
  const cdnHost = "wudc2027.pages.dev";
  const ballotsOrigin = "https://ballots.simpletab.app";

  const chairLink = newLink("adjudicator", cdnHost, ballotsOrigin, slug);
  const panellistLink = newLink("adjudicator", cdnHost, ballotsOrigin, slug);
  const ogLink = newLink("team", cdnHost, ballotsOrigin, slug);
  const ooLink = newLink("team", cdnHost, ballotsOrigin, slug);
  const cgLink = newLink("team", cdnHost, ballotsOrigin, slug);
  const coLink = newLink("team", cdnHost, ballotsOrigin, slug);
  const spkLink = newLink("speaker", cdnHost, ballotsOrigin, slug);

  const round: OpRound = {
    id: roundId,
    tournamentId,
    seq: 1,
    name: "Round 1",
    abbreviation: "R1",
    stage: "preliminary",
    drawType: "random",
    drawStatus: "released",
    adjudicatorsRevealed: true,
    feedbackWeight: 1,
    silent: false,
    motionsReleased: options.motionsReleased ?? false,
    motionsStatus: options.motionsReleased ? "motions_released" : "not_released",
    resultsReleased: false,
    completed: false,
    createdAt: "2026-11-24T00:00:00.000Z",
    simpletab: {
      ballotDeadline: "2026-11-24T12:00:00.000Z",
      feedbackDeadline: "2026-11-24T13:00:00.000Z",
      timeZone: "UTC",
    },
  };

  const state: TournamentState = createTournamentState(
    {
      id: tournamentId,
      name: "Round Files Test",
      shortName: "RFT",
      slug,
      format: "bp",
      active: true,
      ownerId: "host-owner",
      admins: { "host-owner": true },
      preferences: {
        teamsInDebate: 4,
        substantiveSpeakers: 2,
        replyScoresEnabled: false,
        minSpeakerScore: 50,
        maxSpeakerScore: 100,
        stepSpeakerScore: 1,
        minReplyScore: 25,
        maxReplyScore: 50,
        drawRule: "power_paired",
        sideAllocationRule: "balanced",
        ballotDoubleEntry: false,
        publicDraw: true,
        publicResults: true,
        publicStandings: true,
        publicMotions: true,
        feedbackEnabled: true,
        feedbackMinScore: 1,
        feedbackMaxScore: 5,
      },
      createdAt: "2026-11-24T00:00:00.000Z",
      updatedAt: "2026-11-24T00:00:00.000Z",
    },
    {
      rounds: [round],
      teams: [
        {
          id: "team-og",
          tournamentId,
          name: "Oxford A",
          shortName: "OXF A",
          breakCategories: [],
          speakerCategories: [],          speakers: [
            { id: "spk-1", name: "Alice" },
            { id: "spk-2", name: "Bob" },
          ],
        },
        {
          id: "team-oo",
          tournamentId,
          name: "Cambridge A",
          shortName: "CAM A",
          breakCategories: [],
          speakerCategories: [],          speakers: [
            { id: "spk-3", name: "Cara" },
            { id: "spk-4", name: "Dan" },
          ],
        },
        {
          id: "team-cg",
          tournamentId,
          name: "Yale A",
          shortName: "YAL A",
          breakCategories: [],
          speakerCategories: [],          speakers: [
            { id: "spk-5", name: "Eli" },
            { id: "spk-6", name: "Fay" },
          ],
        },
        {
          id: "team-co",
          tournamentId,
          name: "Harvard A",
          shortName: "HAR A",
          breakCategories: [],
          speakerCategories: [],          speakers: [
            { id: "spk-7", name: "Gus" },
            { id: "spk-8", name: "Hana" },
          ],
        },
      ],
      adjudicators: [
        {
          id: "adj-chair",
          tournamentId,
          name: "Chair Judge",
          baseScore: 9,
          trainee: false,
          independent: false,
          conflicts: [],
        },
        {
          id: "adj-pan",
          tournamentId,
          name: "Wing Judge",
          baseScore: 7,
          trainee: false,
          independent: false,
          conflicts: [],
        },
      ],
      debates: [
        {
          id: debateId,
          tournamentId,
          roundId,
          roundSeq: 1,
          bracket: 0,
          roomRank: 1,
          importance: 1,
          sidesConfirmed: true,
          flags: [],
          venueName: "Hall A",
          teams: {
            OG: { side: "OG", teamId: "team-og", teamName: "Oxford A" },
            OO: { side: "OO", teamId: "team-oo", teamName: "Cambridge A" },
            CG: { side: "CG", teamId: "team-cg", teamName: "Yale A" },
            CO: { side: "CO", teamId: "team-co", teamName: "Harvard A" },
            // A BP debate has only these four sides; the type covers two-team sides as well.
          } as Debate["teams"],
          adjudicators: {
            chairId: "adj-chair",
            chairName: "Chair Judge",
            panellistIds: ["adj-pan"],
            panellistNames: ["Wing Judge"],
            traineeIds: [],
            traineeNames: [],
          },
          resultStatus: "none",
        },
      ],
      motions: [
        {
          id: "m-1",
          tournamentId,
          seq: 1,
          text: "THW fund open-source software via public endowments.",
          infoSlide: "An endowment invests principal permanently.",
          rounds: [roundId],
          released: options.motionsReleased ?? false,
        },
      ],
      links: [
        { lookupId: chairLink.lookupId, entityId: "adj-chair", secret: base32Encode(chairLink.secret) },
        { lookupId: panellistLink.lookupId, entityId: "adj-pan", secret: base32Encode(panellistLink.secret) },
        { lookupId: ogLink.lookupId, entityId: "team-og", secret: base32Encode(ogLink.secret) },
        { lookupId: ooLink.lookupId, entityId: "team-oo", secret: base32Encode(ooLink.secret) },
        { lookupId: cgLink.lookupId, entityId: "team-cg", secret: base32Encode(cgLink.secret) },
        { lookupId: coLink.lookupId, entityId: "team-co", secret: base32Encode(coLink.secret) },
        { lookupId: spkLink.lookupId, entityId: "spk-1", secret: base32Encode(spkLink.secret) },
      ],
    },
  );

  return {
    state,
    chairSecret: base32Encode(chairLink.secret),
    chairLookupId: chairLink.lookupId,
    panellistSecret: base32Encode(panellistLink.secret),
    panellistLookupId: panellistLink.lookupId,
    ogTeamSecret: base32Encode(ogLink.secret),
    ogTeamLookupId: ogLink.lookupId,
  };
}

describe("buildRoundFiles", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes manifest, forms, and sealed buckets; omits unreleased motion; decrypts matching row only; and skips unchanged rebuilds", async () => {
    const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "simpletab-publish-"));
    tempDirs.push(workspaceDir);

    const fixture = makePublishedState({ motionsReleased: false });
    const first = await buildRoundFiles({
      state: fixture.state,
      workspaceDir,
      ballotCollection: "online_qr",
      headHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      nowIso: "2026-11-24T09:00:00.000Z",
    });

    expect(first.writtenFiles.length).toBeGreaterThan(0);
    const manifestJson = JSON.parse(
      readFileSync(path.join(first.publishDir, "manifest.json"), "utf8"),
    ) as unknown;
    const parsedManifest = parseManifest(manifestJson);
    expect(parsedManifest.ok).toBe(true);
    if (!parsedManifest.ok) {
      return;
    }

    expect(parsedManifest.value.ballotCollectionMode).toBe("online_and_qr");
    expect(parsedManifest.value.rounds).toHaveLength(1);
    const roundEntry = parsedManifest.value.rounds[0]!;
    expect(roundEntry.motionsFile).toBeUndefined();
    expect(roundEntry.ballotDeadline).toBe("2026-11-24T12:00:00.000Z");

    // Verify forms file parses cleanly
    const formsJson = JSON.parse(
      readFileSync(path.join(first.publishDir, roundEntry.formsFile), "utf8"),
    ) as unknown;
    const parsedForms = parseFormsFile(formsJson);
    expect(parsedForms.ok).toBe(true);

    // No motions directory files exist before motion release
    expect(
      first.writtenFiles.some((file) => file.startsWith("motions/")),
    ).toBe(false);

    // Open chair's row using phone-side deriveKeys + openRow across all 32 buckets
    const bucketPaths = Object.values(roundEntry.buckets);
    expect(bucketPaths).toHaveLength(32);

    const chairKeys = await deriveKeys(
      base32Decode(fixture.chairSecret)!,
      fixture.state.tournament.slug,
    );
    const ogKeys = await deriveKeys(
      base32Decode(fixture.ogTeamSecret)!,
      fixture.state.tournament.slug,
    );

    const chairRows: RoundBundleRow[] = [];
    for (const bucketRel of bucketPaths) {
      const bucketBytes = new Uint8Array(
        readFileSync(path.join(first.publishDir, bucketRel)),
      );
      const opened = await openRow<RoundBundleRow>(
        bucketBytes,
        { lookupKey: chairKeys.lookupKey, fileKey: chairKeys.fileKey },
        "r-1",
      );
      if (opened !== null) {
        chairRows.push(opened);
      }
    }

    expect(chairRows).toHaveLength(1);
    const chairRowFound = chairRows[0]!;
    expect(chairRowFound.room).toBe("Hall A");
    expect(chairRowFound.side).toBeUndefined();
    expect(
      chairRowFound.panel?.some((m) => m.name === "Chair Judge" && m.role === "chair"),
    ).toBe(true);
    expect(chairRowFound.forms).toContain("ballot-d-1");
    expect(chairRowFound.forms.length).toBeGreaterThanOrEqual(2);

    // OG team keys open only OG team's own row (never chair's row)
    const ogRows: RoundBundleRow[] = [];
    for (const bucketRel of bucketPaths) {
      const bucketBytes = new Uint8Array(
        readFileSync(path.join(first.publishDir, bucketRel)),
      );
      const opened = await openRow<RoundBundleRow>(
        bucketBytes,
        { lookupKey: ogKeys.lookupKey, fileKey: ogKeys.fileKey },
        "r-1",
      );
      if (opened !== null) {
        ogRows.push(opened);
      }
    }
    expect(ogRows).toHaveLength(1);
    const ogRowFound = ogRows[0]!;
    expect(ogRowFound.room).toBe("Hall A");
    expect(ogRowFound.side).toBe("OG");
    expect(ogRowFound.teammates).toEqual(["Alice", "Bob"]);
    expect(ogRowFound.forms).not.toContain("ballot-d-1");

    // Wrong roundId with valid keys returns null across buckets
    const singleBucket = new Uint8Array(
      readFileSync(path.join(first.publishDir, bucketPaths[0]!)),
    );
    expect(
      await openRow<RoundBundleRow>(
        singleBucket,
        { lookupKey: chairKeys.lookupKey, fileKey: chairKeys.fileKey },
        "r-other",
      ),
    ).toBeNull();

    // Re-running unchanged skips writing all files
    const unchanged = await buildRoundFiles({
      state: fixture.state,
      workspaceDir,
      ballotCollection: "online_qr",
      headHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      nowIso: "2026-11-24T09:05:00.000Z",
    });
    expect(unchanged.writtenFiles).toEqual([]);

    // Releasing motion writes motions/<seq>.<hash>.json and sets manifest motionsFile
    const releasedFixture = makePublishedState({ motionsReleased: true });
    const afterMotion = await buildRoundFiles({
      state: releasedFixture.state,
      workspaceDir,
      ballotCollection: "online",
      headHash: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      nowIso: "2026-11-24T09:10:00.000Z",
    });

    const motionsFile = afterMotion.manifest.rounds[0]?.motionsFile;
    expect(motionsFile).toBeTruthy();
    expect(existsSync(path.join(afterMotion.publishDir, motionsFile!))).toBe(true);
    const motionsJson = JSON.parse(
      readFileSync(path.join(afterMotion.publishDir, motionsFile!), "utf8"),
    ) as unknown;
    const parsedMotions = parseMotionsFile(motionsJson);
    expect(parsedMotions.ok).toBe(true);
    if (parsedMotions.ok) {
      expect(parsedMotions.value.motions[0]?.text).toContain("open-source software");
    }
  });
});
