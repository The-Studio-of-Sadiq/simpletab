import { eraseOpType } from "../setup/helpers";
import type { OpDef } from "../types";
import {
  allocationAssignManualOp,
  allocationAutoOp,
  allocationRestoreOp,
  allocationSwapRoomsOp,
} from "./allocation";
import {
  allocationPreformedAutofillOp,
  allocationPreformedSaveOp,
} from "./preformed";

export * from "./allocation";
export * from "./preformed";

export const ALLOCATION_OPS: readonly OpDef<unknown>[] = [
  eraseOpType(allocationAutoOp),
  eraseOpType(allocationRestoreOp),
  eraseOpType(allocationAssignManualOp),
  eraseOpType(allocationSwapRoomsOp),
  eraseOpType(allocationPreformedSaveOp),
  eraseOpType(allocationPreformedAutofillOp),
];
