import type { DecisionCallRecord } from "../decision/call.ts";
import type { ExecutionEvidence, StoredExecutionEvidence } from "./execution-evidence.ts";

/**
 * Runtime 领域类型与持久化 port。
 * 状态机语义见 docs/runtime.md；M0 切片① 只覆盖单节点 pipeline。
 */

export type RunState = "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export type AttemptState =
  | "dispatching"
  | "running"
  | "cancel_requested"
  | "unknown"
  | "succeeded"
  | "failed"
  | "cancelled";
export type RunPurpose = "normal" | "evaluation";

export interface TaskBudget {
  maxAttempts: number;
  maxWallClockSeconds: number;
}

export interface TaskAcceptance {
  /** JSON Schema 文件路径（相对 task 文件所在目录） */
  outputSchema: string;
  /** 可选的固定期望输出 JSON；存在时除 schema 外还须逐值相等 */
  expectedOutput?: string;
  /** 指向 GenomeSnapshot acceptance-evaluator 槽位绑定的 artifact id */
  verifier: string;
}

export interface TaskRecord {
  id: string;
  revision: number;
  requestedBy: string;
  goal: string;
  familyId?: string | null;
  /** 输入路径（相对 task 文件所在目录；admission 时解析为绝对路径再写入记录） */
  inputs: string[];
  budget: TaskBudget;
  acceptance: TaskAcceptance;
  /** 声明所需能力（短名，如 changed-file-summary）；对应快照槽位 capability/<name> */
  requires: string[];
  createdAt: number;
}

export interface RunRecord {
  id: string;
  taskId: string;
  taskRevision: number;
  organismId: string;
  purpose: RunPurpose;
  snapshotId: string;
  graphDigest: string;
  state: RunState;
  supersedesRunId: string | null;
  budget: TaskBudget;
  failureReason: string | null;
  /** 能力缺口等待：缺失能力清单；null 表示非缺口等待 */
  missingCapabilities: string[] | null;
  /** 缺口等待截止时刻（epoch ms）；到时 advance 结案 failed/missing_capability */
  waitingUntil: number | null;
  /**
   * 评估 Run 的固定裁判版本（评估计划钉住，docs/runtime.md §1）；
   * null 表示使用快照 acceptance-evaluator 槽位
   */
  evaluatorVersionId: string | null;
  /** Run 截止点（epoch ms，createdAt + budget.maxWallClockSeconds）；剩余时间由此计算 */
  deadlineAt: number;
  /** 实验 Run 归属（organism-decision-v1）；普通 Run 为 null */
  experimentId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProcessRecord {
  id: string;
  runId: string;
  nodeId: string;
  role: string;
  createdAt: number;
}

export interface AttemptRecord {
  id: string;
  processId: string;
  ordinal: number;
  dispatchId: string;
  state: AttemptState;
  handle: string | null;
  startedAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
  outputRef: string | null;
}

export interface OutcomeCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface ExperienceOutcome {
  result: "succeeded" | "failed" | "cancelled";
  checks: OutcomeCheck[];
  outputDigest: string | null;
  attemptCount: number;
  durationMs: number;
  /** 关联的决策调用账本（ADR 0007 §4.4：决策证据与 Experience 通过 runId 关联） */
  decisionCallIds: string[];
}

export interface ExperienceRecord {
  id: string;
  runId: string;
  outcome: ExperienceOutcome;
  createdAt: number;
}

export interface EventAppend {
  streamId: string;
  type: string;
  payload: Record<string, unknown>;
  correlationId?: string;
  causationId?: string;
  organismId?: string;
  runId?: string;
  processId?: string;
  attemptId?: string;
  occurredAt: number;
}

export interface EventRecord {
  eventId: string;
  streamId: string;
  seq: number;
  type: string;
  schemaVersion: number;
  correlationId: string | null;
  causationId: string | null;
  organismId: string | null;
  runId: string | null;
  processId: string | null;
  attemptId: string | null;
  payload: Record<string, unknown>;
  occurredAt: number;
  recordedAt: number;
}

export interface DispatchRecord {
  dispatchId: string;
  runId: string;
  processId: string;
  attemptId: string;
  kind: string;
  payload: Record<string, unknown>;
  state: "pending" | "dispatched" | "completed";
  handle: string | null;
  createdAt: number;
  dispatchedAt: number | null;
  completedAt: number | null;
}

export interface RunSummaryNode {
  id: string;
  type: "decision" | "execute" | "verify";
  state: "succeeded" | "failed" | "skipped";
}

export interface RunSummaryDecision {
  nodeId: string;
  value: string;
  provider: string;
  policyVersion: string;
}

export interface RunSummary {
  runId: string;
  taskId: string;
  state: RunState;
  failureReason: string | null;
  snapshotId: string;
  graphSource: "pipeline-v1" | "dag-v1";
  nodes: RunSummaryNode[];
  decisions: RunSummaryDecision[];
  attempts: Array<{
    id: string;
    ordinal: number;
    state: AttemptState;
    exitCode: number | null;
    evidence?: StoredExecutionEvidence;
  }>;
  checks: OutcomeCheck[];
  experienceId: string | null;
}

export type BudgetEntryKind = "reserve" | "settle";

/**
 * Organism 级预算池（Q5 决策：Attempt 数 + 墙钟秒数，Run 与 Organism 两级）。
 * 在途额度 = 活跃 Run 的 reserve 记录之和；准入时原子检查，结算后释放。
 * M3 起按用途分池（ADR 0006 挂账兑现）：评估 Run 独立于普通 Run 的
 * 并发/Attempt/墙钟额度，学习与评估不挤占在线任务预算（principles.md）。
 */
export interface BudgetPool {
  maxConcurrentRuns: number;
  maxInFlightAttempts: number;
  maxInFlightWallClockSeconds: number;
}

export interface OrganismBudget {
  normal: BudgetPool;
  evaluation: BudgetPool;
}

const DEFAULT_POOL: BudgetPool = {
  maxConcurrentRuns: 4,
  maxInFlightAttempts: 16,
  maxInFlightWallClockSeconds: 86_400,
};

export const DEFAULT_ORGANISM_BUDGET: OrganismBudget = {
  normal: DEFAULT_POOL,
  evaluation: DEFAULT_POOL,
};

/** Runtime 持久化 port；由 storage 实现。 */
export interface RuntimeStore {
  insertTask(t: TaskRecord): void;
  getTask(id: string): TaskRecord | undefined;

  insertRun(r: RunRecord): void;
  getRun(id: string): RunRecord | undefined;
  listRuns(limit: number): Array<RunRecord & { goal: string }>;
  listRunsByStates(states: RunState[], limit: number, organismId?: string): RunRecord[];
  updateRunState(
    id: string,
    state: RunState,
    patch: { failureReason?: string | null; updatedAt: number },
  ): void;

  insertProcess(p: ProcessRecord): void;
  listProcesses(runId: string): ProcessRecord[];
  /** 重试沿用 Process 身份（docs/runtime.md §1）：按节点查找既有 Process */
  findProcessByNode(runId: string, nodeId: string): ProcessRecord | undefined;

  insertAttempt(a: AttemptRecord): void;
  updateAttempt(
    id: string,
    patch: Partial<Pick<AttemptRecord, "state" | "handle" | "endedAt" | "exitCode" | "outputRef">>,
  ): void;
  listAttempts(processId: string): AttemptRecord[];

  insertExperience(e: ExperienceRecord): void;
  getExperienceByRun(runId: string): ExperienceRecord | undefined;

  appendBudget(
    id: string,
    runId: string,
    organismId: string,
    kind: BudgetEntryKind,
    attempts: number,
    seconds: number,
    at: number,
  ): void;
  /** organism 当前活跃（pending/running/waiting）Run 的数量；scope 缺省为全用途 */
  countActiveRuns(organismId: string, scope?: RunPurpose): number;
  /** organism 在途预算：活跃 Run 的 reserve 之和（settle 后的 Run 不再计入） */
  inFlightBudget(organismId: string, scope?: RunPurpose): { attempts: number; seconds: number };

  appendEvent(e: EventAppend): { eventId: string; seq: number };
  listEvents(filter: { runId?: string; streamId?: string }, limit: number): EventRecord[];
  hasCancelIntent(runId: string): boolean;

  insertDispatch(d: DispatchRecord): void;
  getDispatch(dispatchId: string): DispatchRecord | undefined;
  markDispatched(dispatchId: string, handle: string, at: number): void;
  completeDispatch(dispatchId: string, at: number): void;

  // ---- 本体决策实验：决策调用账本与额度（ADR 0007）----

  insertDecisionCall(call: DecisionCallRecord): void;
  getDecisionCall(id: string): DecisionCallRecord | undefined;
  /** 同一 Run 同一节点的最新决策调用（恢复路径） */
  findDecisionCall(runId: string, nodeId: string): DecisionCallRecord | undefined;
  listDecisionCalls(runId: string): DecisionCallRecord[];
  updateDecisionCall(
    id: string,
    patch: Partial<
      Pick<
        DecisionCallRecord,
        | "state"
        | "sent"
        | "responseRef"
        | "responseDigest"
        | "usage"
        | "errorClass"
        | "startedAt"
        | "endedAt"
        | "durationMs"
        | "lateArrival"
      >
    >,
    opts: { updatedAt: number },
  ): void;
  /** 额度计数：已发送（sent）或仍处 prepared 预留的远端调用数（D06） */
  countDecisionQuotaCalls(scope: { organismId: string; experimentId?: string | null }): number;
  setDecisionCallLimit(
    scope: { organismId: string; experimentId?: string | null },
    maxCalls: number,
    at: number,
  ): void;
  getDecisionCallLimit(scope: {
    organismId: string;
    experimentId?: string | null;
  }): number | undefined;
}

/**
 * 执行请求：prompt 是发送给执行主体（agent/worker）的任务指令（来自 Task.goal）；
 * 本地 worker 可忽略它，ACP/SDK 型 agent 以此为用户消息。
 * start 等待执行完成；handle/事件流/cancel 语义随后续切片扩展（docs/runtime.md §5）。
 */
export interface ExecutionRequest {
  runId: string;
  processId: string;
  attemptId: string;
  workspaceDir: string;
  prompt: string;
  timeoutMs: number;
}

export interface ExecutionResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** 工作区内 output.json 的绝对路径；不存在为 null */
  outputRef: string | null;
  /** 可选以兼容旧 Adapter；缺项明确为 unavailable。 */
  evidence?: ExecutionEvidence;
}

export interface ExecutorProvider {
  readonly name: string;
  /** retry-safe 仅适用于无工作区产物即可证明未产生外部副作用的受信执行器。 */
  readonly recoveryPolicy: "retry-safe" | "manual";
  start(req: ExecutionRequest): Promise<ExecutionResult>;
}
