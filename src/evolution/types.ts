/**
 * Evolution 领域类型（M2）。三种记录分别表达的事实不可合并（docs/evolution.md §5）：
 * Candidate 提议、Evaluation 证据、Promotion 决定。
 * Candidate 流程状态由 candidate-<id> 事件流投影，不物化为 status 列。
 */

export interface CandidateRecord {
  id: string;
  organismId: string;
  baseSnapshotId: string;
  baseRevision: number;
  proposedSnapshotId: string;
  hypothesis: string;
  proposedBy: string;
  /** 来源追溯：builderRunId、capability、specDigest 等 */
  sourceRefs: Record<string, string>;
  datasetRef: string | null;
  createdAt: number;
}

export interface EvaluationRunOutcome {
  role: "new-capability" | "regression" | "baseline";
  purpose: string;
  runId: string;
  snapshotId: string;
  state: string;
  failureReason: string | null;
  durationMs: number;
}

export interface EvaluationMetrics {
  newCapability: { passed: boolean; durationMs: number };
  regression: { passed: boolean; durationMs: number };
  baseline: { passed: boolean; durationMs: number };
  /** 成本留待真实计费数据（M3）；M2 显式记 null 而非臆造 */
  cost: null;
}

export interface EvaluationRecord {
  id: string;
  candidateId: string;
  protocolDigest: string;
  baselineSnapshotId: string;
  runs: EvaluationRunOutcome[];
  /** eligible=requisite 全过；rejected=候选失败；inconclusive=评估环境不可信（可重评） */
  verdict: "eligible" | "rejected" | "inconclusive";
  metrics: EvaluationMetrics;
  createdAt: number;
}

export interface PromotionRecord {
  id: string;
  operationId: string;
  kind: "adopt" | "rollback";
  organismId: string;
  fromSnapshotId: string;
  toSnapshotId: string;
  expectedRevision: number;
  resultRevision: number;
  evaluationRef: string | null;
  authorizationRef: string | null;
  actor: string;
  note: string | null;
  createdAt: number;
}

/** Candidate 流程状态（事件投影）：eligible 是证据满足，不代表获得晋升授权 */
export type CandidateStatus =
  | "proposed"
  | "evaluating"
  | "eligible"
  | "rejected"
  | "stale"
  | "adopted";
