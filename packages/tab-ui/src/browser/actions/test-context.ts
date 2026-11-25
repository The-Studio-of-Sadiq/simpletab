import type { OpRequest } from "@simpletab/core/ops";
import type {
  ArchiveStatus,
  DevicesStatus,
  HostCancelLongResult,
  HostStatus,
  OnlineSettings,
  ProjectedState,
  PromoteParams,
  PublishStatus,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import { DEFAULT_ONLINE_SETTINGS } from "@simpletab/host/lib/common/host-protocol";
import type { IssuedPairingCode } from "@simpletab/host/lib/common/collab-protocol";
import type { TournamentStore, TournamentStoreSnapshot } from "../store/tournament-store";
import type {
  ActionContext,
  ActionPrompts,
  ActionResult,
  ActionRunner,
  SimpleTabAction,
} from "./action";

/** Answers the palette prompts in order, as a person would; tests only. */
export interface ScriptedPrompts extends ActionPrompts {
  asked: string[];
}

export function scriptedPrompts(answers: unknown[]): ScriptedPrompts {
  const queue = [...answers];
  const asked: string[] = [];
  const next = <T,>(label: string): T | undefined => {
    asked.push(label);
    return queue.shift() as T | undefined;
  };
  return {
    asked,
    pick: async <T,>(_items: ReadonlyArray<{ label: string; value: T }>, placeholder: string) =>
      next<T>(placeholder),
    input: async (prompt: string) => next<string>(prompt),
    confirm: async (title: string) => next<boolean>(title) === true,
  };
}

export interface FakeStoreOptions {
  status?: Partial<HostStatus>;
  publishStatus?: PublishStatus;
  archiveStatus?: ArchiveStatus;
  devicesStatus?: DevicesStatus;
  cancelLongResult?: HostCancelLongResult;
  exportCopyFile?: string;
}

export interface FakeStoreCalls {
  submitted: OpRequest[];
  statusReads: number;
  publishStatusReads: number;
  archiveStatusReads: number;
  devicesStatusReads: number;
  publishNow: number;
  archiveNow: number;
  onlineSettingsPatches: Partial<OnlineSettings>[];
  cancelLongIds: string[];
  enabledValues: boolean[];
  issuedRoleIds: string[];
  cancelledCodes: string[];
  approvedJoinIds: string[];
  rejectedJoinIds: string[];
  removedDeviceIds: string[];
  successionOrders: string[][];
  promoteParams: PromoteParams[];
  exportDirectories: string[];
}

export interface FakeStore {
  submitted: OpRequest[];
  calls: FakeStoreCalls;
  store: TournamentStore;
}

const OK = { ok: true, seq: 1, writes: [] } as unknown as SubmitResult;

const EMPTY_DEVICES_STATUS: DevicesStatus = {
  running: false,
  addresses: [],
  codes: [],
  pendingJoins: [],
  connected: [],
  devices: [],
  succession: [],
  pairableRoles: [],
};

/** A store with a fixed state that records submitted ops and host calls; tests only. */
export function fakeStore(
  state: ProjectedState | null,
  result: SubmitResult = OK,
  options: FakeStoreOptions = {},
): FakeStore {
  const calls: FakeStoreCalls = {
    submitted: [],
    statusReads: 0,
    publishStatusReads: 0,
    archiveStatusReads: 0,
    devicesStatusReads: 0,
    publishNow: 0,
    archiveNow: 0,
    onlineSettingsPatches: [],
    cancelLongIds: [],
    enabledValues: [],
    issuedRoleIds: [],
    cancelledCodes: [],
    approvedJoinIds: [],
    rejectedJoinIds: [],
    removedDeviceIds: [],
    successionOrders: [],
    promoteParams: [],
    exportDirectories: [],
  };
  const status: HostStatus = {
    open: state !== null,
    locks: [],
    ...options.status,
  };
  const snapshot = {
    state,
    status,
    loading: false,
    error: null,
    lastEvent: null,
    ...(options.devicesStatus !== undefined
      ? { devicesStatus: options.devicesStatus }
      : {}),
  } as unknown as TournamentStoreSnapshot;
  const publishStatus = options.publishStatus ?? { state: "done" };
  const archiveStatus = options.archiveStatus ?? { state: "done" };
  const devicesStatus = options.devicesStatus ?? EMPTY_DEVICES_STATUS;

  const store = {
    getSnapshot: () => snapshot,
    getState: () => state,
    getStatus: () => {
      calls.statusReads += 1;
      return status;
    },
    submit: async (request: OpRequest) => {
      calls.submitted.push(request);
      return result;
    },
    getPublishStatus: async () => {
      calls.publishStatusReads += 1;
      return publishStatus;
    },
    publishNow: async () => {
      calls.publishNow += 1;
      return publishStatus;
    },
    getArchiveStatus: async () => {
      calls.archiveStatusReads += 1;
      return archiveStatus;
    },
    archiveNow: async () => {
      calls.archiveNow += 1;
      return archiveStatus;
    },
    updateOnlineSettings: async (patch: Partial<OnlineSettings>): Promise<OnlineSettings> => {
      calls.onlineSettingsPatches.push(patch);
      return { ...DEFAULT_ONLINE_SETTINGS, ...patch };
    },
    cancelLong: async (lockId: string): Promise<HostCancelLongResult> => {
      calls.cancelLongIds.push(lockId);
      return options.cancelLongResult ?? { ok: true, lockId };
    },
    getDevicesStatus: async () => {
      calls.devicesStatusReads += 1;
      return devicesStatus;
    },
    setDevicesEnabled: async (enabled: boolean) => {
      calls.enabledValues.push(enabled);
      return devicesStatus;
    },
    issuePairingCode: async (roleId: string): Promise<IssuedPairingCode> => {
      calls.issuedRoleIds.push(roleId);
      return {
        code: "12345678",
        roleId,
        expiresAt: "2026-11-25T10:05:00.000Z",
      };
    },
    cancelPairingCode: async (code: string) => {
      calls.cancelledCodes.push(code);
    },
    approveJoin: async (joinId: string) => {
      calls.approvedJoinIds.push(joinId);
    },
    rejectJoin: async (joinId: string) => {
      calls.rejectedJoinIds.push(joinId);
    },
    removeDevice: async (deviceId: string) => {
      calls.removedDeviceIds.push(deviceId);
    },
    setSuccession: async (order: string[]) => {
      calls.successionOrders.push(order);
    },
    promoteToHost: async (params: PromoteParams): Promise<HostStatus> => {
      calls.promoteParams.push(params);
      return status;
    },
    exportDeviceCopy: async (directory: string) => {
      calls.exportDirectories.push(directory);
      return options.exportCopyFile ?? "";
    },
  } as unknown as TournamentStore;
  return { submitted: calls.submitted, calls, store };
}

export function testContext(
  store: TournamentStore,
  prompts: ActionPrompts,
  openPage: (widgetId: string) => Promise<void> = async () => undefined,
): ActionContext {
  return { store, prompts, openPage };
}

/** Runs actions with known arguments, the way a page button does; tests only. */
export function directRunner(
  store: TournamentStore,
  prompts: ActionPrompts = scriptedPrompts([]),
): ActionRunner {
  const ctx = testContext(store, prompts);
  const run = <A, R extends ActionResult>(
    action: SimpleTabAction<A, R>,
    args: A,
  ): Promise<R> => action.run(ctx, args);
  return run as unknown as ActionRunner;
}
