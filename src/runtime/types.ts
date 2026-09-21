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
  /** 指向 GenomeSnapshot acceptance-evaluator 槽位绑定的 artifact id */
  verifier: string;
}

export interface TaskRecord {
  id: string;
  revision: number;
  requestedBy: string;
  goal: string;
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
  attempts: Array<{ id: string; ordinal: number; state: AttemptState; exitCode: number | null }>;
  checks: OutcomeCheck[];
  experienceId: string | null;
}

export type BudgetEntryKind = "reserve" | "settle";

/**
 * Organism 级预算（Q5 决策：Attempt 数 + 墙钟秒数，Run 与 Organism 两级）。
 * 在途额度 = 活跃 Run 的 reserve 记录之和；准入时原子检查，结算后释放。
 */
export interface OrganismBudget {
  maxConcurrentRuns: number;
  maxInFlightAttempts: number;
  maxInFlightWallClockSeconds: number;
}

export const DEFAULT_ORGANISM_BUDGET: OrganismBudget = {
  maxConcurrentRuns: 4,
  maxInFlightAttempts: 16,
  maxInFlightWallClockSeconds: 86_400,
};

/** Runtime 持久化 port；由 storage 实现。 */
export interface RuntimeStore {
  insertTask(t: TaskRecord): void;
  getTask(id: string): TaskRecord | undefined;

  insertRun(r: RunRecord): void;
  getRun(id: string): RunRecord | undefined;
  listRuns(limit: number): Array<RunRecord & { goal: string }>;
  listRunsByStates(states: RunState[], limit: number): RunRecord[];
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
  /** organism 当前活跃（pending/running/waiting）Run 的数量 */
  countActiveRuns(organismId: string): number;
  /** organism 在途预算：活跃 Run 的 reserve 之和（settle 后的 Run 不再计入） */
  inFlightBudget(organismId: string): { attempts: number; seconds: number };

  appendEvent(e: EventAppend): { eventId: string; seq: number };
  listEvents(filter: { runId?: string; streamId?: string }, limit: number): EventRecord[];
  hasCancelIntent(runId: string): boolean;

  insertDispatch(d: DispatchRecord): void;
  markDispatched(dispatchId: string, handle: string, at: number): void;
  completeDispatch(dispatchId: string, at: number): void;
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
}

export interface ExecutorProvider {
  readonly name: string;
  start(req: ExecutionRequest): Promise<ExecutionResult>;
}
