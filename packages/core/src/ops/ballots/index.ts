import { eraseOpType } from "../setup/helpers";
import type { OpDef } from "../types";
import {
  ballotConfirmOp,
  ballotDiscardOp,
  ballotEnterOp,
  ballotIntakeRecordOp,
  ballotReceiveOnlineOp,
} from "./ballots";

export * from "./ballots";

export const BALLOT_OPS: readonly OpDef<unknown>[] = [
  eraseOpType(ballotEnterOp),
  eraseOpType(ballotReceiveOnlineOp),
  eraseOpType(ballotConfirmOp),
  eraseOpType(ballotDiscardOp),
  eraseOpType(ballotIntakeRecordOp),
];
