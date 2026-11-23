import { eraseOpType } from "../setup/helpers";
import type { OpDef } from "../types";
import {
  drawGenerateOp,
  drawMoveTeamOp,
  drawRestoreOp,
  drawSwapTeamsOp,
  drawUpdateDebateOp,
} from "./draw";
import {
  drawLockOp,
  drawReleaseOp,
  drawReleaseTeamsOp,
  drawUnlockOp,
  drawUnreleaseOp,
} from "./lifecycle";
import { swingCreateOp, swingToggleRoundOp } from "./swing";

export * from "./draw";
export * from "./lifecycle";
export * from "./swing";

export const DRAW_OPS: readonly OpDef<unknown>[] = [
  eraseOpType(drawGenerateOp),
  eraseOpType(drawRestoreOp),
  eraseOpType(drawUpdateDebateOp),
  eraseOpType(drawMoveTeamOp),
  eraseOpType(drawSwapTeamsOp),
  eraseOpType(drawLockOp),
  eraseOpType(drawUnlockOp),
  eraseOpType(drawReleaseTeamsOp),
  eraseOpType(drawReleaseOp),
  eraseOpType(drawUnreleaseOp),
  eraseOpType(swingCreateOp),
  eraseOpType(swingToggleRoundOp),
];
