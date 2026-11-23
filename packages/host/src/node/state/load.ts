import type {
  Adjudicator,
  BallotSubmission,
  BreakCategory,
  Debate,
  FeedbackSubmission,
  Institution,
  Motion,
  Round,
  Team,
  Venue,
} from "@simpletab/core/types";
import type { RegistrationSettings, RegistrationSubmission } from "@simpletab/core/lib/registration/types";
import type { LinkRecord } from "@simpletab/core/projection";
import type {
  DeviceRecord,
  LateSubmissionRecord,
  OpRound,
  OpTournament,
  ProposalRecord,
  RecordKey,
  TournamentState,
} from "@simpletab/core/ops/types";
import type { BallotIntakeRecord } from "@simpletab/core/types";
import type { CustomPermissionGroup } from "@simpletab/core/lib/staffPermissions";
import type { SqliteDatabase } from "../db/database";
import { recordKey } from "@simpletab/core/ops/types";

interface EntityRow {
  id: string;
  version: number;
  data: string;
}

interface SpecialEntityRow {
  version: number;
  data: string;
}

function readJson<T>(serialized: string): T {
  return JSON.parse(serialized) as T;
}

function rows<T>(database: SqliteDatabase, table: string): T[] {
  return database.prepare(`SELECT id, version, data FROM ${table} ORDER BY id`).all() as T[];
}

function readEntities<T extends { id: string }>(
  database: SqliteDatabase,
  table: string,
  kind: Parameters<typeof recordKey>[0],
  versions: Record<RecordKey, number>,
): T[] {
  return rows<EntityRow>(database, table).map((row) => {
    const value = readJson<T>(row.data);
    versions[recordKey(kind, value.id)] = row.version;
    return value;
  });
}

function readMeta<T>(database: SqliteDatabase, key: string): T | undefined {
  const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row === undefined ? undefined : readJson<T>(row.value);
}

function hasOptionalField(fields: readonly string[], field: string): boolean {
  return fields.includes(field);
}

/** Loads the persisted domain records and versions. `runtime` is intentionally never read. */
export function loadState(database: SqliteDatabase): TournamentState | null {
  const versions: Record<RecordKey, number> = {};
  const tournamentRow = database
    .prepare("SELECT version, data FROM tournament WHERE id = 't'")
    .get() as SpecialEntityRow | undefined;
  if (tournamentRow === undefined) {
    return null;
  }
  const tournament = readJson<OpTournament>(tournamentRow.data);
  versions[recordKey("tournament", tournament.id)] = tournamentRow.version;

  const institutions = readEntities<Institution>(database, "institutions", "institution", versions);
  const teams = readEntities<Team>(database, "teams", "team", versions);
  const adjudicators = readEntities<Adjudicator>(database, "adjudicators", "adjudicator", versions);
  const venues = readEntities<Venue>(database, "venues", "venue", versions);
  const rounds = readEntities<OpRound>(database, "rounds", "round", versions);
  const debates = readEntities<Debate>(database, "debates", "debate", versions);
  const motions = readEntities<Motion>(database, "motions", "motion", versions);
  const ballots = readEntities<BallotSubmission>(database, "ballots", "ballot", versions);
  const feedback = readEntities<FeedbackSubmission>(database, "feedback", "feedback", versions);
  const breakCategories = readEntities<BreakCategory>(
    database,
    "break_categories",
    "breakCategory",
    versions,
  );
  const registrations = readEntities<RegistrationSubmission>(
    database,
    "registrations",
    "registration",
    versions,
  );

  const linkRows = rows<EntityRow>(database, "links");
  const links = linkRows.map((row) => {
    const link = readJson<LinkRecord>(row.data);
    versions[recordKey("link", link.lookupId)] = row.version;
    return link;
  });

  const intake = readEntities<BallotIntakeRecord>(
    database,
    "ballot_intake",
    "ballotIntake",
    versions,
  );
  const lateSubmissions = readEntities<LateSubmissionRecord>(
    database,
    "late_submissions",
    "lateSubmission",
    versions,
  );
  const deviceRows = database.prepare("SELECT version, data FROM devices ORDER BY device_id")
    .all() as SpecialEntityRow[];
  const devices = deviceRows.map((row) => {
    const device = readJson<DeviceRecord>(row.data);
    versions[recordKey("device", device.id)] = row.version;
    return device;
  });
  const roleRows = database.prepare("SELECT version, data FROM roles ORDER BY role_id")
    .all() as SpecialEntityRow[];
  const roles = roleRows.map((row) => {
    const role = readJson<CustomPermissionGroup>(row.data);
    versions[recordKey("role", role.id)] = row.version;
    return role;
  });
  const proposalRows = database.prepare("SELECT version, data FROM proposals ORDER BY id")
    .all() as SpecialEntityRow[];
  const proposals = proposalRows.map((row) => {
    const proposal = readJson<ProposalRecord>(row.data);
    versions[recordKey("proposal", proposal.id)] = row.version;
    return proposal;
  });

  const hostRows = rows<EntityRow>(database, "host");
  const hostRow = hostRows[0];
  const host = hostRow === undefined ? undefined : readJson<TournamentState["host"]>(hostRow.data);
  if (host !== undefined && host !== null) {
    versions[recordKey("host", tournament.id)] = hostRow.version;
  }

  const optionalFields = readMeta<string[]>(database, "optional_fields") ?? [];
  const registrationSettings = readMeta<RegistrationSettings>(database, "registration_settings");
  const succession = readMeta<string[]>(database, "succession");
  return {
    tournament,
    institutions,
    teams,
    adjudicators,
    venues,
    rounds,
    debates,
    motions,
    ballots,
    feedback,
    breakCategories,
    links,
    registrations,
    devices,
    roles,
    proposals,
    versions,
    ...(intake.length > 0 || hasOptionalField(optionalFields, "ballotIntake")
      ? { ballotIntake: intake }
      : {}),
    ...(lateSubmissions.length > 0 || hasOptionalField(optionalFields, "lateSubmissions")
      ? { lateSubmissions }
      : {}),
    ...(registrationSettings !== undefined ? { registrationSettings } : {}),
    ...(succession !== undefined ? { succession } : {}),
    ...(host !== undefined && host !== null ? { host } : {}),
  };
}

/** Writes changed records by their core record key. A missing record is a delete. */
export function writeChangedRecords(
  database: SqliteDatabase,
  state: TournamentState,
  writes: readonly RecordKey[],
  seq: number,
): void {
  for (const key of writes) {
    const separator = key.indexOf(":");
    if (separator < 0) {
      throw new Error(`Invalid record key: ${key}`);
    }
    const kind = key.slice(0, separator);
    const id = key.slice(separator + 1);
    const version = state.versions[key] ?? 0;
    switch (kind) {
      case "tournament": {
        if (state.tournament.id !== id) {
          throw new Error(`Cannot write unknown tournament record: ${key}`);
        }
        database.prepare(
          "INSERT INTO tournament(id, version, last_seq, data) VALUES ('t', ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET version=excluded.version, last_seq=excluded.last_seq, data=excluded.data",
        ).run(version, seq, JSON.stringify(state.tournament));
        break;
      }
      case "institution":
        writeSimple(database, "institutions", id, version, seq, state.institutions);
        break;
      case "team":
        writeSimple(database, "teams", id, version, seq, state.teams);
        break;
      case "adjudicator":
        writeSimple(database, "adjudicators", id, version, seq, state.adjudicators);
        break;
      case "venue":
        writeSimple(database, "venues", id, version, seq, state.venues);
        break;
      case "round":
        writeSimple(database, "rounds", id, version, seq, state.rounds);
        break;
      case "debate":
        writeSimple(database, "debates", id, version, seq, state.debates);
        break;
      case "motion":
        writeSimple(database, "motions", id, version, seq, state.motions);
        break;
      case "ballot":
        writeSimple(database, "ballots", id, version, seq, state.ballots);
        break;
      case "ballotIntake":
        writeSimple(database, "ballot_intake", id, version, seq, state.ballotIntake ?? []);
        break;
      case "lateSubmission":
        writeSimple(database, "late_submissions", id, version, seq, state.lateSubmissions ?? []);
        break;
      case "feedback":
        writeSimple(database, "feedback", id, version, seq, state.feedback);
        break;
      case "breakCategory":
        writeSimple(database, "break_categories", id, version, seq, state.breakCategories);
        break;
      case "link":
        writeById(database, "links", id, version, seq, state.links, (link) => link.lookupId);
        break;
      case "registration":
        writeSimple(database, "registrations", id, version, seq, state.registrations);
        break;
      case "device":
        writeDevice(database, id, version, seq, state.devices);
        break;
      case "role":
        writeRole(database, id, version, seq, state.roles);
        break;
      case "host":
        if (state.host === undefined) {
          database.prepare("DELETE FROM host WHERE id = 't'").run();
        } else {
          database.prepare(
            "INSERT INTO host(id, version, last_seq, data) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET version=excluded.version, last_seq=excluded.last_seq, data=excluded.data",
          ).run("t", version, seq, JSON.stringify(state.host));
        }
        break;
      case "proposal":
        writeProposal(database, id, version, seq, state.proposals);
        break;
      default:
        throw new Error(`Unsupported record kind: ${kind}`);
    }
  }

  persistOptionalState(database, state);
}

function writeSimple<T extends { id: string }>(
  database: SqliteDatabase,
  table: string,
  id: string,
  version: number,
  seq: number,
  items: readonly T[],
): void {
  writeById(database, table, id, version, seq, items, (item) => item.id);
}

function writeById<T>(
  database: SqliteDatabase,
  table: string,
  id: string,
  version: number,
  seq: number,
  items: readonly T[],
  getId: (item: T) => string,
): void {
  const item = items.find((candidate) => getId(candidate) === id);
  if (item === undefined) {
    database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    return;
  }
  database.prepare(
    `INSERT INTO ${table}(id, version, last_seq, data) VALUES (?, ?, ?, ?) ` +
    "ON CONFLICT(id) DO UPDATE SET version=excluded.version, last_seq=excluded.last_seq, data=excluded.data",
  ).run(id, version, seq, JSON.stringify(item));
}

function writeDevice(
  database: SqliteDatabase,
  id: string,
  version: number,
  seq: number,
  items: readonly DeviceRecord[],
): void {
  const device = items.find((item) => item.id === id);
  if (device === undefined) {
    database.prepare("DELETE FROM devices WHERE device_id = ?").run(id);
    return;
  }
  database.prepare(
    "INSERT INTO devices(device_id, name, role_id, key_fingerprint, paired_at, removed_at, version, last_seq, data) " +
    "VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?) " +
    "ON CONFLICT(device_id) DO UPDATE SET name=excluded.name, role_id=excluded.role_id, " +
    "key_fingerprint=excluded.key_fingerprint, paired_at=excluded.paired_at, removed_at=NULL, " +
    "version=excluded.version, last_seq=excluded.last_seq, data=excluded.data",
  ).run(id, device.name, device.role.id, device.publicKey, device.approvedAt, version, seq, JSON.stringify(device));
}

function writeRole(
  database: SqliteDatabase,
  id: string,
  version: number,
  seq: number,
  items: readonly CustomPermissionGroup[],
): void {
  const role = items.find((item) => item.id === id);
  if (role === undefined) {
    database.prepare("DELETE FROM roles WHERE role_id = ?").run(id);
    return;
  }
  database.prepare(
    "INSERT INTO roles(role_id, name, permissions, version, last_seq, data) VALUES (?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(role_id) DO UPDATE SET name=excluded.name, permissions=excluded.permissions, " +
    "version=excluded.version, last_seq=excluded.last_seq, data=excluded.data",
  ).run(id, role.name, JSON.stringify(role.permissions), version, seq, JSON.stringify(role));
}

function writeProposal(
  database: SqliteDatabase,
  id: string,
  version: number,
  seq: number,
  items: readonly ProposalRecord[],
): void {
  const proposal = items.find((item) => item.id === id);
  if (proposal === undefined) {
    database.prepare("DELETE FROM proposals WHERE id = ?").run(id);
    return;
  }
  database.prepare(
    "INSERT INTO proposals(id, op, created_at, status, decided_by, version, last_seq, data) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET op=excluded.op, created_at=excluded.created_at, " +
    "status=excluded.status, decided_by=excluded.decided_by, version=excluded.version, " +
    "last_seq=excluded.last_seq, data=excluded.data",
  ).run(
    id,
    JSON.stringify(proposal.op),
    proposal.createdAt,
    proposal.status,
    proposal.resolvedBy ?? null,
    version,
    seq,
    JSON.stringify(proposal),
  );
}

function persistOptionalState(database: SqliteDatabase, state: TournamentState): void {
  const setMeta = database.prepare(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  );
  const deleteMeta = database.prepare("DELETE FROM meta WHERE key = ?");
  const optionalFields = [
    ...(state.ballotIntake !== undefined ? ["ballotIntake"] : []),
    ...(state.lateSubmissions !== undefined ? ["lateSubmissions"] : []),
  ];
  setMeta.run("optional_fields", JSON.stringify(optionalFields));
  if (state.registrationSettings === undefined) {
    deleteMeta.run("registration_settings");
  } else {
    setMeta.run("registration_settings", JSON.stringify(state.registrationSettings));
  }
  if (state.succession === undefined) {
    deleteMeta.run("succession");
  } else {
    setMeta.run("succession", JSON.stringify(state.succession));
  }
}

/** Seeds an empty database with the initial state. */
export function seedState(database: SqliteDatabase, state: TournamentState): void {
  if (database.prepare("SELECT 1 FROM tournament LIMIT 1").get() !== undefined) {
    throw new Error("The tournament database is already initialized.");
  }
  const writes = allRecordKeys(state);
  const seed = database.transaction(() => {
    writeChangedRecords(database, state, writes, 0);
  });
  seed();
}

function allRecordKeys(state: TournamentState): RecordKey[] {
  const keys: RecordKey[] = [recordKey("tournament", state.tournament.id)];
  const add = <T extends { id: string }>(kind: Parameters<typeof recordKey>[0], items: readonly T[]): void => {
    for (const item of items) {
      keys.push(recordKey(kind, item.id));
    }
  };
  add("institution", state.institutions);
  add("team", state.teams);
  add("adjudicator", state.adjudicators);
  add("venue", state.venues);
  add("round", state.rounds);
  add("debate", state.debates);
  add("motion", state.motions);
  add("ballot", state.ballots);
  add("ballotIntake", state.ballotIntake ?? []);
  add("lateSubmission", state.lateSubmissions ?? []);
  add("feedback", state.feedback);
  add("breakCategory", state.breakCategories);
  add("registration", state.registrations);
  for (const link of state.links) {
    keys.push(recordKey("link", link.lookupId));
  }
  add("device", state.devices);
  add("role", state.roles);
  add("proposal", state.proposals);
  if (state.host !== undefined) {
    keys.push(recordKey("host", state.tournament.id));
  }
  return keys;
}
