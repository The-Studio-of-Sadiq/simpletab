import {
  STAFF_PERMISSIONS,
  type StaffPermission,
} from "@/lib/staffPermissions";

/**
 * SimpleTab permissions added beyond CrabbyTab's 14 staff permissions (design Appendix C).
 */
export const NEW_PERMISSIONS = [
  "settings.edit",
  "roles.manage",
  "venues.edit",
  "rounds.manage",
  "draw.generate",
  "draw.release",
  "results.enter_late",
  "motions.manage",
  "break.manage",
  "releases.manage",
  "links.manage",
  "participants.contact",
  "registration.manage",
  "devices.manage",
  "credentials.manage",
  "host.promote",
  "host.promote_others",
  "publish.run",
  "changelog.view_private",
] as const;

export type NewPermission = (typeof NEW_PERMISSIONS)[number];

/**
 * Complete permission catalogue: CrabbyTab's 14 staff permissions plus SimpleTab's 19 new permissions.
 */
export const PERMISSIONS = [
  ...STAFF_PERMISSIONS,
  ...NEW_PERMISSIONS,
] as const;

export type Permission = StaffPermission | NewPermission;

export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  "results.enter": "Enter unconfirmed ballots for debates whose draw is out.",
  "results.confirm_others": "Confirm or blind-check ballots entered by someone else.",
  "ballots.intake": "Record paper ballots arriving in the tab room.",
  "feedback.enter": "Enter feedback on behalf of teams and adjudicators.",
  "checkins.edit": "Mark teams, speakers, adjudicators, and rooms available or checked in.",
  "participants.edit": "Add and edit teams, adjudicators, and institutions.",
  "draw.display": "See confirmed draws and panels before they are released.",
  "motions.display": "See a round's motions before they are released.",
  "conflicts.view": "See adjudicator conflicts and team-institution conflicts.",
  "conflicts.edit": "Edit adjudicator and team-institution conflicts.",
  "feedback.view": "See feedback scores and comments, and adjudicator base/test scores.",
  "adjudicators.scores_edit": "Edit adjudicator base/test scores and breaking status.",
  "allocation.edit": "Edit adjudicator allocations on visible draws.",
  "standings.view": "See standings, the break, analytics, and results of silent or unreleased rounds.",
  "settings.edit": "Edit tournament settings and preferences.",
  "roles.manage": "Create and update custom permission roles.",
  "venues.edit": "Create, update, and delete venues.",
  "rounds.manage": "Create, update, cancel, complete, and set deadlines for rounds.",
  "draw.generate": "Generate, restore, and edit draws.",
  "draw.release": "Lock, unlock, and release draws to teams or the public.",
  "results.enter_late": "Enter or accept ballots after a round's ballot deadline.",
  "motions.manage": "Create, edit, delete, and release motions and info slides.",
  "break.manage": "Configure break categories, overrides, generated breaks, and elimination advancement.",
  "releases.manage": "Toggle public tab and list release gates.",
  "links.manage": "View and regenerate participant private-URL links and passcodes.",
  "participants.contact": "View participant contact details such as emails and phone numbers.",
  "registration.manage": "View and review incoming tournament registrations.",
  "devices.manage": "Approve, remove, and set roles for paired devices.",
  "credentials.manage": "View and update host credentials and API tokens.",
  "host.promote": "Promote a tab-director device to become the active host.",
  "host.promote_others": "Promote another device without being a tab director.",
  "publish.run": "Build and publish the static public site and archive.",
  "changelog.view_private": "View private changelog operation payloads.",
};

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && PERMISSION_SET.has(value);
}
