import { describe, expect, it } from "vitest";
import { STAFF_PERMISSIONS } from "@/lib/staffPermissions";
import {
  BUILT_IN_ROLES,
  NEW_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  PRESET_ROLES,
  customRole,
  hasPermission,
  isPermission,
} from "@/permissions";

describe("permissions catalog", () => {
  it("combines CrabbyTab's 14 staff permissions with the 19 new Appendix C permissions", () => {
    expect(STAFF_PERMISSIONS).toHaveLength(14);
    expect(NEW_PERMISSIONS).toHaveLength(19);
    expect(PERMISSIONS).toHaveLength(33);
    expect(new Set(PERMISSIONS).size).toBe(33);

    for (const permission of STAFF_PERMISSIONS) {
      expect(PERMISSIONS).toContain(permission);
    }
    for (const permission of NEW_PERMISSIONS) {
      expect(PERMISSIONS).toContain(permission);
    }
  });

  it("provides a non-empty one-line description for every permission", () => {
    for (const permission of PERMISSIONS) {
      const desc = PERMISSION_DESCRIPTIONS[permission];
      expect(typeof desc).toBe("string");
      expect(desc.trim().length).toBeGreaterThan(0);
      expect(desc).not.toContain("\n");
    }
  });

  it("validates permission membership with isPermission", () => {
    expect(isPermission("results.enter_late")).toBe(true);
    expect(isPermission("feedback.view")).toBe(true);
    expect(isPermission("not.a.permission")).toBe(false);
    expect(isPermission(42)).toBe(false);
  });
});

describe("built-in roles (Appendix C)", () => {
  it("host_owner has all permissions", () => {
    expect(BUILT_IN_ROLES.host_owner.permissions).toEqual(PERMISSIONS);
    expect(BUILT_IN_ROLES.host_owner.proposalsOnly).toBeUndefined();
  });

  it("tab_director has all permissions except credentials.manage and host.promote_others", () => {
    const perms = BUILT_IN_ROLES.tab_director.permissions;
    expect(perms).not.toContain("credentials.manage");
    expect(perms).not.toContain("host.promote_others");
    expect(perms).toHaveLength(PERMISSIONS.length - 2);
    expect(hasPermission(BUILT_IN_ROLES.tab_director, "results.enter_late")).toBe(true);
    expect(hasPermission(BUILT_IN_ROLES.tab_director, "host.promote")).toBe(true);
  });

  it("adjudication_core matches Appendix C exactly", () => {
    expect(BUILT_IN_ROLES.adjudication_core.permissions).toEqual([
      "feedback.view",
      "adjudicators.scores_edit",
      "allocation.edit",
      "conflicts.view",
      "draw.display",
      "motions.display",
      "standings.view",
    ]);
  });

  it("equity matches Appendix C exactly", () => {
    expect(BUILT_IN_ROLES.equity.permissions).toEqual([
      "conflicts.view",
      "conflicts.edit",
    ]);
  });

  it("tab_assistant matches Appendix C and lacks results.enter_late", () => {
    expect(BUILT_IN_ROLES.tab_assistant.permissions).toEqual([
      "results.enter",
      "results.confirm_others",
      "ballots.intake",
      "feedback.enter",
      "checkins.edit",
      "participants.edit",
      "draw.display",
      "motions.display",
    ]);
    expect(hasPermission(BUILT_IN_ROLES.tab_assistant, "results.enter_late")).toBe(false);
  });

  it("display has no permissions", () => {
    expect(BUILT_IN_ROLES.display.permissions).toEqual([]);
  });

  it("ai has proposalsOnly true and Adjudication-core read set minus feedback.view", () => {
    expect(BUILT_IN_ROLES.ai.proposalsOnly).toBe(true);
    expect(BUILT_IN_ROLES.ai.permissions).toEqual([
      "conflicts.view",
      "draw.display",
      "motions.display",
      "standings.view",
    ]);
    expect(hasPermission(BUILT_IN_ROLES.ai, "feedback.view")).toBe(false);
    expect(hasPermission(BUILT_IN_ROLES.ai, "allocation.edit")).toBe(false);
  });

  it("ships presets for ballot_desk, check_in_desk, and feedback_desk", () => {
    expect(PRESET_ROLES.ballot_desk.permissions).toEqual([
      "results.enter",
      "results.confirm_others",
      "ballots.intake",
    ]);
    expect(PRESET_ROLES.check_in_desk.permissions).toEqual(["checkins.edit"]);
    expect(PRESET_ROLES.feedback_desk.permissions).toEqual(["feedback.enter"]);
  });
});

describe("customRole and hasPermission", () => {
  it("builds a valid custom role and deduplicates permissions", () => {
    const role = customRole("runner", "Paper Runner", [
      "ballots.intake",
      "draw.display",
      "ballots.intake",
    ]);
    expect(role).toEqual({
      id: "runner",
      name: "Paper Runner",
      permissions: ["ballots.intake", "draw.display"],
    });
    expect(hasPermission(role, "ballots.intake")).toBe(true);
    expect(hasPermission(role, "feedback.view")).toBe(false);
  });

  it("rejects unknown permissions and empty id or name", () => {
    expect(() =>
      customRole("bad", "Bad Role", ["draw.display", "unknown.perm"]),
    ).toThrow(/Unknown permission/);
    expect(() => customRole("  ", "Bad", ["draw.display"])).toThrow();
    expect(() => customRole("bad", "  ", ["draw.display"])).toThrow();
  });
});
