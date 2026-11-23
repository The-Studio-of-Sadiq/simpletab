import { createHash } from "node:crypto";
import { canonicalize } from "@simpletab/core/changelog";
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

interface HashRow {
  id: string;
  data: string;
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
