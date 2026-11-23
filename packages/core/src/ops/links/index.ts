import { eraseOpType } from "../setup/helpers";
import type { OpDef } from "../types";
import { privateUrlsRegenerateOp } from "./links";

export * from "./links";

export const LINKS_OPS: readonly OpDef<unknown>[] = [
  eraseOpType(privateUrlsRegenerateOp),
];
