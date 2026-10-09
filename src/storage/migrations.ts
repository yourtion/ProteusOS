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
  {
    // M2 最小自举：能力声明/缺口等待列 + Candidate/Evaluation/Promotion 三表。
    // Candidate 流程状态不落列，由 candidate-<id> 事件流投影（docs/domain-model.md §5）。
    version: 3,
    name: "m2-bootstrap",
    sql: `
ALTER TABLE tasks ADD COLUMN requires TEXT NOT NULL DEFAULT '[]';
ALTER TABLE runs ADD COLUMN missing_capabilities TEXT;
ALTER TABLE runs ADD COLUMN waiting_until INTEGER;

CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  organism_id TEXT NOT NULL,
  base_snapshot_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  proposed_snapshot_id TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  source_refs TEXT NOT NULL,
  dataset_ref TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_candidates_organism ON candidates(organism_id);
CREATE INDEX idx_candidates_proposed ON candidates(proposed_snapshot_id);

CREATE TABLE evaluations (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  protocol_digest TEXT NOT NULL,
  baseline_snapshot_id TEXT NOT NULL,
  runs TEXT NOT NULL,
  verdict TEXT NOT NULL,
  metrics TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_evaluations_candidate ON evaluations(candidate_id);

CREATE TABLE promotions (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  organism_id TEXT NOT NULL,
  from_snapshot_id TEXT NOT NULL,
  to_snapshot_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  result_revision INTEGER NOT NULL,
  evaluation_ref TEXT,
  authorization_ref TEXT,
  actor TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_promotions_organism ON promotions(organism_id);
`,
  },
  {
    // M2 切片②：评估 Run 的固定裁判版本（评估计划钉住，候选不能替换本轮裁判）。
    // null 表示用快照 acceptance-evaluator 槽位；恢复/续跑路径按此列还原裁判。
    version: 4,
    name: "m2-evaluation-evaluator",
    sql: `
ALTER TABLE runs ADD COLUMN evaluator_version_id TEXT;
`,
  },
  {
    // 本体决策实验（ADR 0007）：
    // - runs.deadline_at：Run 截止点持久化，剩余时间不能每个节点重新给足
    // - runs.experiment_id：实验 Run 归属（决策调用额度按 experiment/organism 双域记账）
    // - decision_calls：独立决策调用账本（prepared→started→终态），不挪用 Executor Attempt
    // - decision_call_limits：持久化额度（进程重启/换 experimentId 不能重置）
    version: 5,
    name: "organism-decision-v1",
    sql: `
ALTER TABLE runs ADD COLUMN deadline_at INTEGER;
UPDATE runs SET deadline_at = created_at
  + CAST(COALESCE(JSON_EXTRACT(budget, '$.maxWallClockSeconds'), 0) AS INTEGER) * 1000
  WHERE deadline_at IS NULL;
ALTER TABLE runs ADD COLUMN experiment_id TEXT;

CREATE TABLE decision_calls (
  id TEXT PRIMARY KEY,
  experiment_id TEXT,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,
  view_version_id TEXT,
  request_ref TEXT,
  request_digest TEXT,
  response_ref TEXT,
  response_digest TEXT,
  provenance TEXT NOT NULL,
  usage TEXT,
  error_class TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  duration_ms INTEGER,
  late_arrival INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_decision_calls_run ON decision_calls(run_id);
CREATE INDEX idx_decision_calls_experiment ON decision_calls(experiment_id);

CREATE TABLE decision_call_limits (
  scope TEXT PRIMARY KEY,
  max_calls INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`,
  },
  {
    // M3 经验驱动演化：冻结经验集（ExperienceDataset，docs/domain-model.md §Experience）。
    // 固定成员而非查询语句：成员为终态 Run 的 experience 显式清单 + 内容摘要；
    // purpose 声明用途许可（development=学习 / validation=独立验证 / regression=回归），
    // held-out 复用跟踪经 evaluations.dataset_ref 查询。
    version: 6,
    name: "m3-experience-datasets",
    sql: `
CREATE TABLE experience_datasets (
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL,
  cutoff_at INTEGER NOT NULL,
  member_experience_ids TEXT NOT NULL,
  member_digest TEXT NOT NULL,
  filter_version TEXT NOT NULL,
  permission_scope TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_experience_datasets_purpose ON experience_datasets(purpose);
`,
  },
  {
    // M3 策略评估：held-out 数据集引用列（使用计数与复用审计经此查询）
    version: 7,
    name: "m3-evaluation-dataset-ref",
    sql: "ALTER TABLE evaluations ADD COLUMN dataset_ref TEXT;",
  },
];
