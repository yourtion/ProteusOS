import type { Migration } from "./sqlite.ts";

/**
 * schema v1：M0 切片① 所需的全量表。
 * 事件与 outbox 与运行状态同库；内容 blob 走 BlobStore（按摘要寻址文件）。
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "m0-slice1",
    sql: `
CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE organisms (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  active_genome_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE lineages (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  lineage_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE artifact_versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  lineage_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  content_digest TEXT NOT NULL,
  content_ref TEXT NOT NULL,
  parents TEXT NOT NULL,
  dependencies TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (artifact_id, content_digest)
);
CREATE INDEX idx_versions_lineage ON artifact_versions(lineage_id);

CREATE TABLE genome_snapshots (
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL UNIQUE,
  bindings TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  requested_by TEXT NOT NULL,
  goal TEXT NOT NULL,
  inputs TEXT NOT NULL,
  budget TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  organism_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  graph_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  supersedes_run_id TEXT,
  budget TEXT NOT NULL,
  failure_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_runs_organism ON runs(organism_id);

CREATE TABLE processes (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_processes_run ON processes(run_id);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  process_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  dispatch_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  handle TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  exit_code INTEGER,
  output_ref TEXT,
  UNIQUE (process_id, ordinal)
);

CREATE TABLE experiences (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  outcome TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE budget_ledger (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  seconds REAL NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  correlation_id TEXT,
  causation_id TEXT,
  organism_id TEXT,
  run_id TEXT,
  process_id TEXT,
  attempt_id TEXT,
  payload TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  UNIQUE (stream_id, seq)
);
CREATE INDEX idx_events_run ON events(run_id);

CREATE TABLE outbox (
  dispatch_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  process_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL,
  handle TEXT,
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX idx_outbox_state ON outbox(state);
`,
  },
  {
    version: 2,
    name: "organism-budget-ledger",
    sql: `
ALTER TABLE budget_ledger ADD COLUMN organism_id TEXT NOT NULL DEFAULT '';
UPDATE budget_ledger SET organism_id = (
  SELECT runs.organism_id FROM runs WHERE runs.id = budget_ledger.run_id
) WHERE organism_id = '';
CREATE INDEX idx_budget_organism ON budget_ledger(organism_id);
`,
  },
];
