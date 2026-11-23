export {
  SCHEMA_VERSION,
  openDatabase,
  openTournamentDatabase,
  type SqliteDatabase,
} from "./db/database";
export {
  HostEngine,
  type CancelLongResult,
  type CommitListener,
  type CommittedEvent,
  type HostApplyErrorCode,
  type HostApplyFailure,
  type HostApplyResult,
  type HostEngineOptions,
  type HostHead,
  type UndoFailure,
  type UndoResult,
} from "./engine/engine";
export {
  fastCheck,
  fastCheckWithStateSync,
  fullCheck,
  replayOpRow,
  resolveReplayActor,
  type IntegrityCheckOptions,
  type IntegrityCheckResult,
  type IntegrityStage,
  type IntegrityStateResult,
  type StoredOpRowFull,
} from "./engine/integrity";
export { LockManager, type ActiveLock } from "./engine/locks";
export {
  DEFAULT_SNAPSHOT_EVERY,
  decodeSnapshot,
  encodeSnapshot,
  readAllSnapshots,
  readLatestSnapshot,
  readSeedState,
  shouldTakeSnapshot,
  writeSnapshot,
  type EncodedSnapshot,
  type StoredSnapshotRow,
} from "./engine/snapshots";
export {
  LongOpWorkerPool,
  WorkerCancelledError,
  defaultWorkerPoolSize,
  type RunningWorkerTask,
  type WorkerPoolOptions,
} from "./engine/workers";
export {
  exportDivergent,
  type ExportDivergentOptions,
  type ExportDivergentResult,
} from "./handover/divergent";
export {
  exportHandover,
  type ExportHandoverOptions,
  type ExportHandoverResult,
} from "./handover/export";
export {
  assertNoCredentialMeta,
  parseOpsNdjson,
  serializeOpsNdjson,
  validateHandoverManifest,
  type DivergentManifest,
  type HandoverManifest,
  type HandoverOpRecord,
} from "./handover/format";
export {
  importHandover,
  type ImportHandoverOptions,
  type ImportHandoverResult,
} from "./handover/import";
export {
  allRecordKeys,
  fromContentOnlyState,
  loadState,
  loadVersions,
  seedState,
  toContentOnlyState,
  writeChangedRecords,
  type ContentOnlyState,
} from "./state/load";
export {
  STATE_HASH_TABLE_ORDER,
  stateHash,
  stateHashFromState,
  type StateHashTableName,
} from "./state/state-hash";
