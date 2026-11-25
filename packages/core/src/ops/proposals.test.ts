import { describe, expect, it } from "vitest";
import { FIXED_TIME, makeTournament } from "@/test/tournamentFixtures";
import {
  applyOp,
  createTournamentState,
  defaultRegistry,
} from "./index";
import {
  AI_ACTOR,
  deepFreeze,
  DISPLAY_ACTOR,
  EQUITY_ACTOR,
  expectOpRoundTrip,
  expectWrittenVersionBumps,
  HOST_OWNER_ACTOR,
  stripVersions,
  TAB_ASSISTANT_ACTOR,
  TAB_DIRECTOR_ACTOR,
} from "./test-helpers";

describe("ops proposals & Appendix A registry metadata", () => {
  it("blocks AI actors from normal ops with 'proposal required' and allows proposal.create", () => {
    const registry = defaultRegistry();
    const state = {
      ...createTournamentState(makeTournament("bp")),
      runtime: { portalEnforcing: false, now: "2026-10-01T12:00:00.000Z" },
    };

    const humanCreate = applyOp(
      deepFreeze(state),
      {
        type: "proposal.create",
        payload: {
          id: "human-prop",
          op: {
            type: "settings.update",
            payload: { preferences: { welcomeMessage: "Human proposal" } },
          },
        },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(humanCreate.ok).toBe(false);
    if (!humanCreate.ok) expect(humanCreate.code).toBe("FORBIDDEN");

    const invalidCreate = applyOp(
      deepFreeze(state),
      {
        type: "proposal.create",
        payload: {
          id: "invalid-prop",
          op: { type: "proposal.reject", payload: { proposalId: "nested" } },
        },
      },
      AI_ACTOR,
      registry,
    );
    expect(invalidCreate.ok).toBe(false);
    if (!invalidCreate.ok) expect(invalidCreate.code).toBe("INVALID");

    for (const type of registry.types()) {
      if (type === "proposal.create") continue;
      const direct = applyOp(
        deepFreeze(state),
        { type, payload: {} },
        AI_ACTOR,
        registry,
      );
      expect(direct).toEqual({
        ok: false,
        code: "FORBIDDEN",
        errors: ["proposal required"],
      });
    }

    const missingAccept = applyOp(
      deepFreeze(state),
      { type: "proposal.accept", payload: { proposalId: "missing" } },
      HOST_OWNER_ACTOR,
      registry,
    );
    expect(missingAccept.ok).toBe(false);
    if (!missingAccept.ok) expect(missingAccept.code).toBe("FORBIDDEN");

    const missingReject = applyOp(
      deepFreeze(state),
      { type: "proposal.reject", payload: { proposalId: "missing" } },
      HOST_OWNER_ACTOR,
      registry,
    );
    expect(missingReject.ok).toBe(false);
    if (!missingReject.ok) expect(missingReject.code).toBe("FORBIDDEN");

    const directDraw = applyOp(
      deepFreeze(state),
      {
        type: "settings.update",
        payload: { preferences: { welcomeMessage: "AI direct" } },
      },
      AI_ACTOR,
      registry,
    );
    expect(directDraw).toEqual({
      ok: false,
      code: "FORBIDDEN",
      errors: ["proposal required"],
    });

    const directAccept = applyOp(
      deepFreeze(state),
      {
        type: "proposal.accept",
        payload: { proposalId: "prop-1" },
      },
      AI_ACTOR,
      registry,
    );
    expect(directAccept).toEqual({
      ok: false,
      code: "FORBIDDEN",
      errors: ["proposal required"],
    });

    const created = applyOp(
      deepFreeze(state),
      {
        type: "proposal.create",
        payload: {
          id: "prop-1",
          op: {
            type: "settings.update",
            payload: { preferences: { welcomeMessage: "Proposed Welcome" } },
          },
        },
      },
      AI_ACTOR,
      registry,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.state.proposals).toHaveLength(1);
    expect(created.state.proposals[0]).toMatchObject({
      id: "prop-1",
      createdAt: "2026-10-01T12:00:00.000Z",
      status: "pending",
    });
    expect(created.inverse).toBeNull();
    expectWrittenVersionBumps(state, created);

    // Tab assistant lacks settings.edit, so accepting or rejecting prop-1 is FORBIDDEN
    const assistantAccept = applyOp(
      deepFreeze(created.state),
      { type: "proposal.accept", payload: { proposalId: "prop-1" } },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(assistantAccept.ok).toBe(false);
    if (!assistantAccept.ok) expect(assistantAccept.code).toBe("FORBIDDEN");

    const assistantReject = applyOp(
      deepFreeze(created.state),
      { type: "proposal.reject", payload: { proposalId: "prop-1" } },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(assistantReject.ok).toBe(false);
    if (!assistantReject.ok) expect(assistantReject.code).toBe("FORBIDDEN");

    // Tab director accepts proposal -> applies inner op recursively & returns inner inverse
    const accepted = applyOp(
      deepFreeze(created.state),
      { type: "proposal.accept", payload: { proposalId: "prop-1" } },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.state.tournament.preferences.welcomeMessage).toBe(
      "Proposed Welcome",
    );
    expect(accepted.state.proposals[0]?.status).toBe("accepted");
    expect(accepted.state.proposals[0]?.resolvedBy).toBe(
      TAB_DIRECTOR_ACTOR.ref,
    );
    expect(
      (accepted.committedPayload as { proposedBy?: { actorType?: string } })
        .proposedBy?.actorType,
    ).toBe("ai");
    expect(accepted.inverse).not.toBeNull();
    expectWrittenVersionBumps(created.state, accepted);

    const acceptAgain = applyOp(
      deepFreeze(accepted.state),
      { type: "proposal.accept", payload: { proposalId: "prop-1" } },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(acceptAgain.ok).toBe(false);
    if (!acceptAgain.ok) expect(acceptAgain.code).toBe("INVALID");

    // Applying inner inverse restores tournament settings
    const undone = applyOp(
      deepFreeze(accepted.state),
      accepted.inverse!,
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.state.tournament.preferences).toEqual(
      state.tournament.preferences,
    );

    const allocationProposal = applyOp(
      deepFreeze(state),
      {
        type: "proposal.create",
        payload: {
          id: "prop-allocation",
          op: { type: "allocation.swap_rooms", payload: {} },
        },
      },
      AI_ACTOR,
      registry,
    );
    expect(allocationProposal.ok).toBe(true);
    if (!allocationProposal.ok) return;
    const equityCannotAccept = applyOp(
      deepFreeze(allocationProposal.state),
      {
        type: "proposal.accept",
        payload: { proposalId: "prop-allocation" },
      },
      EQUITY_ACTOR,
      registry,
    );
    expect(equityCannotAccept.ok).toBe(false);
    if (!equityCannotAccept.ok) expect(equityCannotAccept.code).toBe("FORBIDDEN");
  });

  it("supports proposal.reject with inverse round-trip and rejects resolving twice", () => {
    const registry = defaultRegistry();
    const state = {
      ...createTournamentState(makeTournament("bp")),
      runtime: { portalEnforcing: false, now: FIXED_TIME },
    };
    const created = applyOp(
      deepFreeze(state),
      {
        type: "proposal.create",
        payload: {
          id: "prop-2",
          op: {
            type: "settings.update",
            payload: { preferences: { welcomeMessage: "Hello" } },
          },
        },
      },
      AI_ACTOR,
      registry,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.inverse).toBeNull();
    expectWrittenVersionBumps(state, created);

    const rejected = expectOpRoundTrip(
      created.state,
      {
        type: "proposal.reject",
        payload: { proposalId: "prop-2", reason: "Not needed" },
      },
      TAB_DIRECTOR_ACTOR,
    );
    expect(rejected.proposals[0]?.status).toBe("rejected");
    expect(rejected.proposals[0]?.reason).toBe("Not needed");

    const reReject = applyOp(
      deepFreeze(rejected),
      { type: "proposal.reject", payload: { proposalId: "prop-2" } },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(reReject.ok).toBe(false);
    if (!reReject.ok) expect(reReject.code).toBe("INVALID");

    const displayReject = applyOp(
      deepFreeze(created.state),
      { type: "proposal.reject", payload: { proposalId: "prop-2" } },
      DISPLAY_ACTOR,
      registry,
    );
    expect(displayReject.ok).toBe(false);
    if (!displayReject.ok) expect(displayReject.code).toBe("FORBIDDEN");

    expect(stripVersions(created.state).tournament).toEqual(
      stripVersions(state).tournament,
    );
  });

  it("registers all 26 new ops with exact Appendix A visibility, releaseGate, and lock metadata", () => {
    const registry = defaultRegistry();
    expect(registry.types()).toHaveLength(76);

    expect(registry.get("ballot.enter")?.visibility).toBe("private");
    expect(registry.get("ballot.receive_online")?.visibility).toBe("private");
    expect(registry.get("ballot.intake_record")?.visibility).toBe("private");
    expect(registry.get("ballot.confirm")).toMatchObject({
      visibility: "public",
      releaseGate: "round_results_released",
      lock: false,
    });
    expect(registry.get("ballot.discard")).toMatchObject({
      visibility: "public",
      releaseGate: "round_results_released",
      lock: false,
    });

    for (const type of [
      "feedback.enter",
      "feedback.receive_online",
      "feedback.review",
      "private_urls.regenerate",
      "registration.receive",
      "registration.accept",
      "device.approve",
      "device.remove",
      "device.set_role",
      "host.promote",
      "succession.set",
      "proposal.create",
      "proposal.accept",
      "proposal.reject",
    ]) {
      expect(registry.get(type)?.visibility).toBe("private");
    }

    for (const type of [
      "break.categories_save",
      "break.team_override",
      "break.compute",
      "break.clear",
    ]) {
      expect(registry.get(type)).toMatchObject({
        visibility: "public",
        releaseGate: "break_category_published",
      });
    }

    expect(registry.get("break.compute")?.lock).toBe(true);
    expect(registry.get("private_urls.regenerate")?.lock).toBe(true);

    expect(registry.get("elimination.advance")).toMatchObject({
      visibility: "public",
      releaseGate: "draw_released",
      lock: false,
    });

    expect(registry.get("release.set_gate")).toMatchObject({
      visibility: "public",
      lock: false,
    });
    expect(registry.get("release.set_gate")?.releaseGate).toBeUndefined();
    expect(registry.get("release.tab_bundle")).toMatchObject({
      visibility: "public",
      lock: false,
    });
    expect(registry.get("release.tab_bundle")?.releaseGate).toBeUndefined();
  });
});
