import { describe, expect, it } from "vitest";
import { BUILT_IN_ROLES } from "@/permissions";
import { FIXED_TIME, makeTournament } from "@/test/tournamentFixtures";
import {
  applyOp,
  createTournamentState,
  defaultRegistry,
  type DeviceRecord,
} from "../index";
import {
  deepFreeze,
  expectOpRoundTrip,
  expectWrittenVersionBumps,
  TAB_ASSISTANT_ACTOR,
  TAB_DIRECTOR_ACTOR,
} from "../test-helpers";

describe("ops devices & host promotion", () => {
  it("approves, updates role, and removes devices with round-trip inverse and permission checks", () => {
    const registry = defaultRegistry();
    const state0 = {
      ...createTournamentState(makeTournament("bp")),
      succession: [] as string[],
    };
    const device: DeviceRecord = {
      id: "dev-1",
      name: "TD Backup Laptop",
      role: BUILT_IN_ROLES.tab_director,
      publicKey: "pk-base64-1",
      approvedAt: FIXED_TIME,
      rank: 1,
    };

    const forbidden = applyOp(
      deepFreeze(state0),
      { type: "device.approve", payload: { device } },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");

    const state1 = expectOpRoundTrip(
      state0,
      { type: "device.approve", payload: { device } },
      TAB_DIRECTOR_ACTOR,
    );
    expect(state1.devices).toHaveLength(1);
    expect(state1.succession).toEqual(["dev-1"]);

    const dup = applyOp(
      deepFreeze(state1),
      { type: "device.approve", payload: { device } },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe("INVALID");

    const state2 = expectOpRoundTrip(
      state1,
      {
        type: "device.set_role",
        payload: { deviceId: "dev-1", role: BUILT_IN_ROLES.tab_assistant },
      },
      TAB_DIRECTOR_ACTOR,
    );
    expect(state2.devices[0]?.role.id).toBe("tab_assistant");

    const state3 = expectOpRoundTrip(
      state2,
      { type: "device.remove", payload: { deviceId: "dev-1" } },
      TAB_DIRECTOR_ACTOR,
    );
    expect(state3.devices).toHaveLength(0);
    expect(state3.succession).toEqual([]);

    const assistantCannotRemove = applyOp(
      deepFreeze(state2),
      { type: "device.remove", payload: { deviceId: "dev-1" } },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(assistantCannotRemove.ok).toBe(false);
    if (!assistantCannotRemove.ok) expect(assistantCannotRemove.code).toBe("FORBIDDEN");

    const assistantCannotChangeRole = applyOp(
      deepFreeze(state1),
      {
        type: "device.set_role",
        payload: { deviceId: "dev-1", role: BUILT_IN_ROLES.tab_assistant },
      },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(assistantCannotChangeRole.ok).toBe(false);
    if (!assistantCannotChangeRole.ok) expect(assistantCannotChangeRole.code).toBe("FORBIDDEN");

    const missingRemoval = applyOp(
      deepFreeze(state1),
      { type: "device.remove", payload: { deviceId: "missing" } },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(missingRemoval.ok).toBe(false);
    if (!missingRemoval.ok) expect(missingRemoval.code).toBe("INVALID");

    const missingRoleTarget = applyOp(
      deepFreeze(state1),
      {
        type: "device.set_role",
        payload: { deviceId: "missing", role: BUILT_IN_ROLES.tab_assistant },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(missingRoleTarget.ok).toBe(false);
    if (!missingRoleTarget.ok) expect(missingRoleTarget.code).toBe("INVALID");
  });

  it("promotes host only with consecutive host number (host.number + 1)", () => {
    const registry = defaultRegistry();
    const state0 = {
      ...createTournamentState(makeTournament("bp")),
      host: { number: 1, id: "host-1", rank: 1 },
    };

    const forbidden = applyOp(
      deepFreeze(state0),
      {
        type: "host.promote",
        payload: { newHostNumber: 2, hostId: "host-2", rank: 1 },
      },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");

    const nonConsecutiveHigh = applyOp(
      deepFreeze(state0),
      {
        type: "host.promote",
        payload: { newHostNumber: 3, hostId: "host-2", rank: 1 },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(nonConsecutiveHigh.ok).toBe(false);
    if (!nonConsecutiveHigh.ok) expect(nonConsecutiveHigh.code).toBe("INVALID");

    const sameNumber = applyOp(
      deepFreeze(state0),
      {
        type: "host.promote",
        payload: { newHostNumber: 1, hostId: "host-2", rank: 1 },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(sameNumber.ok).toBe(false);
    if (!sameNumber.ok) expect(sameNumber.code).toBe("INVALID");

    const promoted = applyOp(
      deepFreeze(state0),
      {
        type: "host.promote",
        payload: { newHostNumber: 2, hostId: "host-2", rank: 2 },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;
    expect(promoted.state.host).toEqual({
      number: 2,
      id: "host-2",
      rank: 2,
    });
    expect(promoted.inverse).toBeNull();
    expectWrittenVersionBumps(state0, promoted);
  });
});
