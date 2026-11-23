import {
  PERMISSION_GROUPS,
  TAB_ASSISTANT_PERMISSIONS,
} from "@/lib/staffPermissions";
import { PERMISSIONS, isPermission, type Permission } from "./catalog";

export type BuiltInRoleId =
  | "host_owner"
  | "tab_director"
  | "adjudication_core"
  | "equity"
  | "tab_assistant"
  | "display"
  | "ai";

export type PresetRoleId = "ballot_desk" | "check_in_desk" | "feedback_desk";

export interface Role {
  id: string;
  name: string;
  permissions: readonly Permission[];
  proposalsOnly?: boolean;
}

const AI_EXCLUDED_ADJ_CORE_PERMISSIONS: ReadonlySet<Permission> = new Set([
  "feedback.view",
  "adjudicators.scores_edit",
  "allocation.edit",
]);

/**
 * Adjudication-core read set without `feedback.view` (design Appendix C).
 */
const AI_DEFAULT_PERMISSIONS: readonly Permission[] =
  PERMISSION_GROUPS.adjudication_core.permissions.filter(
    (permission) => !AI_EXCLUDED_ADJ_CORE_PERMISSIONS.has(permission),
  );

export const BUILT_IN_ROLES: Record<BuiltInRoleId, Role> = {
  host_owner: {
    id: "host_owner",
    name: "Host owner",
    permissions: PERMISSIONS,
  },
  tab_director: {
    id: "tab_director",
    name: "Tab director",
    permissions: PERMISSIONS.filter(
      (permission) =>
        permission !== "credentials.manage" &&
        permission !== "host.promote_others",
    ),
  },
  adjudication_core: {
    id: "adjudication_core",
    name: PERMISSION_GROUPS.adjudication_core.label,
    permissions: PERMISSION_GROUPS.adjudication_core.permissions,
  },
  equity: {
    id: "equity",
    name: PERMISSION_GROUPS.equity.label,
    permissions: PERMISSION_GROUPS.equity.permissions,
  },
  tab_assistant: {
    id: "tab_assistant",
    name: PERMISSION_GROUPS.tab_assistant.label,
    permissions: TAB_ASSISTANT_PERMISSIONS,
  },
  display: {
    id: "display",
    name: "Display",
    permissions: [],
  },
  ai: {
    id: "ai",
    name: "AI",
    permissions: AI_DEFAULT_PERMISSIONS,
    proposalsOnly: true,
  },
};

/**
 * Shipped custom-role presets matching CrabbyTab's desk permission groups (design Appendix C).
 */
export const PRESET_ROLES: Record<PresetRoleId, Role> = {
  ballot_desk: {
    id: "ballot_desk",
    name: PERMISSION_GROUPS.ballot_desk.label,
    permissions: PERMISSION_GROUPS.ballot_desk.permissions,
  },
  check_in_desk: {
    id: "check_in_desk",
    name: PERMISSION_GROUPS.check_in_desk.label,
    permissions: PERMISSION_GROUPS.check_in_desk.permissions,
  },
  feedback_desk: {
    id: "feedback_desk",
    name: PERMISSION_GROUPS.feedback_desk.label,
    permissions: PERMISSION_GROUPS.feedback_desk.permissions,
  },
};

export interface CustomRoleOptions {
  proposalsOnly?: boolean;
}

/**
 * Creates a custom role after validating all permission names against the catalogue.
 */
export function customRole(
  id: string,
  name: string,
  permissions: readonly string[],
  options?: CustomRoleOptions,
): Role {
  const trimmedId = id.trim();
  const trimmedName = name.trim();
  if (!trimmedId) {
    throw new Error("Custom role id must not be empty.");
  }
  if (!trimmedName) {
    throw new Error("Custom role name must not be empty.");
  }

  const validated: Permission[] = [];
  const seen = new Set<Permission>();
  for (const permission of permissions) {
    if (!isPermission(permission)) {
      throw new Error(`Unknown permission: "${permission}".`);
    }
    if (!seen.has(permission)) {
      seen.add(permission);
      validated.push(permission);
    }
  }

  return {
    id: trimmedId,
    name: trimmedName,
    permissions: validated,
    ...(options?.proposalsOnly !== undefined
      ? { proposalsOnly: options.proposalsOnly }
      : {}),
  };
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return role.permissions.includes(permission);
}
