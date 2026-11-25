import { defaultRegistry } from "@simpletab/core/ops";
import { describe, expect, it } from "vitest";
import { wrapAsProposal } from "./cli-server";

const registry = defaultRegistry();
const fixedId = () => "proposal-1";

describe("wrapAsProposal", () => {
  it("turns a draw, allocation, results, break or release change into a proposal", () => {
    const op = { type: "release.set_gate", payload: { gate: "tab_team", released: true } };
    expect(wrapAsProposal(op, registry, fixedId)).toEqual({
      ok: true,
      request: { type: "proposal.create", payload: { id: "proposal-1", op } },
    });
  });

  it("refuses other areas with a reason", () => {
    const result = wrapAsProposal({ type: "team.update", payload: {} }, registry, fixedId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/only propose changes to the draw/);
  });

  it("checks a hand-made proposal.create by its inner change and keeps its id", () => {
    const inner = { type: "release.set_gate", payload: { gate: "tab_team", released: true } };
    expect(wrapAsProposal({ type: "proposal.create", payload: { id: "mine", op: inner } }, registry, fixedId)).toEqual({
      ok: true,
      request: { type: "proposal.create", payload: { id: "mine", op: inner } },
    });
    expect(
      wrapAsProposal({ type: "proposal.create", payload: { id: "x", op: { type: "team.update", payload: {} } } }, registry),
    ).toMatchObject({ ok: false });
    expect(wrapAsProposal({ type: "proposal.create", payload: { id: "x" } }, registry)).toMatchObject({ ok: false });
  });

  it("never lets the AI accept or reject, and refuses unknown changes", () => {
    expect(wrapAsProposal({ type: "proposal.accept", payload: { proposalId: "p" } }, registry)).toMatchObject({
      ok: false,
      errors: ["Only a person can accept or reject proposals."],
    });
    expect(wrapAsProposal({ type: "nope.op", payload: {} }, registry)).toMatchObject({ ok: false });
  });
});
