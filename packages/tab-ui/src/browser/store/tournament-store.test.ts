import type {
  CreateTournamentResult,
  HostLockInfo,
  HostService,
  HostStatus,
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import { HostServiceClientDispatcher } from "./host-service-client";
import { TournamentStore } from "./tournament-store";

function makeProjectedState(seq: number, slug = "demo"): ProjectedState {
  return {
    seq,
    roleId: "host_owner",
    versions: {},
    tournament: {
      id: `t-${slug}`,
      name: "Demo",
      shortName: "Demo",
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
        feedbackEnabled: false,
        feedbackMinScore: 1,
        feedbackMaxScore: 5,
      },
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
    rounds: [],
    teams: [],
    adjudicators: [],
    institutions: [],
    venues: [],
    debates: [],
    motions: [],
    ballots: [],
    feedback: [],
    breakCategories: [],
  };
}

describe("TournamentStore", () => {
  it("caches ProjectedState, refreshes on onStateChanged, and returns per-op SubmitResult", async () => {
    let currentSeq = 1;
    let currentStatus: HostStatus = {
      open: true,
      slug: "demo",
      headSeq: 1,
      integrityOk: true,
      canSync: true,
      locks: [],
    };

    const submitMock = vi.fn<HostService["submit"]>(async (req) => {
      if (req.type === "institution.create") {
        return {
          ok: false,
          code: "INVALID",
          errors: ["Institution name must not be empty."],
        } satisfies SubmitResult;
      }
      currentSeq = 2;
      currentStatus = { ...currentStatus, headSeq: 2 };
      return {
        ok: true,
        seq: 2,
        writes: ["tournament:t-demo"],
        committedPayload: req.payload,
      } satisfies SubmitResult;
    });

    const hostService: HostService = {
      setClient: vi.fn(),
      dispose: vi.fn(),
      status: vi.fn(async () => currentStatus),
      openTournament: vi.fn(async () => currentStatus),
      createDemoTournament: vi.fn(),
      createTournament: vi.fn(
        async (): Promise<CreateTournamentResult> => ({
          dbPath: "/tmp/demo.simpletab.db",
          status: currentStatus,
          state: makeProjectedState(1),
        }),
      ),
      submit: submitMock,
      undo: vi.fn(),
      getLocks: vi.fn(async () => []),
      cancelLong: vi.fn(async (lockId: string) => ({ ok: true as const, lockId })),
      getState: vi.fn(async () => makeProjectedState(currentSeq)),
      getChangelog: vi.fn(async () => []),
      getOpUndoInfo: vi.fn(async () => []),
    };

    const dispatcher = new HostServiceClientDispatcher();
    const store = new TournamentStore(hostService, dispatcher);

    await store.refresh();
    expect(store.getState()?.seq).toBe(1);

    const failResult = await store.submit({
      type: "institution.create",
      payload: {
        institution: {
          id: "inst-1",
          tournamentId: "t-demo",
          name: "",
          code: "OXF",
        },
      },
    });
    expect(failResult).toEqual({
      ok: false,
      code: "INVALID",
      errors: ["Institution name must not be empty."],
    });

    // Simulate backend push notification after an external commit
    currentSeq = 3;
    currentStatus = { ...currentStatus, headSeq: 3 };
    dispatcher.onStateChanged({
      seq: 3,
      type: "team.create",
      writes: ["team:team-1"],
    });

    await vi.waitFor(() => {
      expect(store.getState()?.seq).toBe(3);
      expect(store.getSnapshot().lastEvent?.seq).toBe(3);
    });

    store.dispose();
  });

  it("updates cached state immediately on createTournament", async () => {
    const createdState = makeProjectedState(4, "new-tourney");
    const createdStatus: HostStatus = {
      open: true,
      slug: "new-tourney",
      headSeq: 4,
      integrityOk: true,
      canSync: true,
      locks: [],
    };
    const hostService: HostService = {
      setClient: vi.fn(),
      dispose: vi.fn(),
      status: vi.fn(async () => ({ open: false, locks: [] })),
      openTournament: vi.fn(),
      createDemoTournament: vi.fn(),
      createTournament: vi.fn(async () => ({
        dbPath: "/tmp/new-tourney.simpletab.db",
        status: createdStatus,
        state: createdState,
      })),
      submit: vi.fn(),
      undo: vi.fn(),
      getLocks: vi.fn(async () => []),
      cancelLong: vi.fn(async (lockId: string) => ({ ok: true as const, lockId })),
      getState: vi.fn(async () => null),
      getChangelog: vi.fn(async () => []),
      getOpUndoInfo: vi.fn(async () => []),
    };

    const store = new TournamentStore(hostService);
    await store.createTournament({
      name: "New Tourney",
      slug: "new-tourney",
      format: "bp",
      presetId: "bp",
      prelimRounds: 4,
      directory: "/tmp",
    });

    expect(store.getStatus().slug).toBe("new-tourney");
    expect(store.getState()?.seq).toBe(4);
    store.dispose();
  });

  it("updates locks via onLocksChanged and calls hostService.cancelLong", async () => {
    const activeLock: HostLockInfo = {
      lockId: "lock-1",
      opType: "draw.generate",
      actorRef: "host-owner",
      startedAt: "2026-11-24T00:00:00.000Z",
      roundId: "r-1",
    };
    let currentLocks: HostLockInfo[] = [activeLock];
    const cancelLongMock = vi.fn<HostService["cancelLong"]>(async (lockId: string) => {
      currentLocks = [];
      return { ok: true, lockId };
    });

    const hostService: HostService = {
      setClient: vi.fn(),
      dispose: vi.fn(),
      status: vi.fn(async () => ({ open: true, slug: "demo", headSeq: 1, locks: currentLocks })),
      openTournament: vi.fn(),
      createDemoTournament: vi.fn(),
      createTournament: vi.fn(),
      submit: vi.fn(),
      undo: vi.fn(),
      getLocks: vi.fn(async () => currentLocks),
      cancelLong: cancelLongMock,
      getState: vi.fn(async () => makeProjectedState(1)),
      getChangelog: vi.fn(async () => []),
      getOpUndoInfo: vi.fn(async () => []),
    };

    const dispatcher = new HostServiceClientDispatcher();
    const store = new TournamentStore(hostService, dispatcher);

    dispatcher.onLocksChanged([activeLock]);
    expect(store.getStatus().locks).toEqual([activeLock]);

    const cancelled = await store.cancelLong("lock-1");
    expect(cancelled).toEqual({ ok: true, lockId: "lock-1" });
    expect(cancelLongMock).toHaveBeenCalledWith("lock-1");
    expect(store.getStatus().locks).toEqual([]);
    store.dispose();
  });
});
