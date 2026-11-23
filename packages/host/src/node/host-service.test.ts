import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import type { HostLockInfo, StateChangedEvent } from "../common/host-protocol";
import { HostServiceImpl } from "./host-service";

describe("HostServiceImpl", () => {
  const tempDirs: string[] = [];
  const services: HostServiceImpl[] = [];

  function createService(): HostServiceImpl {
    const service = new HostServiceImpl();
    services.push(service);
    return service;
  }

  afterEach(async () => {
    for (const service of services.splice(0)) {
      await service.onStop();
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports closed status initially and rejects ops when closed", async () => {
    const service = createService();
    const status = await service.status();
    expect(status).toEqual({
      open: false,
      locks: [],
    });
    expect(await service.getState()).toBeNull();
    expect(await service.getChangelog()).toEqual([]);
    expect(await service.getLocks()).toEqual([]);
    expect(await service.cancelLong("missing-lock")).toEqual({
      ok: false,
      code: "NO_TOURNAMENT",
      errors: ["No tournament is currently open."],
    });

    const submitResult = await service.submit({
      type: "institution.create",
      payload: {
        institution: {
          id: "inst-1",
          tournamentId: "t-1",
          name: "Oxford",
          code: "OXF",
        },
      },
    });
    expect(submitResult.ok).toBe(false);
    if (!submitResult.ok) {
      expect(submitResult.code).toBe("NO_TOURNAMENT");
    }
  });

  it("creates, seeds, and reopens a demo BP tournament", async () => {
    const service = createService();
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "simpletab-host-svc-"));
    tempDirs.push(tempDir);

    const created = await service.createDemoTournament(tempDir);
    expect(created.dbPath).toBe(path.join(tempDir, "bp-demo.simpletab.db"));
    expect(created.status.open).toBe(true);
    expect(created.status.slug).toBe("bp-demo");
    expect(created.status.headSeq).toBe(5);
    expect(created.status.integrityOk).toBe(true);
    expect(created.status.canSync).toBe(true);
    expect(created.status.locks).toEqual([]);

    const reopened = await service.openTournament(created.dbPath);
    expect(reopened).toEqual(created.status);
  });

  it("creates tournaments from BP and two-team presets and rejects unsupported presets", async () => {
    const service = createService();
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "simpletab-host-preset-"));
    tempDirs.push(tempDir);

    const bpCreated = await service.createTournament({
      name: "Winter BP 2026",
      slug: "winter-bp-2026",
      format: "bp",
      presetId: "bp",
      prelimRounds: 3,
      directory: tempDir,
    });
    expect(bpCreated.dbPath).toBe(path.join(tempDir, "winter-bp-2026.simpletab.db"));
    expect(bpCreated.state.tournament.format).toBe("bp");
    expect(bpCreated.state.tournament.preferences.teamsInDebate).toBe(4);
    expect(bpCreated.state.rounds.filter((r) => r.stage === "preliminary")).toHaveLength(3);
    expect(bpCreated.state.breakCategories[0]?.breakSize).toBe(8);
    expect(bpCreated.status.integrityOk).toBe(true);

    const uadcCreated = await service.createTournament({
      name: "Asia UADC",
      slug: "asia-uadc",
      format: "two-team",
      presetId: "uadc",
      prelimRounds: 5,
      directory: tempDir,
    });
    expect(uadcCreated.state.tournament.format).toBe("uadc");
    expect(uadcCreated.state.tournament.preferences.teamsInDebate).toBe(2);
    expect(uadcCreated.state.tournament.preferences.substantiveSpeakers).toBe(3);
    expect(uadcCreated.state.tournament.preferences.replyScoresEnabled).toBe(true);
    expect(uadcCreated.state.rounds.filter((r) => r.stage === "preliminary")).toHaveLength(5);

    await expect(
      service.createTournament({
        name: "Duplicate",
        slug: "asia-uadc",
        format: "two-team",
        presetId: "uadc",
        directory: tempDir,
      }),
    ).rejects.toThrow(/already exists/i);

    await expect(
      service.createTournament({
        name: "Poly Rejected",
        slug: "poly-rejected",
        format: "two-team",
        presetId: "public_speaking",
        directory: tempDir,
      }),
    ).rejects.toThrow(/unsupported/i);

    await expect(
      service.createTournament({
        name: "Mismatch",
        slug: "mismatch-slug",
        format: "bp",
        presetId: "uadc",
        directory: tempDir,
      }),
    ).rejects.toThrow(/does not match/i);
  });

  it("submits ops, enforces validation/versions, undoes ops, and emits onStateChanged notifications", async () => {
    const service = createService();
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "simpletab-host-ops-"));
    tempDirs.push(tempDir);

    const events: StateChangedEvent[] = [];
    service.setClient({
      onStateChanged(event) {
        events.push(event);
      },
    });

    const created = await service.createTournament({
      name: "Bridge Test",
      slug: "bridge-test",
      format: "bp",
      presetId: "bp",
      prelimRounds: 2,
      directory: tempDir,
    });
    const tournamentId = created.state.tournament.id;
    expect(events.at(-1)?.type).toBe("tournament.created");

    const invalidResult = await service.submit({
      type: "institution.create",
      payload: {
        institution: {
          id: "inst-bad",
          tournamentId,
          name: "",
          code: "BAD",
        },
      },
    });
    expect(invalidResult.ok).toBe(false);
    if (!invalidResult.ok) {
      expect(invalidResult.code).toBe("INVALID");
      expect(invalidResult.errors.length).toBeGreaterThan(0);
    }

    const createInst = await service.submit({
      type: "institution.create",
      payload: {
        institution: {
          id: "inst-oxf",
          tournamentId,
          name: "Oxford Union",
          code: "OXF",
        },
      },
    });
    expect(createInst.ok).toBe(true);
    if (!createInst.ok) {
      throw new Error("Expected institution.create to succeed");
    }
    expect(events.some((e) => e.seq === createInst.seq && e.type === "institution.create")).toBe(
      true,
    );

    const staleUpdate = await service.submit({
      type: "institution.update",
      expectedVersions: { "institution:inst-oxf": 99 },
      payload: {
        institution: {
          id: "inst-oxf",
          tournamentId,
          name: "Oxford Stale",
          code: "OXF",
        },
      },
    });
    expect(staleUpdate.ok).toBe(false);
    if (!staleUpdate.ok) {
      expect(staleUpdate.code).toBe("VERSION_CONFLICT");
      expect(staleUpdate.current?.["institution:inst-oxf"]).toBe(1);
    }

    const validUpdate = await service.submit({
      type: "institution.update",
      expectedVersions: { "institution:inst-oxf": 1 },
      payload: {
        institution: {
          id: "inst-oxf",
          tournamentId,
          name: "Oxford Updated",
          code: "OXF",
        },
      },
    });
    expect(validUpdate.ok).toBe(true);

    // Earlier create op is blocked from undo because validUpdate wrote the same record.
    const blockedUndo = await service.undo(createInst.seq);
    expect(blockedUndo.ok).toBe(false);
    if (!blockedUndo.ok) {
      expect(blockedUndo.code).toBe("CANNOT_UNDO");
      expect(blockedUndo.blockingSeqs).toContain(validUpdate.ok ? validUpdate.seq : -1);
    }

    // Undoing the latest op succeeds and notifies the client.
    if (validUpdate.ok) {
      const undoLatest = await service.undo(validUpdate.seq);
      expect(undoLatest.ok).toBe(true);
      const afterUndo = await service.getState();
      expect(afterUndo?.institutions.find((i) => i.id === "inst-oxf")?.name).toBe(
        "Oxford Union",
      );
      expect(events.at(-1)?.type).toBe("institution.update");
    }

    const fullLog = await service.getChangelog();
    const afterLog = await service.getChangelog(createInst.seq - 1, 2);
    expect(fullLog.length).toBeGreaterThanOrEqual(4);
    expect(afterLog).toHaveLength(2);
    expect(afterLog[0]?.entry.seq).toBe(createInst.seq);
  });

  it("projects getState according to the local role", async () => {
    const service = createService();
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "simpletab-host-proj-"));
    tempDirs.push(tempDir);

    const created = await service.createTournament({
      name: "Projection Test",
      slug: "projection-test",
      format: "bp",
      presetId: "bp",
      prelimRounds: 1,
      directory: tempDir,
    });
    const tournamentId = created.state.tournament.id;

    await service.submit({
      type: "adjudicator.create",
      payload: {
        adjudicator: {
          id: "adj-1",
          tournamentId,
          name: "Judge Secret",
          email: "judge@example.com",
          baseScore: 8.5,
          trainee: false,
          independent: true,
          conflicts: [{ teamId: "team-1", type: "personal" }],
        },
      },
    });

    const ownerState = await service.getState();
    expect(ownerState?.roleId).toBe("host_owner");
    expect(ownerState?.adjudicators[0]?.email).toBe("judge@example.com");
    expect(ownerState?.adjudicators[0]?.baseScore).toBe(8.5);
    expect(ownerState?.adjudicators[0]?.conflicts).toHaveLength(1);

    service.setLocalRole(BUILT_IN_ROLES.display);
    const displayState = await service.getState();
    expect(displayState?.roleId).toBe("display");
    expect(displayState?.adjudicators[0]?.email).toBeUndefined();
    expect(displayState?.adjudicators[0]?.baseScore).toBe(0);
    expect(displayState?.adjudicators[0]?.conflicts).toEqual([]);
  });

  it("exposes getLocks, pushes onLocksChanged, and enforces host-owner permission on cancelLong", { timeout: 20_000 }, async () => {
    const service = createService();
    service.setLongOpWorkerDelayMs(250);
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "simpletab-host-locks-"));
    tempDirs.push(tempDir);

    const lockEvents: HostLockInfo[][] = [];
    service.setClient({
      onStateChanged() {},
      onLocksChanged(locks) {
        lockEvents.push(locks);
      },
    });

    const created = await service.createDemoTournament(tempDir);
    expect(created.status.open).toBe(true);
    const initialState = await service.getState();
    const roundId = initialState?.rounds[0]?.id;
    expect(roundId).toBeTruthy();

    const drawPromise = service.submit({
      type: "draw.generate",
      payload: { roundId, seed: 42 },
    });

    let activeLocks: HostLockInfo[] = [];
    await vi.waitFor(async () => {
      activeLocks = await service.getLocks();
      expect(activeLocks).toHaveLength(1);
    });

    const activeLock = activeLocks[0]!;
    expect(activeLock.opType).toBe("draw.generate");
    expect(activeLock.actorRef).toBe("host-owner");
    expect(activeLock.roundId).toBe(roundId);
    expect(activeLock.lockId).toBeTruthy();
    expect(activeLock.startedAt).toBeTruthy();

    // Non-host-owner cannot cancel
    service.setLocalRole(BUILT_IN_ROLES.tab_director);
    const forbiddenCancel = await service.cancelLong(activeLock.lockId);
    expect(forbiddenCancel).toMatchObject({ ok: false, code: "FORBIDDEN" });

    // Host owner can cancel
    service.setLocalRole(BUILT_IN_ROLES.host_owner);
    const notFound = await service.cancelLong("non-existent-lock");
    expect(notFound).toMatchObject({ ok: false, code: "NOT_FOUND" });

    const cancelled = await service.cancelLong(activeLock.lockId);
    expect(cancelled).toEqual({ ok: true, lockId: activeLock.lockId });

    const drawResult = await drawPromise;
    expect(drawResult).toMatchObject({ ok: false, code: "CANCELLED" });
    expect(await service.getLocks()).toEqual([]);
    expect((await service.getState())?.debates).toEqual([]);
    expect(lockEvents.some((list) => list.length === 1 && list[0]?.lockId === activeLock.lockId)).toBe(true);
    expect(lockEvents.at(-1)).toEqual([]);
  });
});
