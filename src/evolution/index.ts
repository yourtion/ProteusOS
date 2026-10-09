import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Clock, IdGen, PromotionRecord } from "../kernel/index.ts";
import type { Kernel } from "../kernel/index.ts";
import type { RunSummary, TaskBudget } from "../runtime/types.ts";
import type { Runtime } from "../runtime/index.ts";
import { isCapabilityName } from "../runtime/capability.ts";
import type { BlobStore } from "../storage/blobs.ts";
import { canonicalJson, digestOf } from "../storage/blobs.ts";
import type { Storage } from "../storage/store.ts";
import {
  ensureBuilderGenome,
  ensureCapabilityGenome,
  ensureHybridEvaluatorVersion,
  ensureJudgeGenome,
  evaluationProtocolDigest,
  registerDerivedVersion,
} from "./assets.ts";
import {
  consolidateRoutes,
  DEFAULT_CONSOLIDATION_PARAMS,
  refineProposals,
  type ConsolidationParams,
  type ConsolidationResult,
  type RouteProposer,
  type RouteSample,
} from "./consolidation.ts";
import type {
  CandidateRecord,
  CandidateStatus,
  ConsolidationJobRecord,
  ConsolidationMode,
  EvaluationRecord,
  EvaluationRunOutcome,
  ExperienceDatasetPurpose,
  ExperienceDatasetRecord,
  ExperienceDecisionCallView,
  ExperienceMemberView,
  PolicyArmMetrics,
  ValidationSetRecord,
} from "./types.ts";

/**
 * Evolution（M2 最小自举）：委托构建 → 采集构造候选 → （切片④）评估与晋升编排。
 * 它只产出候选与证据，不改写 active 指针——晋升必须跨过 Kernel 的 CAS 与一致性检查
 * （docs/architecture.md Evolution 职责边界）。M3 前允许人工提出候选，流程仍记录来源。
 */
/** 冻结成员筛选语义版本（成员扫描规则的显式记录） */
const EXPERIENCE_FILTER_VERSION_CUTOFF = "v1:cutoff-terminal-experiences";
const EXPERIENCE_FILTER_VERSION_EXPLICIT = "v1:explicit-run-ids";

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
    assertCapabilityName(input.capability);
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
    assertCapabilityName(opts.capability);
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
          candidateType: "capability",
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
   * 提议裁判候选（M3 裁判拆分）：基于当前 active 构造只升 acceptance-evaluator
   * 的候选快照与记录。评估依据 = 能力不变的回归集上新旧判定等价
   * （evaluateJudgeCandidate）；晋升走同一 operator 通道。按 proposedSnapshot 去重。
   */
  proposeJudgeCandidate(opts: {
    evaluatorContent: object;
    hypothesis: string;
    proposedBy: string;
  }): { candidate: CandidateRecord; created: boolean } {
    const organism = this.deps.kernel.getOrganism(this.deps.organismId);
    const baseSnapshotId = organism?.activeGenomeId ?? null;
    if (!organism || !baseSnapshotId) {
      throw new EvolutionError("no_active_genome", "默认快照未安装，无基准可组合候选");
    }
    const genome = ensureJudgeGenome(
      {
        kernel: this.deps.kernel,
        storage: this.deps.storage,
        blobs: this.deps.blobs,
        clock: this.deps.clock,
      },
      {
        baseSnapshotId,
        evaluatorContent: opts.evaluatorContent,
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
        baseRevision: organism.revision,
        proposedSnapshotId: genome.snapshot.id,
        hypothesis: opts.hypothesis,
        proposedBy: opts.proposedBy,
        sourceRefs: {
          candidateType: "judge",
          evaluatorDigest: digestOf(canonicalJson(opts.evaluatorContent)),
        },
        datasetRef: null,
        createdAt: now,
      };
      this.deps.storage.insertCandidate(candidate);
      this.deps.storage.appendEvent({
        streamId: `candidate-${candidate.id}`,
        type: "candidate.proposed",
        payload: {
          candidateId: candidate.id,
          candidateType: "judge",
          proposedSnapshotId: candidate.proposedSnapshotId,
          proposedSnapshotDigest: genome.snapshot.digest,
          baseSnapshotId,
          baseRevision: candidate.baseRevision,
          hypothesis: opts.hypothesis,
        },
        organismId: this.deps.organismId,
        occurredAt: now,
      });
      return { candidate, created: true };
    });
  }

  /**
   * 评估裁判候选（裁判拆分的独立评估）：候选快照×回归集（钉住候选的新裁判，
   * 验证新裁判不破坏既有任务判定）+ 基准快照×回归集（基准裁判，环境健康对照）。
   * 全过 → eligible；候选臂失败 → rejected；基线臂失败 → inconclusive（可重评）。
   */
  async evaluateJudgeCandidate(
    candidateId: string,
    plan: { regression: TaskSubmissionLike | TaskSubmissionLike[]; requestedBy: string },
  ): Promise<{ evaluation: EvaluationRecord; status: CandidateStatus }> {
    const candidate = this.mustGetCandidate(candidateId);
    if (candidate.sourceRefs["candidateType"] !== "judge") {
      throw new EvolutionError(
        "not_a_judge_candidate",
        `候选 ${candidateId} 不是裁判候选（sourceRefs.candidateType != judge）`,
      );
    }
    const regressions = normalizeRegressions(plan.regression);
    if (regressions.length === 0) {
      throw new EvolutionError(
        "evaluation_plan_missing_regression",
        "评估计划至少需要一个回归任务",
      );
    }
    // 候选快照的裁判槽位即被评估的新裁判；评估 Run 显式钉住它
    const proposedEvaluator = this.deps.kernel
      .resolveSnapshot(candidate.proposedSnapshotId)
      .versions.get("acceptance-evaluator");
    if (!proposedEvaluator) {
      throw new EvolutionError("missing_binding", "候选快照缺少 acceptance-evaluator 槽位");
    }

    this.deps.storage.tx(() => {
      this.deps.storage.appendEvent({
        streamId: `candidate-${candidateId}`,
        type: "candidate.evaluating",
        payload: {
          protocol: "m3-judge-eval-v1",
          evaluatorVersionId: proposedEvaluator.id,
        },
        organismId: this.deps.organismId,
        occurredAt: this.deps.clock.now(),
      });
    });

    const runOutcome = (
      role: EvaluationRunOutcome["role"],
      purpose: string,
      submission: TaskSubmissionLike,
      snapshotId: string,
      evaluatorVersionId: string | null,
    ): Promise<EvaluationRunOutcome> =>
      this.deps.runtime
        .submitTask(
          { ...submission, requestedBy: plan.requestedBy },
          {
            purpose: "evaluation",
            snapshotId,
            evaluatorVersionId: evaluatorVersionId ?? undefined,
          },
        )
        .then((summary) => ({
          role,
          purpose,
          runId: summary.runId,
          snapshotId,
          state: summary.state,
          failureReason: summary.failureReason,
          durationMs: this.deps.storage.getExperienceByRun(summary.runId)?.outcome.durationMs ?? 0,
        }));

    // 候选臂（新裁判）与基线臂（基准快照+其槽位裁判）交错并行
    const outcomes = await Promise.all([
      ...regressions.map((regression, i) =>
        runOutcome(
          "regression",
          `新裁判回归 ${i + 1}`,
          regression,
          candidate.proposedSnapshotId,
          proposedEvaluator.id,
        ),
      ),
      ...regressions.map((regression, i) =>
        runOutcome(
          `baseline` as const,
          `基线健康对照 ${i + 1}`,
          regression,
          candidate.baseSnapshotId,
          null,
        ),
      ),
    ]);
    const candidateOutcomes = outcomes.filter((o) => o.role === "regression");
    const baselineOutcomes = outcomes.filter((o) => o.role === "baseline");
    const passed = (o: EvaluationRunOutcome) => o.state === "succeeded";

    let verdict: EvaluationRecord["verdict"];
    let note: string;
    if (!baselineOutcomes.every(passed)) {
      verdict = "inconclusive";
      note = "基线对照失败：评估环境不可信，不判 rejected，可修复后重评";
    } else if (!candidateOutcomes.every(passed)) {
      verdict = "rejected";
      note = `新裁判在既有任务上判定失败（${candidateOutcomes.find((o) => !passed(o))?.failureReason}）：判定等价性不成立`;
    } else {
      verdict = "eligible";
      note = "新裁判在既有任务上与基准判定一致（运行时对照 + tests/evals 等价性用例）";
    }

    const evaluation: EvaluationRecord = {
      id: this.deps.ids.next(),
      candidateId,
      protocolDigest: digestOf("m3-judge-eval-v1"),
      baselineSnapshotId: candidate.baseSnapshotId,
      runs: outcomes,
      verdict,
      metrics: {
        // 裁判候选无新能力臂；切片⑤协议泛化时重构 metrics 分列
        newCapability: { passed: verdict === "eligible", durationMs: 0 },
        regression: {
          passed: candidateOutcomes.every(passed),
          durationMs: candidateOutcomes.reduce((acc, o) => acc + o.durationMs, 0),
        },
        baseline: {
          passed: baselineOutcomes.every(passed),
          durationMs: baselineOutcomes.reduce((acc, o) => acc + o.durationMs, 0),
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
    const operationId = opts.operationId ?? this.deps.ids.next();
    return this.deps.storage.tx(() => {
      const latest = this.deps.storage.listEvaluationsByCandidate(candidateId, 1)[0];
      if (!latest || latest.verdict !== "eligible") {
        throw new EvolutionError(
          "evaluation_not_eligible",
          `候选 ${candidateId} 缺少 eligible 评估（最新：${latest ? latest.verdict : "无"}），禁止晋升`,
        );
      }
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

  /**
   * 冻结经验窗口（M3，evolution.md §3"只读取一个已确定的经验窗口，后续经验留给下一轮"）：
   * 显式固定成员清单（默认 cutoff 前全部终态 Run 的 experience）与内容摘要，
   * 固定成员而非查询语句（docs/domain-model.md §Experience）。不可变、按 digest 幂等。
   */
  freezeExperienceWindow(opts: {
    purpose: ExperienceDatasetPurpose;
    cutoffAt?: number;
    runIds?: string[];
    createdBy: string;
    permissionScope?: string;
  }): { dataset: ExperienceDatasetRecord; created: boolean; memberCount: number } {
    const cutoff = opts.cutoffAt ?? this.deps.clock.now();
    const scan = this.deps.storage.listExperiences(100_000);
    const selected = scan
      .filter((e) => (opts.runIds ? opts.runIds.includes(e.runId) : e.createdAt <= cutoff))
      .map((e) => this.memberView(e.id, e.runId))
      .filter((m): m is ExperienceMemberView => m !== null)
      .sort((a, b) => (a.experienceId < b.experienceId ? -1 : 1));

    const memberDigest = digestOf(canonicalJson(selected.map((m) => digestOf(canonicalJson(m)))));
    const memberExperienceIds = selected.map((m) => m.experienceId);
    const filterVersion = opts.runIds
      ? EXPERIENCE_FILTER_VERSION_EXPLICIT
      : EXPERIENCE_FILTER_VERSION_CUTOFF;
    const digest = digestOf(
      canonicalJson({
        purpose: opts.purpose,
        cutoffAt: cutoff,
        memberExperienceIds,
        memberDigest,
        filterVersion,
      }),
    );

    return this.deps.storage.tx(() => {
      const existing = this.deps.storage.findExperienceDatasetByDigest(digest);
      if (existing) return { dataset: existing, created: false, memberCount: selected.length };
      const now = this.deps.clock.now();
      const dataset: ExperienceDatasetRecord = {
        id: this.deps.ids.next(),
        digest,
        purpose: opts.purpose,
        cutoffAt: cutoff,
        memberExperienceIds,
        memberDigest,
        filterVersion,
        permissionScope: opts.permissionScope ?? `organism:${this.deps.organismId}`,
        createdBy: opts.createdBy,
        createdAt: now,
      };
      this.deps.storage.insertExperienceDataset(dataset);
      this.deps.storage.appendEvent({
        streamId: `dataset-${dataset.id}`,
        type: "dataset.frozen",
        payload: {
          datasetId: dataset.id,
          digest,
          purpose: dataset.purpose,
          cutoffAt: cutoff,
          memberCount: memberExperienceIds.length,
          memberDigest,
          filterVersion,
        },
        organismId: this.deps.organismId,
        occurredAt: now,
      });
      return { dataset, created: true, memberCount: selected.length };
    });
  }

  /** 冻结经验集的学习投影（Consolidation 的唯一输入）：成员 × 决策调用 × 预算 */
  experienceDatasetView(datasetId: string): {
    dataset: ExperienceDatasetRecord;
    members: ExperienceMemberView[];
  } {
    const dataset = this.deps.storage.getExperienceDataset(datasetId);
    if (!dataset) throw new EvolutionError("unknown_dataset", `经验集 ${datasetId} 不存在`);
    const members = dataset.memberExperienceIds
      .map((experienceId) => {
        // 成员按 experience id 固化；run 关系经存储反查
        const scan = this.deps.storage.listExperiences(100_000).find((e) => e.id === experienceId);
        return scan ? this.memberView(experienceId, scan.runId) : null;
      })
      .filter((m): m is ExperienceMemberView => m !== null);
    return { dataset, members };
  }

  /**
   * 策略候选提议（M3 首个学习场景，evolution.md §2 Variation"规则搜索"）：
   * 冻结经验集（development 许可）→ 确定性规则归纳 → 只改 routing-policy 的
   * 候选快照（图/能力/裁判固定）。策略内容 rule-hybrid-v1：归纳的
   * featureRoutes 优先，基准兜底 routes 继承（回归约束）。
   * 零提议是正常结果（证据不足，不提议候选）。
   */
  /**
   * 提交 Consolidation 作业（异步队列，evolution.md §3"独立队列与取消策略"）：
   * 参数内容寻址（门槛 + gold 的 blob 引用）；同参数存在非终态或已完成作业时
   * 幂等返回既有。提交即返回，执行由 runPendingConsolidationJobs 驱动。
   */
  submitConsolidationJob(opts: {
    datasetId: string;
    params?: ConsolidationParams;
    goldMatches?: Array<{ goal: string; choice: string }>;
    mode?: ConsolidationMode;
    createdBy: string;
  }): { job: ConsolidationJobRecord; created: boolean } {
    const dataset = this.deps.storage.getExperienceDataset(opts.datasetId);
    if (!dataset) throw new EvolutionError("unknown_dataset", `经验集 ${opts.datasetId} 不存在`);
    if (dataset.purpose !== "development") {
      throw new EvolutionError(
        "dataset_purpose_forbidden",
        `经验集 ${opts.datasetId} 用途为 ${dataset.purpose}，仅 development 许可作为学习来源`,
      );
    }
    const consolidation = opts.params ?? DEFAULT_CONSOLIDATION_PARAMS;
    const mode = opts.mode ?? "rule";
    const goldRef = opts.goldMatches
      ? this.deps.blobs.write(canonicalJson(opts.goldMatches)).ref
      : null;
    const paramsDigest = digestOf(
      canonicalJson({ datasetId: opts.datasetId, mode, consolidation, goldRef }),
    );

    return this.deps.storage.tx(() => {
      const existing = this.deps.storage
        .listConsolidationJobs({ datasetId: opts.datasetId }, 50)
        .find(
          (j) =>
            j.paramsDigest === paramsDigest &&
            (j.state === "queued" || j.state === "running" || j.state === "completed"),
        );
      if (existing) return { job: existing, created: false };
      const now = this.deps.clock.now();
      const job: ConsolidationJobRecord = {
        id: this.deps.ids.next(),
        datasetId: opts.datasetId,
        mode,
        paramsDigest,
        params: { consolidation, goldRef },
        state: "queued",
        result: null,
        error: null,
        requestedBy: opts.createdBy,
        createdAt: now,
        updatedAt: now,
      };
      this.deps.storage.insertConsolidationJob(job);
      this.deps.storage.appendEvent({
        streamId: `job-${job.id}`,
        type: "consolidation.job.submitted",
        payload: { jobId: job.id, datasetId: opts.datasetId, mode, paramsDigest },
        organismId: this.deps.organismId,
        occurredAt: now,
      });
      return { job, created: true };
    });
  }

  /**
   * 驱动队列（operator 显式调用；串行执行，单 writer 语义）：
   * queued → running → completed/failed。执行体为纯函数短操作，
   * cancel 仅作用于 queued（不可中断如实记录）。失败保留证据可重提。
   */
  async runPendingConsolidationJobs(
    limit = 1,
  ): Promise<Array<{ jobId: string; outcome: string; detail: string }>> {
    const queued = this.deps.storage.listConsolidationJobs({ state: "queued" }, limit);
    const results: Array<{
      jobId: string;
      outcome: "completed" | "failed" | "skipped" | "cancelled";
      detail: string;
    }> = [];
    for (const job of queued) {
      // 启动迁移（queued → running）
      this.deps.storage.tx(() => {
        this.deps.storage.updateConsolidationJob(job.id, {
          state: "running",
          updatedAt: this.deps.clock.now(),
        });
        this.deps.storage.appendEvent({
          streamId: `job-${job.id}`,
          type: "consolidation.job.started",
          payload: { jobId: job.id },
          organismId: this.deps.organismId,
          occurredAt: this.deps.clock.now(),
        });
      });
      try {
        const goldMatches = job.params.goldRef
          ? (JSON.parse(this.deps.blobs.read(job.params.goldRef)) as Array<{
              goal: string;
              choice: string;
            }>)
          : undefined;
        const executed = await this.executeConsolidation({
          datasetId: job.datasetId,
          params: job.params.consolidation,
          goldMatches,
          mode: job.mode,
          createdBy: job.requestedBy,
        });
        this.deps.storage.tx(() => {
          this.deps.storage.updateConsolidationJob(job.id, {
            state: "completed",
            result: {
              candidateId: executed.candidate?.id ?? null,
              hypothesis: executed.consolidation.hypothesis,
              proposals: executed.consolidation.proposals.length,
            },
            updatedAt: this.deps.clock.now(),
          });
          this.deps.storage.appendEvent({
            streamId: `job-${job.id}`,
            type: "consolidation.job.completed",
            payload: {
              jobId: job.id,
              candidateId: executed.candidate?.id ?? null,
              proposals: executed.consolidation.proposals.length,
              hypothesis: executed.consolidation.hypothesis,
            },
            organismId: this.deps.organismId,
            occurredAt: this.deps.clock.now(),
          });
        });
        results.push({
          jobId: job.id,
          outcome: "completed",
          detail: executed.candidate
            ? `候选 ${executed.candidate.id}（${executed.consolidation.proposals.length} 条规则）`
            : "零提议（证据不足，正常结果）",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.storage.tx(() => {
          this.deps.storage.updateConsolidationJob(job.id, {
            state: "failed",
            error: message,
            updatedAt: this.deps.clock.now(),
          });
          this.deps.storage.appendEvent({
            streamId: `job-${job.id}`,
            type: "consolidation.job.failed",
            payload: { jobId: job.id, error: message },
            organismId: this.deps.organismId,
            occurredAt: this.deps.clock.now(),
          });
        });
        results.push({ jobId: job.id, outcome: "failed", detail: message });
      }
    }
    return results;
  }

  /** 取消作业：仅 queued 可取消（执行为纯函数短操作，running 不可中断） */
  cancelConsolidationJob(jobId: string): { jobId: string; state: string; note: string } {
    const job = this.deps.storage.getConsolidationJob(jobId);
    if (!job) throw new EvolutionError("unknown_job", `作业 ${jobId} 不存在`);
    if (job.state !== "queued") {
      return {
        jobId,
        state: job.state,
        note: `作业已处于 ${job.state}，不能取消（执行为短操作不可中断）`,
      };
    }
    this.deps.storage.tx(() => {
      this.deps.storage.updateConsolidationJob(jobId, {
        state: "cancelled",
        updatedAt: this.deps.clock.now(),
      });
      this.deps.storage.appendEvent({
        streamId: `job-${jobId}`,
        type: "consolidation.job.cancelled",
        payload: { jobId },
        organismId: this.deps.organismId,
        occurredAt: this.deps.clock.now(),
      });
    });
    return { jobId, state: "cancelled", note: "已取消（未开始执行）" };
  }

  consolidationJob(jobId: string): ConsolidationJobRecord {
    const job = this.deps.storage.getConsolidationJob(jobId);
    if (!job) throw new EvolutionError("unknown_job", `作业 ${jobId} 不存在`);
    return job;
  }

  /**
   * 注册验证集（移交验证负责人机制，实验文档 §12）：
   * - family 与开发集完全隔离（显式断言，防 held-out 泄漏为开发反馈）
   * - 固定成员与来源引用，immutable；使用计数与降级语义可审计
   * devFamiliesDigest 是注册时的开发集 family 指纹——后续开发集扩张
   * 后重放隔离断言的依据。
   */
  registerValidationSet(opts: {
    familyIds: string[];
    sourceRef: string;
    preparedBy: string;
    /** 注册时开发集全部 family（隔离断言基准） */
    devFamilyIds: string[];
  }): ValidationSetRecord {
    const overlap = opts.familyIds.filter((f) => opts.devFamilyIds.includes(f));
    if (overlap.length > 0) {
      throw new EvolutionError(
        "validation_family_overlap",
        `验证集 family 与开发集重叠：${overlap.join(", ")}（held-out 不得参与开发反馈）`,
      );
    }
    const devFamiliesDigest = digestOf(canonicalJson([...opts.devFamilyIds].sort()));
    const now = this.deps.clock.now();
    const record: ValidationSetRecord = {
      id: this.deps.ids.next(),
      familyIds: [...new Set(opts.familyIds)].sort(),
      sourceRef: opts.sourceRef,
      preparedBy: opts.preparedBy,
      devFamiliesDigest,
      state: "ready",
      usageCount: 0,
      firstUsedAt: null,
      retiredAt: null,
      createdAt: now,
    };
    return this.deps.storage.tx(() => {
      this.deps.storage.insertValidationSet(record);
      this.deps.storage.appendEvent({
        streamId: `validation-set-${record.id}`,
        type: "validation.set.registered",
        payload: {
          validationSetId: record.id,
          familyCount: record.familyIds.length,
          preparedBy: record.preparedBy,
          devFamiliesDigest,
        },
        organismId: this.deps.organismId,
        occurredAt: now,
      });
      return record;
    });
  }

  /**
   * 领用验证集做正式评估：ready 或"首次使用中"可领用（计数 +1）；
   * 正式结果公开后（第二次领用）拒绝——必须先显式 retire 转为回归集。
   */
  claimValidationSet(id: string): ValidationSetRecord {
    const set = this.deps.storage.getValidationSet(id);
    if (!set) throw new EvolutionError("unknown_validation_set", `验证集 ${id} 不存在`);
    if (set.state === "retired") {
      throw new EvolutionError(
        "validation_set_retired",
        `验证集 ${id} 已退休为回归集（正式结果已公开，不得继续充当未见验证集）`,
      );
    }
    if (set.usageCount >= 1) {
      throw new EvolutionError(
        "validation_set_exhausted",
        `验证集 ${id} 已被一次正式评估使用（usage=${set.usageCount}）；正式结果公开后须 retire 转为回归集，下一轮另备新 family`,
      );
    }
    return this.deps.storage.tx(() => {
      const now = this.deps.clock.now();
      this.deps.storage.updateValidationSet(id, {
        state: "in_use",
        usageCount: set.usageCount + 1,
        firstUsedAt: set.firstUsedAt ?? now,
        updatedAt: now,
      });
      this.deps.storage.appendEvent({
        streamId: `validation-set-${id}`,
        type: "validation.set.claimed",
        payload: { validationSetId: id, usageCount: set.usageCount + 1 },
        organismId: this.deps.organismId,
        occurredAt: now,
      });
      return this.deps.storage.getValidationSet(id)!;
    });
  }

  /** 退休验证集（正式结果公开后显式降级为回归集；此后仅可 purpose=regression 引用） */
  retireValidationSet(id: string, note?: string): ValidationSetRecord {
    const set = this.deps.storage.getValidationSet(id);
    if (!set) throw new EvolutionError("unknown_validation_set", `验证集 ${id} 不存在`);
    if (set.state === "retired") return set;
    return this.deps.storage.tx(() => {
      const now = this.deps.clock.now();
      this.deps.storage.updateValidationSet(id, { state: "retired", retiredAt: now, updatedAt: now });
      this.deps.storage.appendEvent({
        streamId: `validation-set-${id}`,
        type: "validation.set.retired",
        payload: { validationSetId: id, note: note ?? null, usageCount: set.usageCount },
        organismId: this.deps.organismId,
        occurredAt: now,
      });
      return this.deps.storage.getValidationSet(id)!;
    });
  }

  validationSet(id: string): ValidationSetRecord {
    const set = this.deps.storage.getValidationSet(id);
    if (!set) throw new EvolutionError("unknown_validation_set", `验证集 ${id} 不存在`);
    return set;
  }

  /** 同步便捷入口（不经队列）：提交语义见 executeConsolidation */
  proposePolicyCandidate(opts: {
    datasetId: string;
    params?: ConsolidationParams;
    /** 开发集标注（goal → 正确选项）：失败/弃权成员 join 为正例；验证 family 不得传入 */
    goldMatches?: Array<{ goal: string; choice: string }>;
    mode?: ConsolidationMode;
    createdBy: string;
  }): Promise<{
    candidate: CandidateRecord | null;
    consolidation: ConsolidationResult;
  }> {
    return this.executeConsolidation({
      datasetId: opts.datasetId,
      params: opts.params ?? DEFAULT_CONSOLIDATION_PARAMS,
      goldMatches: opts.goldMatches,
      mode: opts.mode ?? "rule",
      createdBy: opts.createdBy,
    });
  }

  /** 归纳执行核心（队列与同步入口共用）；mode 记入候选来源 */
  private async executeConsolidation(input: {
    datasetId: string;
    params: ConsolidationParams;
    goldMatches?: Array<{ goal: string; choice: string }>;
    mode: ConsolidationMode;
    createdBy: string;
  }): Promise<{
    candidate: CandidateRecord | null;
    consolidation: ConsolidationResult;
  }> {
    const { dataset, members } = this.experienceDatasetView(input.datasetId);
    if (dataset.purpose !== "development") {
      throw new EvolutionError(
        "dataset_purpose_forbidden",
        `经验集 ${input.datasetId} 用途为 ${dataset.purpose}，仅 development 许可作为学习来源`,
      );
    }
    const params = input.params;

    // 组装归纳样本：决策视图特征来自请求 blob（请求内容不可回放的调用计入缺口统计）
    const samples: RouteSample[] = [];
    let unreplayable = 0;
    for (const member of members) {
      for (const call of member.decisionCalls) {
        const features = this.callFeatures(call.id);
        if (!features) {
          unreplayable += 1;
          continue;
        }
        const succeeded = member.result === "succeeded";
        const gold = succeeded
          ? undefined
          : input.goldMatches?.find((g) => g.goal === member.taskGoal);
        samples.push({
          runId: member.runId,
          experienceId: member.experienceId,
          features,
          chosen: succeeded ? call.chosenOption : (gold?.choice ?? null),
          succeeded,
          origin: succeeded ? "experience" : gold ? "gold" : undefined,
        });
      }
    }
    let consolidation: ConsolidationResult;
    let llmProvenance: { promptDigest: string; responseDigest: string; proposer: string } | null =
      null;
    if (input.mode === "llm") {
      // LLM 归纳：提议者只看缺口样本（不含正确答案），提议必须经统计门槛重算
      if (!this.deps.routeProposer) {
        throw new EvolutionError(
          "llm_proposer_unavailable",
          "mode=llm 需要装配 RouteProposer（PROTEUS_LLM_API_KEY 未配置或未注入）",
        );
      }
      const routeContext = this.routeOptionsAndFeatures();
      const gapSamples = samples
        .filter((s) => !s.succeeded && s.origin !== "gold")
        .map((s) => {
          const member = members.find((m) => m.experienceId === s.experienceId)!;
          return {
            goal: member.taskGoal,
            features: s.features,
            reason: member.decisionCalls.find((c) => c.chosenOption === null)
              ? "规则弃权（信息不足）"
              : `路由后 Run 失败（${member.result}）`,
          };
        });
      const rawProposals = await this.deps.routeProposer.propose({
        gapSamples,
        options: routeContext.options,
        features: routeContext.features,
      });
      const refined = refineProposals(samples, rawProposals, params);
      const proposer = this.deps.routeProposer as {
        name: string;
        lastProvenance?: { promptDigest: string; responseDigest: string } | null;
      };
      if (proposer.lastProvenance) {
        llmProvenance = {
          proposer: this.deps.routeProposer.name,
          promptDigest: proposer.lastProvenance.promptDigest,
          responseDigest: proposer.lastProvenance.responseDigest,
        };
      }
      consolidation = {
        proposals: refined.accepted,
        stats: {
          samples: samples.length,
          positiveMembers: samples.filter(
            (x) => x.chosen !== null && (x.succeeded || x.origin === "gold"),
          ).length,
          abstainMembers: samples.filter((x) => x.chosen === null && x.origin !== "gold").length,
          failedMembers: samples.filter((x) => !x.succeeded && x.origin !== "gold").length,
          featuresScanned: routeContext.features,
        },
        hypothesis:
          refined.accepted.length === 0
            ? `LLM（${this.deps.routeProposer.name}）提议 ${rawProposals.length} 条，统计重算后全部未达门槛（${refined.rejected.map((r) => `${r.feature}→${r.choose}:${r.reason}`).join("; ") || "无有效提议"}）：证据不足，不提议候选`
            : `LLM（${this.deps.routeProposer.name}）提议 ${rawProposals.length} 条，统计重算保留 ${refined.accepted.length} 条（丢弃 ${refined.rejected.length} 条未达门槛）：${refined.accepted
                .map(
                  (p) =>
                    `${p.feature}→${p.choose}(支持 ${p.support}/精度 ${p.precision.toFixed(2)})`,
                )
                .join("; ")}`,
      };
    } else {
      consolidation = consolidateRoutes(samples, params);
    }
    if (unreplayable > 0) {
      consolidation.hypothesis += `；${unreplayable} 个决策调用请求不可回放，未计入`;
    }
    if (consolidation.proposals.length === 0) {
      return { candidate: null, consolidation };
    }

    const organism = this.deps.kernel.getOrganism(this.deps.organismId);
    const baseSnapshotId = organism?.activeGenomeId ?? null;
    if (!organism || !baseSnapshotId) {
      throw new EvolutionError("no_active_genome", "默认快照未安装，无基准可组合策略候选");
    }
    const { snapshot: base, versions: baseVersions } =
      this.deps.kernel.resolveSnapshot(baseSnapshotId);
    const basePolicy = baseVersions.get("routing-policy");
    if (!basePolicy) {
      throw new EvolutionError("missing_binding", "基准快照缺少 routing-policy 槽位");
    }
    if (!base.bindings["decision-view"]) {
      throw new EvolutionError(
        "missing_binding",
        "基准快照缺少 decision-view 槽位：策略候选的图须声明受限视图（先经能力组合建立）",
      );
    }

    // 混合策略内容：归纳 featureRoutes + 基准兜底 routes 继承
    const basePolicyContent = JSON.parse(this.deps.blobs.read(basePolicy.contentRef)) as {
      kind?: string;
      routes?: Array<{ when: Record<string, unknown>; choose: string }>;
      featureRoutes?: Array<{ feature: string; choose: string }>;
    };
    const fallbackRoutes =
      basePolicyContent.kind === "rule-hybrid-v1" && Array.isArray(basePolicyContent.routes)
        ? basePolicyContent.routes
        : basePolicyContent.kind === "rule-v1" && Array.isArray(basePolicyContent.routes)
          ? basePolicyContent.routes.map((r) => ({ when: r.when, choose: String(r.choose) }))
          : [];
    const existingFeatures = new Set(
      basePolicyContent.kind === "rule-hybrid-v1"
        ? (basePolicyContent.featureRoutes ?? []).map((r) => r.feature)
        : [],
    );
    const merged = [
      ...(basePolicyContent.kind === "rule-hybrid-v1"
        ? (basePolicyContent.featureRoutes ?? [])
        : []),
      ...consolidation.proposals
        .filter((p) => !existingFeatures.has(p.feature))
        .map((p) => ({ feature: p.feature, choose: p.choose })),
    ];
    const policyContent = {
      schemaVersion: 1,
      kind: "rule-hybrid-v1",
      featureRoutes: merged,
      routes:
        fallbackRoutes.length > 0
          ? fallbackRoutes
          : [{ when: { nodeType: "execute" }, choose: "local-process" }],
    };

    return this.deps.storage.tx(() => {
      const policyVersion = registerDerivedVersion(
        {
          kernel: this.deps.kernel,
          storage: this.deps.storage,
          blobs: this.deps.blobs,
          clock: this.deps.clock,
        },
        {
          slot: "routing-policy",
          baseVersion: basePolicy,
          content: policyContent,
          createdBy: input.createdBy,
        },
      );
      const bindings = { ...base.bindings, "routing-policy": policyVersion.id };
      const snapshot = this.deps.kernel.createSnapshot(bindings, input.createdBy);
      const existing = this.deps.storage.findCandidateByProposedSnapshot(
        this.deps.organismId,
        snapshot.id,
      );
      if (existing) return { candidate: existing, consolidation };
      const now = this.deps.clock.now();
      const candidate: CandidateRecord = {
        id: this.deps.ids.next(),
        organismId: this.deps.organismId,
        baseSnapshotId,
        baseRevision: organism.revision,
        proposedSnapshotId: snapshot.id,
        hypothesis: consolidation.hypothesis,
        proposedBy: input.createdBy,
        sourceRefs: {
          candidateType: "policy",
          datasetId: dataset.id,
          datasetDigest: dataset.digest,
          consolidationMode: input.mode,
          consolidationParamsDigest: digestOf(canonicalJson(params)),
          rulesDigest: digestOf(canonicalJson(policyContent)),
          ...(llmProvenance
            ? {
                llmProposer: llmProvenance.proposer,
                llmPromptDigest: llmProvenance.promptDigest,
                llmResponseDigest: llmProvenance.responseDigest,
              }
            : {}),
        },
        datasetRef: dataset.id,
        createdAt: now,
      };
      this.deps.storage.insertCandidate(candidate);
      this.deps.storage.appendEvent({
        streamId: `candidate-${candidate.id}`,
        type: "candidate.proposed",
        payload: {
          candidateId: candidate.id,
          candidateType: "policy",
          proposedSnapshotId: snapshot.id,
          proposedSnapshotDigest: snapshot.digest,
          baseSnapshotId,
          baseRevision: candidate.baseRevision,
          hypothesis: candidate.hypothesis,
          datasetId: dataset.id,
          datasetDigest: dataset.digest,
        },
        organismId: this.deps.organismId,
        occurredAt: now,
      });
      return { candidate, consolidation };
    });
  }

  /**
   * 策略候选评估（协议 m3-policy-eval-v1，构造候选前固定门槛参数）：
   * 双臂（基准快照 vs 候选快照）× 验证集 cases × repeats（固定顺序）。
   * 指标分列不合成总分（principles.md）：成功率 / 路由准确率（有期望的
   * case）/ 弃权率 / 时延 p50·p95 / 成功率跨重复方差。
   * verdict：样本不足或基线臂在基线本应通过的 case 上全败 → inconclusive
   * （证据不足不判通过）；候选臂成功率或相对改善未达门槛 → rejected。
   */
  async evaluatePolicyCandidate(
    candidateId: string,
    plan: PolicyEvaluationPlan,
  ): Promise<{ evaluation: EvaluationRecord; status: CandidateStatus }> {
    const candidate = this.mustGetCandidate(candidateId);
    if (candidate.sourceRefs["candidateType"] !== "policy") {
      throw new EvolutionError(
        "not_a_policy_candidate",
        `候选 ${candidateId} 不是策略候选（sourceRefs.candidateType != policy）`,
      );
    }
    if (plan.cases.length === 0) {
      throw new EvolutionError("evaluation_plan_missing_cases", "验证集至少需要一个 case");
    }
    if (plan.repeats < 1) {
      throw new EvolutionError("evaluation_plan_invalid_repeats", "repeats 至少为 1");
    }

    this.deps.storage.tx(() => {
      this.deps.storage.appendEvent({
        streamId: `candidate-${candidateId}`,
        type: "candidate.evaluating",
        payload: { protocol: "m3-policy-eval-v1", cases: plan.cases.length, repeats: plan.repeats },
        organismId: this.deps.organismId,
        occurredAt: this.deps.clock.now(),
      });
    });

    const outcomes: EvaluationRunOutcome[] = [];
    const armLatency = { base: [] as number[], candidate: [] as number[] };
    const armSuccess = { base: [] as boolean[], candidate: [] as boolean[] };
    const armRouteOk = { base: [] as boolean[], candidate: [] as boolean[] };
    const armAbstain = { base: [] as boolean[], candidate: [] as boolean[] };
    // 确定性顺序：case 序 × repeat 序 × 双臂（base 先）
    for (let caseIndex = 0; caseIndex < plan.cases.length; caseIndex++) {
      const c = plan.cases[caseIndex]!;
      for (let repeat = 1; repeat <= plan.repeats; repeat++) {
        for (const arm of ["base", "candidate"] as const) {
          const snapshotId =
            arm === "base" ? candidate.baseSnapshotId : candidate.proposedSnapshotId;
          const summary = await this.deps.runtime.submitTask(
            { ...c.task, requestedBy: plan.requestedBy },
            { purpose: "evaluation", snapshotId },
          );
          const experience = this.deps.storage.getExperienceByRun(summary.runId);
          const durationMs = experience?.outcome.durationMs ?? 0;
          const succeeded = summary.state === "succeeded";
          const chosen = this.routeChoiceOf(summary.runId);
          const abstained = chosen === null;
          const routeOk = c.expectedChoice !== null && chosen === c.expectedChoice;
          outcomes.push({
            role: arm === "base" ? "policy-base" : "policy-candidate",
            purpose: `${arm} 臂 case ${caseIndex + 1}×${repeat}`,
            runId: summary.runId,
            snapshotId,
            state: summary.state,
            failureReason: summary.failureReason,
            durationMs,
          });
          armLatency[arm].push(durationMs);
          armSuccess[arm].push(succeeded);
          armAbstain[arm].push(abstained);
          if (c.expectedChoice !== null) armRouteOk[arm].push(routeOk);
        }
      }
    }

    const percentile = (sorted: number[], p: number): number =>
      sorted.length === 0
        ? 0
        : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
    const rate = (arr: boolean[]): number =>
      arr.length === 0 ? 0 : arr.filter(Boolean).length / arr.length;
    const variance = (perRepeat: number[]): number => {
      if (perRepeat.length < 2) return 0;
      const mean = perRepeat.reduce((a, b) => a + b, 0) / perRepeat.length;
      return perRepeat.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (perRepeat.length - 1);
    };
    const armMetrics = (arm: "base" | "candidate"): PolicyArmMetrics => {
      const sortedLatency = [...armLatency[arm]].sort((a, b) => a - b);
      // 数组按 (case → repeat → arm) 顺序交错：该臂第 ci 个 case 第 r 次重复
      // 的索引 = ci*repeats*2 + r*2 + (base?0:1)
      const armOffset = arm === "base" ? 0 : 1;
      const perRepeat: number[] = [];
      for (let r = 0; r < plan.repeats; r++) {
        const flags: boolean[] = [];
        for (let ci = 0; ci < plan.cases.length; ci++) {
          flags.push(armSuccess[arm][ci * plan.repeats * 2 + r * 2 + armOffset] === true);
        }
        perRepeat.push(rate(flags));
      }
      return {
        runs: armLatency[arm].length,
        successRate: rate(armSuccess[arm]),
        routeAccuracy: armRouteOk[arm].length === 0 ? null : rate(armRouteOk[arm]),
        abstainRate: rate(armAbstain[arm]),
        latencyP50Ms: percentile(sortedLatency, 50),
        latencyP95Ms: percentile(sortedLatency, 95),
        successRateVariance: variance(perRepeat),
      };
    };
    const base = armMetrics("base");
    const candidateArm = armMetrics("candidate");
    const totalSamples = candidateArm.runs;
    const thresholds = plan.thresholds;
    const improvement = candidateArm.successRate - base.successRate;

    let verdict: EvaluationRecord["verdict"];
    let note: string;
    if (totalSamples < thresholds.minSamples) {
      verdict = "inconclusive";
      note = `样本不足（${totalSamples} < ${thresholds.minSamples}）：证据不足，不判通过`;
    } else if (candidateArm.successRate < thresholds.minSuccessRate) {
      verdict = "rejected";
      note = `候选臂成功率 ${(candidateArm.successRate * 100).toFixed(0)}% 低于门槛 ${(thresholds.minSuccessRate * 100).toFixed(0)}%`;
    } else if (improvement < thresholds.minImprovement) {
      verdict = "rejected";
      note = `相对改善 ${(improvement * 100).toFixed(0)}pp 未达最小改善 ${(thresholds.minImprovement * 100).toFixed(0)}pp（基线 ${(base.successRate * 100).toFixed(0)}%）`;
    } else {
      verdict = "eligible";
      note = `候选臂成功率 ${(candidateArm.successRate * 100).toFixed(0)}%（基线 ${(base.successRate * 100).toFixed(0)}%，改善 ${(improvement * 100).toFixed(0)}pp），路由准确率 ${candidateArm.routeAccuracy === null ? "n/a" : `${(candidateArm.routeAccuracy * 100).toFixed(0)}%`}`;
    }

    const evaluation: EvaluationRecord = {
      id: this.deps.ids.next(),
      candidateId,
      protocolDigest: digestOf(
        canonicalJson({
          protocol: "m3-policy-eval-v1",
          cases: plan.cases.length,
          repeats: plan.repeats,
          thresholds,
        }),
      ),
      baselineSnapshotId: candidate.baseSnapshotId,
      runs: outcomes,
      verdict,
      metrics: {
        newCapability: { passed: verdict === "eligible", durationMs: 0 },
        regression: { passed: base.successRate >= 0, durationMs: base.latencyP50Ms },
        baseline: { passed: true, durationMs: candidateArm.latencyP50Ms },
        cost: null,
      },
      policy: { base, candidate: candidateArm, thresholds, repeats: plan.repeats },
      datasetRef: candidate.datasetRef,
      datasetSplitRefs: plan.cases.map((_, i) => `case-${i + 1}`),
      createdAt: this.deps.clock.now(),
    };
    this.deps.storage.tx(() => {
      this.deps.storage.insertEvaluation(evaluation);
      this.deps.storage.appendEvent({
        streamId: `candidate-${candidateId}`,
        type: "candidate.evaluated",
        payload: { evaluationId: evaluation.id, verdict, note, policy: evaluation.policy },
        organismId: this.deps.organismId,
        occurredAt: this.deps.clock.now(),
      });
    });
    return { evaluation, status: this.candidateStatus(candidateId).status };
  }

  /** Run 的 route 决策选择（decision.recorded 投影；无决策或弃权为 null） */
  private routeChoiceOf(runId: string): string | null {
    const events = this.deps.storage.listEvents({ runId }, 500);
    for (const event of events) {
      if (event.type === "decision.recorded") {
        const value = event.payload["value"];
        return typeof value === "string" ? value : null;
      }
    }
    return null;
  }

  /** active 快照的路由选项与视图特征名（LLM 提议者的受限词表） */
  private routeOptionsAndFeatures(): { options: string[]; features: string[] } {
    const organism = this.deps.kernel.getOrganism(this.deps.organismId);
    if (!organism?.activeGenomeId) {
      throw new EvolutionError("no_active_genome", "默认快照未安装");
    }
    const { versions } = this.deps.kernel.resolveSnapshot(organism.activeGenomeId);
    const graph = versions.get("task-graph");
    const view = versions.get("decision-view");
    if (!graph || !view) {
      throw new EvolutionError("missing_binding", "基准快照缺少 task-graph 或 decision-view 槽位");
    }
    const graphContent = JSON.parse(this.deps.blobs.read(graph.contentRef)) as {
      nodes?: Array<{ type?: string; options?: string[] }>;
    };
    const routeNode = graphContent.nodes?.find((n) => n.type === "decision" && n.options);
    const viewContent = JSON.parse(this.deps.blobs.read(view.contentRef)) as {
      features?: Record<string, unknown>;
      optionDescriptions?: Record<string, string>;
    };
    return {
      options: [
        ...new Set([
          ...(routeNode?.options ?? []),
          ...Object.keys(viewContent.optionDescriptions ?? {}),
        ]),
      ].sort(),
      features: Object.keys(viewContent.features ?? {}).sort(),
    };
  }

  /** 决策调用的视图特征（请求 blob 重放；缺失/损坏返回 null） */
  private callFeatures(decisionCallId: string): Record<string, boolean> | null {
    const call = this.deps.storage.getDecisionCall(decisionCallId);
    if (!call?.requestRef || !this.deps.blobs.has(call.requestRef)) return null;
    try {
      const parsed = JSON.parse(this.deps.blobs.read(call.requestRef)) as {
        view?: { features?: unknown } | null;
      };
      const features = parsed.view?.features;
      if (typeof features !== "object" || features === null) return null;
      return features as Record<string, boolean>;
    } catch {
      return null;
    }
  }

  /** 单个成员的学习投影；experience 或关联记录缺失时如实返回 null（不可回放则显式标注） */
  private memberView(experienceId: string, runId: string): ExperienceMemberView | null {
    const run = this.deps.storage.getRun(runId);
    const experience = this.deps.storage.getExperienceByRun(runId);
    if (!run || !experience || experience.id !== experienceId) return null;
    const task = this.deps.storage.getTask(run.taskId);
    const decisionValue = new Map<string, string>();
    for (const event of this.deps.storage.listEvents({ runId }, 500)) {
      if (event.type === "decision.recorded") {
        decisionValue.set(String(event.payload["nodeId"]), String(event.payload["value"]));
      }
    }
    const decisionCalls: ExperienceDecisionCallView[] = this.deps.storage
      .listDecisionCalls(runId)
      .map((call) => ({
        id: call.id,
        nodeId: call.nodeId,
        kind: call.kind,
        state: call.state,
        chosenOption: decisionValue.get(call.nodeId) ?? null,
        durationMs: call.durationMs,
      }));
    return {
      runId,
      experienceId,
      taskGoal: task?.goal ?? "(task 缺失)",
      requires: task?.requires ?? [],
      runPurpose: run.purpose,
      snapshotId: run.snapshotId,
      result: experience.outcome.result,
      checks: experience.outcome.checks,
      outputDigest: experience.outcome.outputDigest,
      attemptCount: experience.outcome.attemptCount,
      durationMs: experience.outcome.durationMs,
      decisionCalls,
      budget: {
        reservedAttempts: run.budget.maxAttempts,
        reservedSeconds: run.budget.maxWallClockSeconds,
      },
      createdAt: experience.createdAt,
    };
  }
}

export type PromoteOutcome =
  | { result: "promoted"; promotion: PromotionRecord }
  | { result: "already"; promotion: PromotionRecord }
  | { result: "stale"; currentRevision: number };

/** 策略评估计划（m3-policy-eval-v1）：验证集 cases × repeats × 显式门槛 */
export interface PolicyEvaluationPlan {
  cases: Array<{
    task: TaskSubmissionLike;
    /** 期望路由选项（路由准确率分母）；无期望为 null */
    expectedChoice: string | null;
  }>;
  repeats: number;
  thresholds: {
    /** 候选臂成功率绝对门槛 */
    minSuccessRate: number;
    /** 候选臂相对基线臂的最小成功率改善（百分点/100） */
    minImprovement: number;
    /** 候选臂最低有效样本数（Run 数） */
    minSamples: number;
  };
  requestedBy: string;
}

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
  /** LLM 归纳的提议者（mode=llm 时必需；未装配明确报错） */
  routeProposer?: RouteProposer;
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

function assertCapabilityName(name: string): void {
  if (!isCapabilityName(name)) {
    throw new EvolutionError("invalid_capability_name", `能力名称不合法：${name}`);
  }
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
