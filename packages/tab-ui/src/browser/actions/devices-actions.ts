import type { IssuedPairingCode } from "@simpletab/host/lib/common/collab-protocol";
import type { DeviceModeStatus, DevicesStatus } from "@simpletab/host/lib/common/host-protocol";
import { t } from "../i18n";
import { stateHasPermission } from "../lib/permissions";
import type { TournamentStoreSnapshot } from "../store/tournament-store";
import { defineAction, type ActionContext } from "./action";

/** Widget id of the Devices page. Promotion lives on the Setup page (see below). */
export const DEVICES_PAGE = "simpletab-devices-widget";
export const SETUP_PAGE = "simpletab-setup-widget";

function canManage(snapshot: TournamentStoreSnapshot): boolean {
  return (
    snapshot.state !== null &&
    snapshot.status.open &&
    stateHasPermission(snapshot.state, "devices.manage")
  );
}

function deviceStatus(snapshot: TournamentStoreSnapshot): DevicesStatus | undefined {
  return snapshot.devicesStatus;
}

/**
 * Whether the last known devices status allows something. Until the Devices page or a prompt has
 * read the status, it is unknown, and the palette offers the action (its prompt reads the live
 * status) rather than hiding it from someone who has not opened the Devices page yet.
 */
function statusAllows(
  snapshot: TournamentStoreSnapshot,
  test: (status: DevicesStatus) => boolean,
): boolean {
  const status = deviceStatus(snapshot);
  return canManage(snapshot) && (status === undefined || test(status));
}

function modeOf(snapshot: TournamentStoreSnapshot): DeviceModeStatus | undefined {
  return snapshot.status.device;
}

function canPromote(snapshot: TournamentStoreSnapshot): boolean {
  const device = modeOf(snapshot);
  return (
    device !== undefined &&
    device.roleId === "tab_director" &&
    device.connection !== "connected" &&
    device.copy !== undefined
  );
}

async function liveStatus(ctx: ActionContext): Promise<DevicesStatus> {
  return ctx.store.getDevicesStatus();
}

async function pickOnOff(ctx: ActionContext, placeholder: string): Promise<boolean | undefined> {
  return ctx.prompts.pick(
    [
      { label: t("action.devices.on"), value: true },
      { label: t("action.devices.off"), value: false },
    ],
    placeholder,
  );
}

export interface SetDevicesEnabledArgs {
  enabled: boolean;
}

export const setDevicesEnabledAction = defineAction<SetDevicesEnabledArgs>({
  id: "simpletab.devices.set-enabled",
  labelKey: "action.devices.setEnabled",
  page: DEVICES_PAGE,
  isEnabled(snapshot) {
    return canManage(snapshot);
  },
  async prompt(ctx) {
    const enabled = await pickOnOff(ctx, t("action.devices.pickEnabled"));
    return enabled === undefined ? undefined : { enabled };
  },
  async run(ctx, { enabled }) {
    await ctx.store.setDevicesEnabled(enabled);
    return { ok: true };
  },
});

export interface IssuePairingCodeArgs {
  roleId: string;
}

export const issuePairingCodeAction = defineAction<IssuePairingCodeArgs>({
  id: "simpletab.devices.issue-code",
  labelKey: "action.devices.issueCode",
  page: DEVICES_PAGE,
  isEnabled(snapshot) {
    return statusAllows(snapshot, (status) => status.running && status.pairableRoles.length > 0);
  },
  async prompt(ctx) {
    const status = await liveStatus(ctx);
    const roleId = await ctx.prompts.pick(
      status.pairableRoles.map((role) => ({
        label: role.name,
        value: role.id,
      })),
      t("action.devices.pickRole"),
    );
    return roleId === undefined ? undefined : { roleId };
  },
  async run(ctx, { roleId }) {
    await ctx.store.issuePairingCode(roleId);
    return { ok: true };
  },
});

export function groupCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}

function codeLabel(code: IssuedPairingCode, status: DevicesStatus): string {
  const role = status.pairableRoles.find((item) => item.id === code.roleId);
  const name = role?.name ?? code.roleId;
  return `${groupCode(code.code)} · ${name}`;
}

export interface CancelPairingCodeArgs {
  code: string;
}

export const cancelPairingCodeAction = defineAction<CancelPairingCodeArgs>({
  id: "simpletab.devices.cancel-code",
  labelKey: "action.devices.cancelCode",
  page: DEVICES_PAGE,
  isEnabled(snapshot) {
    return statusAllows(snapshot, (status) => status.running && status.codes.length > 0);
  },
  async prompt(ctx) {
    const status = await liveStatus(ctx);
    const codes = status.running ? status.codes : [];
    const code = await ctx.prompts.pick(
      codes.map((item) => ({
        label: codeLabel(item, status),
        description: t("devices.cancelCode"),
        value: item.code,
      })),
      t("action.devices.pickCode"),
    );
    return code === undefined ? undefined : { code };
  },
  async run(ctx, { code }) {
    await ctx.store.cancelPairingCode(code);
    return { ok: true };
  },
});

export interface JoinArgs {
  joinId: string;
}

async function pickJoin(ctx: ActionContext, placeholder: string): Promise<JoinArgs | undefined> {
  const status = await liveStatus(ctx);
  const joinId = await ctx.prompts.pick(
    status.pendingJoins.map((join) => {
      const role = status.pairableRoles.find((item) => item.id === join.roleId);
      return {
        label: join.deviceName,
        description: t("devices.pendingRole", {
          role: role?.name ?? join.roleId,
        }),
        value: join.joinId,
      };
    }),
    placeholder,
  );
  return joinId === undefined ? undefined : { joinId };
}

function hasJoin(snapshot: TournamentStoreSnapshot): boolean {
  return statusAllows(snapshot, (status) => status.pendingJoins.length > 0);
}

export const approveJoinAction = defineAction<JoinArgs>({
  id: "simpletab.devices.approve-join",
  labelKey: "action.devices.approveJoin",
  page: DEVICES_PAGE,
  isEnabled: hasJoin,
  async prompt(ctx) {
    return pickJoin(ctx, t("action.devices.pickJoinToApprove"));
  },
  async run(ctx, { joinId }) {
    await ctx.store.approveJoin(joinId);
    return { ok: true };
  },
});

export const rejectJoinAction = defineAction<JoinArgs>({
  id: "simpletab.devices.reject-join",
  labelKey: "action.devices.rejectJoin",
  page: DEVICES_PAGE,
  isEnabled: hasJoin,
  async prompt(ctx) {
    return pickJoin(ctx, t("action.devices.pickJoinToReject"));
  },
  async run(ctx, { joinId }) {
    await ctx.store.rejectJoin(joinId);
    return { ok: true };
  },
});

export interface RemoveDeviceArgs {
  deviceId: string;
}

export const removeDeviceAction = defineAction<RemoveDeviceArgs>({
  id: "simpletab.devices.remove-device",
  labelKey: "action.devices.removeDevice",
  page: DEVICES_PAGE,
  isEnabled(snapshot) {
    return statusAllows(snapshot, (status) => status.devices.length > 0);
  },
  async prompt(ctx) {
    const status = await liveStatus(ctx);
    const deviceId = await ctx.prompts.pick(
      status.devices.map((device) => ({
        label: device.name,
        description: device.roleName,
        value: device.deviceId,
      })),
      t("action.devices.pickDeviceToRemove"),
    );
    if (deviceId === undefined) return undefined;
    const device = status.devices.find((item) => item.deviceId === deviceId);
    const confirmed = await ctx.prompts.confirm(
      t("devices.remove"),
      t("devices.removeConfirm", { name: device?.name ?? deviceId }),
    );
    return confirmed ? { deviceId } : undefined;
  },
  async run(ctx, { deviceId }) {
    await ctx.store.removeDevice(deviceId);
    return { ok: true };
  },
});

export interface SetSuccessionArgs {
  order: string[];
}

export const setSuccessionOrderAction = defineAction<SetSuccessionArgs>({
  id: "simpletab.devices.set-succession",
  labelKey: "action.devices.setSuccession",
  page: DEVICES_PAGE,
  isEnabled(snapshot) {
    return statusAllows(snapshot, (status) => status.succession.length > 1);
  },
  async prompt(ctx) {
    const status = await liveStatus(ctx);
    if (status.succession.length < 2) return undefined;
    const deviceId = await ctx.prompts.pick(
      status.succession.map((id, index) => ({
        label: status.devices.find((item) => item.deviceId === id)?.name ?? id,
        description: t("promote.rank", { rank: index + 1 }),
        value: id,
      })),
      t("action.devices.pickDeviceToMove"),
    );
    if (deviceId === undefined) return undefined;
    const direction = await ctx.prompts.pick(
      [
        { label: t("devices.up"), value: -1 },
        { label: t("devices.down"), value: 1 },
      ],
      t("action.devices.pickDirection"),
    );
    if (direction === undefined) return undefined;
    const from = status.succession.indexOf(deviceId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= status.succession.length) return undefined;
    const order = [...status.succession];
    order.splice(from, 1);
    order.splice(to, 0, deviceId);
    return { order };
  },
  async run(ctx, { order }) {
    await ctx.store.setSuccession(order);
    return { ok: true };
  },
});

export interface PromoteArgs {
  directory: string;
  newerCopyPath?: string;
}

export const promoteToHostAction = defineAction<PromoteArgs>({
  id: "simpletab.devices.promote",
  labelKey: "action.devices.promote",
  page: SETUP_PAGE,
  isEnabled: canPromote,
  async prompt(ctx) {
    const directory = await ctx.prompts.input(t("promote.folderLabel"));
    if (directory === undefined || directory.trim().length === 0) return undefined;
    const newerCopy = await ctx.prompts.input(t("promote.newerCopyLabel"), {
      optional: true,
    });
    if (newerCopy === undefined) return undefined;
    const confirmed = await ctx.prompts.confirm(
      t("promote.promote"),
      t("promote.confirm"),
    );
    if (!confirmed) return undefined;
    return {
      directory: directory.trim(),
      ...(newerCopy.trim().length > 0
        ? { newerCopyPath: newerCopy.trim() }
        : {}),
    };
  },
  async run(ctx, { directory, newerCopyPath }) {
    await ctx.store.promoteToHost({
      directory,
      ...(newerCopyPath !== undefined ? { newerCopyPath } : {}),
    });
    return { ok: true };
  },
});

export interface SaveCopyArgs {
  directory: string;
}

export interface SaveCopyResult {
  ok: true;
  file: string;
}

export const saveDeviceCopyAction = defineAction<SaveCopyArgs, SaveCopyResult>({
  id: "simpletab.devices.save-copy",
  labelKey: "action.devices.saveCopy",
  page: SETUP_PAGE,
  isEnabled: canPromote,
  async prompt(ctx) {
    const directory = await ctx.prompts.input(t("promote.folderLabel"));
    if (directory === undefined || directory.trim().length === 0) return undefined;
    return { directory: directory.trim() };
  },
  async run(ctx, { directory }) {
    const file = await ctx.store.exportDeviceCopy(directory);
    return { ok: true, file };
  },
});

export const DEVICES_ACTIONS = [
  setDevicesEnabledAction,
  issuePairingCodeAction,
  cancelPairingCodeAction,
  approveJoinAction,
  rejectJoinAction,
  removeDeviceAction,
  setSuccessionOrderAction,
  promoteToHostAction,
  saveDeviceCopyAction,
] as const;
