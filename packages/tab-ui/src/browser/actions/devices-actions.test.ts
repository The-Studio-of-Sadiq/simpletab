import type {
  DeviceModeStatus,
  DevicesStatus,
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import { describe, expect, it } from "vitest";
import type { TournamentStoreSnapshot } from "../store/tournament-store";
import {
  approveJoinAction,
  cancelPairingCodeAction,
  groupCode,
  issuePairingCodeAction,
  promoteToHostAction,
  rejectJoinAction,
  removeDeviceAction,
  saveDeviceCopyAction,
  setDevicesEnabledAction,
  setSuccessionOrderAction,
} from "./devices-actions";
import {
  fakeStore,
  scriptedPrompts,
  testContext,
  type FakeStoreOptions,
} from "./test-context";

const SUBMIT = {
  ok: true,
  seq: 1,
  writes: [],
  committedPayload: null,
} as unknown as SubmitResult;

function deviceState(patch: Partial<ProjectedState> = {}): ProjectedState {
  return {
    roleId: "tab_director",
    permissions: ["devices.manage"],
    seq: 1,
    tournament: { id: "t-1" },
    rounds: [],
    versions: {},
    ...patch,
  } as unknown as ProjectedState;
}

function devicesStatus(patch: Partial<DevicesStatus> = {}): DevicesStatus {
  return {
    running: true,
    port: 47820,
    addresses: ["192.168.1.20"],
    hostFingerprint: "ab".repeat(32),
    codes: [],
    pendingJoins: [],
    connected: [],
    devices: [],
    succession: [],
    pairableRoles: [
      { id: "tab_director", name: "Tab director" },
      { id: "equity", name: "Equity" },
    ],
    ...patch,
  };
}

function director(patch: Partial<DeviceModeStatus> = {}): DeviceModeStatus {
  return {
    connection: "reconnecting",
    deviceId: "dev-2",
    hostAddress: "192.168.1.20:47820",
    deviceName: "Mina's laptop",
    roleId: "tab_director",
    roleName: "Tab director",
    queued: [],
    rejected: [],
    presence: [],
    copy: { lastSeq: 412 },
    ...patch,
  };
}

type Enableable = {
  isEnabled?: (snapshot: TournamentStoreSnapshot) => boolean;
};

function can(
  action: Enableable,
  state: ProjectedState | null,
  status: DevicesStatus = devicesStatus(),
): boolean {
  return (
    action.isEnabled?.(
      fakeStore(state, SUBMIT, { devicesStatus: status }).store.getSnapshot(),
    ) ?? false
  );
}

function options(status: DevicesStatus = devicesStatus()): FakeStoreOptions {
  return { devicesStatus: status };
}

describe("device actions", () => {
  it("offers device management only with a tournament and permission", () => {
    const state = deviceState();
    expect(can(setDevicesEnabledAction, state)).toBe(true);
    expect(can(setDevicesEnabledAction, null)).toBe(false);
    expect(can(setDevicesEnabledAction, deviceState({ permissions: [] }))).toBe(false);
    expect(can(setDevicesEnabledAction, state, { ...devicesStatus(), running: false })).toBe(true);
  });

  it("offers device actions before the Devices page has read the status (the prompt reads it)", () => {
    const state = deviceState();
    const unknown = (action: Enableable, s: ProjectedState | null) =>
      action.isEnabled?.(fakeStore(s, SUBMIT).store.getSnapshot()) ?? false;
    for (const action of [setDevicesEnabledAction, approveJoinAction, removeDeviceAction]) {
      expect(unknown(action, state)).toBe(true);
      expect(unknown(action, deviceState({ permissions: [] }))).toBe(false);
    }
  });

  it("asks for the connected switch and applies it", async () => {
    const { store, calls } = fakeStore(deviceState(), SUBMIT, options());
    const ctx = testContext(store, scriptedPrompts([true]));
    expect(await setDevicesEnabledAction.prompt(ctx)).toEqual({ enabled: true });
    expect(await setDevicesEnabledAction.prompt(testContext(store, scriptedPrompts([undefined])))).toBeUndefined();
    expect(await setDevicesEnabledAction.run(ctx, { enabled: false })).toEqual({ ok: true });
    expect(calls.enabledValues).toEqual([false]);
  });

  it("offers code actions only for a running server with the relevant entries", async () => {
    const state = deviceState();
    expect(can(issuePairingCodeAction, state)).toBe(true);
    expect(can(issuePairingCodeAction, state, devicesStatus({ running: false }))).toBe(false);
    expect(can(issuePairingCodeAction, state, devicesStatus({ pairableRoles: [] }))).toBe(false);
    expect(can(cancelPairingCodeAction, state)).toBe(false);
    expect(can(cancelPairingCodeAction, state, devicesStatus({
      codes: [{ code: "12345678", roleId: "equity", expiresAt: "2026-11-25T10:05:00.000Z" }],
    }))).toBe(true);
    expect(can(cancelPairingCodeAction, state, devicesStatus({
      running: false,
      codes: [{ code: "12345678", roleId: "equity", expiresAt: "2026-11-25T10:05:00.000Z" }],
    }))).toBe(false);

    const { store, calls } = fakeStore(deviceState(), SUBMIT, options(devicesStatus({
      codes: [{ code: "12345678", roleId: "equity", expiresAt: "2026-11-25T10:05:00.000Z" }],
    })));
    expect(await issuePairingCodeAction.prompt(testContext(store, scriptedPrompts([undefined])))).toBeUndefined();
    expect(await issuePairingCodeAction.prompt(testContext(store, scriptedPrompts(["equity"])))).toEqual({ roleId: "equity" });
    expect(await issuePairingCodeAction.run(testContext(store, scriptedPrompts([])), { roleId: "equity" })).toEqual({ ok: true });
    expect(calls.issuedRoleIds).toEqual(["equity"]);

    expect(await cancelPairingCodeAction.prompt(testContext(store, scriptedPrompts([undefined])))).toBeUndefined();
    expect(await cancelPairingCodeAction.prompt(testContext(store, scriptedPrompts(["12345678"])))).toEqual({ code: "12345678" });
    expect(await cancelPairingCodeAction.run(testContext(store, scriptedPrompts([])), { code: "12345678" })).toEqual({ ok: true });
    expect(calls.cancelledCodes).toEqual(["12345678"]);
    expect(groupCode("12345678")).toBe("1234 5678");
  });

  it("offers join decisions only with pending joins and calls the host", async () => {
    const status = devicesStatus({
      pendingJoins: [{
        joinId: "j1",
        deviceName: "Rafi's laptop",
        roleId: "tab_director",
        words: ["abandon", "ability", "able", "about", "above", "absent"],
        deviceFingerprint: "cd".repeat(32),
        expiresAt: "2026-11-25T10:02:00.000Z",
      }],
    });
    const state = deviceState();
    expect(can(approveJoinAction, state, status)).toBe(true);
    expect(can(rejectJoinAction, state, status)).toBe(true);
    expect(can(approveJoinAction, state)).toBe(false);
    expect(can(rejectJoinAction, state)).toBe(false);

    const { store, calls } = fakeStore(state, SUBMIT, options(status));
    for (const action of [approveJoinAction, rejectJoinAction]) {
      expect(await action.prompt(testContext(store, scriptedPrompts([undefined])))).toBeUndefined();
      expect(await action.prompt(testContext(store, scriptedPrompts(["j1"])))).toEqual({ joinId: "j1" });
    }
    const ctx = testContext(store, scriptedPrompts([]));
    expect(await approveJoinAction.run(ctx, { joinId: "j1" })).toEqual({ ok: true });
    expect(await rejectJoinAction.run(ctx, { joinId: "j1" })).toEqual({ ok: true });
    expect(calls.approvedJoinIds).toEqual(["j1"]);
    expect(calls.rejectedJoinIds).toEqual(["j1"]);
  });

  it("confirms before removing a device and calls the host", async () => {
    const status = devicesStatus({
      devices: [{
        deviceId: "dev-1",
        name: "Rafi's laptop",
        roleId: "tab_director",
        roleName: "Tab director",
        approvedAt: "2026-11-25T09:00:00.000Z",
        connected: true,
      }],
    });
    const state = deviceState();
    expect(can(removeDeviceAction, state, status)).toBe(true);
    expect(can(removeDeviceAction, state)).toBe(false);

    const { store, calls } = fakeStore(state, SUBMIT, options(status));
    expect(await removeDeviceAction.prompt(testContext(store, scriptedPrompts([undefined])))).toBeUndefined();
    expect(await removeDeviceAction.prompt(testContext(store, scriptedPrompts(["dev-1", false])))).toBeUndefined();
    expect(await removeDeviceAction.prompt(testContext(store, scriptedPrompts(["dev-1", true])))).toEqual({ deviceId: "dev-1" });
    expect(await removeDeviceAction.run(testContext(store, scriptedPrompts([])), { deviceId: "dev-1" })).toEqual({ ok: true });
    expect(calls.removedDeviceIds).toEqual(["dev-1"]);
  });

  it("asks which device to move and in which direction, then saves the order", async () => {
    const status = devicesStatus({
      succession: ["a", "b"],
      devices: [
        { deviceId: "a", name: "Rafi", roleId: "tab_director", roleName: "Tab director", approvedAt: "2026-11-25T09:00:00.000Z", connected: true },
        { deviceId: "b", name: "Mina", roleId: "tab_director", roleName: "Tab director", approvedAt: "2026-11-25T09:00:00.000Z", connected: true },
      ],
    });
    const state = deviceState();
    expect(can(setSuccessionOrderAction, state, status)).toBe(true);
    expect(can(setSuccessionOrderAction, state, devicesStatus({ succession: ["a"] }))).toBe(false);

    const { store, calls } = fakeStore(state, SUBMIT, options(status));
    expect(await setSuccessionOrderAction.prompt(testContext(store, scriptedPrompts([undefined])))).toBeUndefined();
    expect(await setSuccessionOrderAction.prompt(testContext(store, scriptedPrompts(["b", undefined])))).toBeUndefined();
    expect(await setSuccessionOrderAction.prompt(testContext(store, scriptedPrompts(["b", -1])))).toEqual({ order: ["b", "a"] });
    await setSuccessionOrderAction.run(testContext(store, scriptedPrompts([])), { order: ["b", "a"] });
    expect(calls.successionOrders).toEqual([["b", "a"]]);
  });

  it("offers promotion only to a tab director whose host is unreachable, with a copy", async () => {
    const state = deviceState();
    expect(can(promoteToHostAction, state, devicesStatus())).toBe(false);
    expect(can(promoteToHostAction, null, devicesStatus())).toBe(false);

    const enabled = (action: Enableable, device: DeviceModeStatus): boolean =>
      action.isEnabled?.(
        fakeStore(null, SUBMIT, { status: { device } }).store.getSnapshot(),
      ) ?? false;
    expect(enabled(promoteToHostAction, director())).toBe(true);
    expect(enabled(saveDeviceCopyAction, director())).toBe(true);
    expect(enabled(promoteToHostAction, director({ connection: "connected" }))).toBe(false);
    expect(enabled(promoteToHostAction, director({ roleId: "equity" }))).toBe(false);
    expect(enabled(promoteToHostAction, director({ copy: undefined }))).toBe(false);
    expect(can(promoteToHostAction, state)).toBe(false);
  });

  it("asks for a folder, optional newer copy and confirmation before promoting", async () => {
    const { store, calls } = fakeStore(null, SUBMIT, {
      status: { device: director() },
    });
    const ctx = testContext(store, scriptedPrompts([" C:/tabs ", " C:/wudc.copy.simpletab ", true]));
    expect(await promoteToHostAction.prompt(ctx)).toEqual({
      directory: "C:/tabs",
      newerCopyPath: "C:/wudc.copy.simpletab",
    });
    expect(await promoteToHostAction.prompt(testContext(store, scriptedPrompts([undefined])))).toBeUndefined();
    expect(await promoteToHostAction.prompt(testContext(store, scriptedPrompts(["C:/tabs", undefined])))).toBeUndefined();
    expect(await promoteToHostAction.prompt(testContext(store, scriptedPrompts(["C:/tabs", "", false])))).toBeUndefined();
    expect(await promoteToHostAction.prompt(testContext(store, scriptedPrompts(["  ", "", true])))).toBeUndefined();

    expect(await promoteToHostAction.run(ctx, { directory: "C:/tabs" })).toEqual({ ok: true });
    expect(calls.promoteParams).toEqual([{ directory: "C:/tabs" }]);
  });

  it("asks for a folder and returns the saved copy path", async () => {
    const { store, calls } = fakeStore(null, SUBMIT, {
      status: { device: director() },
      exportCopyFile: "C:/tabs/wudc.copy-412.simpletab",
    });
    const ctx = testContext(store, scriptedPrompts([" C:/tabs "]));
    expect(await saveDeviceCopyAction.prompt(ctx)).toEqual({ directory: "C:/tabs" });
    expect(await saveDeviceCopyAction.prompt(testContext(store, scriptedPrompts([undefined])))).toBeUndefined();
    expect(await saveDeviceCopyAction.run(ctx, { directory: "C:/tabs" })).toEqual({
      ok: true,
      file: "C:/tabs/wudc.copy-412.simpletab",
    });
    expect(calls.exportDirectories).toEqual(["C:/tabs"]);
  });
});
