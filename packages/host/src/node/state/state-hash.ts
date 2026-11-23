import { createHash } from "node:crypto";
import { canonicalize } from "@simpletab/core/changelog";
import type { TournamentState } from "@simpletab/core/ops/types";
import type { SqliteDatabase } from "../db/database";

export const STATE_HASH_TABLE_ORDER = [
  "tournament",
  "institutions",
  "teams",
  "adjudicators",
  "venues",
  "rounds",
  "debates",
  "motions",
  "ballots",
  "feedback",
  "break_categories",
  "registrations",
  "links",
] as const;

export type StateHashTableName = (typeof STATE_HASH_TABLE_ORDER)[number];

interface HashRow {
  id: string;
  data: string;
}

interface CanonicalRow {
  id: string;
  data: unknown;
}

function compareUtf8Binary(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function toSortedCanonicalRows<T>(
  items: readonly T[],
  getId: (item: T) => string,
): CanonicalRow[] {
  return items
    .map((item) => ({ id: getId(item), data: item as unknown }))
    .sort((left, right) => compareUtf8Binary(left.id, right.id));
}

function rowsForTable(
  state: Pick<
    TournamentState,
    | "tournament"
    | "institutions"
    | "teams"
    | "adjudicators"
    | "venues"
    | "rounds"
    | "debates"
    | "motions"
    | "ballots"
    | "feedback"
    | "breakCategories"
    | "registrations"
    | "links"
  >,
  table: StateHashTableName,
): CanonicalRow[] {
  switch (table) {
    case "tournament":
      return [{ id: "t", data: state.tournament }];
    case "institutions":
      return toSortedCanonicalRows(state.institutions, (item) => item.id);
    case "teams":
      return toSortedCanonicalRows(state.teams, (item) => item.id);
    case "adjudicators":
      return toSortedCanonicalRows(state.adjudicators, (item) => item.id);
    case "venues":
      return toSortedCanonicalRows(state.venues, (item) => item.id);
    case "rounds":
      return toSortedCanonicalRows(state.rounds, (item) => item.id);
    case "debates":
      return toSortedCanonicalRows(state.debates, (item) => item.id);
    case "motions":
      return toSortedCanonicalRows(state.motions, (item) => item.id);
    case "ballots":
      return toSortedCanonicalRows(state.ballots, (item) => item.id);
    case "feedback":
      return toSortedCanonicalRows(state.feedback, (item) => item.id);
    case "break_categories":
      return toSortedCanonicalRows(state.breakCategories, (item) => item.id);
    case "registrations":
      return toSortedCanonicalRows(state.registrations, (item) => item.id);
    case "links":
      return toSortedCanonicalRows(state.links, (item) => item.lookupId);
  }
}

/** Hashes canonical entity content in Appendix D's table order, excluding row versions. */
export function stateHash(database: SqliteDatabase): string {
  const combined = createHash("sha256");
  for (const table of STATE_HASH_TABLE_ORDER) {
    const rows = database.prepare(`SELECT id, data FROM ${table} ORDER BY id`).all() as HashRow[];
    const content = rows.map((row) => ({ id: row.id, data: JSON.parse(row.data) as unknown }));
    const tableHash = createHash("sha256").update(canonicalize(content), "utf8").digest();
    combined.update(tableHash);
  }
  return combined.digest("hex");
}

/**
 * Pure equivalent of `stateHash(database)` over an in-memory `TournamentState` (or content-only state).
 * Produces the identical SHA-256 hex digest in Appendix D's table order.
 */
export function stateHashFromState(
  state: Pick<
    TournamentState,
    | "tournament"
    | "institutions"
    | "teams"
    | "adjudicators"
    | "venues"
    | "rounds"
    | "debates"
    | "motions"
    | "ballots"
    | "feedback"
    | "breakCategories"
    | "registrations"
    | "links"
  >,
): string {
  const combined = createHash("sha256");
  for (const table of STATE_HASH_TABLE_ORDER) {
    const content = rowsForTable(state, table);
    const tableHash = createHash("sha256").update(canonicalize(content), "utf8").digest();
    combined.update(tableHash);
  }
  return combined.digest("hex");
}
