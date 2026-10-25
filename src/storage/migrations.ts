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
  {
    // M3+：Consolidation 异步作业队列（evolution.md §3"受独立队列、预算与取消
    // 策略约束"）。提交与执行分离：queued → running → completed/failed；
    // cancel 仅作用于 queued（执行内为纯函数短操作，不可中断，如实记录）。
    version: 8,
    name: "consolidation-jobs",
    sql: `
CREATE TABLE consolidation_jobs (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  params_digest TEXT NOT NULL,
  params TEXT NOT NULL,
  state TEXT NOT NULL,
  result TEXT,
  error TEXT,
  requested_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_consolidation_jobs_state ON consolidation_jobs(state);
CREATE INDEX idx_consolidation_jobs_dataset ON consolidation_jobs(dataset_id, params_digest);
`,
  },
  {
    // 验证集移交验证负责人机制（实验文档 §12 / evolution.md"多次查看同一
    // held-out 集会使其变成开发反馈"）：注册表固定 family 成员与隔离基准，
    // 使用计数与降级语义（正式使用一次后退休为回归集）可审计。
    version: 9,
    name: "validation-sets",
    sql: `
CREATE TABLE validation_sets (
  id TEXT PRIMARY KEY,
  family_ids TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  prepared_by TEXT NOT NULL,
  dev_families_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0,
  first_used_at INTEGER,
  retired_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_validation_sets_state ON validation_sets(state);
`,
  },
  {
    version: 10,
    name: "m3-frozen-policy-evidence-and-learning-ledger",
    sql: `
ALTER TABLE tasks ADD COLUMN family_id TEXT;
ALTER TABLE experience_datasets ADD COLUMN organism_id TEXT NOT NULL DEFAULT 'organism-default';
UPDATE experience_datasets SET organism_id = substr(permission_scope, 10) WHERE permission_scope LIKE 'organism:%';
ALTER TABLE consolidation_jobs ADD COLUMN organism_id TEXT NOT NULL DEFAULT 'organism-default';
UPDATE consolidation_jobs SET organism_id = COALESCE((SELECT organism_id FROM experience_datasets WHERE id = dataset_id), 'organism-default');
ALTER TABLE consolidation_jobs ADD COLUMN validation_set_id TEXT;
ALTER TABLE consolidation_jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE validation_sets ADD COLUMN organism_id TEXT NOT NULL DEFAULT 'organism-default';
ALTER TABLE validation_sets ADD COLUMN dev_family_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE validation_sets ADD COLUMN plan_digest TEXT;
ALTER TABLE validation_sets ADD COLUMN plan_ref TEXT;
ALTER TABLE validation_sets ADD COLUMN candidate_id TEXT;
CREATE TABLE experience_dataset_members (
  dataset_id TEXT NOT NULL REFERENCES experience_datasets(id),
  experience_id TEXT NOT NULL,
  PRIMARY KEY(dataset_id, experience_id)
);
INSERT INTO experience_dataset_members SELECT d.id, j.value FROM experience_datasets d, json_each(d.member_experience_ids) j;
CREATE INDEX idx_dataset_members_experience ON experience_dataset_members(experience_id);
CREATE TABLE learning_calls (
  id TEXT PRIMARY KEY,
  organism_id TEXT NOT NULL,
  job_id TEXT,
  state TEXT NOT NULL,
  usage TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX idx_learning_calls_organism ON learning_calls(organism_id);
CREATE TABLE learning_call_limits (organism_id TEXT PRIMARY KEY, max_calls INTEGER NOT NULL);
`,
  },
  {
    version: 11,
    name: "m4-version-scopes-and-selective-sharing",
    sql: `
ALTER TABLE artifact_versions RENAME TO artifact_versions_legacy;
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
  scope TEXT NOT NULL,
  UNIQUE(artifact_id, content_digest, scope)
);
INSERT INTO artifact_versions SELECT v.*, 'principal:' || COALESCE(a.owner_id, v.created_by)
  FROM artifact_versions_legacy v LEFT JOIN artifacts a ON a.id = v.artifact_id;
UPDATE artifact_versions SET scope = 'public' WHERE artifact_id IN ('stats-graph', 'stats-rule', 'stats-acceptance') AND parents = '[]';
DROP TABLE artifact_versions_legacy;
CREATE INDEX idx_versions_lineage ON artifact_versions(lineage_id);
CREATE TABLE access_grants (
  scope TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  action TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(scope, principal_id, action)
);
CREATE TABLE external_version_refs (
  id TEXT PRIMARY KEY,
  content_digest TEXT NOT NULL,
  lineage_id TEXT NOT NULL,
  publication_digest TEXT NOT NULL
);
CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  bundle_digest TEXT NOT NULL UNIQUE,
  bundle_ref TEXT NOT NULL,
  version_ids TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE shared_imports (
  id TEXT PRIMARY KEY,
  organism_id TEXT NOT NULL,
  bundle_digest TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  versions TEXT NOT NULL,
  root_version_ids TEXT NOT NULL,
  state TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(organism_id, bundle_digest)
);
`,
  },
  {
    version: 12,
    name: "m4-retain-imported-publication-claims",
    sql: "ALTER TABLE shared_imports ADD COLUMN bundle_ref TEXT;",
  },
  {
    version: 13,
    name: "m4-organism-scoped-experiment-limits",
    sql: "INSERT OR IGNORE INTO decision_call_limits SELECT 'experiment:organism-default:' || substr(scope, 12), max_calls, created_at FROM decision_call_limits WHERE scope LIKE 'experiment:%';",
  },
  {
    version: 14,
    name: "signed-sharing-trust-and-registry",
    sql: `
CREATE TABLE publication_keys (
  organism_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  publisher TEXT NOT NULL,
  public_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active', 'revoked')),
  local_signer INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(organism_id, key_id)
);
CREATE TABLE import_signatures (
  import_id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  signed_ref TEXT NOT NULL
);
CREATE TABLE registry_packages (
  organism_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  signed_ref TEXT NOT NULL,
  team_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  key_id TEXT NOT NULL,
  PRIMARY KEY(organism_id, digest)
);
CREATE TABLE registry_credentials (
  id TEXT PRIMARY KEY,
  organism_id TEXT NOT NULL,
  token_digest TEXT NOT NULL UNIQUE,
  team_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  actions TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active', 'revoked')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`,
  },
  {
    version: 15,
    name: "bounded-policy-compilation",
    sql: `
CREATE TABLE policy_compile_cases (
  id TEXT PRIMARY KEY,
  organism_id TEXT NOT NULL,
  experience_id TEXT NOT NULL,
  record TEXT NOT NULL,
  UNIQUE(organism_id, experience_id)
);
CREATE TABLE policy_compile_jobs (
  id TEXT PRIMARY KEY,
  organism_id TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  record TEXT NOT NULL,
  UNIQUE(organism_id, plan_digest)
);
CREATE TABLE policy_compile_trials (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES policy_compile_jobs(id),
  ordinal INTEGER NOT NULL,
  record TEXT NOT NULL,
  UNIQUE(job_id, ordinal)
);
`,
  },
  {
    version: 16,
    name: "adaptive-experiment-journal",
    sql: `
CREATE TABLE adaptive_experiments (
  id TEXT PRIMARY KEY,
  organism_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  record TEXT NOT NULL,
  UNIQUE(organism_id, manifest_digest)
);
CREATE TABLE adaptive_reservations (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES adaptive_experiments(id),
  ordinal INTEGER NOT NULL,
  record TEXT NOT NULL,
  UNIQUE(experiment_id, ordinal)
);
`,
  },
  {
    version: 17,
    name: "frozen-compile-development-bundles",
    sql: `
CREATE TABLE compile_development_bundles (
  job_id TEXT PRIMARY KEY REFERENCES policy_compile_jobs(id),
  organism_id TEXT NOT NULL,
  record TEXT NOT NULL
);
`,
  },
];
