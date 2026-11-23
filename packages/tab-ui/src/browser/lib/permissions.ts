import {
  BUILT_IN_ROLES,
  hasPermission,
  PRESET_ROLES,
  type Permission,
  type Role,
} from "@simpletab/core/permissions";
import type { ProjectedState } from "@simpletab/host/lib/common/host-protocol";

const KNOWN_ROLES: ReadonlyMap<string, Role> = new Map(
  [...Object.values(BUILT_IN_ROLES), ...Object.values(PRESET_ROLES)].map(
    (role) => [role.id, role],
  ),
);

export function stateHasPermission(
  state: Pick<ProjectedState, "roleId" | "permissions"> | null | undefined,
  permission: Permission,
): boolean {
  if (!state) {
    return false;
  }
  if (Array.isArray(state.permissions)) {
    return state.permissions.includes(permission);
  }
  const role = KNOWN_ROLES.get(state.roleId);
  return role !== undefined ? hasPermission(role, permission) : false;
}
