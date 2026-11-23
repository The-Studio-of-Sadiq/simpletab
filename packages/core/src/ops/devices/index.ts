import { eraseOpType } from "../setup/helpers";
import type { OpDef } from "../types";
import {
  deviceApproveOp,
  deviceRemoveOp,
  deviceSetRoleOp,
  hostPromoteOp,
} from "./devices";

export * from "./devices";

export const DEVICE_OPS: readonly OpDef<unknown>[] = [
  eraseOpType(deviceApproveOp),
  eraseOpType(deviceRemoveOp),
  eraseOpType(deviceSetRoleOp),
  eraseOpType(hostPromoteOp),
];
