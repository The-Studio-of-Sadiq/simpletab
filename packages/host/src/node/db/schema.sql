CREATE TABLE tournament (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE institutions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  institution_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.institutionId')) STORED,
  data TEXT NOT NULL
);
CREATE TABLE adjudicators (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  institution_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.institutionId')) STORED,
  data TEXT NOT NULL
);
CREATE TABLE venues (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE rounds (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE debates (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  round_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.roundId')) STORED,
  data TEXT NOT NULL
);
CREATE TABLE motions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE ballots (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  debate_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.debateId')) STORED,
  round_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.roundId')) STORED,
  data TEXT NOT NULL
);
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  round_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.roundId')) STORED,
  adjudicator_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.targetAdjudicatorId')) STORED,
  data TEXT NOT NULL
);
CREATE TABLE break_categories (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE registrations (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE links (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  lookup_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.lookupId')) STORED,
  entity_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.entityId')) STORED,
  data TEXT NOT NULL
);

CREATE INDEX teams_institution_id_idx ON teams(institution_id);
CREATE INDEX adjudicators_institution_id_idx ON adjudicators(institution_id);
CREATE INDEX debates_round_id_idx ON debates(round_id);
CREATE INDEX ballots_debate_id_idx ON ballots(debate_id);
CREATE INDEX ballots_round_id_idx ON ballots(round_id);
CREATE INDEX feedback_round_id_idx ON feedback(round_id);
CREATE INDEX feedback_adjudicator_id_idx ON feedback(adjudicator_id);
CREATE UNIQUE INDEX links_lookup_id_unique ON links(lookup_id);
CREATE INDEX links_entity_id_idx ON links(entity_id);

CREATE TABLE ballot_intake (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE late_submissions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE host (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE ops (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  writes TEXT NOT NULL,
  inverse TEXT,
  inverse_of INTEGER,
  host_number INTEGER NOT NULL
);
CREATE TABLE changelog (
  seq INTEGER PRIMARY KEY,
  entry TEXT NOT NULL,
  salt BLOB NOT NULL,
  entry_hash TEXT NOT NULL
);
CREATE TABLE snapshots (
  seq INTEGER PRIMARY KEY,
  state_hash TEXT NOT NULL,
  data BLOB NOT NULL
);
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  op TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_by TEXT,
  version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role_id TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  paired_at TEXT NOT NULL,
  removed_at TEXT,
  version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE roles (
  role_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  permissions TEXT NOT NULL,
  version INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE staff (
  actor_ref TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role_id TEXT NOT NULL
);
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
