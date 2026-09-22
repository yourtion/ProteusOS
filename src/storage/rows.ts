/** 数据库原始行类型（snake_case），与 migrations.ts 的 schema 一一对应 */

export interface PrincipalRow {
  id: string;
  kind: string;
  created_at: number;
}

export interface OrganismRow {
  id: string;
  owner_id: string;
  scope: string;
  active_genome_id: string | null;
  revision: number;
  created_at: number;
}

export interface LineageRow {
  id: string;
  owner_id: string;
  scope: string;
  created_at: number;
}

export interface ArtifactRow {
  id: string;
  kind: string;
  lineage_id: string;
  owner_id: string;
  created_at: number;
}

export interface VersionRow {
  id: string;
  artifact_id: string;
  lineage_id: string;
  schema_version: number;
  content_digest: string;
  content_ref: string;
  parents: string;
  dependencies: string;
  created_by: string;
  created_at: number;
}

export interface SnapshotRow {
  id: string;
  digest: string;
  bindings: string;
  created_by: string;
  created_at: number;
}

export interface TaskRow {
  id: string;
  revision: number;
  requested_by: string;
  goal: string;
  inputs: string;
  budget: string;
  acceptance: string;
  requires: string;
  created_at: number;
}

export interface RunRow {
  id: string;
  task_id: string;
  task_revision: number;
  organism_id: string;
  purpose: string;
  snapshot_id: string;
  graph_digest: string;
  state: string;
  supersedes_run_id: string | null;
  budget: string;
  failure_reason: string | null;
  missing_capabilities: string | null;
  waiting_until: number | null;
  evaluator_version_id: string | null;
  deadline_at: number | null;
  experiment_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ProcessRow {
  id: string;
  run_id: string;
  node_id: string;
  role: string;
  created_at: number;
}

export interface AttemptRow {
  id: string;
  process_id: string;
  ordinal: number;
  dispatch_id: string;
  state: string;
  handle: string | null;
  started_at: number | null;
  ended_at: number | null;
  exit_code: number | null;
  output_ref: string | null;
}

export interface ExperienceRow {
  id: string;
  run_id: string;
  outcome: string;
  created_at: number;
}

export interface EventRow {
  event_id: string;
  stream_id: string;
  seq: number;
  type: string;
  schema_version: number;
  correlation_id: string | null;
  causation_id: string | null;
  organism_id: string | null;
  run_id: string | null;
  process_id: string | null;
  attempt_id: string | null;
  payload: string;
  occurred_at: number;
  recorded_at: number;
}

export interface DispatchRow {
  dispatch_id: string;
  run_id: string;
  process_id: string;
  attempt_id: string;
  kind: string;
  payload: string;
  state: string;
  handle: string | null;
  created_at: number;
  dispatched_at: number | null;
  completed_at: number | null;
}

export interface CandidateRow {
  id: string;
  organism_id: string;
  base_snapshot_id: string;
  base_revision: number;
  proposed_snapshot_id: string;
  hypothesis: string;
  proposed_by: string;
  source_refs: string;
  dataset_ref: string | null;
  created_at: number;
}

export interface EvaluationRow {
  id: string;
  candidate_id: string;
  protocol_digest: string;
  baseline_snapshot_id: string;
  runs: string;
  verdict: string;
  metrics: string;
  created_at: number;
}

export interface PromotionRow {
  id: string;
  operation_id: string;
  kind: string;
  organism_id: string;
  from_snapshot_id: string;
  to_snapshot_id: string;
  expected_revision: number;
  result_revision: number;
  evaluation_ref: string | null;
  authorization_ref: string | null;
  actor: string;
  note: string | null;
  created_at: number;
}

export interface DecisionCallRow {
  id: string;
  experiment_id: string | null;
  run_id: string;
  node_id: string;
  snapshot_id: string;
  kind: string;
  state: string;
  sent: number;
  provider: string;
  policy_version_id: string;
  view_version_id: string | null;
  request_ref: string | null;
  request_digest: string | null;
  response_ref: string | null;
  response_digest: string | null;
  provenance: string;
  usage: string | null;
  error_class: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  late_arrival: number;
  created_at: number;
  updated_at: number;
}

export interface DecisionCallLimitRow {
  scope: string;
  max_calls: number;
  created_at: number;
}
