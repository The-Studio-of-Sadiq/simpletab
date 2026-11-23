import { eraseOpType } from "../setup/helpers";
import type { OpDef } from "../types";
import {
  motionCreateOp,
  motionDeleteOp,
  motionSetRoundStatusOp,
  motionUpdateOp,
} from "./motions";

export * from "./motions";

export const MOTION_OPS: readonly OpDef<unknown>[] = [
  eraseOpType(motionCreateOp),
  eraseOpType(motionUpdateOp),
  eraseOpType(motionDeleteOp),
  eraseOpType(motionSetRoundStatusOp),
];
