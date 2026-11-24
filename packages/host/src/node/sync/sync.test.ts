import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  base32Decode,
  base32Encode,
  deriveKeys,
  newLink,
  verifier,
} from "@simpletab/core/crypto";
import { createTournamentState, type OpRequest, type OpRound, type TournamentState } from "@simpletab/core/ops";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import {
  SCHEMA_VERSION,
  type InboxItem,
  type InboxPage,
  type PermitUpload,
} from "@simpletab/core/wire";
import {
  DEFAULT_ONLINE_SETTINGS,
  type HostServiceClient,
} from "../../common/host-protocol";
import type {
  CredentialsFetchClient,
  CredentialsFetchRequest,
  CredentialsFetchResponse,
} from "../../common/credentials-protocol";
import { CredentialsVault } from "../../electron-main/credentials-store";
import { HostEngine } from "../engine/engine";
import { HOST_OWNER_ACTOR, HostServiceImpl } from "../host-service";
import { createTestCredentialsIpcBridge } from "./credentials-ipc-client";
import { processInboxItems } from "./inbox-to-ops";
import { buildPermitUpload } from "./permits";
import { IDLE_POLL_MS, OPEN_ROUND_POLL_MS, SyncScheduler } from "./scheduler";
import { ServiceClient } from "./service-client";
import type { Debate } from "@simpletab/core/types";

interface FixtureIds {
  slug: string;
  tournamentId: string;
  roundId: string;
  debateId: string;
  chairId: string;
  panellistId: string;
  teamIds: [string, string, string, string];
  chairLookupId: string;
  chairSecret: string;
  panellistLookupId: string;
  ogTeamLookupId: string;
}

async function createSeededEngine(
  dir: string,
  options: { releaseDraw?: boolean } = {},
): Promise<{ engine: HostEngine; ids: FixtureIds }> {
  const dbPath = path.join(dir, "sync-test.simpletab.db");
  const slug = "sync-test";
  const tournamentId = "t-sync";
  const roundId = "r-1";
  const debateId = "d-1";

  const initialState: TournamentState = createTournamentState(
    {
      id: tournamentId,
      name: "Sync Test Open",
      shortName: "STO",
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
        allowSelfCheckIn: true,
        feedbackEnabled: true,
        feedbackPath: "everyone",
        feedbackMinScore: 1,
        feedbackMaxScore: 5,
      },
      createdAt: "2026-11-24T00:00:00.000Z",
      updatedAt: "2026-11-24T00:00:00.000Z",
    },
    {
      rounds: [
        {
          id: roundId,
          tournamentId,
          seq: 1,
          name: "Round 1",
          abbreviation: "R1",
          stage: "preliminary",
          drawType: "random",
          drawStatus: options.releaseDraw === false ? "draft" : "released",
          adjudicatorsRevealed: true,
          feedbackWeight: 1,
          silent: false,
          motionsReleased: false,
          resultsReleased: false,
          completed: false,
          createdAt: "2026-11-24T00:00:00.000Z",
          simpletab: {
            ballotDeadline: "2026-11-24T12:00:00.000Z",
            feedbackDeadline: "2026-11-24T13:00:00.000Z",
            timeZone: "UTC",
          },
        } as OpRound,
      ],
      teams: [
        {
          id: "team-og",
          tournamentId,
          name: "Oxford A",
          shortName: "OXF A",
          breakCategories: [],
          speakerCategories: [],
          speakers: [
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
          speakerCategories: [],
          speakers: [
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
          speakerCategories: [],
          speakers: [
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
          speakerCategories: [],
          speakers: [
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
          venueName: "Room 101",
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
    },
  );

  const engine = HostEngine.open(dbPath, { initialState });

  const cdnHost = "wudc2027.pages.dev";
  const ballotsOrigin = "https://ballots.simpletab.app";
  const chairLink = newLink("adjudicator", cdnHost, ballotsOrigin, slug);
  const panLink = newLink("adjudicator", cdnHost, ballotsOrigin, slug);
  const ogLink = newLink("team", cdnHost, ballotsOrigin, slug);

  const regenRes = await engine.submit(
    {
      type: "private_urls.regenerate",
      payload: {
        scope: "all",
        force: true,
        links: [
          {
            lookupId: chairLink.lookupId,
            entityId: "adj-chair",
            secret: base32Encode(chairLink.secret),
          },
          {
            lookupId: panLink.lookupId,
            entityId: "adj-pan",
            secret: base32Encode(panLink.secret),
          },
          {
            lookupId: ogLink.lookupId,
            entityId: "team-og",
            secret: base32Encode(ogLink.secret),
          },
        ],
      },
    },
    HOST_OWNER_ACTOR,
  );
  if (!regenRes.ok) {
    throw new Error(`Failed to seed links: ${regenRes.errors.join("; ")}`);
  }

  return {
    engine,
    ids: {
      slug,
      tournamentId,
      roundId,
      debateId,
      chairId: "adj-chair",
      panellistId: "adj-pan",
      teamIds: ["team-og", "team-oo", "team-cg", "team-co"],
      chairLookupId: chairLink.lookupId,
      chairSecret: base32Encode(chairLink.secret),
      panellistLookupId: panLink.lookupId,
      ogTeamLookupId: ogLink.lookupId,
    },
  };
}

function makeBpBallotPayload(ids: FixtureIds): Record<string, unknown> {
  return {
    debateId: ids.debateId,
    speakerScores: {
      OG: [
        { speakerId: "spk-1", speakerName: "Alice", position: 1, score: 78 },
        { speakerId: "spk-2", speakerName: "Bob", position: 2, score: 77 },
      ],
      OO: [
        { speakerId: "spk-3", speakerName: "Cara", position: 1, score: 76 },
        { speakerId: "spk-4", speakerName: "Dan", position: 2, score: 75 },
      ],
      CG: [
        { speakerId: "spk-5", speakerName: "Eli", position: 1, score: 74 },
        { speakerId: "spk-6", speakerName: "Fay", position: 2, score: 73 },
      ],
      CO: [
        { speakerId: "spk-7", speakerName: "Gus", position: 1, score: 72 },
        { speakerId: "spk-8", speakerName: "Hana", position: 2, score: 71 },
      ],
    },
    teamScores: {
      OG: { side: "OG", teamId: "team-og", rank: 1, points: 3, totalSpeakerScore: 155 },
      OO: { side: "OO", teamId: "team-oo", rank: 2, points: 2, totalSpeakerScore: 151 },
      CG: { side: "CG", teamId: "team-cg", rank: 3, points: 1, totalSpeakerScore: 147 },
      CO: { side: "CO", teamId: "team-co", rank: 4, points: 0, totalSpeakerScore: 143 },
    },
  };
}

// Each test opens a real engine (SQLite + worker threads); allow for a loaded CI machine.
describe("M3 step c sync and portal integration", { timeout: 30_000 }, () => {
  const tempDirs: string[] = [];
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    vi.useRealTimers();
    for (const fn of cleanups.splice(0).reverse()) {
      await fn();
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isolates tournamentKey in electron-main across real HTTP IPC without exposing it to the backend", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "simpletab-sync-ipc-"));
    tempDirs.push(tmp);

    const secretKey = "tk_live_super_secret_do_not_leak_42";
    const capturedRequests: Array<{
      method: string;
      url: string;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }> = [];

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        capturedRequests.push({
          method: req.method ?? "GET",
          url: req.url ?? "/",
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });

        if (req.url?.startsWith("/v1/status")) {
          res.writeHead(200, {
            "content-type": "application/json",
            date: new Date("2026-11-24T10:00:00.000Z").toUTCString(),
          });
          res.end(
            JSON.stringify({
              schema: SCHEMA_VERSION,
              items: [],
              shareLeft: 480,
            }),
          );
          return;
        }

        res.writeHead(200, {
          "content-type": "application/json",
          date: new Date("2026-11-24T10:00:00.000Z").toUTCString(),
        });
        res.end(
          JSON.stringify({
            schema: SCHEMA_VERSION,
            roundId: "r-1",
            version: 1,
            open: true,
          }),
        );
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    );

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected TCP server address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const vault = new CredentialsVault({
      getStorageDir: () => path.join(tmp, "vault"),
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain, "utf8"),
      decryptString: (buf) => buf.toString("utf8"),
      defaultServiceBaseUrl: baseUrl,
      fetchImpl: (input, init) => globalThis.fetch(input, init),
    });
    await vault.set("tournamentKey", secretKey);

    const bridge = createTestCredentialsIpcBridge(vault);
    cleanups.push(() => bridge.dispose());

    const client = new ServiceClient({
      fetchClient: bridge.client,
      getHostIdentity: () => ({ hostNumber: 2, hostId: "host-node-2", hostRank: 1 }),
      clock: () => new Date("2026-11-24T10:00:05.000Z"),
    });

    const statusResult = await client.getStatus("sync-test");
    expect(statusResult.ok).toBe(true);
    if (statusResult.ok) {
      expect(statusResult.data.shareLeft).toBe(480);
      expect(statusResult.clockSkewMs).toBe(5000);
    }

    const { engine, ids } = await createSeededEngine(tmp);
    cleanups.push(() => engine.close());
    const permit = await buildPermitUpload(engine.getState()!, ids.roundId, 1);
    const permitResult = await client.uploadPermit(permit!);
    expect(permitResult.ok).toBe(true);

    expect(capturedRequests).toHaveLength(2);
    for (const req of capturedRequests) {
      expect(req.headers.authorization).toBe(`Bearer ${secretKey}`);
      expect(req.headers["x-host-number"]).toBe("2");
      expect(req.headers["x-host-id"]).toBe("host-node-2");
      expect(req.headers["x-host-rank"]).toBe("1");
      expect(typeof req.headers["x-request-id"]).toBe("string");
    }

    for (const ipcReq of bridge.sentRequests) {
      expect(ipcReq.req.headers?.Authorization).toBeUndefined();
      expect(ipcReq.req.headers?.authorization).toBeUndefined();
    }
    expect(
      JSON.stringify({
        sentRequests: bridge.sentRequests,
        receivedReplies: bridge.receivedReplies,
        statusResult,
        permitResult,
      }),
    ).not.toContain(secretKey);
  });

  it("builds valid permits with Worker-matching verifiers, role-based forms, and round deadlines", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "simpletab-permit-"));
    tempDirs.push(tmp);

    const { engine, ids } = await createSeededEngine(tmp);
    cleanups.push(() => engine.close());

    // The fixture is BP, where ballots are always one consensus ballot from the chair.
    const bpState = engine.getState()!;
    const bpPermit = await buildPermitUpload(bpState, ids.roundId, 3);
    expect(bpPermit).not.toBeNull();
    expect(bpPermit!.version).toBe(3);
    expect(bpPermit!.open).toBe(true);
    expect(bpPermit!.timeZone).toBe("UTC");
    expect(bpPermit!.ballotDeadline).toBe("2026-11-24T12:00:00.000Z");
    expect(bpPermit!.feedbackDeadline).toBe("2026-11-24T13:00:00.000Z");

    const entryFor = (permit: PermitUpload, lookupId: string) =>
      permit.entries.find((entry) => entry.lookupId === lookupId);

    const chairEntry = entryFor(bpPermit!, ids.chairLookupId);
    expect(chairEntry?.forms).toEqual(["ballot", "feedback", "checkin"]);
    expect(entryFor(bpPermit!, ids.panellistLookupId)?.forms).toEqual(["feedback", "checkin"]);
    expect(entryFor(bpPermit!, ids.ogTeamLookupId)?.forms).toEqual(["feedback", "checkin"]);

    // Verifier matches what the Worker computes from link secret
    const expectedDerived = await deriveKeys(
      base32Decode(ids.chairSecret)!,
      ids.slug,
    );
    const expectedVerifier = await verifier(expectedDerived.authKey);
    expect(chairEntry?.verifier).toBe(expectedVerifier);

    // A two-team tournament with voting ballots gives every voting panellist a ballot form.
    const votingState: TournamentState = {
      ...bpState,
      tournament: {
        ...bpState.tournament,
        format: "wsdc",
        preferences: { ...bpState.tournament.preferences, teamsInDebate: 2, ballotMode: "voting" },
      },
      debates: bpState.debates.map((debate) => ({
        ...debate,
        teams: {
          AFF: { side: "AFF", teamId: "team-og", teamName: "Oxford A" },
          NEG: { side: "NEG", teamId: "team-oo", teamName: "Cambridge A" },
        } as Debate["teams"],
      })),
    };
    const votingPermit = await buildPermitUpload(votingState, ids.roundId, 4);
    expect(entryFor(votingPermit!, ids.chairLookupId)?.forms).toEqual(["ballot", "feedback", "checkin"]);
    expect(entryFor(votingPermit!, ids.panellistLookupId)?.forms).toEqual(["ballot", "feedback", "checkin"]);
    expect(entryFor(votingPermit!, ids.ogTeamLookupId)?.forms).toEqual(["feedback", "checkin"]);

    // The same two-team tournament on consensus ballots: only the chair submits.
    const consensusState: TournamentState = {
      ...votingState,
      tournament: {
        ...votingState.tournament,
        preferences: { ...votingState.tournament.preferences, ballotMode: "consensus" },
      },
    };
    const consensusPermit = await buildPermitUpload(consensusState, ids.roundId, 5);
    expect(entryFor(consensusPermit!, ids.chairLookupId)?.forms).toContain("ballot");
    expect(entryFor(consensusPermit!, ids.panellistLookupId)?.forms).not.toContain("ballot");
    expect(entryFor(consensusPermit!, ids.panellistLookupId)?.forms).toContain("checkin");
  });

  it("maps inbox items to ops idempotently, routes late ballots, stops on error before ack, and preserves integrity replay", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "simpletab-inbox-ops-"));
    tempDirs.push(tmp);

    const { engine, ids } = await createSeededEngine(tmp);
    cleanups.push(() => engine.close());

    const processedIds = new Set<string>();
    const onTimeItems: InboxItem[] = [
      {
        rowid: 1,
        submissionId: "sub-ballot-1",
        roundId: ids.roundId,
        lookupId: ids.chairLookupId,
        type: "ballot",
        payload: makeBpBallotPayload(ids),
        receivedAt: "2026-11-24T11:30:00.000Z",
      },
      {
        rowid: 2,
        submissionId: "sub-fb-1",
        roundId: ids.roundId,
        lookupId: ids.ogTeamLookupId,
        type: "feedback",
        payload: {
          debateId: ids.debateId,
          targetType: "adjudicator",
          targetId: ids.chairId,
          score: 5,
          comments: "Clear oral adjudication",
        },
        receivedAt: "2026-11-24T11:35:00.000Z",
      },
      {
        rowid: 3,
        submissionId: "sub-checkin-1",
        roundId: ids.roundId,
        lookupId: ids.panellistLookupId,
        type: "checkin",
        payload: { roundId: ids.roundId, available: true },
        receivedAt: "2026-11-24T11:36:00.000Z",
      },
      {
        rowid: 4,
        submissionId: "sub-reg-1",
        roundId: ids.roundId,
        lookupId: ids.ogTeamLookupId,
        type: "registration",
        payload: { note: "future M10" },
        receivedAt: "2026-11-24T11:37:00.000Z",
      },
    ];

    const firstPass = await processInboxItems(engine, onTimeItems, processedIds);
    expect(firstPass.appliedCount).toBe(3);
    expect(firstPass.ignoredCount).toBe(1);
    expect(firstPass.highestProcessedRowId).toBe(4);
    expect(firstPass.stoppedOnError).toBeUndefined();

    const stateAfterFirst = engine.getState()!;
    expect(stateAfterFirst.ballots).toHaveLength(1);
    expect(stateAfterFirst.ballots[0]?.timestamp).toBe("2026-11-24T11:30:00.000Z");
    expect(stateAfterFirst.feedback).toHaveLength(1);
    expect(
      stateAfterFirst.adjudicators.find((a) => a.id === ids.panellistId)?.roundAvailability?.[
        ids.roundId
      ],
    ).toBe(true);

    // Re-pulling the same items must be completely idempotent
    const replayPass = await processInboxItems(engine, onTimeItems, processedIds);
    expect(replayPass.appliedCount).toBe(0);
    expect(replayPass.duplicateCount).toBe(4);
    expect(engine.getState()!.ballots).toHaveLength(1);
    expect(engine.getState()!.feedback).toHaveLength(1);

    // An invalid item stops processing so highestProcessedRowId stops before it
    const partialItems: InboxItem[] = [
      {
        rowid: 5,
        submissionId: "sub-checkin-2",
        roundId: ids.roundId,
        lookupId: ids.chairLookupId,
        type: "checkin",
        payload: { roundId: ids.roundId, available: true },
        receivedAt: "2026-11-24T11:38:00.000Z",
      },
      {
        rowid: 6,
        submissionId: "sub-broken",
        roundId: ids.roundId,
        lookupId: "a9999999999999",
        type: "checkin",
        payload: { roundId: ids.roundId, available: true },
        receivedAt: "2026-11-24T11:39:00.000Z",
      },
    ];
    const partialRes = await processInboxItems(engine, partialItems, processedIds);
    expect(partialRes.highestProcessedRowId).toBe(5);
    expect(partialRes.stoppedOnError?.rowid).toBe(6);

    // With portalEnforcing active, ballot received after ballotDeadline routes to lateSubmissions
    engine.setPortalEnforcing(true);
    const lateItems: InboxItem[] = [
      {
        rowid: 7,
        submissionId: "sub-late-ballot",
        roundId: ids.roundId,
        lookupId: ids.panellistLookupId,
        type: "ballot",
        payload: {
          ...makeBpBallotPayload(ids),
          submitterId: ids.panellistId,
        },
        receivedAt: "2026-11-24T12:15:00.000Z",
      },
    ];
    const lateRes = await processInboxItems(engine, lateItems, processedIds);
    expect(lateRes.appliedCount).toBe(1);
    expect(lateRes.lateCount).toBe(1);
    expect(engine.getState()!.lateSubmissions).toHaveLength(1);

    expect(await engine.runFastCheck()).toEqual({ ok: true });
    expect(await engine.runFullCheck()).toEqual({ ok: true });
  });

  it("schedules 30s open / 5m idle polls, backoff, pauses on HOST_STALE without making engine read-only, and auto-pushes permits", async () => {
    vi.useFakeTimers();
    const tmp = mkdtempSync(path.join(os.tmpdir(), "simpletab-scheduler-"));
    tempDirs.push(tmp);

    const { engine, ids } = await createSeededEngine(tmp, { releaseDraw: false });
    cleanups.push(() => engine.close());

    const calls: Array<{ method: string; path: string; body?: string }> = [];
    let permitMode: "ok" | "host_stale" | "key_revoked" | "quota" | "offline" = "ok";
    let inboxMode: "ok" | "quota" | "offline" = "ok";

    const fakeFetchClient: CredentialsFetchClient = {
      async fetch(_name, req: CredentialsFetchRequest): Promise<CredentialsFetchResponse> {
        calls.push({
          method: req.method,
          path: req.path,
          ...(req.body !== undefined ? { body: req.body } : {}),
        });

        if (req.path.startsWith("/v1/status")) {
          return {
            status: 200,
            headers: { date: new Date("2026-11-24T10:00:00.000Z").toUTCString() },
            body: JSON.stringify({
              schema: SCHEMA_VERSION,
              items: [],
              shareLeft: 400,
            }),
          };
        }

        if (req.path === "/v1/host/permits") {
          if (permitMode === "host_stale") {
            return {
              status: 409,
              headers: {},
              body: JSON.stringify({
                code: "HOST_STALE",
                message: "Behind host 3",
                storedHostNumber: 3,
              }),
            };
          }
          if (permitMode === "key_revoked") {
            return {
              status: 403,
              headers: {},
              body: JSON.stringify({
                code: "KEY_REVOKED",
                message: "Revoked",
              }),
            };
          }
          const parsed = JSON.parse(req.body ?? "{}") as PermitUpload;
          return {
            status: 200,
            headers: { date: new Date("2026-11-24T10:00:00.000Z").toUTCString() },
            body: JSON.stringify({
              schema: SCHEMA_VERSION,
              roundId: parsed.roundId,
              version: parsed.version,
              open: parsed.open,
            }),
          };
        }

        if (req.path.startsWith("/v1/host/inbox")) {
          if (inboxMode === "quota") {
            return {
              status: 429,
              headers: {},
              body: JSON.stringify({
                code: "QUOTA_EXHAUSTED",
                message: "Quota used up",
              }),
            };
          }
          if (inboxMode === "offline") {
            return {
              status: 503,
              headers: {},
              body: JSON.stringify({ message: "Unavailable" }),
            };
          }
          const page: InboxPage = {
            schema: SCHEMA_VERSION,
            items: [],
            next: null,
          };
          return {
            status: 200,
            headers: { date: new Date("2026-11-24T10:00:00.000Z").toUTCString() },
            body: JSON.stringify(page),
          };
        }

        return { status: 200, headers: {}, body: JSON.stringify({ schema: SCHEMA_VERSION, ackedThrough: 0 }) };
      },
    };

    const client = new ServiceClient({
      fetchClient: fakeFetchClient,
      getHostIdentity: () => ({ hostNumber: 1, hostId: "h-1", hostRank: 1 }),
    });

    const portalEnforcingHistory: boolean[] = [];
    const scheduler = new SyncScheduler({
      engine,
      client,
      initialSettings: { ...DEFAULT_ONLINE_SETTINGS, ballotPortal: false },
      hostNumber: 1,
      onPortalEnforcingChanged: (val) => portalEnforcingHistory.push(val),
    });
    cleanups.push(() => scheduler.dispose());

    // When ballotPortal is OFF, advancing time performs zero HTTP calls
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 2);
    expect(calls).toHaveLength(0);

    // Enable ballotPortal while round draw is still draft -> 5 min idle interval
    scheduler.updateSettings({ ...DEFAULT_ONLINE_SETTINGS, ballotPortal: true });
    await vi.advanceTimersByTimeAsync(0);
    const afterStartCalls = calls.length;
    await vi.advanceTimersByTimeAsync(OPEN_ROUND_POLL_MS);
    expect(calls.length).toBe(afterStartCalls); // Did NOT poll at 30s when idle

    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS - OPEN_ROUND_POLL_MS);
    expect(calls.length).toBeGreaterThan(afterStartCalls);

    // qr_only mode disables network calls immediately
    scheduler.updateSettings({
      ...DEFAULT_ONLINE_SETTINGS,
      ballotPortal: true,
      ballotCollection: "qr_only",
    });
    const beforeQrCalls = calls.length;
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 2);
    expect(calls.length).toBe(beforeQrCalls);

    // Re-enable online mode, release draw -> auto-pushes permit and switches to 30s poll!
    scheduler.updateSettings({
      ...DEFAULT_ONLINE_SETTINGS,
      ballotPortal: true,
      ballotCollection: "online",
    });
    await vi.advanceTimersByTimeAsync(0);

    calls.length = 0;
    const releaseRes = await engine.submit(
      { type: "draw.release", payload: { roundId: ids.roundId } },
      HOST_OWNER_ACTOR,
    );
    expect(releaseRes.ok).toBe(true);
    if (releaseRes.ok) {
      scheduler.handleCommitted({
        seq: engine.head().seq,
        type: "draw.release",
        writes: [...releaseRes.writes],
        committedPayload: releaseRes.committedPayload,
      });
    }
    // Permit building uses real WebCrypto, so wait for the push rather than a fixed fake delay.
    await vi.waitFor(() => {
      expect(calls.some((c) => c.path === "/v1/host/permits")).toBe(true);
    });

    // Ballot deadline update auto-pushes incremented permit version
    calls.length = 0;
    const dlRes = await engine.submit(
      {
        type: "round.set_ballot_deadline",
        payload: {
          roundId: ids.roundId,
          ballotDeadline: "2026-11-24T12:30:00.000Z",
          timeZone: "UTC",
        },
      },
      HOST_OWNER_ACTOR,
    );
    expect(dlRes.ok).toBe(true);
    if (dlRes.ok) {
      scheduler.handleCommitted({
        seq: engine.head().seq,
        type: "round.set_ballot_deadline",
        writes: [...dlRes.writes],
        committedPayload: dlRes.committedPayload,
      });
    }
    await vi.waitFor(() => {
      expect(calls.some((c) => c.path === "/v1/host/permits")).toBe(true);
    });
    const permitPush = calls.find((c) => c.path === "/v1/host/permits");
    expect(permitPush).toBeDefined();
    expect(JSON.parse(permitPush!.body!).version).toBeGreaterThanOrEqual(2);

    // Verify 30s open poll fires while round is open
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(OPEN_ROUND_POLL_MS);
    expect(calls.some((c) => c.path.startsWith("/v1/host/inbox"))).toBe(true);

    // Transient failure triggers exponential backoff and pausedReason: "OFFLINE"
    inboxMode = "offline";
    await scheduler.pullNow();
    expect(scheduler.getSyncStatus().pausedReason).toBe("OFFLINE");
    expect(scheduler.getSyncStatus().consecutiveFailures).toBe(1);
    inboxMode = "ok";

    // QUOTA_EXHAUSTED pauses sync
    inboxMode = "quota";
    await scheduler.pullNow();
    expect(scheduler.getSyncStatus().pausedReason).toBe("QUOTA_EXHAUSTED");
    inboxMode = "ok";

    // HOST_STALE pauses sync (and stores storedHostNumber), yet local tabbing writes still succeed!
    scheduler.updateSettings({ ...DEFAULT_ONLINE_SETTINGS, ballotPortal: true });
    await vi.advanceTimersByTimeAsync(0);
    permitMode = "host_stale";
    const staleDeadline = await engine.submit(
      {
        type: "round.set_ballot_deadline",
        payload: {
          roundId: ids.roundId,
          ballotDeadline: "2026-11-24T12:45:00.000Z",
          timeZone: "UTC",
        },
      },
      HOST_OWNER_ACTOR,
    );
    expect(staleDeadline.ok).toBe(true);
    if (staleDeadline.ok) {
      scheduler.handleCommitted({
        seq: engine.head().seq,
        type: "round.set_ballot_deadline",
        writes: [...staleDeadline.writes],
        committedPayload: staleDeadline.committedPayload,
      });
    }
    await vi.waitFor(() => {
      expect(scheduler.getSyncStatus().pausedReason).toBe("HOST_STALE");
    });

    const staleStatus = scheduler.getSyncStatus();
    expect(staleStatus.active).toBe(false);
    expect(staleStatus.pausedReason).toBe("HOST_STALE");
    expect(staleStatus.storedHostNumber).toBe(3);

    // Tabbing engine must remain writable despite HOST_STALE
    const instWrite = await engine.submit(
      {
        type: "institution.create",
        payload: {
          institution: {
            id: "inst-after-stale",
            tournamentId: ids.tournamentId,
            name: "Writable After Host Stale",
            code: "WAHS",
          },
        },
      },
      HOST_OWNER_ACTOR,
    );
    expect(instWrite.ok).toBe(true);
    expect(portalEnforcingHistory.includes(true)).toBe(true);
  });

  it("wires getSyncStatus, pullNow, clock skew warning, and preserves QR auto-confirm in HostServiceImpl", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "simpletab-hostservice-sync-"));
    tempDirs.push(tmp);

    const hostClientEvents: HostStatusSnapshot[] = [];
    interface HostStatusSnapshot {
      seq: number;
      type: string;
    }

    const service = new HostServiceImpl();
    cleanups.push(() => service.onStop());

    const stubClient: HostServiceClient = {
      onStateChanged(ev) {
        hostClientEvents.push({ seq: ev.seq, type: ev.type });
      },
      onLocksChanged() {},
    };
    service.setClient(stubClient);

    // Deterministic host clock skewed +180s ahead of server Date header
    service.setClock(() => new Date("2026-11-24T10:03:00.000Z"));
    service.setCredentialsFetchClient({
      async fetch(_name, req) {
        const serverDate = new Date("2026-11-24T10:00:00.000Z").toUTCString();
        if (req.path.startsWith("/v1/status")) {
          return {
            status: 200,
            headers: { date: serverDate },
            body: JSON.stringify({
              schema: SCHEMA_VERSION,
              items: [],
              shareLeft: 321,
            }),
          };
        }
        if (req.path.startsWith("/v1/host/inbox")) {
          return {
            status: 200,
            headers: { date: serverDate },
            body: JSON.stringify({
              schema: SCHEMA_VERSION,
              items: [],
              next: null,
            }),
          };
        }
        return {
          status: 200,
          headers: { date: serverDate },
          body: JSON.stringify({
            schema: SCHEMA_VERSION,
            roundId: "round-1",
            version: 1,
            open: false,
          }),
        };
      },
    });

    const created = await service.createTournament({
      name: "Service Sync",
      slug: "svc-sync",
      format: "bp",
      presetId: "bp",
      prelimRounds: 1,
      directory: tmp,
    });
    expect(created.status.open).toBe(true);

    await service.updateOnlineSettings({
      ballotPortal: true,
      cdnHost: "wudc2027.pages.dev",
      trustSignedBallots: true,
    });

    const syncStatus = await service.pullNow();
    expect(syncStatus.active).toBe(true);
    expect(syncStatus.shareLeft).toBe(321);
    expect(syncStatus.clockSkewMs).toBe(180_000);
    expect(syncStatus.clockSkewWarning).toBe(true);
    expect(syncStatus.lastPullAt).toBe("2026-11-24T10:03:00.000Z");

    const hostStatus = await service.status();
    expect(hostStatus.syncStatus?.shareLeft).toBe(321);
    expect((await service.getSyncStatus()).shareLeft).toBe(321);
    expect(hostStatus.onlineSettings?.cdnHost).toBe("wudc2027.pages.dev");

    // Seed debate + submit QR ballot with trustSignedBallots=true -> auto-confirmed as before
    const st = (await service.getState())!;
    const r1 = st.rounds[0]!;
    for (const [idx, tid] of ["t1", "t2", "t3", "t4"].entries()) {
      await service.submit({
        type: "team.create",
        payload: {
          team: {
            id: tid,
            tournamentId: st.tournament.id,
            name: `Team ${idx + 1}`,
            shortName: `T${idx + 1}`,
            breakCategories: [],
            speakerCategories: [],            speakers: [
              { id: `${tid}-s1`, name: `S1 ${idx}`, teamId: tid },
              { id: `${tid}-s2`, name: `S2 ${idx}`, teamId: tid },
            ],
          },
        },
      });
    }
    await service.submit({
      type: "adjudicator.create",
      payload: {
        adjudicator: {
          id: "adj-qr",
          tournamentId: st.tournament.id,
          name: "QR Chair",
          baseScore: 8,
          trainee: false,
          independent: false,
          conflicts: [],
        },
      },
    });
    const genRes = await service.submit({
      type: "draw.generate",
      payload: { roundId: r1.id, seed: 7 },
    } as OpRequest);
    expect(genRes.ok).toBe(true);
    await service.submit({
      type: "allocation.auto",
      payload: { roundId: r1.id },
    } as OpRequest);
    const relRes = await service.submit({
      type: "draw.release",
      payload: { roundId: r1.id },
    });
    expect(relRes.ok).toBe(true);

    const withDraw = (await service.getState())!;
    const debate = withDraw.debates[0]!;
    const qrRes = await service.submit({
      type: "ballot.receive_online",
      payload: {
        source: "qr",
        ballot: {
          id: "qr-ballot-1",
          tournamentId: st.tournament.id,
          roundId: r1.id,
          debateId: debate.id,
          version: 1,
          confirmed: true,
          discarded: false,
          submitterType: "judge",
          submitterId: debate.adjudicators.chairId ?? "adj-qr",
          speakerScores: {
            OG: [
              { speakerId: `${debate.teams.OG!.teamId}-s1`, speakerName: "S1", position: 1, score: 78 },
              { speakerId: `${debate.teams.OG!.teamId}-s2`, speakerName: "S2", position: 2, score: 77 },
            ],
            OO: [
              { speakerId: `${debate.teams.OO!.teamId}-s1`, speakerName: "S1", position: 1, score: 76 },
              { speakerId: `${debate.teams.OO!.teamId}-s2`, speakerName: "S2", position: 2, score: 75 },
            ],
            CG: [
              { speakerId: `${debate.teams.CG!.teamId}-s1`, speakerName: "S1", position: 1, score: 74 },
              { speakerId: `${debate.teams.CG!.teamId}-s2`, speakerName: "S2", position: 2, score: 73 },
            ],
            CO: [
              { speakerId: `${debate.teams.CO!.teamId}-s1`, speakerName: "S1", position: 1, score: 72 },
              { speakerId: `${debate.teams.CO!.teamId}-s2`, speakerName: "S2", position: 2, score: 71 },
            ],
          },
          teamScores: {
            OG: { side: "OG", teamId: debate.teams.OG!.teamId, rank: 1, points: 3, totalSpeakerScore: 155 },
            OO: { side: "OO", teamId: debate.teams.OO!.teamId, rank: 2, points: 2, totalSpeakerScore: 151 },
            CG: { side: "CG", teamId: debate.teams.CG!.teamId, rank: 3, points: 1, totalSpeakerScore: 147 },
            CO: { side: "CO", teamId: debate.teams.CO!.teamId, rank: 4, points: 0, totalSpeakerScore: 143 },
          },
          timestamp: "2026-11-24T10:02:00.000Z",
        },
      },
    });
    expect(qrRes.ok).toBe(true);
    const finalState = (await service.getState())!;
    const savedQrBallot = finalState.ballots.find((b) => b.id === "qr-ballot-1");
    expect(savedQrBallot?.confirmed).toBe(true);
    expect(hostClientEvents.length).toBeGreaterThan(0);
  });

  it("starts the next pull after rows the service already scanned, but re-pulls an item that failed", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "simpletab-pull-cursor-"));
    tempDirs.push(tmp);
    const { engine, ids } = await createSeededEngine(tmp);
    cleanups.push(() => engine.close());

    const inboxAfter: number[] = [];
    let nextPage: InboxPage = { schema: SCHEMA_VERSION, items: [], next: null, scanned: 500 };
    const fetchClient: CredentialsFetchClient = {
      async fetch(_name, req: CredentialsFetchRequest): Promise<CredentialsFetchResponse> {
        if (req.path.startsWith("/v1/host/inbox")) {
          inboxAfter.push(Number(new URL(req.path, "https://x").searchParams.get("after")));
          return { status: 200, headers: {}, body: JSON.stringify(nextPage) };
        }
        if (req.path.startsWith("/v1/host/ack")) {
          const body = JSON.parse(req.body ?? "{}") as { ackedThrough?: number };
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ schema: SCHEMA_VERSION, ackedThrough: body.ackedThrough ?? 0 }),
          };
        }
        return { status: 200, headers: {}, body: JSON.stringify({ schema: SCHEMA_VERSION, items: [] }) };
      },
    };
    const client = new ServiceClient({
      fetchClient,
      getHostIdentity: () => ({ hostNumber: 1, hostId: "h-1", hostRank: 1 }),
    });
    const scheduler = new SyncScheduler({
      engine,
      client,
      initialSettings: { ...DEFAULT_ONLINE_SETTINGS, ballotPortal: true },
      hostNumber: 1,
    });
    cleanups.push(() => scheduler.dispose());

    // A quiet pull: nothing for this tournament, but the service scanned up to rowid 500.
    await scheduler.pullNow();
    await scheduler.pullNow();
    expect(inboxAfter.at(-1)).toBe(500);

    // An item that cannot be applied stops the pass; the position must not move past it.
    nextPage = {
      schema: SCHEMA_VERSION,
      items: [
        {
          rowid: 700,
          submissionId: "sub-bad-1",
          roundId: ids.roundId,
          lookupId: ids.chairLookupId,
          type: "ballot",
          payload: { debateId: ids.debateId, speakerScores: {}, teamScores: {} },
          receivedAt: "2026-11-24T11:30:00.000Z",
        },
      ],
      next: null,
      scanned: 900,
    };
    await scheduler.pullNow();
    await scheduler.pullNow();
    expect(inboxAfter.at(-1)).toBe(500);

    // The position survives a restart (kept in the host database, not on the service).
    scheduler.dispose();
    nextPage = { schema: SCHEMA_VERSION, items: [], next: null, scanned: 1200 };
    const restarted = new SyncScheduler({
      engine,
      client,
      initialSettings: { ...DEFAULT_ONLINE_SETTINGS, ballotPortal: true },
      hostNumber: 1,
    });
    cleanups.push(() => restarted.dispose());
    await restarted.pullNow();
    expect(inboxAfter.at(-1)).toBe(500);
    await restarted.pullNow();
    expect(inboxAfter.at(-1)).toBe(1200);
  });
});
