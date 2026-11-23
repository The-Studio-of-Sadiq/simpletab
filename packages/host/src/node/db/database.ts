import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const SCHEMA_VERSION = 1;

export type SqliteDatabase = InstanceType<typeof Database>;

function schemaSql(): string {
  return readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
}

function hasTable(database: SqliteDatabase, name: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

function migrate(database: SqliteDatabase): void {
  if (!hasTable(database, "schema_migrations")) {
    const applyInitialSchema = database.transaction(() => {
      database.exec(schemaSql());
      const now = new Date().toISOString();
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(SCHEMA_VERSION, now);
      const insertMeta = database.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
      insertMeta.run("schema_version", String(SCHEMA_VERSION));
      insertMeta.run("host_number", "1");
    });
    applyInitialSchema();
    return;
  }

  const schemaVersion = database.prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  const currentVersion = schemaVersion === undefined ? 0 : Number(schemaVersion.value);
  if (!Number.isInteger(currentVersion) || currentVersion < 0) {
    throw new Error("The tournament database has an invalid schema version.");
  }
  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(
      `The tournament database schema version ${currentVersion} is newer than supported version ${SCHEMA_VERSION}.`,
    );
  }
  if (currentVersion < SCHEMA_VERSION) {
    throw new Error(`No forward migration is available from schema version ${currentVersion}.`);
  }
}

/** Opens and migrates a SQLite database file. Pass ":memory:" for an in-memory database. */
export function openDatabase(filePath: string): SqliteDatabase {
  if (filePath !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  }
  const database = new Database(filePath);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    migrate(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/** Opens the tournament DB at `<directory>/<slug>.simpletab.db`. */
export function openTournamentDatabase(directory: string, slug: string): SqliteDatabase {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) {
    throw new Error(`Invalid tournament slug: ${slug}`);
  }
  return openDatabase(path.join(directory, `${slug}.simpletab.db`));
}
