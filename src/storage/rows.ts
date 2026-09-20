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
