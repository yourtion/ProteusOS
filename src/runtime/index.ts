import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DecisionProvider, DecisionRequest, DecisionResult } from "../decision/index.ts";
import {
  DecisionViewError,
  RESPONSE_SCHEMA_DIGEST_TARGET,
  buildDecisionView,
  parseDecisionViewContent,
  validateChoice,
  type DecisionView,
} from "../decision/index.ts";
import type {
  DecisionCallKind,
  DecisionCallProvenance,
  DecisionCallRecord,
  DecisionCallState,
} from "../decision/call.ts";
import type { ArtifactVersion, Clock, IdGen, Kernel } from "../kernel/index.ts";
import { canonicalJson, digestOf, type BlobStore } from "../storage/blobs.ts";
import type { Storage } from "../storage/store.ts";
import {
  evaluateExpectedOutput,
  evaluateHybridOutput,
  evaluateStatsOutput,
  evaluateTestRunner,
  readEvaluatorKind,
} from "./acceptance.ts";
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
  RunPurpose,
  RunRecord,
  RunState,
  RunSummary,
  RunSummaryDecision,
  RunSummaryNode,
  TaskBudget,
  TaskRecord,
} from "./types.ts";
import { isCapabilityName, parseCapabilityModule, runCapabilityModule } from "./capability.ts";
import type { SandboxBackend } from "./sandbox.ts";

export interface TaskSubmission {
  familyId?: string;
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
    /** 可选固定期望输出 JSON 文件绝对路径 */
    expectedOutput?: string;
    /** 必须与快照 acceptance-evaluator 槽位绑定的 artifact 一致 */
    verifier: string;
  };
}

/** 能力短名 → 快照槽位名（capability/<name>，artifact kind 与槽位一致） */
export function capabilitySlot(name: string): string {
  return `capability/${name}`;
}

export const DEFAULT_MISSING_CAPABILITY_WAIT_SECONDS = 3600;

/**
 * 提交选项（M2）：评估 Run 的显式授权入口（docs/runtime.md §1）。
 * 指定 snapshotId 绑定候选/基线快照且不改变 activeGenome；
 * evaluatorVersionId 仅评估用途允许——评估计划固定裁判，候选不能替换本轮裁判。
 */
export interface SubmitOptions {
  purpose?: RunPurpose;
  /** 显式绑定的快照（已注册但未激活的候选/基线/构建器快照） */
  snapshotId?: string;
  /** 接替的 Run（R2 接替 R1）；运行与经验记录保留接替关系 */
  supersedesRunId?: string;
  /** 评估计划固定的裁判版本；仅 purpose=evaluation 允许 */
  evaluatorVersionId?: string;
  /** Task 修订号（接替场景为原 Task revision+1）；默认 1 */
  taskRevision?: number;
  /** 实验 Run 归属（ADR 0007）：决策调用额度按 experiment 域记账 */
  experimentId?: string;
}

export type RuntimeErrorCode =
  | "unknown_run"
  | "unknown_organism"
  | "no_active_genome"
  | "invalid_input_path"
  | "invalid_capability"
  | "invalid_graph"
  | "verifier_mismatch"
  | "missing_binding"
  | "run_not_pending"
  | "budget_exhausted"
  | "organism_budget_exceeded"
  | "decision_call_not_pending";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RuntimeDeps {
  actorId?: string;
  storage: Storage;
  kernel: Kernel;
  organismId: string;
  /** 图节点 executor 名 → 执行器实例（local-process / claude-code-acp / codex-acp / pi） */
  executors: ReadonlyMap<string, ExecutorProvider>;
  /** 图节点 provider 名 → 决策实例（app 决策注册表；未装配名得到明确 unknown_decision_provider） */
  decisions: ReadonlyMap<string, DecisionProvider>;
  blobs: BlobStore;
  instanceRoot: string;
  clock: Clock;
  ids: IdGen;
  organismBudget: OrganismBudget;
  /** 单次决策调用超时上限（默认 15s）；实际超时取此值与 Run 剩余时间的较小值 */
  decisionCallTimeoutMs?: number;
  /**
   * 能力执行沙箱后端（M3 真隔离）：提供即沙箱模式（不可用明确拒绝，
   * 不静默降级）；缺省为进程级（M2 行为，非真隔离）
   */
  capabilitySandbox?: SandboxBackend;
}

/** 实验协议 organism-decision-v1 的单次模型调用超时默认值（§4.2） */
export const DEFAULT_DECISION_CALL_TIMEOUT_MS = 15_000;

type NodeState = "succeeded" | "failed" | "skipped";

/** 节点级失败：reason 进入 Run.failureReason，下游节点跳过 */
class NodeFailure extends Error {
  readonly reason: string;

  constructor(reason: string, detail: string) {
    super(detail);
    this.reason = reason;
  }
}

/** 决策调用进入 unknown（可能已计费）：Run 保持 waiting，等待显式结案（§4.3） */
class DecisionPendingUnknown extends Error {
  readonly decisionId: string;

  constructor(decisionId: string, detail: string) {
    super(detail);
    this.decisionId = decisionId;
  }
}

/** invokeDecision 的四种可观察结局（provider 结果 / 超时 / 取消 / 传输错误） */
type DecisionOutcome =
  | { type: "result"; result: DecisionResult; durationMs: number }
  | { type: "timeout"; durationMs: number }
  | { type: "cancelled"; durationMs: number }
  | { type: "transport_error"; error: unknown; durationMs: number };

/** 决策调用失败终态 → 节点失败原因（恢复沿用，不重调） */
function decisionFailureReason(state: DecisionCallState): string {
  switch (state) {
    case "abstain":
      return "decision_abstained";
    case "invalid_output":
      return "decision_invalid_output";
    case "transport_error":
      return "decision_transport_error";
    case "timeout":
      return "decision_timeout";
    case "cancelled":
      return "decision_cancelled";
    default:
      return `decision_${state}`;
  }
}

/** 从 provider 结果提取用量提示（缺失落 null，不按零计） */
function evidenceUsage(result: DecisionResult): DecisionCallRecord["usage"] {
  const e = result.evidence;
  if (!e) return null;
  return {
    inputTokens: e.inputTokens ?? null,
    outputTokens: e.outputTokens ?? null,
    costAmount: e.costAmount ?? null,
    costCurrency: e.costCurrency ?? null,
    priceRef: e.priceRef ?? null,
  };
}

export interface RecoveryAction {
  runId: string;
  action:
    | "resumed"
    | "needs_reconciliation"
    | "already_terminal"
    | "waiting_capability"
    | "waiting_decision";
  unknownAttempts: Array<{ attemptId: string; ordinal: number }>;
  summary: RunSummary | null;
}

export interface ReconcileReport {
  runId: string;
  resolved: Array<{
    attemptId: string;
    nodeId: string;
    verdict: "succeeded" | "failed" | "unknown";
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
  /** 进行中的决策调用 AbortController（runId → 集合）：cancel 时中止底层请求 */
  private readonly activeDecisionAborts = new Map<string, Set<AbortController>>();
  private readonly activeDecisionHooks = new Map<AbortController, () => void>();

  constructor(deps: RuntimeDeps) {
    this.deps = deps;
  }

  /** 提交任务并内联执行到终态；options 提供评估 Run 的显式授权入口（M2） */
  async submitTask(input: TaskSubmission, options: SubmitOptions = {}): Promise<RunSummary> {
    this.deps.kernel.assertOrganismAccess(
      this.deps.organismId,
      this.deps.actorId ?? input.requestedBy,
    );
    this.deps.kernel.assertOrganismAccess(this.deps.organismId, input.requestedBy);
    for (const p of input.inputs) {
      assertInputPath(p);
    }
    assertInputPath(input.acceptance.outputSchema);
    if (input.acceptance.expectedOutput) assertInputPath(input.acceptance.expectedOutput);
    for (const capability of input.requires ?? []) {
      if (!isCapabilityName(capability)) {
        throw new RuntimeError("invalid_capability", `能力名称不合法：${capability}`);
      }
    }
    if (options.evaluatorVersionId && options.purpose !== "evaluation") {
      throw new RuntimeError(
        "run_not_pending",
        "evaluatorVersionId 仅评估用途（purpose=evaluation）允许指定：普通 Run 的裁判由快照槽位固定",
      );
    }
    if (
      options.supersedesRunId &&
      this.deps.storage.getRun(options.supersedesRunId)?.organismId !== this.deps.organismId
    ) {
      throw new RuntimeError(
        "unknown_run",
        `被接替的 run ${options.supersedesRunId} 不存在或属于其他个体`,
      );
    }

    const runId = this.deps.ids.next();
    const taskId = this.deps.ids.next();
    const purpose: RunPurpose = options.purpose ?? "normal";
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
      this.assertOrganismBudget(input.budget, purpose);
      // 原子固定快照：评估 Run 可显式绑定候选/基线快照，不读也不改 activeGenome
      const boundSnapshotId = options.snapshotId ?? organism.activeGenomeId;
      const { snapshot, versions } = this.deps.kernel.resolveSnapshot(boundSnapshotId);
      for (const version of versions.values())
        this.deps.kernel.assertVersionAccess(version.id, input.requestedBy);
      // 生效裁判：评估计划可钉住版本；普通 Run 用快照槽位
      const effectiveEvaluator = this.resolveEvaluator(
        versions,
        options.evaluatorVersionId ?? null,
      );
      this.assertVerifierBinding(effectiveEvaluator, input.acceptance.verifier);
      const graphVersion = versions.get("task-graph");
      if (!graphVersion) throw new RuntimeError("missing_binding", "快照缺少 task-graph 槽位");

      // 能力检查（M2）：Task 声明的每个能力须有快照槽位；缺口进入带截止点的等待，
      // 不执行图——Run 固定本快照，能力只会出现在未来快照中，出路是接替或到期结案
      const requires = input.requires ?? [];
      const missing = requires.filter((c) => !versions.has(capabilitySlot(c)));
      missingPending = missing;

      const graphContent = this.deps.blobs.read(graphVersion.contentRef);
      const dag = normalizeDag(parseGraph(graphContent));
      try {
        validateDag(dag);
      } catch (err) {
        throw new RuntimeError("invalid_graph", `task-graph 产物内容无效：${String(err)}`);
      }
      // 实验图准入（ADR 0007 §4.1）：声明 decision-view 的图必须有该槽位，缺失拒绝准入
      if (
        dag.nodes.some((n) => n.type === "decision" && n.view) &&
        !versions.has("decision-view")
      ) {
        throw new RuntimeError(
          "missing_binding",
          "图声明 decision-view-v1，但快照缺少 decision-view 槽位，拒绝准入",
        );
      }

      const now = this.deps.clock.now();
      const taskRevision = options.taskRevision ?? 1;
      this.deps.storage.insertTask({
        id: taskId,
        revision: taskRevision,
        requestedBy: input.requestedBy,
        goal: input.goal,
        familyId: input.familyId ?? null,
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
        taskRevision,
        organismId: this.deps.organismId,
        purpose,
        snapshotId: snapshot.id,
        graphDigest: digestOf(graphContent),
        state: missing.length > 0 ? "waiting" : "pending",
        supersedesRunId: options.supersedesRunId ?? null,
        budget: { ...input.budget },
        failureReason: null,
        missingCapabilities: missing.length > 0 ? missing : null,
        waitingUntil: missing.length > 0 ? now + waitSeconds * 1000 : null,
        evaluatorVersionId: options.evaluatorVersionId ?? null,
        // 截止点持久化：剩余时间由此计算，不能每个节点重新给足总时限（§4.2）
        deadlineAt: now + input.budget.maxWallClockSeconds * 1000,
        experimentId: options.experimentId ?? null,
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
          purpose,
          requires,
          supersedesRunId: options.supersedesRunId ?? null,
          deadlineAt: now + input.budget.maxWallClockSeconds * 1000,
          ...(options.experimentId ? { experimentId: options.experimentId } : {}),
          ...(options.evaluatorVersionId ? { evaluatorVersionId: options.evaluatorVersionId } : {}),
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
   * 接替结案（M2，operator 显式调用）：能力缺口等待中的 Run 以 failed/superseded
   * 结案，原因记录为被新运行接替；接替 Run 由调用方创建并经 supersedesRunId 关联。
   * 既有经验与外部结果不被抹去。
   */
  supersedeRun(runId: string): RunSummary {
    const run = this.mustGetRun(runId);
    if (isTerminal(run.state)) {
      throw new RuntimeError("run_not_pending", `run ${runId} 已终态（${run.state}），不能接替`);
    }
    if (!run.missingCapabilities) {
      throw new RuntimeError(
        "run_not_pending",
        `run ${runId} 不在能力缺口等待中；接替仅适用于缺口等待的 Run（其他状态的 Run 请用 cancel）`,
      );
    }
    return this.finalize(runId, "failed", "superseded", []);
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

    // 未结决策调用守卫（§4.3）：普通 execute/recover 入口都必须尊重——
    // started/unknown 的 model 调用可能已计费，不自动重发、不派发 worker
    const unresolvedCall = this.deps.storage
      .listDecisionCalls(runId)
      .find((c) => c.kind === "model" && (c.state === "started" || c.state === "unknown"));
    if (unresolvedCall) {
      this.transition(runId, "running", "waiting", "decision_call_unknown");
      return this.getRunSummary(runId);
    }

    const run = this.mustGetRun(runId);
    const { versions } = this.deps.kernel.resolveSnapshot(run.snapshotId);
    const graphVersion = versions.get("task-graph");
    if (!graphVersion) throw new RuntimeError("missing_binding", "快照缺少 task-graph 槽位");
    const dag = normalizeDag(parseGraph(this.deps.blobs.read(graphVersion.contentRef)));
    try {
      validateDag(dag);
    } catch {
      return this.finalize(runId, "failed", "invalid_graph", [], null, {
        dag,
        nodeStates: new Map(),
        decisions: [],
      });
    }
    const task = this.deps.storage.getTask(run.taskId);
    if (!task) throw new RuntimeError("unknown_run", `run ${runId} 的 task ${run.taskId} 缺失`);

    // verify 节点的裁判必须等于生效验收器（候选不能替换本轮裁判）；
    // 评估 Run 的裁判由评估计划钉住（run.evaluatorVersionId），与快照槽位无关
    const evaluator = this.resolveEvaluator(versions, run.evaluatorVersionId);
    const evaluatorArtifactId = evaluator.artifactId;
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
      if (failure?.reason === "access_revoked") {
        this.markNode(runId, node, "skipped", "access_revoked", nodeStates);
        continue;
      }
      if (!node.dependsOn.every((d) => nodeStates.get(d) === "succeeded")) {
        this.markNode(runId, node, "skipped", "dependency_not_succeeded", nodeStates);
        continue;
      }
      // 旧崩溃窗口修复（D07）：choice 已记录（decision.recorded）但节点完成未存——
      // 恢复使用已持久化的选择，不再次推断、不重复调用 provider
      if (node.type === "decision" && decisions.some((d) => d.nodeId === node.id)) {
        this.markNode(runId, node, "succeeded", "recovered_recorded_choice", nodeStates);
        continue;
      }

      try {
        if (node.type === "decision") {
          // runDecision 在同一事务提交 value 终态、decision.recorded 与 node.completed
          decisions.push(
            await this.runDecision(runId, run, task, node, policy!, versions, nodeStates),
          );
          continue;
        }
        if (node.type === "execute") {
          outputs.set(node.id, await this.runExecute(runId, run, task, node, decisions, versions));
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
        if (err instanceof DecisionPendingUnknown) {
          // 决策调用结果不明（可能已计费）：保留 unknown 证据，Run 置 waiting，
          // 不自动重发、不派发 worker，等待显式结案（settleDecisionCall）
          this.transition(runId, "running", "waiting", "decision_call_unknown");
          return this.getRunSummary(runId);
        }
        if (!(err instanceof NodeFailure)) throw err;
        if (!nodeStates.has(node.id)) {
          this.markNode(runId, node, "failed", err.reason, nodeStates);
        }
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
        if (task.acceptance.expectedOutput) {
          const expected = JSON.parse(readFileSync(task.acceptance.expectedOutput, "utf8"));
          const expectedCheck = evaluateExpectedOutput(JSON.parse(outputRaw), expected);
          evaluation.checks.push(expectedCheck);
          evaluation.passed &&= expectedCheck.passed;
        }
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
    const cancelledByFailure =
      failure?.reason === "cancel_requested" ||
      failure?.reason === "decision_cancelled" ||
      failure?.reason === "decision_call_cancelled";
    const state: "succeeded" | "failed" | "cancelled" = allSucceeded
      ? "succeeded"
      : cancelObserved || cancelledByFailure
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
    // 中止进行中的决策调用（结束本地等待；远端费用未知，调用按 cancelled 记录）
    for (const controller of this.activeDecisionAborts.get(runId) ?? []) {
      this.activeDecisionHooks.get(controller)?.();
    }
    if (run.state === "pending") {
      this.finalize(runId, "cancelled", "cancelled_before_start", []);
      return { runId, state: "cancelled", note: "run 尚未开始，已直接取消" };
    }
    return {
      runId,
      state: run.state,
      note: "已持久化停止意图并中止进行中的决策调用；将在下一个节点派发边界生效，执行中 Attempt 的结果仍会如实记录",
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
      : this.deps.storage.listRunsByStates(
          ["pending", "running", "waiting"],
          100,
          this.deps.organismId,
        );
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
      // 决策调用结果不明（可能已计费）：started 固化为 unknown 证据，Run 保持
      // waiting，等待显式结案（settleDecisionCall）或外部证据；不自动重发
      const unknownCalls = this.deps.storage
        .listDecisionCalls(run.id)
        .filter((c) => (c.state === "started" || c.state === "unknown") && c.kind === "model");
      if (unknownCalls.length > 0) {
        const at = this.deps.clock.now();
        this.deps.storage.tx(() => {
          for (const call of unknownCalls) {
            if (call.state !== "started") continue;
            this.deps.storage.updateDecisionCall(
              call.id,
              { state: "unknown", errorClass: "recovered_after_crash" },
              { updatedAt: at },
            );
            this.deps.storage.appendEvent({
              streamId: `run-${run.id}`,
              type: "decision.unknown",
              payload: { decisionId: call.id, reason: "recovered_after_crash", sent: call.sent },
              correlationId: run.id,
              runId: run.id,
              occurredAt: at,
            });
          }
        });
        if (run.state !== "waiting") {
          this.transition(run.id, run.state, "waiting", "decision_call_unknown");
        }
        actions.push({
          runId: run.id,
          action: "waiting_decision",
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
   * - 证据不成立且执行器声明 retry-safe → 判定 failed 并有界重试新建 Attempt
   * - 其余情况 → 保留 unknown，等待人工或执行器侧证据，禁止自动重试
   */
  async reconcileRun(runId: string): Promise<ReconcileReport> {
    this.mustGetRun(runId);
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
      verdict: "succeeded" | "failed" | "unknown";
      evidence: string;
    }> = [];
    this.deps.storage.tx(() => {
      for (const a of unknowns) {
        const nodeId = processNode.get(a.processId) ?? "unknown-node";
        const dispatch = this.deps.storage.getDispatch(a.dispatchId);
        const recoveryPolicy = dispatch?.payload["recoveryPolicy"];
        const outputRef = join(this.instanceWorkspacesRoot(), runId, nodeId, "output.json");
        let hasCompleteOutput = false;
        let evidence = "工作区无完整产物";
        if (existsSync(outputRef)) {
          try {
            JSON.parse(readFileSync(outputRef, "utf8"));
            hasCompleteOutput = true;
            evidence = "工作区产物完整（output.json 可解析）";
          } catch {
            evidence = "工作区产物损坏（output.json 不可解析）";
          }
        }
        if (!hasCompleteOutput && recoveryPolicy !== "retry-safe") {
          evidence = `${evidence}；执行器未声明可安全重试，保留 unknown 等待人工或外部证据`;
          this.deps.storage.appendEvent({
            streamId: `attempt-${a.id}`,
            type: "attempt.reconciliation.deferred",
            payload: { verdict: "unknown", evidence, nodeId, recoveryPolicy: "manual" },
            correlationId: runId,
            runId,
            processId: a.processId,
            attemptId: a.id,
            occurredAt: this.deps.clock.now(),
          });
          resolved.push({ attemptId: a.id, nodeId, verdict: "unknown", evidence });
          continue;
        }
        const verdict = hasCompleteOutput ? "succeeded" : "failed";
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
    if (resolved.some((item) => item.verdict === "unknown")) {
      return {
        runId,
        resolved,
        summary: null,
        note: "仍有无法确认副作用的 Attempt，保持 waiting，未自动重试",
      };
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

  /**
   * 决策调用生命周期（ADR 0007 §4.3）：
   * prepared（额度检查+预留同事务）→ started（先于网络发送）→ 终态；
   * value、decision.recorded 与节点成功在同一事务提交，关闭崩溃窗口。
   * 网络调用在数据库事务外执行；请求前、响应接受时与 worker 派发前检查取消与剩余时间。
   */
  private async runDecision(
    runId: string,
    run: RunRecord,
    task: TaskRecord,
    node: NormalizedNode,
    policy: { versionId: string; content: unknown },
    versions: Map<string, ArtifactVersion>,
    nodeStates: Map<string, NodeState>,
  ): Promise<RunSummaryDecision> {
    const provider = this.deps.decisions.get(node.provider!);
    if (!provider) {
      throw new NodeFailure(
        "unknown_decision_provider",
        `图声明的决策 provider ${node.provider} 未装配（可用：${[...this.deps.decisions.keys()].join(", ")}）`,
      );
    }
    if (!provider.capabilities().problems.includes(node.problem!)) {
      throw new NodeFailure("decision_unsupported", `provider 不支持问题类型 ${node.problem}`);
    }

    // 剩余时间从持久化截止点计算（§4.2）；deadline 已过不再发起决策
    const remainingMs = run.deadlineAt - this.deps.clock.now();
    if (remainingMs <= 0) {
      throw new NodeFailure(
        "deadline_exceeded",
        `Run 截止点已过（剩余 ${remainingMs}ms），不再发起决策调用`,
      );
    }

    // 视图装配（decision-view 节点）：Runtime 构建受限视图并校验大小
    let view: DecisionView | undefined;
    let viewVersionId: string | null = null;
    if (node.view) {
      const version = versions.get("decision-view");
      if (!version) {
        throw new NodeFailure("missing_binding", "快照缺少 decision-view 槽位（实验图）");
      }
      viewVersionId = version.id;
      let content;
      try {
        content = parseDecisionViewContent(JSON.parse(this.deps.blobs.read(version.contentRef)));
      } catch (err) {
        throw new NodeFailure("decision_view_invalid", `decision-view 产物不合法：${String(err)}`);
      }
      try {
        view = buildDecisionView({
          content,
          goal: task.goal,
          options: node.options!,
          taskInputs: task.inputs,
        });
      } catch (err) {
        if (err instanceof DecisionViewError && err.code === "input_too_large") {
          this.deps.storage.tx(() => {
            this.appendDecisionEvent(runId, node, "decision.rejected", {
              reason: "input_too_large",
              detail: err.message,
            });
          });
          throw new NodeFailure("input_too_large", err.message);
        }
        throw new NodeFailure(
          "decision_view_invalid",
          `decision-view 构建失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 恢复路径：该节点已有决策调用记录（prepared/started/终态），按 §4.3 处置
    const existing = this.deps.storage.findDecisionCall(runId, node.id);
    if (existing) {
      return this.resumeDecisionCall(existing, {
        run,
        node,
        policy,
        provider,
        view,
        viewVersionId,
        remainingMs,
        nodeStates,
      });
    }

    // 新调用：请求内容写入受控 blob（实际发送视图与序列化消息的完整内容）
    const requestCanonical = canonicalJson({
      problem: node.problem,
      options: node.options,
      view: view ?? null,
      context: node.context ?? {},
    });
    const requestDigest = digestOf(requestCanonical);
    const { ref: requestRef } = this.deps.blobs.write(requestCanonical);
    const decisionId = this.deps.ids.next();
    const kind: DecisionCallKind = provider.remote === true ? "model" : "local";
    const request = this.buildDecisionRequest({
      node,
      policy,
      run,
      runId,
      remainingMs,
      view,
      requires: task.requires,
    });

    // 事务一：额度检查与预留 + prepared 记录（远端调用才查额度；本地计算不消耗）
    const now = this.deps.clock.now();
    this.deps.storage.tx(() => {
      try {
        this.assertRunAccess(run, task, versions);
      } catch {
        throw new NodeFailure("access_revoked", "访问权限已撤销，禁止准备决策调用");
      }
      if (kind === "model") {
        const scopes: Array<{ organismId: string; experimentId?: string | null }> = [
          { organismId: run.organismId },
        ];
        if (run.experimentId) {
          scopes.push({ organismId: run.organismId, experimentId: run.experimentId });
        }
        for (const scope of scopes) {
          const limit = this.deps.storage.getDecisionCallLimit(scope);
          if (limit === undefined) continue;
          const used = this.deps.storage.countDecisionQuotaCalls(scope);
          if (used + 1 > limit) {
            throw new NodeFailure(
              "decision_budget_exhausted",
              `决策调用额度已尽（${scope.experimentId ? `experiment ${scope.experimentId}` : `organism ${scope.organismId}`}：${used}/${limit}），拒绝发起第 ${used + 1} 次调用`,
            );
          }
        }
      }
      this.deps.storage.insertDecisionCall({
        id: decisionId,
        experimentId: run.experimentId,
        runId,
        nodeId: node.id,
        snapshotId: run.snapshotId,
        kind,
        state: "prepared",
        sent: false,
        provider: provider.name,
        policyVersionId: policy.versionId,
        viewVersionId,
        requestRef,
        requestDigest,
        responseRef: null,
        responseDigest: null,
        provenance: this.buildProvenance(provider, { policy, viewVersionId, request }),
        usage: null,
        errorClass: null,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        lateArrival: false,
        createdAt: now,
        updatedAt: now,
      });
      this.appendDecisionEvent(runId, node, "decision.prepared", {
        decisionId,
        kind,
        provider: provider.name,
        policyVersionId: policy.versionId,
        requestDigest,
      });
    });

    return this.sendDecisionCall(decisionId, {
      run,
      node,
      provider,
      request,
      remainingMs,
      nodeStates,
    });
  }

  /** prepared → started（先于真正网络发送；取消在此检查）→ 调用 → 终态同事务提交 */
  private async sendDecisionCall(
    decisionId: string,
    args: {
      run: RunRecord;
      node: NormalizedNode;
      provider: DecisionProvider;
      request: DecisionRequest;
      remainingMs: number;
      nodeStates: Map<string, NodeState>;
    },
  ): Promise<RunSummaryDecision> {
    const { run, node, provider, request, remainingMs, nodeStates } = args;
    const now = this.deps.clock.now();
    let beforeSendFailure: NodeFailure | undefined;
    // 事务二：started 先于网络发送（§4.3：标记后、发送前崩溃保守判 unknown 的依据）
    this.deps.storage.tx(() => {
      try {
        const task = this.deps.storage.getTask(run.taskId);
        if (!task) throw new Error(`run ${run.id} 的 task 缺失`);
        this.assertRunAccess(run, task, this.deps.kernel.resolveSnapshot(run.snapshotId).versions);
      } catch {
        this.deps.storage.updateDecisionCall(
          decisionId,
          { state: "cancelled", sent: false, endedAt: now, errorClass: "access_revoked" },
          { updatedAt: now },
        );
        this.appendDecisionEvent(run.id, node, "decision.cancelled", {
          decisionId,
          phase: "access_revoked",
        });
        beforeSendFailure = new NodeFailure("access_revoked", "访问权限已撤销，决策调用未发送");
        return;
      }
      if (this.deps.storage.hasCancelIntent(run.id)) {
        this.deps.storage.updateDecisionCall(
          decisionId,
          {
            state: "cancelled",
            sent: false,
            endedAt: now,
            errorClass: "cancel_before_send",
          },
          { updatedAt: now },
        );
        this.appendDecisionEvent(run.id, node, "decision.cancelled", {
          decisionId,
          phase: "before_send",
        });
        beforeSendFailure = new NodeFailure(
          "decision_cancelled",
          `决策 ${node.id} 发送前收到取消请求，调用未发出（额度已释放）`,
        );
        return;
      }
      this.deps.storage.updateDecisionCall(
        decisionId,
        { state: "started", sent: provider.remote === true, startedAt: now },
        { updatedAt: now },
      );
      this.appendDecisionEvent(run.id, node, "decision.started", { decisionId });
    });
    if (beforeSendFailure) throw beforeSendFailure;

    // 网络调用在数据库事务外执行；超时取单次上限与 Run 剩余时间的较小值
    const startedAt = this.deps.clock.now();
    const outcome = await this.invokeDecision(provider, request, run.id, {
      timeoutMs: Math.min(
        this.deps.decisionCallTimeoutMs ?? DEFAULT_DECISION_CALL_TIMEOUT_MS,
        remainingMs,
      ),
      decisionId,
    });
    return this.commitDecisionOutcome(decisionId, {
      run,
      node,
      options: node.options!,
      outcome,
      startedAt,
      nodeStates,
    });
  }

  /**
   * 恢复既有决策调用（§4.3 表）：
   * - value：直接使用记录（响应 blob 必须在且摘要匹配），不再次推断
   * - 失败/abstain 终态：沿用失败原因，节点与 Run 状态补齐，不重调
   * - prepared：确认未发送，使用原 decisionId 与预留额度允许首次发送
   * - started/unknown（model）：可能已计费——保留 unknown、不重发、不派发，Run 置 waiting
   * - started（local）：确定性本地计算无计费风险，安全重发
   */
  private async resumeDecisionCall(
    existing: DecisionCallRecord,
    args: {
      run: RunRecord;
      node: NormalizedNode;
      policy: { versionId: string; content: unknown };
      provider: DecisionProvider;
      view: DecisionView | undefined;
      viewVersionId: string | null;
      remainingMs: number;
      nodeStates: Map<string, NodeState>;
    },
  ): Promise<RunSummaryDecision> {
    const { run, node, provider, view, nodeStates } = args;
    if (existing.state === "value") {
      const entry = this.decisionEntryFromCall(existing, node);
      // 同事务写入可能缺失（防御）：补记 decision.recorded 与节点完成
      this.deps.storage.tx(() => {
        this.appendDecisionEvent(run.id, node, "decision.recorded", {
          decisionId: existing.id,
          nodeId: node.id,
          value: entry.value,
          provider: entry.provider,
          policyVersion: entry.policyVersion,
          problem: node.problem,
          recovered: true,
        });
        this.appendNodeCompleted(run.id, node, "succeeded", "recovered_decision_call");
      });
      nodeStates.set(node.id, "succeeded");
      return entry;
    }
    if (
      existing.state === "abstain" ||
      existing.state === "invalid_output" ||
      existing.state === "transport_error" ||
      existing.state === "timeout" ||
      existing.state === "cancelled"
    ) {
      // 恢复沿用失败原因；不重调模型（§4.3）
      throw new NodeFailure(
        decisionFailureReason(existing.state),
        `恢复：决策调用 ${existing.id} 已处终态 ${existing.state}（${existing.errorClass ?? "无细类"}），不重新调用`,
      );
    }
    // prepared / started / unknown
    if (
      (existing.state === "started" || existing.state === "unknown") &&
      existing.kind === "model"
    ) {
      throw new DecisionPendingUnknown(
        existing.id,
        `决策调用 ${existing.id} 结果不明（${existing.state}，可能已计费）：保留证据，Run 置 waiting，不自动重发`,
      );
    }
    // 重发必须使用原请求内容：请求 blob 丢失或摘要不匹配 → 明确不可恢复（§4.3 末行）
    if (!existing.requestRef || !this.deps.blobs.has(existing.requestRef)) {
      throw new NodeFailure(
        "decision_request_lost",
        `决策调用 ${existing.id} 的请求 blob（${existing.requestRef ?? "null"}）丢失，明确不可恢复，不得用重建内容补发`,
      );
    }
    const stored = this.deps.blobs.read(existing.requestRef);
    if (digestOf(stored) !== existing.requestDigest) {
      throw new NodeFailure(
        "decision_request_drift",
        `决策调用 ${existing.id} 的请求 blob 摘要不匹配，明确不可恢复`,
      );
    }
    const parsedStored = JSON.parse(stored) as {
      problem: DecisionRequest["problem"];
      options: string[];
      view: DecisionView | null;
      context: Record<string, unknown>;
    };
    const request = this.buildDecisionRequest({
      node,
      policy: { versionId: existing.policyVersionId, content: args.policy.content },
      run,
      runId: run.id,
      remainingMs: args.remainingMs,
      view: parsedStored.view ?? view,
      options: parsedStored.options,
      context: parsedStored.context,
    });
    if (existing.policyVersionId !== args.policy.versionId) {
      throw new NodeFailure(
        "decision_policy_drift",
        `决策调用 ${existing.id} 的策略版本 ${existing.policyVersionId} 与快照解析结果 ${args.policy.versionId} 不一致，拒绝恢复`,
      );
    }
    return this.sendDecisionCall(existing.id, {
      run,
      node,
      provider,
      request,
      remainingMs: args.remainingMs,
      nodeStates,
    });
  }

  /** 从调用记录还原决策条目（value 终态；响应 blob 为证据源） */
  private decisionEntryFromCall(
    call: DecisionCallRecord,
    node: NormalizedNode,
  ): RunSummaryDecision {
    if (!call.responseRef || !this.deps.blobs.has(call.responseRef)) {
      throw new NodeFailure(
        "decision_evidence_lost",
        `决策调用 ${call.id} 缺少响应证据 blob，不能恢复 value（明确不可恢复）`,
      );
    }
    const raw = this.deps.blobs.read(call.responseRef);
    if (digestOf(raw) !== call.responseDigest) {
      throw new NodeFailure("decision_evidence_drift", `决策调用 ${call.id} 响应 blob 摘要不匹配`);
    }
    const result = JSON.parse(raw) as DecisionResult;
    const validation = validateChoice(result, node.options!);
    if (!validation.ok) {
      throw new NodeFailure(
        "decision_invalid_output",
        `恢复的 value 记录不再合法：${validation.detail}`,
      );
    }
    return {
      nodeId: node.id,
      value: validation.value,
      provider: result.provenance.provider,
      policyVersion: result.provenance.policyVersion,
    };
  }

  /** 网络调用（事务外）：超时/取消竞速 + 迟到证据记录；永不 resolve 的 provider 也能结束等待 */
  private async invokeDecision(
    provider: DecisionProvider,
    request: DecisionRequest,
    runId: string,
    opts: { timeoutMs: number; decisionId: string },
  ): Promise<DecisionOutcome> {
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const startedAt = this.deps.clock.now();
    const active = this.activeDecisionAborts.get(runId) ?? new Set<AbortController>();
    active.add(controller);
    this.activeDecisionAborts.set(runId, active);
    request.signal = controller.signal;
    const promise = provider.decide(request);
    let raceReject: ((err: Error) => void) | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      raceReject = reject;
    });
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort("decision_timeout");
        raceReject?.(new Error("decision timeout"));
      },
      Math.max(1, opts.timeoutMs),
    );
    const cancelHook = () => {
      cancelled = true;
      controller.abort("decision_cancelled");
      raceReject?.(new Error("decision cancelled"));
    };
    this.activeDecisionHooks.set(controller, cancelHook);
    try {
      const result = await Promise.race([promise, timeoutPromise]);
      return { type: "result", result, durationMs: this.deps.clock.now() - startedAt };
    } catch (err) {
      const durationMs = this.deps.clock.now() - startedAt;
      if (
        timedOut ||
        (controller.signal.aborted && controller.signal.reason === "decision_timeout")
      ) {
        return { type: "timeout", durationMs };
      }
      if (
        cancelled ||
        (controller.signal.aborted && controller.signal.reason === "decision_cancelled")
      ) {
        return { type: "cancelled", durationMs };
      }
      return { type: "transport_error", error: err, durationMs };
    } finally {
      clearTimeout(timer);
      this.activeDecisionHooks.delete(controller);
      active.delete(controller);
      if (active.size === 0) this.activeDecisionAborts.delete(runId);
      // 迟到结果：关联原 decisionId 追加证据；不改终态、不派发 worker（§4.3）
      void promise.then(
        (late) =>
          this.recordLateDecisionArrival(opts.decisionId, {
            settled: true,
            value: late.kind === "value" ? String(late.value) : late.kind,
          }),
        (late) =>
          this.recordLateDecisionArrival(opts.decisionId, {
            settled: false,
            value:
              late instanceof Error ? `${late.name}: ${late.message}`.slice(0, 300) : String(late),
          }),
      );
    }
  }

  /** 终态提交（一个短事务）：全部状态可审计；value 与 decision.recorded、节点成功同事务 */
  private commitDecisionOutcome(
    decisionId: string,
    args: {
      run: RunRecord;
      node: NormalizedNode;
      options: string[];
      outcome: DecisionOutcome;
      startedAt: number;
      nodeStates: Map<string, NodeState>;
    },
  ): RunSummaryDecision {
    const { run, node, options, outcome, startedAt, nodeStates } = args;
    const endedAt = this.deps.clock.now();
    const durationMs = endedAt - startedAt;

    type Committed =
      | { kind: "value"; entry: RunSummaryDecision }
      | { kind: "failed"; reason: string; detail: string };
    const committed = this.deps.storage.tx((): Committed => {
      const finish = (patch: {
        state: DecisionCallState;
        response?: string | null;
        usage?: DecisionCallRecord["usage"];
        errorClass?: string | null;
      }) => {
        let responseRef: string | null = null;
        let responseDigest: string | null = null;
        if (patch.response !== null && patch.response !== undefined) {
          const written = this.deps.blobs.write(patch.response);
          responseRef = written.ref;
          responseDigest = written.digest;
        }
        this.deps.storage.updateDecisionCall(
          decisionId,
          {
            state: patch.state,
            responseRef,
            responseDigest,
            usage: patch.usage ?? null,
            errorClass: patch.errorClass ?? null,
            endedAt,
            durationMs,
          },
          { updatedAt: endedAt },
        );
        return responseRef;
      };

      if (outcome.type === "result") {
        const result = outcome.result;
        const usage = evidenceUsage(result);
        if (result.kind === "abstain") {
          finish({
            state: "abstain",
            response: result.raw ?? canonicalJson({ kind: result.kind, reason: result.reason }),
            usage,
          });
          this.appendDecisionEvent(run.id, node, "decision.abstained", {
            decisionId,
            reason: result.reason.slice(0, 512),
            origin: result.origin ?? "model",
          });
          return {
            kind: "failed",
            reason: "decision_abstained",
            detail: `decision ${node.id} abstain（${result.origin ?? "model"}）: ${result.reason}`,
          };
        }
        const validation = validateChoice(result, options);
        if (!validation.ok) {
          finish({
            state: "invalid_output",
            response: result.raw ?? canonicalJson({ kind: result.kind, detail: validation.detail }),
            usage,
          });
          this.appendDecisionEvent(run.id, node, "decision.invalid_output", {
            decisionId,
            detail: validation.detail.slice(0, 512),
          });
          return {
            kind: "failed",
            reason: "decision_invalid_output",
            detail: `decision ${node.id} invalid_output: ${validation.detail}`,
          };
        }
        // 成功选择：value 终态 + decision.recorded + 节点成功同事务（关闭 D07 崩溃窗口）
        finish({
          state: "value",
          response: result.raw ?? canonicalJson(result),
          usage,
        });
        const entry: RunSummaryDecision = {
          nodeId: node.id,
          value: validation.value,
          provider: result.provenance.provider,
          policyVersion: result.provenance.policyVersion,
        };
        this.appendDecisionEvent(run.id, node, "decision.recorded", {
          decisionId,
          ...entry,
          problem: node.problem,
        });
        this.appendNodeCompleted(run.id, node, "succeeded", null);
        return { kind: "value", entry };
      }
      if (outcome.type === "timeout") {
        finish({ state: "timeout", errorClass: "timeout", response: null });
        this.appendDecisionEvent(run.id, node, "decision.timeout", { decisionId, durationMs });
        return {
          kind: "failed",
          reason: "decision_timeout",
          detail: `decision ${node.id} 超时（${durationMs}ms，上限内含 Run 剩余时间）`,
        };
      }
      if (outcome.type === "cancelled") {
        finish({ state: "cancelled", errorClass: "cancelled_during_call", response: null });
        this.appendDecisionEvent(run.id, node, "decision.cancelled", {
          decisionId,
          phase: "during_call",
        });
        return {
          kind: "failed",
          reason: "decision_call_cancelled",
          detail: `decision ${node.id} 调用中被取消；本地等待已结束，远端费用未知`,
        };
      }
      const err = outcome.error;
      const errorClass = err instanceof Error ? err.name : "Error";
      const detail = err instanceof Error ? err.message : String(err);
      finish({
        state: "transport_error",
        errorClass,
        response: canonicalJson({ error: errorClass, message: detail.slice(0, 2000) }),
      });
      this.appendDecisionEvent(run.id, node, "decision.transport_error", {
        decisionId,
        errorClass,
        detail: detail.slice(0, 512),
      });
      return {
        kind: "failed",
        reason: "decision_transport_error",
        detail: `decision ${node.id} 传输/服务错误（${errorClass}）：${detail.slice(0, 300)}`,
      };
    });

    if (committed.kind === "failed") {
      throw new NodeFailure(committed.reason, committed.detail);
    }
    nodeStates.set(node.id, "succeeded");
    return committed.entry;
  }

  /** 迟到证据：仅在 timeout/cancelled 终态上追加 lateArrival 标记与事件，不改终态 */
  private recordLateDecisionArrival(
    decisionId: string,
    evidence: { settled: boolean; value: string },
  ): void {
    try {
      this.deps.storage.tx(() => {
        const call = this.deps.storage.getDecisionCall(decisionId);
        if (!call || call.lateArrival) return;
        if (call.state !== "timeout" && call.state !== "cancelled") return;
        this.deps.storage.updateDecisionCall(
          decisionId,
          { lateArrival: true },
          { updatedAt: this.deps.clock.now() },
        );
        this.deps.storage.appendEvent({
          streamId: `run-${call.runId}`,
          type: "decision.late_arrival",
          payload: { decisionId, originalState: call.state, evidence },
          correlationId: call.runId,
          runId: call.runId,
          occurredAt: this.deps.clock.now(),
        });
      });
    } catch {
      // 迟到证据是尽力记录：记录失败不改变已提交终态，也不抛出
    }
  }

  /**
   * 显式结案 unknown 决策调用（operator 入口，§4.3）：
   * 保留 unknown 证据与未结算费用，Run 以 failed/decision_unknown 结案；
   * 不证明远端费用为零，也不改写调用终态。
   */
  settleDecisionCall(
    decisionId: string,
    opts: { note?: string } = {},
  ): { decisionId: string; runId: string; state: RunState; note: string } {
    const call = this.deps.storage.getDecisionCall(decisionId);
    if (!call) throw new RuntimeError("unknown_run", `决策调用 ${decisionId} 不存在`);
    if (call.state !== "unknown" && call.state !== "started") {
      throw new RuntimeError(
        "decision_call_not_pending",
        `决策调用 ${decisionId} 状态为 ${call.state}，无需结案`,
      );
    }
    const run = this.mustGetRun(call.runId);
    if (isTerminal(run.state)) {
      throw new RuntimeError(
        "decision_call_not_pending",
        `run ${call.runId} 已终态（${run.state}），仅补充结案事件`,
      );
    }
    const at = this.deps.clock.now();
    this.deps.storage.tx(() => {
      this.deps.storage.appendEvent({
        streamId: `run-${call.runId}`,
        type: "decision.settled",
        payload: { decisionId, note: opts.note ?? null, evidenceState: call.state },
        correlationId: call.runId,
        runId: call.runId,
        occurredAt: at,
      });
    });
    const summary = this.finalize(call.runId, "failed", "decision_unknown", [], null, undefined);
    return {
      decisionId,
      runId: call.runId,
      state: summary.state,
      note: `决策调用 ${decisionId} 保持 unknown 证据；run 以 failed/decision_unknown 结案（未结算费用不视为零）`,
    };
  }

  private buildDecisionRequest(args: {
    node: NormalizedNode;
    policy: { versionId: string; content: unknown };
    run: RunRecord;
    runId: string;
    remainingMs: number;
    view?: DecisionView;
    options?: string[];
    context?: Record<string, unknown>;
    requires?: string[];
  }): DecisionRequest {
    return {
      problem: args.node.problem!,
      options: [...(args.options ?? args.node.options!)],
      // 任务声明的能力展开为布尔键（capability:<name>: true）——M2 rule-v1
      // 路由语义保持不变；view 节点的决策依据来自受限视图而非 context
      context: {
        ...(args.context ?? args.node.context),
        ...capabilityContext(args.requires ?? []),
      },
      policy: args.policy,
      deadlineMs: Math.max(
        1,
        Math.min(
          this.deps.decisionCallTimeoutMs ?? DEFAULT_DECISION_CALL_TIMEOUT_MS,
          args.remainingMs,
        ),
      ),
      remainingAttempts: Math.max(
        0,
        args.run.budget.maxAttempts - this.listRunAttempts(args.runId).length,
      ),
      ...(args.view ? { view: args.view } : {}),
    };
  }

  /** 受信装配的调用来源：Adapter 填充服务/模型/采样/提示摘要，不信模型自报 */
  private buildProvenance(
    provider: DecisionProvider,
    args: {
      policy: { versionId: string; content: unknown };
      viewVersionId: string | null;
      request: DecisionRequest;
    },
  ): DecisionCallProvenance {
    const adapter = provider.callProvenance?.(args.request) ?? {
      adapter: `${provider.name}@in-process`,
    };
    return {
      provider: provider.name,
      adapter: adapter.adapter,
      policyVersionId: args.policy.versionId,
      viewVersionId: args.viewVersionId,
      serviceId: adapter.serviceId ?? null,
      requestedModel: adapter.requestedModel ?? null,
      servedModel: null,
      sampling: adapter.sampling ?? null,
      promptDigest: adapter.promptDigest ?? null,
      responseSchemaDigest: digestOf(RESPONSE_SCHEMA_DIGEST_TARGET),
      commit: process.env.PROTEUS_COMMIT ?? null,
      reproducibility:
        adapter.reproducibility ?? (provider.remote === true ? "recorded-inputs-only" : "pinned"),
    };
  }

  private appendDecisionEvent(
    runId: string,
    node: NormalizedNode,
    type: string,
    payload: Record<string, unknown>,
  ): { eventId: string; seq: number } {
    return this.deps.storage.appendEvent({
      streamId: `run-${runId}`,
      type,
      payload: { nodeId: node.id, ...payload },
      correlationId: runId,
      runId,
      organismId: this.deps.organismId,
      occurredAt: this.deps.clock.now(),
    });
  }

  private appendNodeCompleted(
    runId: string,
    node: NormalizedNode,
    state: NodeState,
    reason: string | null,
  ): void {
    this.deps.storage.appendEvent({
      streamId: `run-${runId}`,
      type: "node.completed",
      payload: { nodeId: node.id, type: node.type, state, reason },
      correlationId: runId,
      runId,
      organismId: this.deps.organismId,
      occurredAt: this.deps.clock.now(),
    });
  }

  private async runExecute(
    runId: string,
    run: RunRecord,
    task: TaskRecord,
    node: NormalizedNode,
    decisions: RunSummaryDecision[],
    versions: Map<string, ArtifactVersion>,
  ): Promise<string> {
    const executorName =
      node.executor ?? decisions.find((d) => d.nodeId === node.executorFrom)?.value ?? undefined;
    if (!executorName) {
      throw new NodeFailure("unknown_executor", `execute ${node.id} 无法解析执行器`);
    }
    const capabilityVersion = versions.get(executorName);
    if (
      executorName.startsWith("capability/") &&
      capabilityVersion &&
      this.deps.kernel.hasExternalAncestry(capabilityVersion.id) &&
      !this.deps.capabilitySandbox?.isolated
    )
      throw new NodeFailure("sandbox_required", "导入的能力代码及其派生版本必须在真实隔离后端执行");
    const executor = this.resolveExecutor(executorName, versions);
    if (!executor) {
      const detail = executorName.startsWith("capability/")
        ? `快照缺少槽位 ${executorName}（图引用了能力，但 Task 未声明或快照未绑定）`
        : `执行器 ${executorName} 未装配（可用：${[...this.deps.executors.keys()].join(", ")}）`;
      throw new NodeFailure("unknown_executor", detail);
    }

    const attemptId = this.deps.ids.next();
    const dispatchId = this.deps.ids.next();
    const startedAt = this.deps.clock.now();
    // worker 执行时限 = Run 剩余时间（持久化截止点计算，不重新给足总时限）
    const remainingMs = run.deadlineAt - startedAt;
    if (remainingMs <= 0) {
      throw new NodeFailure(
        "deadline_exceeded",
        `Run 截止点已过（剩余 ${remainingMs}ms），不再派发 worker`,
      );
    }

    // Attempt 配额检查与创建必须在同一事务内：并发派发不会重复花费同一余额。
    // 重试沿用 Process 身份并创建新 Attempt（docs/runtime.md §1）。
    const processId = this.deps.storage.tx((): string => {
      try {
        this.assertRunAccess(run, task, versions);
      } catch {
        throw new NodeFailure("access_revoked", "访问权限已撤销，禁止派发 worker");
      }
      // worker 派发前检查取消与未结决策调用（§4.3：不能只在实验 runner 内阻止）
      if (this.deps.storage.hasCancelIntent(runId)) {
        throw new NodeFailure("cancel_requested", `execute ${node.id} 派发前收到取消请求`);
      }
      const unresolved = this.deps.storage
        .listDecisionCalls(runId)
        .find((c) => c.state === "started" || c.state === "unknown");
      if (unresolved) {
        throw new NodeFailure(
          "decision_call_unresolved",
          `存在未结决策调用 ${unresolved.id}（${unresolved.state}），禁止派发 worker`,
        );
      }
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
        payload: {
          executor: executorName,
          node: node.id,
          recoveryPolicy: executor.recoveryPolicy,
        },
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
      timeoutMs: remainingMs,
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
    // 裁判按生效验收器产物内容分发：候选不能替换本轮裁判（docs/evolution.md §6）
    const kind = readEvaluatorKind(evaluatorContent);
    let evaluation: {
      passed: boolean;
      checks: OutcomeCheck[];
      attestedOutputs?: Record<string, string>;
    };
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
      evaluation =
        kind === "hybrid-acceptance-v1"
          ? evaluateHybridOutput(output, schema)
          : evaluateStatsOutput(output, schema);
      if (task.acceptance.expectedOutput) {
        const expected = JSON.parse(readFileSync(task.acceptance.expectedOutput, "utf8"));
        const expectedCheck = evaluateExpectedOutput(output, expected);
        evaluation.checks.push(expectedCheck);
        evaluation.passed &&= expectedCheck.passed;
      }
      outputDigest = digestOf(outputRaw);
    }
    checks.push(...evaluation.checks);
    this.deps.storage.tx(() => {
      this.deps.storage.appendEvent({
        streamId: `run-${runId}`,
        type: "verify.completed",
        payload: {
          nodeId: node.id,
          passed: evaluation.passed,
          checks: evaluation.checks,
          ...(evaluation.attestedOutputs ? { attestedOutputs: evaluation.attestedOutputs } : {}),
        },
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
   * 解析执行器：实例注册表，或 capability/<name> 前缀的快照槽位产物——
   * 能力代码经独立子进程协议加载，不热加载进 kernel（roadmap M2）
   */
  private resolveExecutor(
    name: string,
    versions: Map<string, ArtifactVersion>,
  ): ExecutorProvider | undefined {
    if (!name.startsWith("capability/")) {
      return this.deps.executors.get(name);
    }
    const version = versions.get(name);
    if (!version) return undefined;
    return {
      name,
      recoveryPolicy: "manual",
      start: async (req) => {
        let parsed: ReturnType<typeof parseCapabilityModule>;
        try {
          parsed = parseCapabilityModule(JSON.parse(this.deps.blobs.read(version.contentRef)));
        } catch {
          return {
            ok: false,
            exitCode: null,
            stdout: "",
            stderr: `能力槽位 ${name} 的产物内容无法解析`,
            durationMs: 0,
            outputRef: null,
          };
        }
        if (!parsed.ok) {
          return {
            ok: false,
            exitCode: null,
            stdout: "",
            stderr: `能力槽位 ${name} 产物不合法：${parsed.error}`,
            durationMs: 0,
            outputRef: null,
          };
        }
        return runCapabilityModule(
          parsed.module,
          req.workspaceDir,
          req.timeoutMs,
          this.deps.capabilitySandbox,
        );
      },
    };
  }

  /** 生效裁判版本：评估 Run 钉住的版本优先，否则快照 acceptance-evaluator 槽位 */
  private resolveEvaluator(
    versions: Map<string, ArtifactVersion>,
    evaluatorVersionId: string | null,
  ): ArtifactVersion {
    if (evaluatorVersionId) {
      const version = this.deps.storage.getArtifactVersion(evaluatorVersionId);
      if (!version) {
        throw new RuntimeError(
          "missing_binding",
          `评估计划指定的裁判版本 ${evaluatorVersionId} 不存在`,
        );
      }
      const artifact = this.deps.storage.getArtifact(version.artifactId);
      if (!artifact || artifact.kind !== "acceptance-evaluator") {
        throw new RuntimeError(
          "missing_binding",
          `评估计划指定的 ${evaluatorVersionId} 不是 acceptance-evaluator 产物`,
        );
      }
      return version;
    }
    const bound = versions.get("acceptance-evaluator");
    if (!bound) throw new RuntimeError("missing_binding", "快照缺少 acceptance-evaluator 槽位");
    return bound;
  }

  /**
   * Organism 级预算准入检查（必须在准入事务内调用）。
   * 无法施加约束时拒绝准入，而不是放行后超支（docs/runtime.md §2）。
   * M3 起按用途分池：评估 Run 与普通 Run 各自计额度，互不挤占。
   */
  private assertOrganismBudget(budget: TaskBudget, purpose: RunPurpose): void {
    const cap = this.deps.organismBudget[purpose];
    const activeRuns = this.deps.storage.countActiveRuns(this.deps.organismId, purpose);
    if (activeRuns >= cap.maxConcurrentRuns) {
      throw new RuntimeError(
        "organism_budget_exceeded",
        `${purpose} 用途并发 Run 数已达上限 ${cap.maxConcurrentRuns}（当前活跃 ${activeRuns}），拒绝准入`,
      );
    }
    const inFlight = this.deps.storage.inFlightBudget(this.deps.organismId, purpose);
    if (inFlight.attempts + budget.maxAttempts > cap.maxInFlightAttempts) {
      throw new RuntimeError(
        "organism_budget_exceeded",
        `${purpose} 用途在途 Attempt 预留 ${inFlight.attempts} + 本次 ${budget.maxAttempts} 超过上限 ${cap.maxInFlightAttempts}`,
      );
    }
    if (inFlight.seconds + budget.maxWallClockSeconds > cap.maxInFlightWallClockSeconds) {
      throw new RuntimeError(
        "organism_budget_exceeded",
        `${purpose} 用途在途墙钟预留 ${inFlight.seconds}s + 本次 ${budget.maxWallClockSeconds}s 超过上限 ${cap.maxInFlightWallClockSeconds}s`,
      );
    }
  }

  private assertVerifierBinding(evaluator: ArtifactVersion, verifier: string): void {
    if (evaluator.artifactId !== verifier) {
      throw new RuntimeError(
        "verifier_mismatch",
        `task.verifier=${verifier} 与生效验收器 ${evaluator.artifactId} 不一致，拒绝执行`,
      );
    }
  }

  private mustGetRun(runId: string): RunRecord {
    const run = this.deps.storage.getRun(runId);
    if (!run) throw new RuntimeError("unknown_run", `run ${runId} 不存在`);
    if (run.organismId !== this.deps.organismId)
      throw new RuntimeError("unknown_run", "Run 属于其他个体");
    return run;
  }

  private assertRunAccess(
    run: RunRecord,
    task: TaskRecord,
    versions: Map<string, ArtifactVersion>,
  ): void {
    const actors = new Set([this.deps.actorId ?? task.requestedBy, task.requestedBy]);
    for (const actor of actors) {
      this.deps.kernel.assertOrganismAccess(run.organismId, actor, "operate");
      for (const version of versions.values())
        this.deps.kernel.assertVersionAccess(version.id, actor);
      if (run.evaluatorVersionId)
        this.deps.kernel.assertVersionAccess(run.evaluatorVersionId, actor);
    }
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
          decisionCallIds: this.deps.storage.listDecisionCalls(runId).map((c) => c.id),
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

/** 任务声明的能力 → 决策上下文布尔键（rule-v1 严格匹配，零扩展） */
function capabilityContext(requires: string[]): Record<string, true> {
  const context: Record<string, true> = {};
  for (const c of requires) {
    context[`capability:${c}`] = true;
  }
  return context;
}

function assertInputPath(p: string): void {
  try {
    statSync(p);
  } catch {
    throw new RuntimeError("invalid_input_path", `输入路径不可读：${p}`);
  }
}
