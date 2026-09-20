import { cpSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DecisionProvider } from "../decision/index.ts";
import { validateChoice } from "../decision/index.ts";
import type { Clock, IdGen, Kernel } from "../kernel/index.ts";
import { digestOf, type BlobStore } from "../storage/blobs.ts";
import type { Storage } from "../storage/store.ts";
import { evaluateStatsOutput } from "./acceptance.ts";
import {
  normalizeDag,
  parseGraph,
  topoOrder,
  validateDag,
  type NormalizedDag,
  type NormalizedNode,
} from "./graph.ts";
import type {
  AttemptRecord,
  ExecutorProvider,
  OrganismBudget,
  OutcomeCheck,
  RunRecord,
  RunState,
  RunSummary,
  RunSummaryDecision,
  RunSummaryNode,
  TaskBudget,
  TaskRecord,
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
  | "budget_exhausted"
  | "organism_budget_exceeded";

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
  decision: DecisionProvider;
  blobs: BlobStore;
  instanceRoot: string;
  clock: Clock;
  ids: IdGen;
  organismBudget: OrganismBudget;
}

type NodeState = "succeeded" | "failed" | "skipped";

/** 节点级失败：reason 进入 Run.failureReason，下游节点跳过 */
class NodeFailure extends Error {
  readonly reason: string;

  constructor(reason: string, detail: string) {
    super(detail);
    this.reason = reason;
  }
}

interface ExecContext {
  dag: NormalizedDag;
  nodeStates: Map<string, NodeState>;
  decisions: RunSummaryDecision[];
}

/**
 * Runtime：Task/Run/Process/Attempt 状态机与 DAG 节点循环。
 * M0 切片②：decision（规则路由）→ execute（受控进程）→ verify（独立裁判）。
 * 恢复/对账语义在切片④ 扩展。
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
      if (!organism) {
        throw new RuntimeError("unknown_organism", `organism ${this.deps.organismId} 不存在`);
      }
      if (!organism.activeGenomeId) {
        throw new RuntimeError("no_active_genome", "默认快照未安装，请先运行 proteus init");
      }
      // Organism 级预算在准入事务内原子检查：单 writer + BEGIN IMMEDIATE
      // 保证并发（含跨进程）提交不会各自读取同一余额后重复花费
      this.assertOrganismBudget(input.budget);
      // 原子读取 active 指针并固定解析后的快照（docs/runtime.md §1）
      const { snapshot, versions } = this.deps.kernel.resolveSnapshot(organism.activeGenomeId);
      this.assertVerifierBinding(versions, input.acceptance.verifier);
      const graphVersion = versions.get("task-graph");
      if (!graphVersion) throw new RuntimeError("missing_binding", "快照缺少 task-graph 槽位");

      const graphContent = this.deps.blobs.read(graphVersion.contentRef);
      try {
        validateDag(normalizeDag(parseGraph(graphContent)));
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
        this.deps.organismId,
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
    const graphVersion = versions.get("task-graph");
    if (!graphVersion) throw new RuntimeError("missing_binding", "快照缺少 task-graph 槽位");
    const dag = normalizeDag(parseGraph(this.deps.blobs.read(graphVersion.contentRef)));
    try {
      validateDag(dag);
    } catch (err) {
      return this.finalize(runId, "failed", "invalid_graph", [], null, {
        dag,
        nodeStates: new Map(),
        decisions: [],
      });
    }
    const task = this.deps.storage.getTask(run.taskId);
    if (!task) throw new RuntimeError("unknown_run", `run ${runId} 的 task ${run.taskId} 缺失`);

    // verify 节点的裁判必须等于快照绑定的验收器（候选不能替换本轮裁判）
    const evaluator = versions.get("acceptance-evaluator")!;
    const evaluatorArtifactId = this.deps.storage.getArtifact(evaluator.artifactId)!.id;
    for (const node of dag.nodes) {
      if (node.type === "verify" && node.verifier !== evaluatorArtifactId) {
        return this.finalize(runId, "failed", "verifier_mismatch", [], null, {
          dag,
          nodeStates: new Map(),
          decisions: [],
        });
      }
    }

    // decision 节点需要快照的 routing-policy
    const policyVersion = versions.get("routing-policy");
    const policy = policyVersion
      ? {
          versionId: policyVersion.id,
          content: JSON.parse(this.deps.blobs.read(policyVersion.contentRef)) as unknown,
        }
      : null;
    if (dag.nodes.some((n) => n.type === "decision") && !policy) {
      return this.finalize(runId, "failed", "missing_binding", [], null, {
        dag,
        nodeStates: new Map(),
        decisions: [],
      });
    }

    const nodeStates = new Map<string, NodeState>();
    const decisions: RunSummaryDecision[] = [];
    const outputs = new Map<string, string>(); // execute 节点 id -> outputRef
    const checks: OutcomeCheck[] = [];
    let failure: { nodeId: string; reason: string } | null = null;
    let cancelObserved = false;
    let verifiedDigest: string | null = null;

    for (const nodeId of topoOrder(dag)) {
      const node = dag.nodes.find((n) => n.id === nodeId)!;

      if (this.deps.storage.hasCancelIntent(runId)) {
        cancelObserved = true;
        this.markNode(runId, node, "skipped", "cancel_requested", nodeStates);
        continue;
      }
      if (!node.dependsOn.every((d) => nodeStates.get(d) === "succeeded")) {
        this.markNode(runId, node, "skipped", "dependency_not_succeeded", nodeStates);
        continue;
      }

      try {
        if (node.type === "decision") {
          decisions.push(await this.runDecision(runId, run, node, policy!));
        } else if (node.type === "execute") {
          outputs.set(node.id, await this.runExecute(runId, run, task, node, decisions));
        } else {
          verifiedDigest ??= this.runVerify(runId, task, node, outputs, checks);
        }
        this.markNode(runId, node, "succeeded", null, nodeStates);
      } catch (err) {
        if (!(err instanceof NodeFailure)) throw err;
        this.markNode(runId, node, "failed", err.reason, nodeStates);
        failure ??= { nodeId, reason: err.reason };
      }
    }

    // pipeline-v1 兼容：无 verify 节点时在 run 级做验收（切片①语义）
    if (!failure && !dag.nodes.some((n) => n.type === "verify")) {
      const firstExecute = dag.nodes.find((n) => n.type === "execute")!;
      const outputRef = outputs.get(firstExecute.id);
      try {
        const outputRaw = readFileSync(outputRef!, "utf8");
        const evaluation = evaluateStatsOutput(
          JSON.parse(outputRaw),
          JSON.parse(readFileSync(task.acceptance.outputSchema, "utf8")),
        );
        checks.push(...evaluation.checks);
        if (!evaluation.passed) {
          failure = { nodeId: firstExecute.id, reason: "acceptance_failed" };
          this.markNode(runId, firstExecute, "failed", "acceptance_failed", nodeStates);
        } else {
          verifiedDigest ??= digestOf(outputRaw);
        }
      } catch {
        failure = { nodeId: firstExecute.id, reason: "invalid_output" };
      }
    }

    const allSucceeded = !failure && dag.nodes.every((n) => nodeStates.get(n.id) === "succeeded");
    const state: "succeeded" | "failed" | "cancelled" = allSucceeded
      ? "succeeded"
      : cancelObserved
        ? "cancelled"
        : "failed";
    const reason =
      state === "cancelled"
        ? "cancelled_during_execution"
        : (failure?.reason ?? (state === "succeeded" ? null : "node_skipped"));
    return this.finalize(runId, state, reason, checks, verifiedDigest, {
      dag,
      nodeStates,
      decisions,
    });
  }

  /** 记录停止意图；pending 状态直接取消，执行中的 Run 在节点派发边界生效 */
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

  /** 事后汇总（CLI/inspect 用）：节点与决策从事件投影重建 */
  getRunSummary(runId: string): RunSummary {
    const run = this.mustGetRun(runId);
    const attempts = this.listRunAttempts(runId);
    const experience = this.deps.storage.getExperienceByRun(runId);
    const events = this.deps.storage.listEvents({ runId }, 500);

    const nodes: RunSummaryNode[] = events
      .filter((e) => e.type === "node.completed")
      .map((e) => ({
        id: String(e.payload["nodeId"]),
        type: e.payload["type"] as RunSummaryNode["type"],
        state: e.payload["state"] as NodeState,
      }));
    const decisions: RunSummaryDecision[] = events
      .filter((e) => e.type === "decision.recorded")
      .map((e) => ({
        nodeId: String(e.payload["nodeId"]),
        value: String(e.payload["value"]),
        provider: String(e.payload["provider"]),
        policyVersion: String(e.payload["policyVersion"]),
      }));

    return {
      runId: run.id,
      taskId: run.taskId,
      state: run.state,
      failureReason: run.failureReason,
      snapshotId: run.snapshotId,
      graphSource: events.some((e) => e.payload["graphKind"] === "dag-v1")
        ? "dag-v1"
        : "pipeline-v1",
      nodes,
      decisions,
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

  // ---- 节点执行 ----

  private async runDecision(
    runId: string,
    run: RunRecord,
    node: NormalizedNode,
    policy: { versionId: string; content: unknown },
  ): Promise<RunSummaryDecision> {
    const provider = this.deps.decision;
    if (node.provider !== provider.name) {
      throw new NodeFailure(
        "unknown_decision_provider",
        `图声明的决策 provider ${node.provider} 未装配（当前：${provider.name}）`,
      );
    }
    if (!provider.capabilities().problems.includes(node.problem!)) {
      throw new NodeFailure("decision_unsupported", `provider 不支持问题类型 ${node.problem}`);
    }
    const result = await provider.decide({
      problem: node.problem!,
      options: node.options!,
      context: node.context ?? {},
      policy,
      deadlineMs: run.budget.maxWallClockSeconds * 1000,
      remainingAttempts: Math.max(0, run.budget.maxAttempts - this.listRunAttempts(runId).length),
    });
    // Runtime 独立校验：选项成员关系不依赖 provider 自述（docs/runtime.md §3）
    const validation = validateChoice(result, node.options!);
    if (!validation.ok) {
      throw new NodeFailure(
        validation.reason === "abstain" ? "decision_abstained" : "decision_invalid_output",
        `decision ${node.id} ${validation.reason}: ${validation.detail}`,
      );
    }
    const entry: RunSummaryDecision = {
      nodeId: node.id,
      value: validation.value,
      provider: result.provenance.provider,
      policyVersion: result.provenance.policyVersion,
    };
    this.deps.storage.tx(() => {
      this.deps.storage.appendEvent({
        streamId: `run-${runId}`,
        type: "decision.recorded",
        payload: { ...entry, problem: node.problem },
        correlationId: runId,
        runId,
        organismId: this.deps.organismId,
        occurredAt: this.deps.clock.now(),
      });
    });
    return entry;
  }

  private async runExecute(
    runId: string,
    run: RunRecord,
    task: TaskRecord,
    node: NormalizedNode,
    decisions: RunSummaryDecision[],
  ): Promise<string> {
    const executorName =
      node.executor ?? decisions.find((d) => d.nodeId === node.executorFrom)?.value ?? undefined;
    if (!executorName) {
      throw new NodeFailure("unknown_executor", `execute ${node.id} 无法解析执行器`);
    }
    if (executorName !== this.deps.executor.name) {
      throw new NodeFailure(
        "unknown_executor",
        `执行器 ${executorName} 未装配（当前：${this.deps.executor.name}）`,
      );
    }

    const processId = this.deps.ids.next();
    const attemptId = this.deps.ids.next();
    const dispatchId = this.deps.ids.next();
    const startedAt = this.deps.clock.now();

    // Attempt 配额检查与创建必须在同一事务内：并发派发不会重复花费同一余额
    this.deps.storage.tx(() => {
      const previousAttempts = this.listRunAttempts(runId);
      if (previousAttempts.length >= run.budget.maxAttempts) {
        throw new NodeFailure("budget_exhausted", `Attempt 数已达上限 ${run.budget.maxAttempts}`);
      }
      const ordinal = previousAttempts.length + 1;
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
        ordinal,
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
        payload: { executor: executorName, node: node.id },
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
        payload: { dispatchId, executor: executorName, ordinal },
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
      throw new NodeFailure(
        result.exitCode === null ? "execution_aborted" : "execution_failed",
        `execute ${node.id} 失败（exit=${String(result.exitCode)}）`,
      );
    }
    return result.outputRef;
  }

  private runVerify(
    runId: string,
    task: TaskRecord,
    node: NormalizedNode,
    outputs: Map<string, string>,
    checks: OutcomeCheck[],
  ): string {
    const outputRef = outputs.get(node.inputFrom!);
    if (!outputRef) {
      throw new NodeFailure("output_missing", `verify ${node.id} 找不到 ${node.inputFrom} 的输出`);
    }
    let outputRaw: string;
    let output: unknown;
    let schema: unknown;
    try {
      outputRaw = readFileSync(outputRef, "utf8");
      output = JSON.parse(outputRaw);
      schema = JSON.parse(readFileSync(task.acceptance.outputSchema, "utf8"));
    } catch {
      throw new NodeFailure("invalid_output", `verify ${node.id} 无法读取或解析输出`);
    }
    const evaluation = evaluateStatsOutput(output, schema);
    checks.push(...evaluation.checks);
    this.deps.storage.tx(() => {
      this.deps.storage.appendEvent({
        streamId: `run-${runId}`,
        type: "verify.completed",
        payload: { nodeId: node.id, passed: evaluation.passed, checks: evaluation.checks },
        correlationId: runId,
        runId,
        organismId: this.deps.organismId,
        occurredAt: this.deps.clock.now(),
      });
    });
    if (!evaluation.passed) {
      const failed = evaluation.checks.find((c) => !c.passed);
      throw new NodeFailure(
        "acceptance_failed",
        `verify ${node.id} 未通过：${failed?.detail ?? ""}`,
      );
    }
    return digestOf(outputRaw);
  }

  private markNode(
    runId: string,
    node: NormalizedNode,
    state: NodeState,
    reason: string | null,
    nodeStates: Map<string, NodeState>,
  ): void {
    nodeStates.set(node.id, state);
    this.deps.storage.tx(() => {
      this.deps.storage.appendEvent({
        streamId: `run-${runId}`,
        type: "node.completed",
        payload: { nodeId: node.id, type: node.type, state, reason },
        correlationId: runId,
        runId,
        organismId: this.deps.organismId,
        occurredAt: this.deps.clock.now(),
      });
    });
  }

  // ---- 内部 ----

  /**
   * Organism 级预算准入检查（必须在准入事务内调用）。
   * 无法施加约束时拒绝准入，而不是放行后超支（docs/runtime.md §2）。
   */
  private assertOrganismBudget(budget: TaskBudget): void {
    const cap = this.deps.organismBudget;
    const activeRuns = this.deps.storage.countActiveRuns(this.deps.organismId);
    if (activeRuns >= cap.maxConcurrentRuns) {
      throw new RuntimeError(
        "organism_budget_exceeded",
        `并发 Run 数已达上限 ${cap.maxConcurrentRuns}（当前活跃 ${activeRuns}），拒绝准入`,
      );
    }
    const inFlight = this.deps.storage.inFlightBudget(this.deps.organismId);
    if (inFlight.attempts + budget.maxAttempts > cap.maxInFlightAttempts) {
      throw new RuntimeError(
        "organism_budget_exceeded",
        `在途 Attempt 预留 ${inFlight.attempts} + 本次 ${budget.maxAttempts} 超过上限 ${cap.maxInFlightAttempts}`,
      );
    }
    if (inFlight.seconds + budget.maxWallClockSeconds > cap.maxInFlightWallClockSeconds) {
      throw new RuntimeError(
        "organism_budget_exceeded",
        `在途墙钟预留 ${inFlight.seconds}s + 本次 ${budget.maxWallClockSeconds}s 超过上限 ${cap.maxInFlightWallClockSeconds}s`,
      );
    }
  }

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
    ctx?: ExecContext,
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
        run.organismId,
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
        payload: {
          from: run.state,
          to: state,
          reason,
          graphKind: ctx?.dag.source,
        },
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
      graphSource: ctx?.dag.source ?? "pipeline-v1",
      nodes: ctx
        ? [...ctx.nodeStates.entries()].map(([id, nodeState]) => {
            const node = ctx.dag.nodes.find((n) => n.id === id)!;
            return { id, type: node.type, state: nodeState };
          })
        : [],
      decisions: ctx?.decisions ?? [],
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
