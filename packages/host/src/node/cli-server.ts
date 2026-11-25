import { randomUUID } from "node:crypto";
import type { OpRegistryLookup, OpRequest } from "@simpletab/core/ops";
import type { Role } from "@simpletab/core/permissions";

/**
 * The host side of the CLI and AI (design section 6, "AI actor"). The CLI pairs as a staff device;
 * when its role is proposals-only (the built-in AI role), every change it sends is turned into a
 * `proposal.create` here, and a person with the needed permission accepts or rejects it.
 *
 * The AI may propose only draw, allocation, results, break and release changes. Anything else is
 * refused with a reason rather than silently dropped.
 */

/** Op categories the AI may propose (design Appendix C, AI role). `ballot` is the results area. */
export const AI_PROPOSABLE_CATEGORIES: ReadonlySet<string> = new Set([
  "draw",
  "allocation",
  "ballot",
  "break",
  "releases",
]);

export function isProposalsOnly(role: Role): boolean {
  return role.proposalsOnly === true;
}

export type ProposalWrap =
  | { ok: true; request: OpRequest<{ id: string; op: OpRequest<unknown> }> }
  | { ok: false; errors: string[] };

/**
 * Turns a proposals-only device's change into a proposal. A `proposal.create` it sends itself is
 * checked the same way, so the category rule cannot be bypassed by wrapping the op by hand.
 */
export function wrapAsProposal(
  request: OpRequest<unknown>,
  registry: OpRegistryLookup,
  newId: () => string = () => `proposal-${randomUUID()}`,
): ProposalWrap {
  let inner: OpRequest<unknown> = request;
  let id = newId();
  if (request.type === "proposal.create") {
    const payload = request.payload as { id?: unknown; op?: unknown } | null;
    const op = payload?.op as { type?: unknown; payload?: unknown } | undefined;
    if (op === undefined || op === null || typeof op.type !== "string" || !("payload" in op)) {
      return { ok: false, errors: ["A proposal must contain the change it proposes."] };
    }
    inner = { type: op.type, payload: op.payload };
    if (typeof payload?.id === "string" && payload.id.trim() !== "") id = payload.id;
  } else if (request.type.startsWith("proposal.")) {
    return { ok: false, errors: ["Only a person can accept or reject proposals."] };
  }
  const definition = registry.get(inner.type);
  if (definition === undefined) {
    return { ok: false, errors: [`Unknown change: ${inner.type}.`] };
  }
  if (!AI_PROPOSABLE_CATEGORIES.has(definition.category)) {
    return {
      ok: false,
      errors: [
        `The AI can only propose changes to the draw, allocation, results, break and releases; ${inner.type} is not one of them.`,
      ],
    };
  }
  return {
    ok: true,
    request: { type: "proposal.create", payload: { id, op: { type: inner.type, payload: inner.payload } } },
  };
}
