import { eraseOpType } from "../setup/helpers";
import type { OpDef } from "../types";
import {
  breakCategoriesSaveOp,
  breakClearOp,
  breakComputeOp,
  breakTeamOverrideOp,
  eliminationAdvanceOp,
} from "./breaks";

export * from "./breaks";

export const BREAK_OPS: readonly OpDef<unknown>[] = [
  eraseOpType(breakCategoriesSaveOp),
  eraseOpType(breakTeamOverrideOp),
  eraseOpType(breakComputeOp),
  eraseOpType(breakClearOp),
  eraseOpType(eliminationAdvanceOp),
];
