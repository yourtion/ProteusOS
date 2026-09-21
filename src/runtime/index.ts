import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DecisionProvider } from "../decision/index.ts";
import { validateChoice } from "../decision/index.ts";
import type { Clock, IdGen, Kernel } from "../kernel/index.ts";
import { digestOf, type BlobStore } from "../storage/blobs.ts";
import type { Storage } from "../storage/store.ts";
import { evaluateStatsOutput, evaluateTestRunner, readEvaluatorKind } from "./acceptance.ts";
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
  /** 声明所需能力（短名）；快照须含 capability/<name> 槽位，缺一口即进入缺口等待 */
  requires?: string[];
  /** 能力缺口等待截止秒数（默认 3600）；到期 advance 结案 failed/missing_capability */
  missingCapabilityWaitSeconds?: number;
  acceptance: {
    /** JSON Schema 文件绝对路径 */
    outputSchema: string;
    /** 必须与快照 acceptance-evaluator 槽位绑定的 artifact 一致 */
    verifier: string;
  };
}

/** 能力短名 → 快照槽位名（capability/<name>，artifact kind 与槽位一致） */
export function capabilitySlot(name: string): string {
  return `capability/${name}`;
}

export const DEFAULT_MISSING_CAPABILITY_WAIT_SECONDS = 3600;

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
  /** 图节点 executor 名 → 执行器实例（local-process / claude-code-acp / codex-acp / pi） */
  executors: ReadonlyMap<string, ExecutorProvider>;
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

export interface RecoveryAction {
  runId: string;
  action: "resumed" | "needs_reconciliation" | "already_terminal" | "waiting_capability";
  unknownAttempts: Array<{ attemptId: string; ordinal: number }>;
  summary: RunSummary | null;
}

export interface ReconcileReport {
  runId: string;
  resolved: Array<{
    attemptId: string;
    nodeId: string;
    verdict: "succeeded" | "failed";
    evidence: string;
  }>;
  summary: RunSummary | null;
  note: string;
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
    let missingPending: string[] = [];

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

      // 能力检查（M2）：Task 声明的每个能力须有快照槽位；缺口进入带截止点的等待，
      // 不执行图——Run 固定本快照，能力只会出现在未来快照中，出路是接替或到期结案
      const requires = input.requires ?? [];
      const missing = requires.filter((c) => !versions.has(capabilitySlot(c)));
      missingPending = missing;

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
        requires: [...requires],
        createdAt: now,
      });
      const waitSeconds =
        input.missingCapabilityWaitSeconds ?? DEFAULT_MISSING_CAPABILITY_WAIT_SECONDS;
      this.deps.storage.insertRun({
        id: runId,
        taskId,
        taskRevision: 1,
        organismId: this.deps.organismId,
        purpose: "normal",
        snapshotId: snapshot.id,
        graphDigest: digestOf(graphContent),
        state: missing.length > 0 ? "waiting" : "pending",
        supersedesRunId: null,
        budget: { ...input.budget },
        failureReason: null,
        missingCapabilities: missing.length > 0 ? missing : null,
        waitingUntil: missing.length > 0 ? now + waitSeconds * 1000 : null,
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
        payload: {
          taskId,
          snapshotId: snapshot.id,
          purpose: "normal",
          requires,
          ...(missing.length > 0
            ? { missingCapabilities: missing, waitingUntil: now + waitSeconds * 1000 }
            : {}),
        },
        correlationId: runId,
        causationId: taskId,
        organismId: this.deps.organismId,
        runId,
        occurredAt: now,
      });
    });

    if (missingPending.length > 0) {
      return this.getRunSummary(runId);
    }
    return this.executeRun(runId);
  }

  /**
   * 推进能力缺口等待中的 Run（operator 显式调用）：
   * 截止时刻已到 → failed/missing_capability 结案；未到 → 保持等待。
   * 缺口 Run 固定自身快照，能力不会在其中出现，因此不存在"能力补齐续跑"路径。
   */
  async advanceRun(runId: string): Promise<{ runId: string; state: RunState; note: string }> {
    const run = this.mustGetRun(runId);
    if (!run.missingCapabilities) {
      return { runId, state: run.state, note: "run 不在能力缺口等待中，无操作" };
    }
    if (isTerminal(run.state)) {
      return { runId, state: run.state, note: `run 已终态（${run.state}），无操作` };
    }
    const now = this.deps.clock.now();
    const until = run.waitingUntil ?? run.createdAt;
    if (now < until) {
      return {
        runId,
        state: run.state,
        note: `等待截止 ${new Date(until).toISOString()} 未到，保持 waiting`,
      };
    }
    this.finalize(runId, "failed", "missing_capability", []);
    return {
      runId,
      state: "failed",
      note: `能力缺口等待到期：缺少 ${run.missingCapabilities.join(", ")}，以 failed/missing_capability 结案`,
    };
  }

  /**
   * 执行 Run 到终态。支持断点续跑：running/waiting 状态的 Run 从
   * node.completed 事件投影恢复已成功节点（跳过重派，避免重复副作用），
   * 其余节点按拓扑顺序继续。
   */
  async executeRun(runId: string): Promise<RunSummary> {
    const initial = this.mustGetRun(runId);
    if (initial.missingCapabilities && !isTerminal(initial.state)) {
      throw new RuntimeError(
        "run_not_pending",
        `run ${runId} 在能力缺口等待中（缺少 ${initial.missingCapabilities.join(", ")}），不能执行；请 supersede 接替或等待截止后 advance`,
      );
    }
    const resumable: RunState[] = ["pending", "running", "waiting"];
    if (!resumable.includes(initial.state)) {
      throw new RuntimeError("run_not_pending", `run ${runId} 状态为 ${initial.state}，不能执行`);
    }
    if (initial.state === "pending" && this.deps.storage.hasCancelIntent(runId)) {
      return this.finalize(runId, "cancelled", "cancelled_before_start", []);
    }

    if (initial.state !== "running") {
      this.transition(runId, initial.state, "running", null);
    }

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
    // 裁判的判定逻辑来自快照绑定的产物内容（stats-acceptance-v1 / test-runner-v1）
    const evaluatorContent = JSON.parse(this.deps.blobs.read(evaluator.contentRef)) as unknown;

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

    // 断点恢复：从事件投影重建已成功节点与决策；执行节点需工作区产物仍在
    if (initial.state !== "pending") {
      const history = this.deps.storage.listEvents({ runId }, 1000);
      for (const event of history) {
        if (event.type === "node.completed" && event.payload["state"] === "succeeded") {
          nodeStates.set(String(event.payload["nodeId"]), "succeeded");
        }
        if (event.type === "decision.recorded") {
          const nodeId = String(event.payload["nodeId"]);
          if (!decisions.some((d) => d.nodeId === nodeId)) {
            decisions.push({
              nodeId,
              value: String(event.payload["value"]),
              provider: String(event.payload["provider"]),
              policyVersion: String(event.payload["policyVersion"]),
            });
          }
        }
      }
      for (const node of dag.nodes) {
        if (node.type !== "execute" || nodeStates.get(node.id) !== "succeeded") continue;
        const outputRef = join(this.instanceWorkspacesRoot(), runId, node.id, "output.json");
        if (existsSync(outputRef)) {
          outputs.set(node.id, outputRef);
        } else {
          // 已成功节点的产物丢失：不能静默重跑（副作用已发生），如实失败
          this.markNode(runId, node, "failed", "output_missing", nodeStates);
          failure ??= { nodeId: node.id, reason: "output_missing" };
        }
      }
    }

    for (const nodeId of topoOrder(dag)) {
      const node = dag.nodes.find((n) => n.id === nodeId)!;

      if (nodeStates.get(nodeId) === "succeeded") continue; // 断点续跑：跳过已成功节点

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
          const inputNode = dag.nodes.find((n) => n.id === node.inputFrom);
          const inputWorkspace = inputNode ? this.nodeWorkspace(runId, inputNode) : "";
          const evaluation = this.runVerify(
            runId,
            task,
            node,
            outputs,
            checks,
            evaluatorContent,
            inputWorkspace,
          );
          if (evaluation) verifiedDigest ??= evaluation;
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
      note: "已持久化停止意图；将在下一个节点派发边界生效，执行中 Attempt 的结果仍会如实记录",
    };
  }

  /**
   * 崩溃恢复（operator 显式调用，M0 单操作者假设下无其他活动执行）：
   * - 遗留 dispatching/running 的 Attempt 无法确认派发是否已到达 → 标记 unknown、
   *   Run 置 waiting，等待 reconcile（docs/runtime.md §8：不能假定未执行并重发写操作）
   * - 无遗留执行的非终态 Run：从断点续跑
   */
  async recoverRun(runId?: string): Promise<RecoveryAction[]> {
    const runs = runId
      ? [this.mustGetRun(runId)]
      : this.deps.storage.listRunsByStates(["pending", "running", "waiting"], 100);
    const actions: RecoveryAction[] = [];
    for (const run of runs) {
      if (isTerminal(run.state)) {
        actions.push({
          runId: run.id,
          action: "already_terminal",
          unknownAttempts: [],
          summary: null,
        });
        continue;
      }
      if (run.missingCapabilities) {
        // 缺口等待不是执行中断，不属恢复范围；出路是接替或到期 advance
        actions.push({
          runId: run.id,
          action: "waiting_capability",
          unknownAttempts: [],
          summary: null,
        });
        continue;
      }
      const dangling = this.listRunAttempts(run.id).filter(
        (a) => a.state === "dispatching" || a.state === "running",
      );
      if (dangling.length > 0) {
        const at = this.deps.clock.now();
        this.deps.storage.tx(() => {
          for (const a of dangling) {
            this.deps.storage.updateAttempt(a.id, { state: "unknown" });
            this.deps.storage.appendEvent({
              streamId: `attempt-${a.id}`,
              type: "attempt.unknown",
              payload: { reason: "recovered_after_crash" },
              correlationId: run.id,
              runId: run.id,
              processId: a.processId,
              attemptId: a.id,
              occurredAt: at,
            });
          }
          this.deps.storage.updateRunState(run.id, "waiting", { updatedAt: at });
          this.deps.storage.appendEvent({
            streamId: `run-${run.id}`,
            type: "run.state.changed",
            payload: {
              from: run.state,
              to: "waiting",
              reason: "unknown_attempts_pending_reconciliation",
            },
            correlationId: run.id,
            runId: run.id,
            organismId: this.deps.organismId,
            occurredAt: at,
          });
        });
        actions.push({
          runId: run.id,
          action: "needs_reconciliation",
          unknownAttempts: dangling.map((a) => ({ attemptId: a.id, ordinal: a.ordinal })),
          summary: null,
        });
        continue;
      }
      const summary = await this.executeRun(run.id);
      actions.push({ runId: run.id, action: "resumed", unknownAttempts: [], summary });
    }
    return actions;
  }

  /**
   * 对账 unknown Attempt（operator 显式调用）。
   * 完成证据 = 工作区 output.json 完整落盘（本地受信 worker 的产物合同：
   * 只写自己的工作区，output.json 最后写入）。
   * - 证据成立 → 判定 succeeded 并补记 node.completed，续跑时跳过该节点
   * - 证据不成立 → 判定 failed（执行未完成、无外泄副作用）→ 有界重试新建 Attempt
   */
  async reconcileRun(runId: string): Promise<ReconcileReport> {
    const run = this.mustGetRun(runId);
    const unknowns = this.listRunAttempts(runId).filter((a) => a.state === "unknown");
    if (unknowns.length === 0) {
      return { runId, resolved: [], summary: null, note: "没有待对账的 unknown Attempt" };
    }
    const processNode = new Map(
      this.deps.storage.listProcesses(runId).map((p) => [p.id, p.nodeId]),
    );
    const resolved: Array<{
      attemptId: string;
      nodeId: string;
      verdict: "succeeded" | "failed";
      evidence: string;
    }> = [];
    this.deps.storage.tx(() => {
      for (const a of unknowns) {
        const nodeId = processNode.get(a.processId) ?? "unknown-node";
        const outputRef = join(this.instanceWorkspacesRoot(), runId, nodeId, "output.json");
        let verdict: "succeeded" | "failed" = "failed";
        let evidence = "工作区无完整产物";
        if (existsSync(outputRef)) {
          try {
            JSON.parse(readFileSync(outputRef, "utf8"));
            verdict = "succeeded";
            evidence = "工作区产物完整（output.json 可解析）";
          } catch {
            evidence = "工作区产物损坏（output.json 不可解析）";
          }
        }
        this.deps.storage.updateAttempt(a.id, {
          state: verdict,
          endedAt: this.deps.clock.now(),
          outputRef: verdict === "succeeded" ? outputRef : a.outputRef,
        });
        this.deps.storage.appendEvent({
          streamId: `attempt-${a.id}`,
          type: "attempt.reconciled",
          payload: { verdict, evidence, nodeId },
          correlationId: runId,
          runId,
          processId: a.processId,
          attemptId: a.id,
          occurredAt: this.deps.clock.now(),
        });
        if (verdict === "succeeded") {
          // 续跑投影需要 node.completed 才会跳过该节点（副作用已发生，不能重派）
          this.deps.storage.appendEvent({
            streamId: `run-${runId}`,
            type: "node.completed",
            payload: { nodeId, type: "execute", state: "succeeded", reason: "reconciled" },
            correlationId: runId,
            runId,
            organismId: this.deps.organismId,
            occurredAt: this.deps.clock.now(),
          });
        }
        resolved.push({ attemptId: a.id, nodeId, verdict, evidence });
      }
    });
    const current = this.mustGetRun(runId);
    if (isTerminal(current.state)) {
      return { runId, resolved, summary: null, note: "run 已处于终态，仅记录对账结论" };
    }
    const summary = await this.executeRun(runId);
    return { runId, resolved, summary, note: "对账完成并已续跑" };
  }

  /** 事后汇总（CLI/inspect 用）：节点与决策从事件投影重建（同 ID 取最新事件） */
  getRunSummary(runId: string): RunSummary {
    const run = this.mustGetRun(runId);
    const attempts = this.listRunAttempts(runId);
    const experience = this.deps.storage.getExperienceByRun(runId);
    const events = this.deps.storage.listEvents({ runId }, 1000);

    const nodeMap = new Map<string, RunSummaryNode>();
    for (const e of events) {
      if (e.type !== "node.completed") continue;
      nodeMap.set(String(e.payload["nodeId"]), {
        id: String(e.payload["nodeId"]),
        type: e.payload["type"] as RunSummaryNode["type"],
        state: e.payload["state"] as NodeState,
      });
    }
    const decisionMap = new Map<string, RunSummaryDecision>();
    for (const e of events) {
      if (e.type !== "decision.recorded") continue;
      const nodeId = String(e.payload["nodeId"]);
      decisionMap.set(nodeId, {
        nodeId,
        value: String(e.payload["value"]),
        provider: String(e.payload["provider"]),
        policyVersion: String(e.payload["policyVersion"]),
      });
    }

    return {
      runId: run.id,
      taskId: run.taskId,
      state: run.state,
      failureReason: run.failureReason,
      snapshotId: run.snapshotId,
      graphSource: events.some((e) => e.payload["graphKind"] === "dag-v1")
        ? "dag-v1"
        : "pipeline-v1",
      nodes: [...nodeMap.values()],
      decisions: [...decisionMap.values()],
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
    const executor = this.deps.executors.get(executorName);
    if (!executor) {
      throw new NodeFailure(
        "unknown_executor",
        `执行器 ${executorName} 未装配（可用：${[...this.deps.executors.keys()].join(", ")}）`,
      );
    }

    const attemptId = this.deps.ids.next();
    const dispatchId = this.deps.ids.next();
    const startedAt = this.deps.clock.now();

    // Attempt 配额检查与创建必须在同一事务内：并发派发不会重复花费同一余额。
    // 重试沿用 Process 身份并创建新 Attempt（docs/runtime.md §1）。
    const processId = this.deps.storage.tx((): string => {
      const previousAttempts = this.listRunAttempts(runId);
      if (previousAttempts.length >= run.budget.maxAttempts) {
        throw new NodeFailure("budget_exhausted", `Attempt 数已达上限 ${run.budget.maxAttempts}`);
      }
      const existing = this.deps.storage.findProcessByNode(runId, node.id);
      const processId = existing?.id ?? this.deps.ids.next();
      if (!existing) {
        this.deps.storage.insertProcess({
          id: processId,
          runId,
          nodeId: node.id,
          role: "execute",
          createdAt: startedAt,
        });
      }
      const ordinal = this.deps.storage.listAttempts(processId).length + 1;
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
      return processId;
    });

    // 工作区准备与外部执行都在事务之外（docs/runtime.md §7）
    const workspace = join(this.instanceWorkspacesRoot(), runId, node.id);
    this.prepareWorkspace(workspace, task.inputs);

    const result = await executor.start({
      runId,
      processId,
      attemptId,
      workspaceDir: workspace,
      prompt: task.goal,
      timeoutMs: run.budget.maxWallClockSeconds * 1000,
    });

    const handle = `${executorName}:${dispatchId}`;
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

    if (!result.ok) {
      throw new NodeFailure(
        result.exitCode === null ? "execution_aborted" : "execution_failed",
        `execute ${node.id} 失败（exit=${String(result.exitCode)}）`,
      );
    }
    // outputRef 对本地 worker 是 output.json；agent 型执行器没有单一输出文件，
    // 其产物是工作区内的代码，由 verify 节点（如 test-runner）验收
    return result.outputRef ?? "";
  }

  private runVerify(
    runId: string,
    task: TaskRecord,
    node: NormalizedNode,
    outputs: Map<string, string>,
    checks: OutcomeCheck[],
    evaluatorContent: unknown,
    inputWorkspace: string,
  ): string {
    // 裁判按快照绑定的验收器产物内容分发：候选不能替换本轮裁判（docs/evolution.md §6）
    const kind = readEvaluatorKind(evaluatorContent);
    let evaluation: { passed: boolean; checks: OutcomeCheck[] };
    let outputDigest: string | null = null;
    if (kind === "test-runner-v1") {
      // 测试命令在产出代码的 execute 节点工作区执行
      evaluation = evaluateTestRunner(evaluatorContent, inputWorkspace);
    } else {
      const outputRef = outputs.get(node.inputFrom!);
      if (!outputRef) {
        throw new NodeFailure(
          "output_missing",
          `verify ${node.id} 找不到 ${node.inputFrom} 的输出`,
        );
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
      evaluation = evaluateStatsOutput(output, schema);
      outputDigest = digestOf(outputRaw);
    }
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
    return outputDigest ?? "";
  }

  private nodeWorkspace(runId: string, node: NormalizedNode): string {
    return join(this.instanceWorkspacesRoot(), runId, node.id);
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
