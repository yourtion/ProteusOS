import { cpSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Clock, IdGen, Kernel } from "../kernel/index.ts";
import { digestOf } from "../storage/blobs.ts";
import type { BlobStore } from "../storage/blobs.ts";
import type { Storage } from "../storage/store.ts";
import { evaluateStatsOutput } from "./acceptance.ts";
import { parseGraph } from "./graph.ts";
import type {
  AttemptRecord,
  ExecutorProvider,
  OutcomeCheck,
  RunRecord,
  RunState,
  RunSummary,
  TaskBudget,
} from "./types.ts";

export interface TaskSubmission {
  requestedBy: string;
  goal: string;
  /** 绝对路径（由 CLI 相对 task 文件解析） */
  inputs: string[];
  budget: TaskBudget;
  acceptance: {
    /** JSON Schema 文件绝对路径 */
    outputSchema: string;
    /** 必须与快照 acceptance-evaluator 槽位绑定的 artifact 一致 */
    verifier: string;
  };
}

export type RuntimeErrorCode =
  | "unknown_run"
  | "unknown_organism"
  | "no_active_genome"
  | "invalid_input_path"
  | "invalid_graph"
  | "verifier_mismatch"
  | "missing_binding"
  | "run_not_pending"
  | "budget_exhausted";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RuntimeDeps {
  storage: Storage;
  kernel: Kernel;
  organismId: string;
  executor: ExecutorProvider;
  blobs: BlobStore;
  instanceRoot: string;
  clock: Clock;
  ids: IdGen;
}

/**
 * Runtime：Task/Run/Process/Attempt 状态机与单节点 pipeline 执行。
 * M0 切片①：submit 内联执行完整闭环；恢复/对账语义在切片④ 扩展。
 */
export class Runtime {
  private readonly deps: RuntimeDeps;

  constructor(deps: RuntimeDeps) {
    this.deps = deps;
  }

  /** 提交任务并内联执行到终态 */
  async submitTask(input: TaskSubmission): Promise<RunSummary> {
    for (const p of input.inputs) {
      assertInputPath(p);
    }
    assertInputPath(input.acceptance.outputSchema);

    const runId = this.deps.ids.next();
    const taskId = this.deps.ids.next();

    this.deps.storage.tx(() => {
      const organism = this.deps.kernel.getOrganism(this.deps.organismId);
      if (!organism)
        throw new RuntimeError("unknown_organism", `organism ${this.deps.organismId} 不存在`);
      if (!organism.activeGenomeId) {
        throw new RuntimeError("no_active_genome", "默认快照未安装，请先运行 proteus init");
      }
      // 原子读取 active 指针并固定解析后的快照（docs/runtime.md §1）
      const { snapshot, versions } = this.deps.kernel.resolveSnapshot(organism.activeGenomeId);
      this.assertVerifierBinding(versions, input.acceptance.verifier);
      const graphVersion = versions.get("task-graph");
      if (!graphVersion) throw new RuntimeError("missing_binding", "快照缺少 task-graph 槽位");

      const graphContent = this.deps.blobs.read(graphVersion.contentRef);
      try {
        parseGraph(graphContent);
      } catch (err) {
        throw new RuntimeError("invalid_graph", `task-graph 产物内容无效：${String(err)}`);
      }

      const now = this.deps.clock.now();
      this.deps.storage.insertTask({
        id: taskId,
        revision: 1,
        requestedBy: input.requestedBy,
        goal: input.goal,
        inputs: [...input.inputs],
        budget: { ...input.budget },
        acceptance: { ...input.acceptance },
        createdAt: now,
      });
      this.deps.storage.insertRun({
        id: runId,
        taskId,
        taskRevision: 1,
        organismId: this.deps.organismId,
        purpose: "normal",
        snapshotId: snapshot.id,
        graphDigest: digestOf(graphContent),
        state: "pending",
        supersedesRunId: null,
        budget: { ...input.budget },
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      });
      this.deps.storage.appendBudget(
        this.deps.ids.next(),
        runId,
        "reserve",
        input.budget.maxAttempts,
        input.budget.maxWallClockSeconds,
        now,
      );
      this.deps.storage.appendEvent({
        streamId: `task-${taskId}`,
        type: "task.created",
        payload: { goal: input.goal, inputs: input.inputs, requestedBy: input.requestedBy },
        correlationId: runId,
        occurredAt: now,
      });
      this.deps.storage.appendEvent({
        streamId: `run-${runId}`,
        type: "run.created",
        payload: { taskId, snapshotId: snapshot.id, purpose: "normal" },
        correlationId: runId,
        causationId: taskId,
        organismId: this.deps.organismId,
        runId,
        occurredAt: now,
      });
    });

    return this.executeRun(runId);
  }

  /** 执行一个 pending 状态的 Run 到终态 */
  async executeRun(runId: string): Promise<RunSummary> {
    const initial = this.mustGetRun(runId);
    if (initial.state !== "pending") {
      throw new RuntimeError("run_not_pending", `run ${runId} 状态为 ${initial.state}，不能执行`);
    }
    if (this.deps.storage.hasCancelIntent(runId)) {
      return this.finalize(runId, "cancelled", "cancelled_before_start", []);
    }

    this.transition(runId, "pending", "running", null);

    const run = this.mustGetRun(runId);
    const { versions } = this.deps.kernel.resolveSnapshot(run.snapshotId);
    const graphVersion = versions.get("task-graph")!;
    const graph = parseGraph(this.deps.blobs.read(graphVersion.contentRef));
    const node = graph.nodes[0]!;
    const task = this.deps.storage.getTask(run.taskId);
    if (!task) throw new RuntimeError("unknown_run", `run ${runId} 的 task ${run.taskId} 缺失`);

    const previousAttempts = this.listRunAttempts(runId);
    if (previousAttempts.length >= run.budget.maxAttempts) {
      return this.finalize(runId, "failed", "budget_exhausted", []);
    }
    // 派发边界检查取消意图（完整对账在切片④）
    if (this.deps.storage.hasCancelIntent(runId)) {
      return this.finalize(runId, "cancelled", "cancelled_before_dispatch", []);
    }

    const processId = this.deps.ids.next();
    const attemptId = this.deps.ids.next();
    const dispatchId = this.deps.ids.next();
    let startedAt = this.deps.clock.now();

    this.deps.storage.tx(() => {
      this.deps.storage.insertProcess({
        id: processId,
        runId,
        nodeId: node.id,
        role: "execute",
        createdAt: startedAt,
      });
      this.deps.storage.insertAttempt({
        id: attemptId,
        processId,
        ordinal: previousAttempts.length + 1,
        dispatchId,
        state: "dispatching",
        handle: null,
        startedAt,
        endedAt: null,
        exitCode: null,
        outputRef: null,
      });
      this.deps.storage.insertDispatch({
        dispatchId,
        runId,
        processId,
        attemptId,
        kind: "executor.start",
        payload: { executor: node.executor, node: node.id },
        state: "pending",
        handle: null,
        createdAt: startedAt,
        dispatchedAt: null,
        completedAt: null,
      });
      this.deps.storage.appendEvent({
        streamId: `process-${processId}`,
        type: "process.created",
        payload: { runId, nodeId: node.id, role: "execute" },
        correlationId: runId,
        runId,
        processId,
        occurredAt: startedAt,
      });
      this.deps.storage.appendEvent({
        streamId: `attempt-${attemptId}`,
        type: "attempt.dispatching",
        payload: { dispatchId, executor: node.executor, ordinal: previousAttempts.length + 1 },
        correlationId: runId,
        runId,
        processId,
        attemptId,
        occurredAt: startedAt,
      });
    });

    // 工作区准备与外部执行都在事务之外（docs/runtime.md §7）
    const workspace = join(this.instanceWorkspacesRoot(), runId, node.id);
    this.prepareWorkspace(workspace, task.inputs);

    const result = await this.deps.executor.start({
      runId,
      processId,
      attemptId,
      workspaceDir: workspace,
      timeoutMs: run.budget.maxWallClockSeconds * 1000,
    });

    const handle = `${this.deps.executor.name}:${dispatchId}`;
    const endedAt = this.deps.clock.now();
    this.deps.storage.tx(() => {
      this.deps.storage.markDispatched(dispatchId, handle, startedAt);
      this.deps.storage.updateAttempt(attemptId, {
        state: result.ok ? "succeeded" : "failed",
        handle,
        endedAt,
        exitCode: result.exitCode,
        outputRef: result.outputRef,
      });
      this.deps.storage.completeDispatch(dispatchId, endedAt);
      this.deps.storage.appendEvent({
        streamId: `attempt-${attemptId}`,
        type: result.ok ? "attempt.succeeded" : "attempt.failed",
        payload: {
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          stderrTail: result.stderr.slice(-2000),
        },
        correlationId: runId,
        runId,
        processId,
        attemptId,
        occurredAt: endedAt,
      });
    });

    if (!result.ok || !result.outputRef) {
      const reason = result.exitCode === null ? "execution_aborted" : "execution_failed";
      return this.finalize(runId, "failed", reason, []);
    }

    // 验收：裁判来自快照槽位，schema 来自 Task；执行器自报成功不构成验收
    let outputRaw: string;
    try {
      outputRaw = readFileSync(result.outputRef, "utf8");
    } catch {
      return this.finalize(runId, "failed", "output_missing", []);
    }
    let output: unknown;
    let schema: unknown;
    try {
      output = JSON.parse(outputRaw);
      schema = JSON.parse(readFileSync(task.acceptance.outputSchema, "utf8"));
    } catch {
      return this.finalize(runId, "failed", "invalid_output", []);
    }
    const evaluation = evaluateStatsOutput(output, schema);
    if (!evaluation.passed) {
      return this.finalize(runId, "failed", "acceptance_failed", evaluation.checks);
    }
    return this.finalize(runId, "succeeded", null, evaluation.checks, digestOf(outputRaw));
  }

  /** 记录停止意图；pending 状态直接取消，执行中的 Run 在派发边界生效 */
  async cancel(runId: string): Promise<{ runId: string; state: RunState; note: string }> {
    const run = this.mustGetRun(runId);
    if (isTerminal(run.state)) {
      return { runId, state: run.state, note: "run 已处于终态，取消无效果" };
    }
    this.deps.storage.tx(() => {
      this.deps.storage.appendEvent({
        streamId: `run-${runId}`,
        type: "run.cancel_requested",
        payload: { requestedAt: this.deps.clock.now() },
        correlationId: runId,
        runId,
        organismId: this.deps.organismId,
        occurredAt: this.deps.clock.now(),
      });
    });
    if (run.state === "pending") {
      this.finalize(runId, "cancelled", "cancelled_before_start", []);
      return { runId, state: "cancelled", note: "run 尚未开始，已直接取消" };
    }
    return {
      runId,
      state: run.state,
      note: "已持久化停止意图；已跨过派发边界的执行需对账确认（切片④实现完整语义）",
    };
  }

  getRunSummary(runId: string): RunSummary {
    const run = this.mustGetRun(runId);
    const attempts = this.listRunAttempts(runId);
    const experience = this.deps.storage.getExperienceByRun(runId);
    return {
      runId: run.id,
      taskId: run.taskId,
      state: run.state,
      failureReason: run.failureReason,
      snapshotId: run.snapshotId,
      attempts: attempts.map((a) => ({
        id: a.id,
        ordinal: a.ordinal,
        state: a.state,
        exitCode: a.exitCode,
      })),
      checks: experience?.outcome.checks ?? [],
      experienceId: experience?.id ?? null,
    };
  }

  // ---- 内部 ----

  private assertVerifierBinding(
    versions: Map<string, { artifactId: string }>,
    verifier: string,
  ): void {
    const evaluator = versions.get("acceptance-evaluator");
    if (!evaluator) throw new RuntimeError("missing_binding", "快照缺少 acceptance-evaluator 槽位");
    if (evaluator.artifactId !== verifier) {
      throw new RuntimeError(
        "verifier_mismatch",
        `task.verifier=${verifier} 与快照绑定的验收器 ${evaluator.artifactId} 不一致，拒绝执行`,
      );
    }
  }

  private mustGetRun(runId: string): RunRecord {
    const run = this.deps.storage.getRun(runId);
    if (!run) throw new RuntimeError("unknown_run", `run ${runId} 不存在`);
    return run;
  }

  private transition(runId: string, from: RunState, to: RunState, reason: string | null): void {
    this.deps.storage.tx(() => {
      this.deps.storage.updateRunState(runId, to, {
        failureReason: reason,
        updatedAt: this.deps.clock.now(),
      });
      this.deps.storage.appendEvent({
        streamId: `run-${runId}`,
        type: "run.state.changed",
        payload: { from, to, reason },
        correlationId: runId,
        runId,
        organismId: this.deps.organismId,
        occurredAt: this.deps.clock.now(),
      });
    });
  }

  private finalize(
    runId: string,
    state: "succeeded" | "failed" | "cancelled",
    reason: string | null,
    checks: OutcomeCheck[],
    outputDigest: string | null = null,
  ): RunSummary {
    const run = this.mustGetRun(runId);
    const attempts = this.listRunAttempts(runId);
    const endedAt = this.deps.clock.now();
    const durationMs = endedAt - run.createdAt;
    const experienceId = this.deps.ids.next();

    this.deps.storage.tx(() => {
      this.deps.storage.updateRunState(runId, state, { failureReason: reason, updatedAt: endedAt });
      this.deps.storage.appendBudget(
        this.deps.ids.next(),
        runId,
        "settle",
        attempts.length,
        durationMs / 1000,
        endedAt,
      );
      this.deps.storage.insertExperience({
        id: experienceId,
        runId,
        outcome: {
          result: state,
          checks,
          outputDigest,
          attemptCount: attempts.length,
          durationMs,
        },
        createdAt: endedAt,
      });
      this.deps.storage.appendEvent({
        streamId: `run-${runId}`,
        type: "run.state.changed",
        payload: { from: run.state, to: state, reason },
        correlationId: runId,
        runId,
        organismId: this.deps.organismId,
        occurredAt: endedAt,
      });
      this.deps.storage.appendEvent({
        streamId: `run-${runId}`,
        type: "experience.recorded",
        payload: { experienceId, result: state, attemptCount: attempts.length, outputDigest },
        correlationId: runId,
        runId,
        organismId: this.deps.organismId,
        occurredAt: endedAt,
      });
    });

    return {
      runId,
      taskId: run.taskId,
      state,
      failureReason: reason,
      snapshotId: run.snapshotId,
      attempts: attempts.map((a) => ({
        id: a.id,
        ordinal: a.ordinal,
        state: a.state,
        exitCode: a.exitCode,
      })),
      checks,
      experienceId,
    };
  }

  private listRunAttempts(runId: string): AttemptRecord[] {
    return this.deps.storage
      .listProcesses(runId)
      .flatMap((p) => this.deps.storage.listAttempts(p.id));
  }

  private instanceWorkspacesRoot(): string {
    return join(this.deps.instanceRoot, "workspaces");
  }

  private prepareWorkspace(workspace: string, inputs: string[]): void {
    mkdirSync(join(workspace, "inputs"), { recursive: true });
    for (const input of inputs) {
      cpSync(input, join(workspace, "inputs", basename(input)), { recursive: true });
    }
  }
}

export function isTerminal(state: RunState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function assertInputPath(p: string): void {
  try {
    statSync(p);
  } catch {
    throw new RuntimeError("invalid_input_path", `输入路径不可读：${p}`);
  }
}
