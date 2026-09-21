import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Clock, IdGen, PromotionRecord } from "../kernel/index.ts";
import type { Kernel } from "../kernel/index.ts";
import type { RunSummary, TaskBudget } from "../runtime/types.ts";
import type { Runtime } from "../runtime/index.ts";
import type { BlobStore } from "../storage/blobs.ts";
import { canonicalJson, digestOf } from "../storage/blobs.ts";
import type { Storage } from "../storage/store.ts";
import {
  ensureBuilderGenome,
  ensureCapabilityGenome,
  ensureHybridEvaluatorVersion,
  evaluationProtocolDigest,
} from "./assets.ts";
import type {
  CandidateRecord,
  CandidateStatus,
  EvaluationRecord,
  EvaluationRunOutcome,
} from "./types.ts";

/**
 * Evolution（M2 最小自举）：委托构建 → 采集构造候选 → （切片④）评估与晋升编排。
 * 它只产出候选与证据，不改写 active 指针——晋升必须跨过 Kernel 的 CAS 与一致性检查
 * （docs/architecture.md Evolution 职责边界）。M3 前允许人工提出候选，流程仍记录来源。
 */
export class Evolution {
  readonly deps: EvolutionRuntimeDeps;

  constructor(deps: EvolutionRuntimeDeps) {
    this.deps = deps;
  }

  /**
   * 委托构建（自举故事步骤 2）：固定 builder 图 + 编码 worker，在独立工作区
   * 将实现规范交给执行器；产出由 test-runner 裁判独立验收（测试失败不能构造候选）。
   */
  async build(input: BuildInput): Promise<RunSummary> {
    const { snapshot } = ensureBuilderGenome(
      {
        kernel: this.deps.kernel,
        storage: this.deps.storage,
        blobs: this.deps.blobs,
        clock: this.deps.clock,
      },
      {
        capability: input.capability,
        executorName: input.executorName,
        testCommand: input.testCommand,
        createdBy: input.requestedBy,
      },
    );
    const summary = await this.deps.runtime.submitTask(
      {
        requestedBy: input.requestedBy,
        goal: input.goal,
        inputs: input.inputs,
        budget: input.budget,
        acceptance: { outputSchema: input.outputSchema, verifier: "builder-acceptance" },
      },
      { purpose: "evaluation", snapshotId: snapshot.id },
    );
    if (summary.state === "succeeded") {
      const verified = this.deps.storage
        .listEvents({ runId: summary.runId }, 200)
        .find((event) => event.type === "verify.completed");
      const attestedOutputs = verified?.payload["attestedOutputs"];
      const outputDigest =
        typeof attestedOutputs === "object" && attestedOutputs !== null
          ? (attestedOutputs as Record<string, unknown>)[`src/${input.capability}.mjs`]
          : undefined;
      if (typeof outputDigest === "string") {
        this.deps.storage.tx(() => {
          this.deps.storage.appendEvent({
            streamId: `run-${summary.runId}`,
            type: "builder.output.attested",
            payload: { capability: input.capability, outputDigest },
            correlationId: summary.runId,
            runId: summary.runId,
            organismId: this.deps.organismId,
            occurredAt: this.deps.clock.now(),
          });
        });
      }
    }
    return summary;
  }

  /**
   * 采集产出并构造候选（自举故事步骤 3）：从 builder 工作区按产出路径约定
   * （src/<capability>.mjs）读取实现 → capability-module → 基于当前 active 组合
   * 候选快照（digest 幂等，同产出同快照）→ Candidate 记录 + proposed 事件。
   * 按 proposedSnapshot 去重：重复 collect 返回既有候选。
   */
  collectCandidate(
    builderRunId: string,
    opts: {
      capability: string;
      hypothesis: string;
      proposedBy: string;
      evaluationPlan: EvaluationPlan;
      datasetRef?: string | null;
    },
  ): { candidate: CandidateRecord; created: boolean } {
    const run = this.deps.storage.getRun(builderRunId);
    if (!run) throw new EvolutionError("unknown_run", `builder run ${builderRunId} 不存在`);
    if (run.state !== "succeeded") {
      throw new EvolutionError(
        "builder_not_succeeded",
        `builder run ${builderRunId} 状态为 ${run.state}（${run.failureReason ?? "无原因"}）：测试未通过的产出不能构造候选`,
      );
    }
    const implPath = builderImplementationPath(
      this.deps.instanceRoot,
      builderRunId,
      opts.capability,
    );
    if (!existsSync(implPath)) {
      throw new EvolutionError(
        "implementation_missing",
        `builder 工作区缺少约定产出路径 src/${opts.capability}.mjs，无法采集`,
      );
    }
    const implementation = readFileSync(implPath, "utf8");
    const builderOutputDigest = digestOf(implementation);
    const attestation = this.deps.storage
      .listEvents({ runId: builderRunId }, 200)
      .find(
        (event) =>
          event.type === "builder.output.attested" &&
          event.payload["capability"] === opts.capability,
      );
    if (!attestation || attestation.payload["outputDigest"] !== builderOutputDigest) {
      throw new EvolutionError(
        "builder_output_changed",
        `builder 产物在验收后发生变化或缺少摘要证明，拒绝采集 ${opts.capability}`,
      );
    }
    const module = {
      kind: "capability-module-v1" as const,
      name: opts.capability,
      entry: "index.mjs",
      files: [{ path: "index.mjs", content: implementation }],
    };

    const organism = this.deps.kernel.getOrganism(this.deps.organismId);
    const baseSnapshotId = organism?.activeGenomeId ?? null;
    if (!organism || !baseSnapshotId) {
      throw new EvolutionError("no_active_genome", "默认快照未安装，无基准可组合候选");
    }
    const baseRevision = organism.revision;
    assertEvaluationPlan(opts.evaluationPlan, opts.capability, baseSnapshotId, this.deps.kernel);
    const planDigest = evaluationPlanDigest(opts.evaluationPlan);
    const genome = ensureCapabilityGenome(
      {
        kernel: this.deps.kernel,
        storage: this.deps.storage,
        blobs: this.deps.blobs,
        clock: this.deps.clock,
      },
      {
        baseSnapshotId,
        capabilities: [{ name: opts.capability, module }],
        createdBy: opts.proposedBy,
      },
    );

    return this.deps.storage.tx(() => {
      const existing = this.deps.storage.findCandidateByProposedSnapshot(
        this.deps.organismId,
        genome.snapshot.id,
      );
      if (existing) return { candidate: existing, created: false };
      const now = this.deps.clock.now();
      const candidate: CandidateRecord = {
        id: this.deps.ids.next(),
        organismId: this.deps.organismId,
        baseSnapshotId,
        baseRevision,
        proposedSnapshotId: genome.snapshot.id,
        hypothesis: opts.hypothesis,
        proposedBy: opts.proposedBy,
        sourceRefs: {
          builderRunId,
          capability: opts.capability,
          builderGoalDigest: digestOf(runGoal(this.deps.storage, builderRunId)),
          builderOutputDigest,
          evaluationPlanDigest: planDigest,
        },
        datasetRef: opts.datasetRef ?? null,
        createdAt: now,
      };
      this.deps.storage.insertCandidate(candidate);
      this.deps.storage.appendEvent({
        streamId: `candidate-${candidate.id}`,
        type: "candidate.proposed",
        payload: {
          candidateId: candidate.id,
          capability: opts.capability,
          proposedSnapshotId: candidate.proposedSnapshotId,
          proposedSnapshotDigest: genome.snapshot.digest,
          baseSnapshotId: candidate.baseSnapshotId,
          baseRevision: candidate.baseRevision,
          hypothesis: opts.hypothesis,
        },
        organismId: this.deps.organismId,
        occurredAt: now,
      });
      return { candidate, created: true };
    });
  }

  /** Candidate 流程状态：由 candidate-<id> 事件流投影（不物化 status 列） */
  candidateStatus(candidateId: string): { status: CandidateStatus; detail: string } {
    const events = this.deps.storage.listEvents({ streamId: `candidate-${candidateId}` }, 100);
    if (events.length === 0)
      throw new EvolutionError("unknown_candidate", `候选 ${candidateId} 不存在`);
    let status: CandidateStatus = "proposed";
    let detail = "已提议，待评估";
    for (const e of events) {
      if (e.type === "candidate.proposed") {
        status = "proposed";
        detail = "已提议，待评估";
      } else if (e.type === "candidate.evaluating") {
        status = "evaluating";
        detail = "评估进行中";
      } else if (e.type === "candidate.evaluated") {
        const verdict = String(e.payload["verdict"]);
        status = verdict === "eligible" ? "eligible" : "rejected";
        detail = String(
          e.payload["note"] ?? (verdict === "eligible" ? "证据满足条件" : "证据不满足"),
        );
      } else if (e.type === "candidate.stale") {
        status = "stale";
        detail = `基准已过期（当前 revision ${String(e.payload["currentRevision"])}），须基于新基准重构重评`;
      } else if (e.type === "candidate.adopted") {
        status = "adopted";
        detail = `已晋升（promotion ${String(e.payload["promotionId"])}，revision ${String(e.payload["revision"])}）`;
      }
    }
    return { status, detail };
  }

  /**
   * 独立评估（自举故事步骤 4，协议 m2-bootstrap-eval-v1）：
   * 三个 evaluation Run——候选×新能力验收、候选×回归、基准×回归（健康对照）。
   * 裁判按内容寻址钉住 hybrid 版本（不取候选快照槽位），候选换裁判放水无效。
   * 基线对照失败 → inconclusive（评估环境不可信，不判 rejected，可重评）。
   */
  async evaluateCandidate(
    candidateId: string,
    plan: EvaluationPlan,
  ): Promise<{ evaluation: EvaluationRecord; status: CandidateStatus }> {
    const candidate = this.mustGetCandidate(candidateId);
    const capability = candidate.sourceRefs["capability"];
    if (!capability) {
      throw new EvolutionError("candidate_capability_missing", "候选缺少 capability 来源引用");
    }
    assertEvaluationPlan(plan, capability, candidate.baseSnapshotId, this.deps.kernel);
    const planDigest = evaluationPlanDigest(plan);
    if (candidate.sourceRefs["evaluationPlanDigest"] !== planDigest) {
      throw new EvolutionError(
        "evaluation_plan_changed",
        `评估计划与候选构造前固定的摘要不一致，拒绝评估候选 ${candidateId}`,
      );
    }
    const regressions = normalizeRegressions(plan.regression);
    const pinnedEvaluator = ensureHybridEvaluatorVersion(
      {
        kernel: this.deps.kernel,
        storage: this.deps.storage,
        blobs: this.deps.blobs,
        clock: this.deps.clock,
      },
      { baseSnapshotId: candidate.baseSnapshotId, createdBy: plan.requestedBy },
    );

    this.deps.storage.tx(() => {
      this.deps.storage.appendEvent({
        streamId: `candidate-${candidateId}`,
        type: "candidate.evaluating",
        payload: {
          protocol: "m2-bootstrap-eval-v1",
          evaluationPlanDigest: planDigest,
          evaluatorVersionId: pinnedEvaluator.id,
        },
        organismId: this.deps.organismId,
        occurredAt: this.deps.clock.now(),
      });
    });

    const runOutcome = async (
      role: EvaluationRunOutcome["role"],
      purpose: string,
      submission: TaskSubmissionLike,
      snapshotId: string,
    ): Promise<EvaluationRunOutcome> => {
      const summary = await this.deps.runtime.submitTask(
        { ...submission, requestedBy: plan.requestedBy },
        { purpose: "evaluation", snapshotId, evaluatorVersionId: pinnedEvaluator.id },
      );
      const experience = this.deps.storage.getExperienceByRun(summary.runId);
      return {
        role,
        purpose,
        runId: summary.runId,
        snapshotId,
        state: summary.state,
        failureReason: summary.failureReason,
        durationMs: experience?.outcome.durationMs ?? 0,
      };
    };

    const outcomes = await Promise.all([
      runOutcome("new-capability", "新能力验收", plan.newCapability, candidate.proposedSnapshotId),
      ...regressions.map((regression, index) =>
        runOutcome(
          "regression",
          `既有能力回归 ${index + 1}`,
          regression,
          candidate.proposedSnapshotId,
        ),
      ),
      ...regressions.map((regression, index) =>
        runOutcome("baseline", `基线健康对照 ${index + 1}`, regression, candidate.baseSnapshotId),
      ),
    ]);
    const [newCapability, ...remaining] = outcomes;
    const regressionRuns = remaining.slice(0, regressions.length);
    const baselineRuns = remaining.slice(regressions.length);

    const passed = (o: EvaluationRunOutcome) => o.state === "succeeded";
    const allPassed = (runs: EvaluationRunOutcome[]) => runs.every(passed);
    let verdict: EvaluationRecord["verdict"];
    let note: string;
    if (!allPassed(baselineRuns)) {
      verdict = "inconclusive";
      note = "基线对照失败：评估环境不可信，不判 rejected，可修复后重评";
    } else if (!passed(newCapability!) || !allPassed(regressionRuns)) {
      verdict = "rejected";
      const failedRegression = regressionRuns.find((run) => !passed(run));
      note = !passed(newCapability!)
        ? `新能力验收失败（${newCapability!.failureReason}）`
        : `既有能力回归失败（${failedRegression?.failureReason}）`;
    } else {
      verdict = "eligible";
      note = "新能力验收与既有能力回归均通过";
    }

    const evaluation: EvaluationRecord = {
      id: this.deps.ids.next(),
      candidateId,
      protocolDigest: digestOf(
        canonicalJson({
          protocolDigest: evaluationProtocolDigest(),
          evaluationPlanDigest: planDigest,
        }),
      ),
      baselineSnapshotId: candidate.baseSnapshotId,
      runs: outcomes,
      verdict,
      metrics: {
        newCapability: {
          passed: passed(newCapability!),
          durationMs: newCapability!.durationMs,
        },
        regression: {
          passed: allPassed(regressionRuns),
          durationMs: regressionRuns.reduce((sum, run) => sum + run.durationMs, 0),
        },
        baseline: {
          passed: allPassed(baselineRuns),
          durationMs: baselineRuns.reduce((sum, run) => sum + run.durationMs, 0),
        },
        cost: null,
      },
      createdAt: this.deps.clock.now(),
    };
    this.deps.storage.tx(() => {
      this.deps.storage.insertEvaluation(evaluation);
      this.deps.storage.appendEvent({
        streamId: `candidate-${candidateId}`,
        type: "candidate.evaluated",
        payload: { evaluationId: evaluation.id, verdict, note, runs: evaluation.runs },
        organismId: this.deps.organismId,
        occurredAt: this.deps.clock.now(),
      });
    });
    return { evaluation, status: this.candidateStatus(candidateId).status };
  }

  /**
   * 晋升（自举故事步骤 5）：仅当最新评估 eligible 才放行（评估完成不等于自动授权，
   * 首版由 operator 显式调用）；同一事务内 kernel.promote + candidate.adopted 事件。
   * CAS 冲突 → candidate.stale 事件，旧记录保留。
   */
  promote(
    candidateId: string,
    opts: { authorizedBy: string; operationId?: string; note?: string },
  ): PromoteOutcome {
    const candidate = this.mustGetCandidate(candidateId);
    const latest = this.deps.storage.listEvaluationsByCandidate(candidateId, 1)[0];
    if (!latest || latest.verdict !== "eligible") {
      throw new EvolutionError(
        "evaluation_not_eligible",
        `候选 ${candidateId} 缺少 eligible 评估（最新：${latest ? latest.verdict : "无"}），禁止晋升`,
      );
    }
    const operationId = opts.operationId ?? this.deps.ids.next();
    return this.deps.storage.tx(() => {
      const outcome = this.deps.kernel.promote({
        organismId: this.deps.organismId,
        kind: "adopt",
        toSnapshotId: candidate.proposedSnapshotId,
        expectedRevision: candidate.baseRevision,
        operationId,
        authorizedBy: opts.authorizedBy,
        evaluationRef: latest.id,
        authorizationRef: opts.note ?? null,
        note: opts.note ?? null,
      });
      if (outcome.result === "stale") {
        this.deps.storage.appendEvent({
          streamId: `candidate-${candidateId}`,
          type: "candidate.stale",
          payload: { currentRevision: outcome.currentRevision, operationId },
          organismId: this.deps.organismId,
          occurredAt: this.deps.clock.now(),
        });
        return outcome;
      }
      if (outcome.result === "promoted") {
        this.deps.storage.appendEvent({
          streamId: `candidate-${candidateId}`,
          type: "candidate.adopted",
          payload: {
            promotionId: outcome.promotion.id,
            revision: outcome.promotion.resultRevision,
            evaluationId: latest.id,
          },
          organismId: this.deps.organismId,
          occurredAt: this.deps.clock.now(),
        });
      }
      this.appendPromotionEvent(outcome.promotion);
      return outcome;
    });
  }

  /**
   * 回滚（自举故事步骤 7）：对历史快照再做一次 kind=rollback 的 Promotion——
   * 同样的 CAS 与权限检查，revision 只增不减，不撤销既有外部副作用。
   */
  rollback(opts: {
    toSnapshotId: string;
    authorizedBy: string;
    operationId?: string;
    note?: string;
  }): PromoteOutcome {
    const operationId = opts.operationId ?? this.deps.ids.next();
    return this.deps.storage.tx(() => {
      const organism = this.deps.kernel.getOrganism(this.deps.organismId);
      if (!organism) throw new EvolutionError("unknown_organism", "organism 不存在");
      if (
        !this.deps.storage.hasHistoricalPromotionSnapshot(this.deps.organismId, opts.toSnapshotId)
      ) {
        throw new EvolutionError(
          "rollback_target_not_adopted",
          `快照 ${opts.toSnapshotId} 未出现在该个体的历史采用记录中，不能回滚`,
        );
      }
      const outcome = this.deps.kernel.promote({
        organismId: this.deps.organismId,
        kind: "rollback",
        toSnapshotId: opts.toSnapshotId,
        expectedRevision: organism.revision,
        operationId,
        authorizedBy: opts.authorizedBy,
        note: opts.note ?? null,
      });
      if (outcome.result === "promoted") {
        this.appendPromotionEvent(outcome.promotion);
      }
      return outcome;
    });
  }

  /**
   * 接替（自举故事步骤 6）：R1（缺口等待）以 failed/superseded 结案，
   * 同一 Task 修订（revision+1）创建 R2 绑定当前 active 快照，supersedesRunId 关联。
   */
  async supersedeAndReplace(
    runId: string,
    opts?: { note?: string },
  ): Promise<{ superseded: RunSummary; successor: RunSummary }> {
    const run = this.deps.storage.getRun(runId);
    if (!run) throw new EvolutionError("unknown_run", `run ${runId} 不存在`);
    const task = this.deps.storage.getTask(run.taskId);
    if (!task) throw new EvolutionError("unknown_run", `run ${runId} 的 task 缺失`);

    const superseded = this.deps.runtime.supersedeRun(runId);
    const successor = await this.deps.runtime.submitTask(
      {
        requestedBy: task.requestedBy,
        goal: task.goal,
        inputs: task.inputs,
        budget: task.budget,
        requires: task.requires,
        acceptance: task.acceptance,
      },
      { supersedesRunId: runId, taskRevision: task.revision + 1 },
    );
    this.deps.storage.tx(() => {
      this.deps.storage.appendEvent({
        streamId: `run-${runId}`,
        type: "run.superseded",
        payload: {
          successorRunId: successor.runId,
          successorSnapshotId: successor.snapshotId,
          note: opts?.note ?? null,
        },
        correlationId: runId,
        runId,
        organismId: this.deps.organismId,
        occurredAt: this.deps.clock.now(),
      });
    });
    return { superseded, successor };
  }

  private appendPromotionEvent(promotion: PromotionRecord): void {
    this.deps.storage.appendEvent({
      streamId: `organism-${promotion.organismId}`,
      type: "organism.genome.promoted",
      payload: {
        promotionId: promotion.id,
        kind: promotion.kind,
        fromSnapshotId: promotion.fromSnapshotId,
        toSnapshotId: promotion.toSnapshotId,
        fromRevision: promotion.expectedRevision,
        toRevision: promotion.resultRevision,
        actor: promotion.actor,
        evaluationRef: promotion.evaluationRef,
      },
      organismId: promotion.organismId,
      occurredAt: this.deps.clock.now(),
    });
  }

  private mustGetCandidate(candidateId: string): CandidateRecord {
    const candidate = this.deps.storage.getCandidate(candidateId);
    if (!candidate) throw new EvolutionError("unknown_candidate", `候选 ${candidateId} 不存在`);
    return candidate;
  }
}

export type PromoteOutcome =
  | { result: "promoted"; promotion: PromotionRecord }
  | { result: "already"; promotion: PromotionRecord }
  | { result: "stale"; currentRevision: number };

/** 评估计划中的任务定义（submitTask 的 TaskSubmission 形） */
export interface TaskSubmissionLike {
  goal: string;
  inputs: string[];
  budget: TaskBudget;
  requires?: string[];
  missingCapabilityWaitSeconds?: number;
  acceptance: { outputSchema: string; expectedOutput?: string; verifier: string };
}

export interface EvaluationPlan {
  newCapability: TaskSubmissionLike;
  regression: TaskSubmissionLike | TaskSubmissionLike[];
  requestedBy: string;
}

export interface EvolutionRuntimeDeps {
  kernel: Kernel;
  storage: Storage;
  blobs: BlobStore;
  runtime: Runtime;
  organismId: string;
  instanceRoot: string;
  clock: Clock;
  ids: IdGen;
}

export interface BuildInput {
  capability: string;
  /** 实现规范文本（作为 builder Run 的 goal；明示产出路径与合同） */
  goal: string;
  inputs: string[];
  executorName: string;
  testCommand: string[];
  budget: TaskBudget;
  /** verifier binding 需要一个 schema 文件路径（test-runner 裁判不消费它） */
  outputSchema: string;
  requestedBy: string;
}

export class EvolutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function runGoal(storage: Storage, runId: string): string {
  const run = storage.getRun(runId);
  const task = run ? storage.getTask(run.taskId) : undefined;
  return task?.goal ?? "";
}

function builderImplementationPath(
  instanceRoot: string,
  runId: string,
  capability: string,
): string {
  return join(instanceRoot, "workspaces", runId, "dev", "src", `${capability}.mjs`);
}

function normalizeRegressions(
  regression: TaskSubmissionLike | TaskSubmissionLike[],
): TaskSubmissionLike[] {
  return Array.isArray(regression) ? regression : [regression];
}

/**
 * 固定评估计划摘要：任务声明、预算、输入树、schema 与期望结果均按内容寻址。
 * 路径本身不参与摘要，同一内容移动位置不会制造不同计划。
 */
export function evaluationPlanDigest(plan: EvaluationPlan): string {
  const taskFingerprint = (task: TaskSubmissionLike) => ({
    goal: task.goal,
    budget: task.budget,
    requires: task.requires ?? [],
    missingCapabilityWaitSeconds: task.missingCapabilityWaitSeconds,
    inputs: task.inputs.map(pathFingerprint),
    acceptance: {
      verifier: task.acceptance.verifier,
      outputSchemaDigest: digestOf(readFileSync(task.acceptance.outputSchema, "utf8")),
      expectedOutputDigest: task.acceptance.expectedOutput
        ? digestOf(readFileSync(task.acceptance.expectedOutput, "utf8"))
        : null,
    },
  });
  return digestOf(
    canonicalJson({
      protocol: "m2-bootstrap-eval-v1",
      requestedBy: plan.requestedBy,
      newCapability: taskFingerprint(plan.newCapability),
      regressions: normalizeRegressions(plan.regression).map(taskFingerprint),
    }),
  );
}

function pathFingerprint(path: string): { kind: "file" | "directory"; digest: string } {
  const stat = statSync(path);
  if (stat.isFile()) return { kind: "file", digest: digestOf(readFileSync(path, "utf8")) };
  if (!stat.isDirectory()) {
    throw new EvolutionError("invalid_evaluation_input", `评估输入不是文件或目录：${path}`);
  }
  const entries = readdirSync(path, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({ name: entry.name, value: pathFingerprint(join(path, entry.name)) }));
  return { kind: "directory", digest: digestOf(canonicalJson(entries)) };
}

function assertEvaluationPlan(
  plan: EvaluationPlan,
  capability: string,
  baseSnapshotId: string,
  kernel: Kernel,
): void {
  if (!(plan.newCapability.requires ?? []).includes(capability)) {
    throw new EvolutionError(
      "evaluation_plan_does_not_exercise_candidate",
      `new-capability 任务必须声明候选能力 ${capability}`,
    );
  }
  const regressions = normalizeRegressions(plan.regression);
  if (regressions.length === 0) {
    throw new EvolutionError("evaluation_plan_missing_regression", "评估计划至少需要一个回归任务");
  }
  if (!regressions.some((task) => (task.requires ?? []).length === 0)) {
    throw new EvolutionError(
      "evaluation_plan_missing_core_regression",
      "评估计划必须包含一个不声明派生能力的核心回归任务",
    );
  }
  const { snapshot } = kernel.resolveSnapshot(baseSnapshotId);
  const existingCapabilities = Object.keys(snapshot.bindings)
    .filter((slot) => slot.startsWith("capability/"))
    .map((slot) => slot.slice("capability/".length))
    .filter((name) => name !== capability);
  const uncovered = existingCapabilities.filter(
    (name) => !regressions.some((task) => task.requires?.length === 1 && task.requires[0] === name),
  );
  if (uncovered.length > 0) {
    throw new EvolutionError(
      "evaluation_plan_missing_capability_regression",
      `评估计划未覆盖已有能力回归：${uncovered.join(", ")}`,
    );
  }
}
