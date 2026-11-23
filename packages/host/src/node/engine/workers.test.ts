import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import {
  createTournamentState,
  type Actor,
  type OpRequest,
  type TournamentState,
} from "@simpletab/core/ops";
import {
  makeRound,
  makeTeams,
  makeTournament,
  makeVenues,
} from "@simpletab/core/test/tournamentFixtures";
import { HostEngine, fastCheck, fullCheck } from "../index";

const FIXED_DATE = new Date("2026-11-24T00:00:00.000Z");

const HOST_OWNER: Actor = {
  ref: "host-owner-1",
  type: "human",
  role: BUILT_IN_ROLES.host_owner,
  isHostOwner: true,
};

const TAB_DIRECTOR: Actor = {
  ref: "tab-director-1",
  type: "human",
  role: BUILT_IN_ROLES.tab_director,
  isHostOwner: false,
};

function makeDrawReadyState(teamCount = 16): TournamentState {
  const tournament = makeTournament("bp");
  const teams = makeTeams(teamCount, { tournamentId: tournament.id });
  const venues = makeVenues(teamCount / 4, tournament.id);
  const round = makeRound(tournament.id, 1);
  return createTournamentState(tournament, {
    teams,
    venues,
    rounds: [round],
  });
}

async function waitForLock(engine: HostEngine, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = engine.locks();
    if (active.length > 0) {
      return active[0]!.lockId;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for long-op lock to be acquired.");
}

describe("long ops in worker threads, locks, and cancellation", () => {
  const engines: HostEngine[] = [];

  function track(engine: HostEngine): HostEngine {
    engines.push(engine);
    return engine;
  }

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => engine.close()));
  });

  it("runs draw.generate in a worker thread while keeping the main thread timer responsive", { timeout: 20_000 }, async () => {
    const initial = makeDrawReadyState(32);
    const roundId = initial.rounds[0]!.id;
    const engine = track(HostEngine.open(":memory:", {
      initialState: initial,
      clock: () => new Date(FIXED_DATE),
      // Synchronous CPU spin inside the worker proves the computation runs off the main thread.
      longOpWorkerDelayMs: 120,
    }));

    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 10);

    try {
      const drawPromise = engine.submit(
        {
          type: "draw.generate",
          payload: { roundId, seed: 42 },
        },
        TAB_DIRECTOR,
      );

      const lockId = await waitForLock(engine);
      const active = engine.locks();
      expect(active).toEqual([
        {
          lockId,
          opType: "draw.generate",
          actorRef: TAB_DIRECTOR.ref,
          startedAt: FIXED_DATE.toISOString(),
        },
      ]);

      const result = await drawPromise;
      expect(result.ok).toBe(true);
      expect(engine.locks()).toEqual([]);
      expect(ticks).toBeGreaterThanOrEqual(3);
      expect(engine.getState()?.debates).toHaveLength(8);
      expect(engine.head().seq).toBe(1);
      expect(await fastCheck(engine.database)).toEqual({ ok: true });
      expect(await fullCheck(engine.database)).toEqual({ ok: true });
    } finally {
      clearInterval(timer);
    }
  });

  it("allows host owner to cancel a running long op, terminating the worker, applying nothing, and releasing the lock", { timeout: 20_000 }, async () => {
    const initial = makeDrawReadyState(16);
    const roundId = initial.rounds[0]!.id;
    const engine = track(HostEngine.open(":memory:", {
      initialState: initial,
      clock: () => new Date(FIXED_DATE),
      longOpWorkerDelayMs: 400,
    }));

    const initialHash = engine.getStateHash();
    const drawPromise = engine.submit(
      {
        type: "draw.generate",
        payload: { roundId, seed: 99 },
      },
      TAB_DIRECTOR,
    );

    const lockId = await waitForLock(engine);
    const cancelled = await engine.cancelLong(lockId, HOST_OWNER);
    expect(cancelled).toEqual({ ok: true, lockId });

    const drawResult = await drawPromise;
    expect(drawResult).toMatchObject({ ok: false, code: "CANCELLED" });
    expect(engine.locks()).toEqual([]);
    expect(engine.head().seq).toBe(0);
    expect(engine.getState()?.debates).toEqual([]);
    expect(engine.getStateHash()).toBe(initialHash);
  });

  it("refuses cancelLong from a tab director and lets the long op finish normally", { timeout: 20_000 }, async () => {
    const initial = makeDrawReadyState(16);
    const roundId = initial.rounds[0]!.id;
    const engine = track(HostEngine.open(":memory:", {
      initialState: initial,
      clock: () => new Date(FIXED_DATE),
      longOpWorkerDelayMs: 120,
    }));

    const drawPromise = engine.submit(
      {
        type: "draw.generate",
        payload: { roundId, seed: 7 },
      },
      TAB_DIRECTOR,
    );

    const lockId = await waitForLock(engine);
    const refused = await engine.cancelLong(lockId, TAB_DIRECTOR);
    expect(refused).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(engine.locks()).toHaveLength(1);

    const drawResult = await drawPromise;
    expect(drawResult.ok).toBe(true);
    expect(engine.locks()).toEqual([]);
    expect(engine.getState()?.debates).toHaveLength(4);
  });

  it("rejects overlapping ops with LOCKED while a lock is held, and allows disjoint ops", { timeout: 20_000 }, async () => {
    const initial = makeDrawReadyState(16);
    const round = initial.rounds[0]!;
    const engine = track(HostEngine.open(":memory:", {
      initialState: initial,
      clock: () => new Date(FIXED_DATE),
      longOpWorkerDelayMs: 200,
    }));

    const drawPromise = engine.submit(
      {
        type: "draw.generate",
        payload: { roundId: round.id, seed: 123 },
      },
      TAB_DIRECTOR,
    );

    const lockId = await waitForLock(engine);

    // Overlapping op writing the same round record must be rejected with LOCKED.
    const overlappingUpdate: OpRequest = {
      type: "round.update",
      payload: { round: { ...round, name: "Renamed while locked" } },
    };
    const lockedResult = await engine.submit(overlappingUpdate, TAB_DIRECTOR);
    expect(lockedResult).toMatchObject({
      ok: false,
      code: "LOCKED",
      lockId,
    });

    // Another draw.generate for the same round also overlaps and gets LOCKED.
    const secondDraw = await engine.submit(
      {
        type: "draw.generate",
        payload: { roundId: round.id, seed: 456 },
      },
      TAB_DIRECTOR,
    );
    expect(secondDraw).toMatchObject({
      ok: false,
      code: "LOCKED",
      lockId,
    });

    // A disjoint op touching records neither read nor written by draw.generate succeeds.
    const disjoint = await engine.submit(
      {
        type: "device.approve",
        payload: {
          device: {
            id: "dev-1",
            name: "Co-TD Laptop",
            role: BUILT_IN_ROLES.tab_director,
            publicKey: "pk-1",
            approvedAt: FIXED_DATE.toISOString(),
          },
        },
      },
      HOST_OWNER,
    );
    expect(disjoint.ok).toBe(true);

    const drawResult = await drawPromise;
    expect(drawResult.ok).toBe(true);
    expect(engine.locks()).toEqual([]);
    expect(engine.getState()?.devices).toHaveLength(1);
    expect(engine.getState()?.debates).toHaveLength(4);
    expect(await fastCheck(engine.database)).toEqual({ ok: true });
    expect(await fullCheck(engine.database)).toEqual({ ok: true });
  });
});
