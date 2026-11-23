import { isPermission, type Role } from "@/permissions";
import {
  cloneValue,
  insertAt,
  isNonEmptyText,
  isValidIsoInstant,
} from "../setup/helpers";
import {
  recordKey,
  type DeviceRecord,
  type HostRecord,
  type OpDef,
} from "../types";

export interface DeviceApprovePayload {
  device: DeviceRecord;
  index?: number;
  restoreSuccession?: string[];
}

export interface DeviceRemovePayload {
  deviceId: string;
  previous?: DeviceRecord;
  previousIndex?: number;
  previousSuccession?: string[];
}

export interface DeviceSetRolePayload {
  deviceId: string;
  role: Role;
  previousRole?: Role;
}

export interface HostPromotePayload {
  newHostNumber: number;
  hostId: string;
  rank: number;
  previousHost?: HostRecord;
}

function validateRole(role: Role): string[] {
  if (typeof role !== "object" || role === null || Array.isArray(role)) {
    return ["Device role must be an object."];
  }
  const errors: string[] = [];
  if (!isNonEmptyText(role.id)) {
    errors.push("Role id must not be empty.");
  }
  if (!isNonEmptyText(role.name)) {
    errors.push("Role name must not be empty.");
  }
  if (!Array.isArray(role.permissions)) {
    errors.push("Role permissions must be an array.");
  } else {
    for (const perm of role.permissions) {
      if (!isPermission(perm)) {
        errors.push(`Unknown permission in device role: ${String(perm)}.`);
      }
    }
  }
  return errors;
}

export const deviceApproveOp: OpDef<DeviceApprovePayload> = {
  type: "device.approve",
  permission: "devices.manage",
  category: "devices",
  visibility: "private",
  lock: false,
  reads(_state, payload) {
    return [recordKey("device", payload.device.id)];
  },
  writes(_state, payload) {
    return [recordKey("device", payload.device.id)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    const { device } = payload;
    if (!isNonEmptyText(device.id)) {
      errors.push("Device id must not be empty.");
    } else if (state.devices.some((item) => item.id === device.id)) {
      errors.push(`Device ${device.id} is already approved.`);
    }
    if (!isNonEmptyText(device.name)) {
      errors.push("Device name must not be empty.");
    }
    if (!isNonEmptyText(device.publicKey)) {
      errors.push("Device publicKey must not be empty.");
    }
    if (!isValidIsoInstant(device.approvedAt)) {
      errors.push("Device approvedAt must be a valid ISO 8601 instant.");
    }
    if (
      device.rank !== undefined &&
      (!Number.isInteger(device.rank) || device.rank < 1)
    ) {
      errors.push("Device rank must be a positive integer.");
    }
    errors.push(...validateRole(device.role));
    return errors;
  },
  apply(state, payload) {
    const created = cloneValue(payload.device);
    let nextSuccession = state.succession;
    if (payload.restoreSuccession !== undefined) {
      nextSuccession = [...payload.restoreSuccession];
    } else if (
      state.succession !== undefined &&
      created.role.id === "tab_director" &&
      !state.succession.includes(created.id)
    ) {
      nextSuccession = [...state.succession, created.id];
    }

    return {
      state: {
        ...state,
        devices: insertAt(state.devices, created, payload.index),
        ...(nextSuccession !== undefined
          ? { succession: nextSuccession }
          : {}),
      },
      committedPayload: {
        device: cloneValue(created),
        ...(payload.index !== undefined ? { index: payload.index } : {}),
        ...(payload.restoreSuccession !== undefined
          ? { restoreSuccession: [...payload.restoreSuccession] }
          : {}),
      },
    };
  },
  inverse(committedPayload) {
    return {
      type: "device.remove",
      payload: {
        deviceId: committedPayload.device.id,
      },
    };
  },
};

export const deviceRemoveOp: OpDef<DeviceRemovePayload> = {
  type: "device.remove",
  permission: "devices.manage",
  category: "devices",
  visibility: "private",
  lock: false,
  reads(_state, payload) {
    return [recordKey("device", payload.deviceId)];
  },
  writes(_state, payload) {
    return [recordKey("device", payload.deviceId)];
  },
  validate(state, payload) {
    if (!isNonEmptyText(payload.deviceId)) {
      return ["deviceId must not be empty."];
    }
    if (!state.devices.some((item) => item.id === payload.deviceId)) {
      return [`Device ${payload.deviceId} does not exist.`];
    }
    return [];
  },
  apply(state, payload) {
    const index = state.devices.findIndex(
      (item) => item.id === payload.deviceId,
    );
    const previous = cloneValue(state.devices[index]!);
    const previousSuccession =
      state.succession !== undefined ? [...state.succession] : undefined;
    const nextSuccession =
      state.succession !== undefined
        ? state.succession.filter((id) => id !== payload.deviceId)
        : undefined;

    return {
      state: {
        ...state,
        devices: state.devices.filter((item) => item.id !== payload.deviceId),
        ...(nextSuccession !== undefined
          ? { succession: nextSuccession }
          : {}),
      },
      committedPayload: {
        deviceId: payload.deviceId,
        previous,
        previousIndex: index,
        ...(previousSuccession !== undefined ? { previousSuccession } : {}),
      },
    };
  },
  inverse(committedPayload) {
    if (!committedPayload.previous) {
      return null;
    }
    return {
      type: "device.approve",
      payload: {
        device: cloneValue(committedPayload.previous),
        index: committedPayload.previousIndex,
        ...(committedPayload.previousSuccession !== undefined
          ? { restoreSuccession: [...committedPayload.previousSuccession] }
          : {}),
      },
    };
  },
};

export const deviceSetRoleOp: OpDef<DeviceSetRolePayload> = {
  type: "device.set_role",
  permission: "devices.manage",
  category: "devices",
  visibility: "private",
  lock: false,
  reads(_state, payload) {
    return [recordKey("device", payload.deviceId)];
  },
  writes(_state, payload) {
    return [recordKey("device", payload.deviceId)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    if (!isNonEmptyText(payload.deviceId)) {
      errors.push("deviceId must not be empty.");
    } else if (!state.devices.some((item) => item.id === payload.deviceId)) {
      errors.push(`Device ${payload.deviceId} does not exist.`);
    }
    errors.push(...validateRole(payload.role));
    return errors;
  },
  apply(state, payload) {
    const existing = state.devices.find(
      (item) => item.id === payload.deviceId,
    )!;
    const previousRole = cloneValue(existing.role);
    const nextRole = cloneValue(payload.role);

    return {
      state: {
        ...state,
        devices: state.devices.map((item) =>
          item.id === payload.deviceId
            ? { ...cloneValue(item), role: nextRole }
            : item,
        ),
      },
      committedPayload: {
        deviceId: payload.deviceId,
        role: cloneValue(nextRole),
        previousRole,
      },
    };
  },
  inverse(committedPayload) {
    if (!committedPayload.previousRole) {
      return null;
    }
    return {
      type: "device.set_role",
      payload: {
        deviceId: committedPayload.deviceId,
        role: cloneValue(committedPayload.previousRole),
      },
    };
  },
};

export const hostPromoteOp: OpDef<HostPromotePayload> = {
  type: "host.promote",
  permission: "host.promote",
  category: "host",
  visibility: "private",
  lock: false,
  reads(state) {
    return [recordKey("host", state.tournament.id)];
  },
  writes(state) {
    return [recordKey("host", state.tournament.id)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    if (!Number.isInteger(payload.newHostNumber)) {
      errors.push("newHostNumber must be an integer.");
    } else {
      const currentNumber = state.host?.number ?? 1;
      if (payload.newHostNumber !== currentNumber + 1) {
        errors.push(
          `newHostNumber must be ${currentNumber + 1} (current host number + 1), got ${payload.newHostNumber}.`,
        );
      }
    }
    if (!isNonEmptyText(payload.hostId)) {
      errors.push("hostId must not be empty.");
    }
    if (!Number.isInteger(payload.rank) || payload.rank < 1) {
      errors.push("rank must be a positive integer.");
    }
    return errors;
  },
  apply(state, payload) {
    const previousHost = state.host ? cloneValue(state.host) : undefined;
    const nextHost: HostRecord = {
      number: payload.newHostNumber,
      id: payload.hostId,
      rank: payload.rank,
    };
    return {
      state: {
        ...state,
        host: nextHost,
      },
      committedPayload: {
        ...cloneValue(payload),
        ...(previousHost ? { previousHost } : {}),
      },
    };
  },
  inverse() {
    return null;
  },
};
