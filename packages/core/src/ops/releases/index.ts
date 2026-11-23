import { eraseOpType } from "../setup/helpers";
import type { OpDef } from "../types";
import { releaseSetGateOp, releaseTabBundleOp } from "./releases";

export * from "./releases";

export const RELEASE_OPS: readonly OpDef<unknown>[] = [
  eraseOpType(releaseSetGateOp),
  eraseOpType(releaseTabBundleOp),
];
