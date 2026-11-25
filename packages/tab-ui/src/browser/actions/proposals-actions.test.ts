import type { ProposalRecord } from "@simpletab/core/ops";
import type { ProjectedState } from "@simpletab/host/lib/common/host-protocol";
import { describe, expect, it } from "vitest";
import { acceptProposalAction, rejectProposalAction } from "./proposals-actions";
import { fakeStore, scriptedPrompts, testContext } from "./test-context";

function proposal(
  id: string,
  createdAt: string,
  status: ProposalRecord["status"] = "pending",
): ProposalRecord {
  return {
    id,
    op: { type: "release.set_gate", payload: {} },
    proposedBy: {
      ref: "device:dev-1",
      type: "ai",
      role: { id: "ai", name: "AI", permissions: [] },
      isHostOwner: false,
    },
    createdAt,
    status,
  } as unknown as ProposalRecord;
}

function state(patch: Partial<ProjectedState> = {}): ProjectedState {
  return {
    roleId: "tab_director",
    permissions: ["draw.edit"],
    proposals: [
      proposal("p2", "2026-11-25T10:00:00Z"),
      proposal("p1", "2026-11-25T09:00:00Z"),
      proposal("p0", "2026-11-25T08:00:00Z", "accepted"),
    ],
    ...patch,
  } as unknown as ProjectedState;
}

describe("proposal actions", () => {
  it("are offered in the palette only to a person who can decide, when something is pending", () => {
    const enabled = (s: ProjectedState | null) =>
      acceptProposalAction.isEnabled?.(fakeStore(s).store.getSnapshot());
    expect(enabled(state())).toBe(true);
    expect(enabled(state({ roleId: "ai" }))).toBe(false);
    expect(enabled(state({ permissions: [] }))).toBe(false);
    expect(enabled(state({ proposals: [] }))).toBe(false);
    expect(enabled(null)).toBe(false);
  });

  it("accepts the proposal picked from the palette", async () => {
    const { store, submitted } = fakeStore(state());
    const ctx = testContext(store, scriptedPrompts(["p1"]));
    const args = await acceptProposalAction.prompt(ctx);
    expect(args).toEqual({ proposalId: "p1" });
    await acceptProposalAction.run(ctx, { proposalId: "p1" });
    expect(submitted).toEqual([{ type: "proposal.accept", payload: { proposalId: "p1" } }]);
  });

  it("lists only pending proposals, oldest first", async () => {
    const { store } = fakeStore(state());
    let offered: string[] = [];
    const ctx = testContext(store, {
      ...scriptedPrompts([]),
      pick: async <T,>(items: ReadonlyArray<{ value: T }>) => {
        offered = items.map((item) => String(item.value));
        return undefined;
      },
    });
    expect(await acceptProposalAction.prompt(ctx)).toBeUndefined();
    expect(offered).toEqual(["p1", "p2"]);
  });

  it("rejects with a trimmed reason, or none when left empty, and stops when cancelled", async () => {
    const { store, submitted } = fakeStore(state());
    const ask = (answers: unknown[]) => rejectProposalAction.prompt(testContext(store, scriptedPrompts(answers)));
    expect(await ask(["p2", "  Too early  "])).toEqual({ proposalId: "p2", reason: "Too early" });
    expect(await ask(["p2", "  "])).toEqual({ proposalId: "p2" });
    expect(await ask(["p2", undefined])).toBeUndefined();
    expect(await ask([undefined])).toBeUndefined();

    const ctx = testContext(store, scriptedPrompts([]));
    await rejectProposalAction.run(ctx, { proposalId: "p2", reason: "Too early" });
    await rejectProposalAction.run(ctx, { proposalId: "p2" });
    expect(submitted).toEqual([
      { type: "proposal.reject", payload: { proposalId: "p2", reason: "Too early" } },
      { type: "proposal.reject", payload: { proposalId: "p2" } },
    ]);
  });
});
