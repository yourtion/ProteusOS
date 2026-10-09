import type { ConsolidationParams } from "./consolidation.ts";

/**
 * Evolution 领域类型（M2）。三种记录分别表达的事实不可合并（docs/evolution.md §5）：
 * Candidate 提议、Evaluation 证据、Promotion 决定（Promotion 归 kernel 领域，此处 re-export）。
 * Candidate 流程状态由 candidate-<id> 事件流投影，不物化为 status 列。
 */
export type { PromotionKind, PromotionRecord } from "../kernel/types.ts";

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
  role: "new-capability" | "regression" | "baseline" | "policy-base" | "policy-candidate";
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

/** 策略评估的单臂分列指标（m3-policy-eval-v1；多目标不合成总分） */
export interface PolicyArmMetrics {
  runs: number;
  successRate: number;
  /** 路由选择与期望一致的比例（无期望的 case 不计入分母） */
  routeAccuracy: number | null;
  abstainRate: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  /** 成功率跨 repeat 的样本方差（重复运行保留方差，evolution.md §6） */
  successRateVariance: number;
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
  /** 策略评估（m3-policy-eval-v1）：双臂分列指标 + 门槛 + 方差 */
  policy?: {
    base: PolicyArmMetrics;
    candidate: PolicyArmMetrics;
    thresholds: { minSuccessRate: number; minImprovement: number; minSamples: number };
    repeats: number;
  };
  /** 评估数据集引用（held-out 使用计数经此查询；domain-model §变化记录） */
  datasetRef?: string | null;
  /** 验证集成员标识（case 级切分引用） */
  datasetSplitRefs?: string[];
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

/** 冻结经验集的用途许可：同一集不得跨用途复用（防 held-out 泄漏为开发反馈） */
export type ExperienceDatasetPurpose = "development" | "validation" | "regression";

/**
 * 冻结经验集（M3，docs/domain-model.md §Experience）：
 * 明确成员、截止点、过滤规则版本与用途许可——固定成员而非查询语句。
 * 不可变：digest = 元数据 + 成员投影内容摘要；幂等去重靠 digest。
 */
export interface ExperienceDatasetRecord {
  id: string;
  organismId: string;
  digest: string;
  purpose: ExperienceDatasetPurpose;
  cutoffAt: number;
  /** 显式成员（experience id 升序） */
  memberExperienceIds: string[];
  /** 成员投影内容摘要的摘要（成员内容变化的指纹） */
  memberDigest: string;
  /** 过滤规则版本（成员筛选语义，如 "v1: terminal runs with experience"） */
  filterVersion: string;
  permissionScope: string;
  createdBy: string;
  createdAt: number;
}

/** 学习投影中的决策调用摘要（Consolidation 的特征来源） */
export interface ExperienceDecisionCallView {
  id: string;
  nodeId: string;
  kind: "local" | "model";
  state: string;
  /** decision.recorded 投影的选择值；abstain/invalid 为 null */
  chosenOption: string | null;
  durationMs: number | null;
}

/** 冻结成员的学习投影视图（experience × run/task × decision_calls × budget） */
export interface ExperienceMemberView {
  runId: string;
  experienceId: string;
  taskGoal: string;
  familyId: string | null;
  requires: string[];
  runPurpose: string;
  snapshotId: string;
  result: "succeeded" | "failed" | "cancelled";
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
  outputDigest: string | null;
  attemptCount: number;
  durationMs: number;
  decisionCalls: ExperienceDecisionCallView[];
  budget: { reservedAttempts: number; reservedSeconds: number };
  createdAt: number;
}

/** Consolidation 作业（异步队列，evolution.md §3：独立队列与取消策略） */
export type ConsolidationJobState = "queued" | "running" | "completed" | "failed" | "cancelled";

/** 归纳模式：rule=确定性统计归纳；llm=LLM 提议 + 统计门槛重算 */
export type ConsolidationMode = "rule" | "llm";

export interface ConsolidationJobRecord {
  id: string;
  organismId: string;
  validationSetId: string | null;
  cancelRequested: boolean;
  datasetId: string;
  mode: ConsolidationMode;
  paramsDigest: string;
  /** 队列参数（内容寻址）：归纳门槛 + gold 的 blob 引用（不内联大数组） */
  params: { consolidation: ConsolidationParams; goldRef: string | null };
  state: ConsolidationJobState;
  result: { candidateId: string | null; hypothesis: string; proposals: number } | null;
  error: string | null;
  requestedBy: string;
  createdAt: number;
  updatedAt: number;
}

/** 验证集生命周期：ready → in_use（一次正式使用）→ retired（仅可作回归集） */
export type ValidationSetState = "ready" | "in_use" | "retired";

export interface ValidationSetRecord {
  id: string;
  organismId: string;
  familyIds: string[];
  /** 数据集来源引用（目录/生成参数摘要，供验证负责人定位） */
  sourceRef: string;
  preparedBy: string;
  /** 注册时的开发集 family 指纹（隔离基准；隔离断言依据） */
  devFamiliesDigest: string;
  devFamilyIds: string[];
  planDigest: string | null;
  planRef: string | null;
  candidateId: string | null;
  state: ValidationSetState;
  usageCount: number;
  firstUsedAt: number | null;
  retiredAt: number | null;
  createdAt: number;
}

export interface LearningCallRecord {
  id: string;
  organismId: string;
  jobId: string | null;
  state: "reserved" | "completed" | "unknown";
  usage: { inputTokens: number; outputTokens: number } | null;
  error: string | null;
  createdAt: number;
  endedAt: number | null;
}
