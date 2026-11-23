import { eraseOpType } from "../setup/helpers";
import type { OpDef } from "../types";
import {
  feedbackEnterOp,
  feedbackReceiveOnlineOp,
  feedbackReviewOp,
} from "./feedback";

export * from "./feedback";

export const FEEDBACK_OPS: readonly OpDef<unknown>[] = [
  eraseOpType(feedbackEnterOp),
  eraseOpType(feedbackReceiveOnlineOp),
  eraseOpType(feedbackReviewOp),
];
