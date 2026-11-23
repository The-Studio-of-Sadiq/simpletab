import { eraseOpType } from "../setup/helpers";
import type { OpDef } from "../types";
import {
  registrationAcceptOp,
  registrationReceiveOp,
} from "./registration";

export * from "./registration";

export const REGISTRATION_OPS: readonly OpDef<unknown>[] = [
  eraseOpType(registrationReceiveOp),
  eraseOpType(registrationAcceptOp),
];
