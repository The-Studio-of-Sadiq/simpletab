import type { PublicChainItem } from "@simpletab/core/changelog";
import type { OpRequest } from "@simpletab/core/ops";
import type {
  ExtensionEntryStatus,
  ExtensionsResult,
  ExtensionsRestartService,
  ExtensionsService,
  ExtensionsStatus,
} from "@simpletab/extensions/lib/common/extensions-protocol";
import type {
  CredentialName,
  CredentialStatusEntry,
  CredentialTestResult,
  CredentialsService,
} from "@simpletab/host/lib/common/credentials-protocol";
import type {
  ArchiveStatus,
  CreateDemoResult,
  CreateTournamentParams,
  CreateTournamentResult,
  DevicesStatus,
  HostCancelLongResult,
  HostIntegrityCheckResult,
  HostStatus,
  JoinHostParams,
  JoinProgress,
  OnlineSettings,
  OpUndoInfo,
  ProjectedState,
  PromoteParams,
  PublishStatus,
  QrReceiveResult,
  SubmitResult,
  SyncStatus,
} from "@simpletab/host/lib/common/host-protocol";
import { DEFAULT_ONLINE_SETTINGS } from "@simpletab/host/lib/common/host-protocol";
import {
  DEFAULT_PROJECTOR_CONTROL,
  type ProjectorControlPatch,
  type ProjectorControlState,
  type ProjectorService,
  type ProjectorSyncPayload,
} from "@simpletab/host/lib/common/projector-protocol";
import type { IssuedPairingCode } from "@simpletab/host/lib/common/collab-protocol";
import type { TournamentStore, TournamentStoreSnapshot } from "../store/tournament-store";
import type {
  ActionContext,
  ActionPrompts,
  ActionResult,
  ActionRunner,
  ActionServices,
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
    pickFile: async (title: string) => next<string>(title),
    openTextFile: async (title: string) => next<string>(title),
  };
}

export interface FakeStoreOptions {
  status?: Partial<HostStatus>;
  publishStatus?: PublishStatus;
  archiveStatus?: ArchiveStatus;
  devicesStatus?: DevicesStatus;
  cancelLongResult?: HostCancelLongResult;
  exportCopyFile?: string;
  /** Result returned by `undo`; defaults to the result passed to `fakeStore`. */
  undoResult?: SubmitResult;
  /** Result returned by `receiveQrBallot`; defaults to `ok: true`. */
  receiveQrBallot?: (codes: string[]) => Promise<QrReceiveResult>;
  /** Live state for action `run` methods; defaults to the state passed to `fakeStore`. */
  getState?: () => ProjectedState | null;
  /** Result returned by `createTournament`; defaults to a minimal success result. */
  createTournamentResult?: (params: CreateTournamentParams) => CreateTournamentResult;
  /** Status returned by `openTournament`; defaults to the store status. */
  openTournamentStatus?: (dbPath: string) => HostStatus;
  /** Changelog and undo info for the Changelog undo prompt; default empty. */
  changelog?: PublicChainItem[];
  opUndoInfo?: OpUndoInfo[];
  /** This session's last draw/allocation change per round, keyed `<opType>:<roundId>`. */
  lastRoundOpSeqs?: Record<string, number>;
  fullCheckResult?: HostIntegrityCheckResult;
  pullNowResult?: SyncStatus;
  createDemoResult?: (directory: string) => CreateDemoResult;
  joinProgress?: (params: JoinHostParams) => JoinProgress;
  displayState?: ProjectedState | null;
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
  undoneSeqs: number[];
  qrCodes: string[][];
  createTournamentParams: CreateTournamentParams[];
  openTournamentPaths: string[];
  fullChecks: number;
  pulls: number;
  demoDirectories: string[];
  joinParams: JoinHostParams[];
  leftHost: number;
  dismissedRejected: number;
  displayStateReads: number;
}

export interface FakeStore {
  submitted: OpRequest[];
  calls: FakeStoreCalls;
  store: TournamentStore;
  undoneSeqs: number[];
}

const OK = { ok: true, seq: 1, writes: [] } as unknown as SubmitResult;
const OK_QR: QrReceiveResult = {
  ok: true,
  seq: 1,
  roundId: "",
  debateId: "",
};

const OK_FULL_CHECK: HostIntegrityCheckResult = { ok: true };
const OK_SYNC: SyncStatus = {
  enabled: true,
  active: true,
  hostNumber: 1,
  ackedThrough: 1,
  consecutiveFailures: 0,
};

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
    undoneSeqs: [],
    qrCodes: [],
    createTournamentParams: [],
    openTournamentPaths: [],
    fullChecks: 0,
    pulls: 0,
    demoDirectories: [],
    joinParams: [],
    leftHost: 0,
    dismissedRejected: 0,
    displayStateReads: 0,
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
    getState: () => options.getState?.() ?? state,
    getStatus: () => {
      calls.statusReads += 1;
      return status;
    },
    submit: async (request: OpRequest) => {
      calls.submitted.push(request);
      return result;
    },
    undo: async (seq: number): Promise<SubmitResult> => {
      calls.undoneSeqs.push(seq);
      return options.undoResult ?? result;
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
    getChangelog: async (): Promise<PublicChainItem[]> => options.changelog ?? [],
    getOpUndoInfo: async (): Promise<OpUndoInfo[]> => options.opUndoInfo ?? [],
    getLastRoundOpSeq: (opType: string, roundId: string): number | undefined =>
      options.lastRoundOpSeqs?.[`${opType}:${roundId}`],
    receiveQrBallot: async (codes: string[]): Promise<QrReceiveResult> => {
      calls.qrCodes.push(codes);
      return options.receiveQrBallot?.(codes) ?? OK_QR;
    },
    createTournament: async (params: CreateTournamentParams): Promise<CreateTournamentResult> => {
      calls.createTournamentParams.push(params);
      return options.createTournamentResult?.(params) ?? {
        dbPath: `${params.directory || "/tmp"}/${params.slug}.db`,
        workspaceDir: params.directory,
        status,
        state: state ?? ({} as ProjectedState),
      };
    },
    openTournament: async (dbPath: string): Promise<HostStatus> => {
      calls.openTournamentPaths.push(dbPath);
      return options.openTournamentStatus?.(dbPath) ?? status;
    },
    runFullCheck: async (): Promise<HostIntegrityCheckResult> => {
      calls.fullChecks += 1;
      return options.fullCheckResult ?? OK_FULL_CHECK;
    },
    pullNow: async (): Promise<SyncStatus> => {
      calls.pulls += 1;
      return options.pullNowResult ?? OK_SYNC;
    },
    createDemoTournament: async (directory: string): Promise<CreateDemoResult> => {
      calls.demoDirectories.push(directory);
      return (
        options.createDemoResult?.(directory) ?? {
          dbPath: `${directory || "/tmp"}/demo.db`,
          workspaceDir: directory,
          status,
        }
      );
    },
    startJoin: async (params: JoinHostParams): Promise<JoinProgress> => {
      calls.joinParams.push(params);
      return options.joinProgress?.(params) ?? { state: "connecting" };
    },
    leaveHost: async () => {
      calls.leftHost += 1;
    },
    dismissRejectedEdits: async () => {
      calls.dismissedRejected += 1;
    },
    getDisplayState: async (): Promise<ProjectedState | null> => {
      calls.displayStateReads += 1;
      return options.displayState ?? null;
    },
  } as unknown as TournamentStore;
  return { submitted: calls.submitted, calls, store, undoneSeqs: calls.undoneSeqs };
}

export interface FakeCredentialsCalls {
  statusReads: number;
  sets: Array<{ name: CredentialName; value: string }>;
  clears: CredentialName[];
  tests: CredentialName[];
}

export function fakeCredentialsService(
  options: {
    status?: CredentialStatusEntry[];
    set?: (name: CredentialName, value: string) => Promise<void>;
    clear?: (name: CredentialName) => Promise<void>;
    test?: (name: CredentialName) => Promise<CredentialTestResult>;
  } = {},
): { service: CredentialsService; calls: FakeCredentialsCalls } {
  const calls: FakeCredentialsCalls = { statusReads: 0, sets: [], clears: [], tests: [] };
  const service = {
    status: async () => {
      calls.statusReads += 1;
      return options.status ?? [];
    },
    set: async (name: CredentialName, value: string) => {
      calls.sets.push({ name, value });
      await options.set?.(name, value);
    },
    clear: async (name: CredentialName) => {
      calls.clears.push(name);
      await options.clear?.(name);
    },
    test: async (name: CredentialName) => {
      calls.tests.push(name);
      return options.test?.(name) ?? { ok: true };
    },
  } as CredentialsService;
  return { service, calls };
}

export interface FakeProjectorCalls {
  syncPayloadReads: number;
  opens: number;
  closes: number;
  fullscreenToggles: number;
  updates: ProjectorControlPatch[];
  starts: Array<number | undefined>;
  pauses: number;
  resets: Array<number | undefined>;
  pushes: Array<ProjectorSyncPayload["displayState"]>;
}

export function fakeProjectorService(
  initial: ProjectorControlState = DEFAULT_PROJECTOR_CONTROL,
): {
  service: ProjectorService;
  calls: FakeProjectorCalls;
  getControl: () => ProjectorControlState;
} {
  let control: ProjectorControlState = {
    ...initial,
    countdown: { ...initial.countdown },
  };
  const calls: FakeProjectorCalls = {
    syncPayloadReads: 0,
    opens: 0,
    closes: 0,
    fullscreenToggles: 0,
    updates: [],
    starts: [],
    pauses: 0,
    resets: [],
    pushes: [],
  };
  const service = {
    getSyncPayload: async () => {
      calls.syncPayloadReads += 1;
      return { control, displayState: null };
    },
    openProjector: async () => {
      calls.opens += 1;
      control = { ...control, open: true };
      return control;
    },
    closeProjector: async () => {
      calls.closes += 1;
      control = { ...control, open: false };
      return control;
    },
    toggleFullscreen: async () => {
      calls.fullscreenToggles += 1;
      control = { ...control, fullscreen: !control.fullscreen };
      return control;
    },
    updateControl: async (patch: ProjectorControlPatch) => {
      calls.updates.push(patch);
      control = { ...control, ...patch };
      return control;
    },
    startCountdown: async (durationSeconds?: number) => {
      calls.starts.push(durationSeconds);
      control = { ...control, countdown: { ...control.countdown, running: true } };
      return control;
    },
    pauseCountdown: async () => {
      calls.pauses += 1;
      control = { ...control, countdown: { ...control.countdown, running: false } };
      return control;
    },
    resetCountdown: async (durationSeconds?: number) => {
      calls.resets.push(durationSeconds);
      control = { ...control, countdown: { ...control.countdown, running: false } };
      return control;
    },
    pushDisplayState: async (displayState: ProjectorSyncPayload["displayState"]) => {
      calls.pushes.push(displayState);
    },
  } as unknown as ProjectorService;
  return { service, calls, getControl: () => control };
}

/** A minimal live status for an Extensions action or page test. */
export function fakeExtensionsStatus(
  overrides: Partial<ExtensionsStatus> = {},
): ExtensionsStatus {
  return {
    extensions: [],
    reason: "may-host",
    startupReason: null,
    restartNeeded: false,
    ignoredFiles: [],
    ...overrides,
  };
}

/** A sample entry with all the fields the Extensions page shows. */
export function fakeExtensionEntry(
  overrides: Partial<ExtensionEntryStatus> = {},
): ExtensionEntryStatus {
  return {
    id: "pub.example@1.0.0",
    version: "1.0.0",
    name: "Example extension",
    purpose: "Example purpose",
    license: "MIT",
    installed: false,
    on: true,
    loaded: false,
    ...overrides,
  };
}

export interface FakeExtensionsCalls {
  statusReads: number;
  installs: string[];
  installFromFilePaths: string[];
  removes: string[];
  setOns: Array<{ id: string; on: boolean }>;
}

export function fakeExtensionsService(
  options: {
    status?: ExtensionsStatus | (() => Promise<ExtensionsStatus>);
    result?: ExtensionsResult;
  } = {},
): { service: ExtensionsService; calls: FakeExtensionsCalls } {
  const calls: FakeExtensionsCalls = {
    statusReads: 0,
    installs: [],
    installFromFilePaths: [],
    removes: [],
    setOns: [],
  };
  const readStatus = async (): Promise<ExtensionsStatus> => {
    calls.statusReads += 1;
    return typeof options.status === "function"
      ? options.status()
      : (options.status ?? fakeExtensionsStatus());
  };
  const result = async (): Promise<ExtensionsResult> =>
    options.result ?? { ok: true, status: await readStatus() };
  const service = {
    status: readStatus,
    install: async (id: string) => {
      calls.installs.push(id);
      return result();
    },
    installFromFile: async (filePath: string) => {
      calls.installFromFilePaths.push(filePath);
      return result();
    },
    remove: async (id: string) => {
      calls.removes.push(id);
      return result();
    },
    setOn: async (id: string, on: boolean) => {
      calls.setOns.push({ id, on });
      return result();
    },
  } as ExtensionsService;
  return { service, calls };
}

export function fakeExtensionsRestartService(
  options: { relaunch?: () => Promise<void> } = {},
): {
  service: ExtensionsRestartService;
  calls: { relaunches: number };
} {
  const calls = { relaunches: 0 };
  const service = {
    relaunch: async () => {
      calls.relaunches += 1;
      await options.relaunch?.();
    },
  } as ExtensionsRestartService;
  return { service, calls };
}

export function testContext(
  store: TournamentStore,
  prompts: ActionPrompts,
  openPage: (widgetId: string) => Promise<void> = async () => undefined,
  services: ActionServices = {},
): ActionContext {
  return { store, prompts, openPage, services };
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

export interface RunnerOptions {
  /** Fixed state, or a live getter so retries see fresh versions. */
  state: ProjectedState | null | (() => ProjectedState | null);
  submit: (request: OpRequest) => Promise<SubmitResult>;
  undo?: (seq: number) => Promise<SubmitResult>;
  cancelLong?: (lockId: string) => Promise<HostCancelLongResult | void>;
  receiveQrBallot?: (codes: string[]) => Promise<QrReceiveResult>;
}

/** Adapts a page's old op callbacks to the action runner it now receives. */
export function runnerFor(options: RunnerOptions): ActionRunner {
  const getState =
    typeof options.state === "function" ? options.state : () => options.state;
  const store = {
    getState,
    submit: options.submit,
    undo: options.undo ?? (async () => OK),
    cancelLong:
      options.cancelLong ??
      (async (lockId: string) => ({ ok: true, lockId })),
    receiveQrBallot: options.receiveQrBallot ?? (async () => OK_QR),
  } as unknown as TournamentStore;
  return directRunner(store);
}
