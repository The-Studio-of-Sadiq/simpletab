import type { OpRequest, TournamentState } from "@simpletab/core/ops";
import type { Role } from "@simpletab/core/permissions";
import { project } from "@simpletab/core/projection";

/**
 * A staff device edits from its role's view, which leaves out fields the role may not see (contact
 * details, passcodes, link keys, scores...). Many ops carry a whole record (`team.update {team}`), so
 * committing the device's copy as it is would silently erase those fields.
 *
 * Before the host commits a device's op, every record in its payload that matches an existing record
 * by id gets back the fields its role could not see: a field that is in the stored record, absent from
 * the role's projection of it and absent from the payload is copied from the stored record. Fields the
 * role can see are left exactly as the device sent them, so a deliberate change or removal stands.
 * Nested records (a team's speakers) are matched by id the same way.
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasId(value: unknown): value is Json & { id: string } {
  return isRecord(value) && typeof value.id === "string";
}

function indexById(state: object): Map<string, Json> {
  const index = new Map<string, Json>();
  for (const value of Object.values(state)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (hasId(item) && !index.has(item.id)) index.set(item.id, item);
    }
  }
  return index;
}

function restore(sent: unknown, stored: unknown, visible: unknown): unknown {
  if (Array.isArray(sent) && Array.isArray(stored)) {
    const storedById = new Map(stored.filter(hasId).map((item) => [item.id, item] as const));
    const visibleById = new Map(
      (Array.isArray(visible) ? visible : []).filter(hasId).map((item) => [item.id, item] as const),
    );
    return sent.map((item) =>
      hasId(item) && storedById.has(item.id)
        ? restore(item, storedById.get(item.id), visibleById.get(item.id) ?? {})
        : item,
    );
  }
  if (!isRecord(sent) || !isRecord(stored)) return sent;
  const shown = isRecord(visible) ? visible : {};
  const out: Json = { ...sent };
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in shown)) {
      if (!(key in sent)) out[key] = structuredClone(value);
    } else if (key in sent) {
      out[key] = restore(sent[key], value, shown[key]);
    }
  }
  return out;
}

/** Returns a copy of `op` whose payload records keep the fields `role` cannot see. */
export function restoreHiddenFields<P>(op: OpRequest<P>, state: TournamentState, role: Role): OpRequest<P> {
  if (!isRecord(op.payload)) return op;
  const storedIndex = indexById(state);
  const visibleIndex = indexById(project(state, role));
  const payload: Json = { ...op.payload };
  for (const [key, value] of Object.entries(payload)) {
    if (hasId(value) && storedIndex.has(value.id)) {
      payload[key] = restore(value, storedIndex.get(value.id), visibleIndex.get(value.id) ?? {});
    }
  }
  return { ...op, payload: payload as P };
}
