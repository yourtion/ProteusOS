import { z } from "zod";
import type { Clock, IdGen, Kernel } from "../kernel/index.ts";
import type { Storage } from "../storage/store.ts";
import { canonicalJson, digestOf, type BlobStore } from "../storage/blobs.ts";
import {
  assertLlmDemoParametersOnly,
  assertLlmDemoView,
  createLlmDemosPolicy,
  isLlmDemosPolicy,
  parseLlmDemosPolicy,
  parseLlmPolicy,
  validateChoice,
  withLlmDemoParameters,
  type DecisionRequest,
  type DecisionResult,
  type DecisionCallUsage,
  type LlmDemosPolicyContent,
} from "../decision/index.ts";
import type {
  ExperienceDatasetRecord,
  ExperienceMemberView,
  ValidationSetRecord,
  CandidateRecord,
} from "./types.ts";
import type { Runtime, TaskSubmission } from "../runtime/index.ts";
import type {
  CompileBackend,
  CompileBudget,
  CompileCaseRecord,
  CompileJobRecord,
  CompilePlan,
  CompileTrial,
} from "./compile-types.ts";
import { buildCompileReport, compileRecordDigest } from "./compile-report.ts";

const positive = z.number().int().positive();
const budgetSchema = z.strictObject({
  maxCalls: positive.max(512),
  maxInputTokens: positive,
  maxOutputTokens: positive,
  wallClockMs: positive.max(3_600_000),
  callTimeoutMs: positive.max(30_000),
});
interface CompilerDeps {
  kernel: Kernel;
  runtime: Runtime;
  storage: Storage;
  blobs: BlobStore;
  clock: Clock;
  ids: IdGen;
  organismId: string;
  actorId?: string;
  backend?: CompileBackend;
  datasetView(id: string): { dataset: ExperienceDatasetRecord; members: ExperienceMemberView[] };
  validation(id: string): ValidationSetRecord;
  taskDigest(task: TaskSubmission): string;
}
export class CompileError extends Error {}

/** 有界、串行的示例参数搜索。网络在事务外，预留/结果/唯一候选分别原子提交。 */
export class PolicyCompiler {
  private readonly active = new Map<string, AbortController>();
  private readonly deps: CompilerDeps;
  constructor(deps: CompilerDeps) {
    this.deps = deps;
  }

  private actor(actor = this.deps.actorId ?? ""): void {
    this.deps.kernel.assertOrganismAccess(this.deps.organismId, this.deps.actorId ?? actor);
    this.deps.kernel.assertOrganismAccess(this.deps.organismId, actor);
  }
  private event(jobId: string, type: string, payload: Record<string, unknown> = {}) {
    this.deps.storage.appendEvent({
      streamId: `compile-${jobId}`,
      type,
      payload: { jobId, ...payload },
      organismId: this.deps.organismId,
      occurredAt: this.deps.clock.now(),
    });
  }
  job(id: string): CompileJobRecord {
    this.actor();
    return this.ownedJob(id);
  }
  private ownedJob(id: string): CompileJobRecord {
    const record = this.deps.storage.getCompileJob(id);
    if (!record || record.organismId !== this.deps.organismId)
      throw new CompileError("作业不存在或属于其他个体");
    return record;
  }
  private access(plan: CompilePlan, executing = true): void {
    const readers = new Set([
      this.deps.actorId ?? plan.requestedBy,
      ...(executing ? [plan.requestedBy] : []),
    ]);
    const base = this.deps.kernel.getSnapshot(plan.baseSnapshotId);
    if (!base) throw new CompileError("编译基线快照缺失");
    for (const reader of readers) {
      this.actor(reader);
      for (const id of new Set([
        ...Object.values(base.bindings),
        ...plan.train.map((c) => c.policyVersionId),
        ...plan.search.map((c) => c.policyVersionId),
      ]))
        this.deps.kernel.assertVersionAccess(id, reader);
    }
  }
  private source(datasetId: string, runId: string, decisionId: string) {
    const { dataset, members } = this.deps.datasetView(datasetId);
    if (dataset.purpose !== "development") throw new CompileError("仅 development 许可可用于编译");
    const member = members.find((m) => m.runId === runId);
    const run = this.deps.storage.getRun(runId);
    const task = run && this.deps.storage.getTask(run.taskId);
    const call = this.deps.storage.getDecisionCall(decisionId);
    if (
      !member ||
      member.runPurpose !== "normal" ||
      !task?.familyId ||
      !call ||
      call.runId !== runId ||
      !call.requestRef ||
      !call.requestDigest ||
      !call.responseRef ||
      !call.responseDigest
    )
      throw new CompileError("来源缺少 normal 经验、family 或可重放决策证据");
    this.deps.kernel.assertVersionAccess(
      call.policyVersionId,
      this.deps.actorId ?? dataset.createdBy,
    );
    const requestRaw = this.deps.blobs.read(call.requestRef);
    const responseRaw = this.deps.blobs.read(call.responseRef);
    if (
      digestOf(requestRaw) !== call.requestDigest ||
      digestOf(responseRaw) !== call.responseDigest
    )
      throw new CompileError("来源调用摘要漂移");
    const request = JSON.parse(requestRaw) as DecisionRequest;
    const response = JSON.parse(responseRaw) as DecisionResult;
    if (!request.view || request.problem !== "choice" || !["value", "abstain"].includes(call.state))
      throw new CompileError("来源不是完整 choice/模型弃权");
    const taskDigest = this.deps.taskDigest({ ...task, familyId: task.familyId ?? undefined });
    const executions = this.deps.runtime.getRunSummary(runId).attempts;
    if (
      executions.some(
        (a) =>
          a.evidence?.executor !== "local-process" &&
          a.evidence?.executor !== "capability/changed-file-summary",
      )
    )
      throw new CompileError("首轮编译只接受本地确定性执行来源，未知 Agent 内部用量不能隐去");
    const sourceDigest = digestOf(
      canonicalJson({ dataset: dataset.digest, member, call, taskDigest, executions }),
    );
    return { member, task, call, request, response, taskDigest, sourceDigest, executions };
  }

  registerCase(input: {
    datasetId: string;
    runId: string;
    decisionId: string;
    caseId: string;
    split: "train" | "search";
    permission: "synthetic" | "permitted";
    expectedChoice: string;
    verifiedBy: string;
  }): CompileCaseRecord {
    this.actor(input.verifiedBy);
    if (
      !["train", "search"].includes(input.split) ||
      !["synthetic", "permitted"].includes(input.permission) ||
      !input.caseId
    )
      throw new CompileError("用途、许可或 caseId 不合法");
    const source = this.source(input.datasetId, input.runId, input.decisionId);
    if (
      input.expectedChoice !== "abstain" &&
      !source.request.options.includes(input.expectedChoice)
    )
      throw new CompileError("标注不在原选项内");
    if (input.split === "train") {
      const correct =
        input.expectedChoice === "abstain"
          ? source.response.kind === "abstain" && source.response.origin === "model"
          : source.response.kind === "value" &&
            source.response.value === input.expectedChoice &&
            source.member.result === "succeeded" &&
            !!source.task.acceptance.expectedOutput;
      if (!correct)
        throw new CompileError("训练示例需要独立路由标注及完整验收，拒绝服务拒绝或失败选择");
    }
    const record: CompileCaseRecord = {
      id: this.deps.ids.next(),
      organismId: this.deps.organismId,
      datasetId: input.datasetId,
      experienceId: source.member.experienceId,
      runId: input.runId,
      decisionId: input.decisionId,
      policyVersionId: source.call.policyVersionId,
      caseId: input.caseId,
      familyId: source.task.familyId!,
      split: input.split,
      permission: input.permission,
      expectedChoice: input.expectedChoice,
      view: source.request.view!,
      requestDigest: source.call.requestDigest!,
      responseDigest: source.call.responseDigest!,
      taskDigest: source.taskDigest,
      sourceDigest: source.sourceDigest,
      metering: {
        kind: source.call.kind,
        sent: source.call.sent,
        usage: source.call.usage,
        durationMs: source.member.durationMs,
        executions: source.executions,
      },
      verifiedBy: input.verifiedBy,
      createdAt: this.deps.clock.now(),
      digest: "",
    };
    record.digest = compileRecordDigest(record, digestOf);
    return this.deps.storage.tx(() => {
      for (const old of this.deps.storage.compileCases(this.deps.organismId)) {
        if (old.caseId === record.caseId && old.experienceId !== record.experienceId)
          throw new CompileError("caseId 重复");
        const sameView = canonicalJson(old.view) === canonicalJson(record.view);
        if (sameView && old.familyId !== record.familyId)
          throw new CompileError("相同视图不得包装成独立 family");
        if (
          old.split !== record.split &&
          (old.familyId === record.familyId || old.taskDigest === record.taskDigest || sameView)
        )
          throw new CompileError("family 或内容不得跨 train/search 复用");
        if (old.experienceId === record.experienceId) {
          if (
            old.datasetId !== record.datasetId ||
            old.caseId !== record.caseId ||
            old.split !== record.split ||
            old.permission !== record.permission ||
            old.expectedChoice !== record.expectedChoice ||
            old.sourceDigest !== record.sourceDigest
          )
            throw new CompileError("已登记经验不得改标签、用途或来源");
          return old;
        }
      }
      this.deps.storage.insertCompileCase(record);
      this.event(record.id, "compile.case.verified", {
        caseDigest: record.digest,
        verifiedBy: input.verifiedBy,
        split: record.split,
      });
      return record;
    });
  }

  private case(id: string): CompileCaseRecord {
    const record = this.deps.storage.getCompileCase(id);
    if (
      !record ||
      record.organismId !== this.deps.organismId ||
      compileRecordDigest(record, digestOf) !== record.digest
    )
      throw new CompileError("编译成员缺失、越权或摘要漂移");
    const source = this.source(record.datasetId, record.runId, record.decisionId);
    if (record.sourceDigest !== source.sourceDigest || record.taskDigest !== source.taskDigest)
      throw new CompileError("编译来源或输入漂移");
    return record;
  }

  submit(input: {
    trainCaseIds: string[];
    searchCaseIds: string[];
    validationSetId: string;
    parameterSets: string[][];
    budget: CompileBudget;
    thresholds: { minAccuracy: number; minImprovement: number };
    requestedBy: string;
  }): { job: CompileJobRecord; created: boolean } {
    this.actor(input.requestedBy);
    const budget = budgetSchema.parse(input.budget);
    const thresholds = z
      .strictObject({
        minAccuracy: z.number().min(0).max(1),
        minImprovement: z.number().positive().max(1),
      })
      .parse(input.thresholds);
    if (
      !input.trainCaseIds.length ||
      input.trainCaseIds.length > 32 ||
      !input.searchCaseIds.length ||
      input.searchCaseIds.length > 32 ||
      input.parameterSets.length < 2 ||
      input.parameterSets.length > 8 ||
      input.parameterSets[0]?.length !== 0
    )
      throw new CompileError("需要 1–32 个 train、1–32 个 search、2–8 组参数，第一组为空示例基线");
    const records = [...input.trainCaseIds, ...input.searchCaseIds].map((id) => this.case(id));
    if (new Set(records.map((c) => c.id)).size !== records.length)
      throw new CompileError("编译成员重复");
    const train = records.slice(0, input.trainCaseIds.length);
    const search = records.slice(input.trainCaseIds.length);
    if (train.some((c) => c.split !== "train") || search.some((c) => c.split !== "search"))
      throw new CompileError("train/search 用途不符");
    const set = this.deps.validation(input.validationSetId);
    if (records.some((c) => set.familyIds.includes(c.familyId)))
      throw new CompileError("formal/regression 与开发 family 重叠");
    const organism = this.deps.kernel.getOrganism(this.deps.organismId)!;
    if (!organism.activeGenomeId) throw new CompileError("缺少基线快照");
    const { snapshot, versions } = this.deps.kernel.resolveSnapshot(organism.activeGenomeId);
    const base = versions.get("routing-policy")!;
    const view = versions.get("decision-view");
    if (!base || !view) throw new CompileError("基线缺少策略/视图绑定");
    this.deps.kernel.assertVersionAccess(base.id, input.requestedBy);
    this.deps.kernel.assertVersionAccess(view.id, input.requestedBy);
    for (const v of versions.values()) {
      this.deps.kernel.assertVersionAccess(v.id, input.requestedBy);
      this.deps.kernel.assertVersionAccess(v.id, this.deps.actorId ?? input.requestedBy);
    }
    const rawBase = JSON.parse(this.deps.blobs.read(base.contentRef));
    // 本切片从固定 v1 基线编译；重复编译须显式重新冻结开发实验。
    if (!parseLlmPolicy(rawBase) || isLlmDemosPolicy(rawBase))
      throw new CompileError("首轮编译需要 llm-choice-v1 基线");
    const graph = JSON.parse(this.deps.blobs.read(versions.get("task-graph")!.contentRef));
    const decisions = graph.nodes?.filter((n: { type: string }) => n.type === "decision");
    if (
      decisions?.length !== 1 ||
      decisions[0].problem !== "choice" ||
      decisions[0].provider !== "decision-llm"
    )
      throw new CompileError("首轮仅支持单一 decision-llm choice 图");
    const initialPolicy = createLlmDemosPolicy({
      basePolicy: { versionId: base.id, contentDigest: base.contentDigest, content: rawBase },
      decisionView: {
        versionId: view.id,
        contentDigest: view.contentDigest,
        content: JSON.parse(this.deps.blobs.read(view.contentRef)),
      },
      options: decisions[0].options,
      demonstrations: train.map((c) => {
        const { response } = this.source(c.datasetId, c.runId, c.decisionId);
        const normalized =
          response.kind === "value"
            ? { kind: "value" as const, value: String(response.value) }
            : {
                kind: "abstain" as const,
                reason: response.kind === "abstain" ? response.reason : "",
              };
        return {
          id: c.id,
          view: c.view,
          response: normalized,
          source: {
            purpose: "development",
            split: "train",
            permission: c.permission,
            datasetId: c.datasetId,
            caseId: c.caseId,
            familyId: c.familyId,
            runId: c.runId,
            decisionId: c.decisionId,
            verificationRef: c.id,
            viewDigest: digestOf(canonicalJson(c.view)),
            responseDigest: digestOf(canonicalJson(normalized)),
          },
        };
      }),
      demoIds: [],
    });
    for (const c of search) {
      assertLlmDemoView(initialPolicy, c.view);
      if (c.expectedChoice !== "abstain" && !initialPolicy.fixed.options.includes(c.expectedChoice))
        throw new CompileError("search 标签不属于冻结选项");
    }
    for (const parameters of input.parameterSets)
      assertLlmDemoParametersOnly(initialPolicy, withLlmDemoParameters(initialPolicy, parameters));
    if (new Set(input.parameterSets.map(canonicalJson)).size !== input.parameterSets.length)
      throw new CompileError("参数配置重复");
    // 旧来源的调用也分配到本轮编译总成本；用量不可知时不假装满足 token 硬预算。
    const sourceUsage = { modelCalls: 0, inputTokens: 0, outputTokens: 0 };
    for (const c of records) {
      const call = this.deps.storage.getDecisionCall(c.decisionId)!;
      if (call.kind !== "model" || !call.sent) continue;
      if (!validTokens(call.usage?.inputTokens) || !validTokens(call.usage?.outputTokens))
        throw new CompileError("来源 token 用量未知，不能冻结累计硬上限");
      sourceUsage.modelCalls++;
      sourceUsage.inputTokens += call.usage.inputTokens;
      sourceUsage.outputTokens += call.usage.outputTokens;
    }
    if (
      sourceUsage.modelCalls + search.length * input.parameterSets.length > budget.maxCalls ||
      sourceUsage.inputTokens > budget.maxInputTokens ||
      sourceUsage.outputTokens > budget.maxOutputTokens
    )
      throw new CompileError("计划或来源开销超过编译总预算");
    const plan: CompilePlan = {
      version: "policy-compile-v1",
      baseSnapshotId: snapshot.id,
      baseRevision: organism.revision,
      validationSetId: set.id,
      validationPlanDigest: set.planDigest!,
      train,
      search,
      initialPolicy,
      parameterSets: input.parameterSets,
      budget,
      thresholds,
      requestedBy: input.requestedBy,
      sourceUsage,
    };
    const planRaw = canonicalJson(plan);
    const planDigest = digestOf(planRaw);
    return this.deps.storage.tx(() => {
      const old = this.deps.storage
        .compileJobs(this.deps.organismId)
        .find((j) => j.planDigest === planDigest);
      if (old) return { job: old, created: false };
      if (set.candidateId) throw new CompileError("正式计划已绑定其他候选");
      const job: CompileJobRecord = {
        id: this.deps.ids.next(),
        organismId: this.deps.organismId,
        planDigest,
        planRef: this.deps.blobs.write(planRaw).ref,
        backend: null,
        state: "queued",
        cancelRequested: false,
        candidateId: null,
        reportRef: null,
        error: null,
        requestedBy: input.requestedBy,
        createdAt: this.deps.clock.now(),
        startedAt: null,
        deadlineAt: null,
      };
      this.deps.storage.insertCompileJob(job);
      this.event(job.id, "compile.submitted", { planDigest });
      return { job, created: true };
    });
  }

  private frozenPlan(job: CompileJobRecord): CompilePlan {
    const raw = this.deps.blobs.read(job.planRef);
    if (digestOf(raw) !== job.planDigest) throw new CompileError("编译清单摘要漂移");
    const plan = JSON.parse(raw) as CompilePlan;
    return plan;
  }
  private plan(job: CompileJobRecord): CompilePlan {
    const plan = this.frozenPlan(job);
    this.access(plan);
    for (const c of [...plan.train, ...plan.search])
      if (this.case(c.id).digest !== c.digest) throw new CompileError("冻结编译成员漂移");
    parseLlmDemosPolicy(plan.initialPolicy);
    const set = this.deps.validation(plan.validationSetId);
    if (set.candidateId && set.candidateId !== job.candidateId)
      throw new CompileError("正式计划已绑定其他候选");
    if (set.planDigest !== plan.validationPlanDigest) throw new CompileError("正式计划已变更");
    const organism = this.deps.kernel.getOrganism(this.deps.organismId)!;
    if (organism.activeGenomeId !== plan.baseSnapshotId || organism.revision !== plan.baseRevision)
      throw new CompileError("基线已变更，作业 stale");
    return plan;
  }

  report(id: string) {
    const job = this.job(id);
    this.access(this.frozenPlan(job), false);
    return this.makeReport(id);
  }
  private makeReport(id: string) {
    const job = this.ownedJob(id);
    const raw = this.deps.blobs.read(job.planRef);
    if (digestOf(raw) !== job.planDigest) throw new CompileError("编译清单摘要漂移");
    const plan = JSON.parse(raw) as CompilePlan;
    return buildCompileReport(
      plan,
      job,
      this.deps.storage.compileTrials(id),
      [...plan.train, ...plan.search].flatMap((c) =>
        c.metering.kind === "model" && c.metering.sent ? [c.metering.usage] : [],
      ),
    );
  }

  cancel(id: string): CompileJobRecord {
    const job = this.job(id);
    this.deps.storage.tx(() => {
      const current = this.ownedJob(id);
      if (current.state !== "queued" && current.state !== "running") return;
      current.cancelRequested = true;
      if (current.state === "queued") current.state = "cancelled";
      this.deps.storage.updateCompileJob(current);
      this.event(id, "compile.cancel_requested");
    });
    this.active.get(id)?.abort(new CompileError("编译已取消"));
    if (job.state === "queued") this.saveReport(id);
    return this.job(id);
  }

  async run(id: string): Promise<CompileJobRecord> {
    const backend = this.deps.backend;
    this.actor();
    const claimed = this.deps.storage.tx(() => {
      const job = this.ownedJob(id);
      if (job.state !== "queued") return false;
      const plan = this.frozenPlan(job);
      job.state = "running";
      job.startedAt ??= this.deps.clock.now();
      job.deadlineAt ??= job.startedAt + plan.budget.wallClockMs;
      this.deps.storage.updateCompileJob(job);
      return true;
    });
    if (!claimed) return this.job(id);
    const abort = new AbortController();
    this.active.set(id, abort);
    try {
      if (
        !backend ||
        !["fixture", "real"].includes(backend.mode) ||
        !backend.version ||
        backend.provider.name !== "decision-llm" ||
        !backend.provider.capabilities().problems.includes("choice") ||
        backend.provider.remote !== true ||
        !backend.provider.prepareRequest ||
        !backend.provider.callProvenance
      )
        throw new CompileError("需要受信编译后端、完整请求与可核验 token 上界");
      let job = this.ownedJob(id);
      const plan = this.plan(job);
      for (let configuration = 0; configuration < plan.parameterSets.length; configuration++) {
        for (let caseIndex = 0; caseIndex < plan.search.length; caseIndex++) {
          job = this.ownedJob(id);
          if (job.cancelRequested || abort.signal.aborted) throw new CompileError("编译已取消");
          if (this.deps.clock.now() >= job.deadlineAt!) throw new CompileError("编译截止点已到");
          this.plan(job);
          const ordinal = configuration * plan.search.length + caseIndex;
          let trial = this.deps.storage.compileTrials(id).find((t) => t.ordinal === ordinal);
          if (trial?.state === "completed") continue;
          if (trial && trial.state !== "prepared") throw new CompileError("调用结果不明，禁止重发");
          const c = plan.search[caseIndex]!;
          const policy = withLlmDemoParameters(
            plan.initialPolicy,
            plan.parameterSets[configuration]!,
          );
          const version = this.policyVersion(plan, policy);
          const request: DecisionRequest = {
            problem: "choice",
            options: policy.fixed.options,
            context: {},
            policy: { versionId: version.id, content: policy },
            view: c.view,
            viewSource: {
              versionId: policy.fixed.decisionView.versionId,
              contentDigest: policy.fixed.decisionView.contentDigest,
            },
            deadlineMs: Math.min(
              plan.budget.callTimeoutMs,
              job.deadlineAt! - this.deps.clock.now(),
            ),
            remainingAttempts: 0,
          };
          request.prepared = backend.provider.prepareRequest(request);
          const provenance = backend.provider.callProvenance(request);
          const bounds = backend.bounds(request);
          if (
            !request.prepared ||
            !bounds ||
            !validTokens(bounds.inputTokens) ||
            !validTokens(bounds.outputTokens) ||
            bounds.outputTokens < policy.fixed.basePolicy.content.sampling.maxOutputTokens
          )
            throw new CompileError("token 上界不可核验，未发送请求");
          const identity = {
            mode: backend.mode,
            version: backend.version,
            provider: backend.provider.name,
            adapter: provenance.adapter,
            serviceId: provenance.serviceId ?? null,
          };
          if (job.backend && canonicalJson(job.backend) !== canonicalJson(identity))
            throw new CompileError("编译后端或端点漂移");
          if (trial) {
            if (
              trial.backendVersion !== backend.version ||
              canonicalJson(trial.prepared) !== canonicalJson(request.prepared) ||
              canonicalJson(trial.provenance) !== canonicalJson(provenance) ||
              canonicalJson(trial.reservation) !== canonicalJson(bounds)
            )
              throw new CompileError("恢复时请求、端点或预算边界漂移");
          } else
            trial = this.reserve(job, plan, {
              ordinal,
              configuration,
              c,
              request,
              provenance,
              bounds,
              backendVersion: backend.version,
            });
          request.prepared = trial.prepared;
          await this.invoke(job, plan, trial, request, abort);
        }
      }
      this.finish(id);
    } catch (error) {
      this.deps.storage.tx(() => {
        const job = this.ownedJob(id);
        job.state = job.cancelRequested ? "cancelled" : "failed";
        job.error = error instanceof Error ? error.message : String(error);
        this.deps.storage.updateCompileJob(job);
        this.event(id, "compile.stopped", { state: job.state, error: job.error });
      });
      this.saveReport(id);
    } finally {
      this.active.delete(id);
    }
    return this.job(id);
  }

  private policyVersion(plan: CompilePlan, content: LlmDemosPolicyContent) {
    assertLlmDemoParametersOnly(plan.initialPolicy, content);
    const base = this.deps.storage.getArtifactVersion(
      plan.initialPolicy.fixed.basePolicy.versionId,
    )!;
    const blob = this.deps.blobs.write(canonicalJson(content));
    return this.deps.kernel.registerVersion({
      artifact: this.deps.storage.getArtifact(base.artifactId)!,
      schemaVersion: 1,
      contentRef: blob.ref,
      contentDigest: blob.digest,
      parents: [base.id],
      dependencies: [base.id, content.fixed.decisionView.versionId],
      createdBy: plan.requestedBy,
      scope: `organism:${this.deps.organismId}`,
    });
  }

  private reserve(
    job: CompileJobRecord,
    plan: CompilePlan,
    args: {
      ordinal: number;
      configuration: number;
      c: CompileCaseRecord;
      request: DecisionRequest;
      provenance: CompileTrial["provenance"];
      bounds: CompileTrial["reservation"];
      backendVersion: string;
    },
  ): CompileTrial {
    return this.deps.storage.tx(() => {
      this.access(plan);
      if (this.ownedJob(job.id).cancelRequested) throw new CompileError("编译已取消");
      const current = this.ownedJob(job.id);
      const identity = {
        mode: this.deps.backend!.mode,
        version: args.backendVersion,
        provider: this.deps.backend!.provider.name,
        adapter: args.provenance.adapter,
        serviceId: args.provenance.serviceId ?? null,
      };
      if (current.backend && canonicalJson(current.backend) !== canonicalJson(identity))
        throw new CompileError("编译后端或端点漂移");
      if (!current.backend) {
        current.backend = identity;
        this.deps.storage.updateCompileJob(current);
      }
      const trials = this.deps.storage.compileTrials(job.id);
      if (
        this.deps.storage.learningCalls(this.deps.organismId).length >=
        this.deps.storage.learningCallLimit(this.deps.organismId)
      )
        throw new CompileError("累计学习调用额度耗尽");
      if (
        plan.sourceUsage.modelCalls + trials.length + 1 > plan.budget.maxCalls ||
        plan.sourceUsage.inputTokens +
          trials.reduce((n, t) => n + t.reservation.inputTokens, 0) +
          args.bounds.inputTokens >
          plan.budget.maxInputTokens ||
        plan.sourceUsage.outputTokens +
          trials.reduce((n, t) => n + t.reservation.outputTokens, 0) +
          args.bounds.outputTokens >
          plan.budget.maxOutputTokens
      )
        throw new CompileError("编译累计预算耗尽");
      const requestRaw = canonicalJson({ ...args.request, signal: undefined });
      const now = this.deps.clock.now();
      const trial: CompileTrial = {
        id: this.deps.ids.next(),
        jobId: job.id,
        ordinal: args.ordinal,
        configuration: args.configuration,
        caseId: args.c.id,
        familyId: args.c.familyId,
        policyVersionId: args.request.policy.versionId,
        callId: this.deps.ids.next(),
        requestRef: this.deps.blobs.write(requestRaw).ref,
        requestDigest: digestOf(requestRaw),
        prepared: args.request.prepared!,
        backendVersion: args.backendVersion,
        provenance: args.provenance,
        reservation: args.bounds,
        state: "prepared",
        responseRef: null,
        responseDigest: null,
        servedModel: null,
        outcome: null,
        correct: null,
        usage: null,
        error: null,
        startedAt: null,
        endedAt: null,
      };
      this.deps.storage.insertLearningCall({
        id: trial.callId,
        organismId: this.deps.organismId,
        jobId: job.id,
        state: "reserved",
        usage: null,
        error: null,
        createdAt: now,
        endedAt: null,
      });
      this.deps.storage.insertCompileTrial(trial);
      this.event(job.id, "compile.trial.prepared", { trialId: trial.id, callId: trial.callId });
      return trial;
    });
  }

  private async invoke(
    job: CompileJobRecord,
    plan: CompilePlan,
    trial: CompileTrial,
    request: DecisionRequest,
    abort: AbortController,
  ): Promise<void> {
    const backend = this.deps.backend!;
    const raw = this.deps.blobs.read(trial.requestRef);
    if (digestOf(raw) !== trial.requestDigest) throw new CompileError("调用请求摘要漂移");
    const saved = JSON.parse(raw) as DecisionRequest;
    if (
      canonicalJson(saved.prepared) !== canonicalJson(trial.prepared) ||
      canonicalJson(saved.policy) !== canonicalJson(request.policy) ||
      canonicalJson(saved.view) !== canonicalJson(request.view) ||
      canonicalJson(saved.viewSource) !== canonicalJson(request.viewSource) ||
      canonicalJson(saved.options) !== canonicalJson(request.options)
    )
      throw new CompileError("已保存请求与恢复内容不一致");
    this.deps.storage.tx(() => {
      this.access(plan);
      if (this.ownedJob(job.id).cancelRequested || this.deps.clock.now() >= job.deadlineAt!)
        throw new CompileError("编译取消或已到截止点");
      trial.state = "started";
      trial.startedAt = this.deps.clock.now();
      this.deps.storage.updateCompileTrial(trial);
      this.event(job.id, "compile.trial.started", { trialId: trial.id });
    });
    request.signal = abort.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(abort.signal.reason ?? new CompileError("编译已取消"));
      abort.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          abort.abort(new CompileError("编译调用超时"));
          reject(new CompileError("编译调用超时"));
        },
        Math.max(1, Math.min(plan.budget.callTimeoutMs, job.deadlineAt! - this.deps.clock.now())),
      );
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          if (abort.signal.aborted) throw abort.signal.reason;
          return backend.provider.decide(request);
        }),
        timeout,
        cancelled,
      ]);
      const validated = validateChoice(result, request.options);
      const c = plan.search.find((c) => c.id === trial.caseId)!;
      trial.correct =
        result.kind === "abstain"
          ? c.expectedChoice === "abstain" && result.origin === "model"
          : validated.ok && validated.value === c.expectedChoice;
      trial.outcome =
        result.kind === "abstain"
          ? result.origin === "model"
            ? "model_abstain"
            : result.origin === "service_refusal"
              ? "service_refusal"
              : "abstain_origin_unavailable"
          : validated.ok
            ? "value"
            : "invalid_output";
      const response = this.deps.blobs.write(canonicalJson(result));
      trial.responseRef = response.ref;
      trial.responseDigest = response.digest;
      trial.servedModel = result.evidence?.servedModel ?? null;
      trial.usage = usageOf(result);
      if (
        (trial.usage.inputTokens !== null &&
          trial.usage.inputTokens > trial.reservation.inputTokens) ||
        (trial.usage.outputTokens !== null &&
          trial.usage.outputTokens > trial.reservation.outputTokens)
      )
        trial.error = "受信后端违反 token 上界";
      trial.state = "completed";
    } catch (error) {
      trial.error = error instanceof Error ? error.message : String(error);
      trial.state = "unknown";
      trial.outcome = this.ownedJob(job.id).cancelRequested
        ? "cancelled"
        : abort.signal.aborted
          ? "timeout"
          : "transport_error";
      trial.correct = null;
    } finally {
      if (timer) clearTimeout(timer);
      if (rejectAbort) abort.signal.removeEventListener("abort", rejectAbort);
      trial.endedAt = this.deps.clock.now();
      this.deps.storage.tx(() => {
        this.deps.storage.updateCompileTrial(trial);
        this.deps.storage.finishLearningCall(
          trial.callId,
          trial.state === "completed" ? "completed" : "unknown",
          trial.usage?.inputTokens != null && trial.usage.outputTokens != null
            ? { inputTokens: trial.usage.inputTokens, outputTokens: trial.usage.outputTokens }
            : null,
          trial.error,
          trial.endedAt!,
        );
        this.event(job.id, "compile.trial.finished", {
          trialId: trial.id,
          state: trial.state,
          outcome: trial.outcome,
        });
      });
    }
    if (trial.state === "unknown" || trial.error)
      throw new CompileError(trial.error ?? "调用结果未知");
  }

  private finish(id: string): void {
    const job = this.ownedJob(id);
    const plan = this.plan(job);
    const report = this.makeReport(id);
    this.deps.storage.tx(() => {
      const current = this.ownedJob(id);
      if (current.cancelRequested || this.deps.clock.now() >= current.deadlineAt!)
        throw new CompileError("编译取消或截止，不生成候选");
      this.plan(current);
      if (report.winner !== null) {
        const content = withLlmDemoParameters(
          plan.initialPolicy,
          plan.parameterSets[report.winner]!,
        );
        const version = this.policyVersion(plan, content);
        const base = this.deps.kernel.getSnapshot(plan.baseSnapshotId)!;
        const snapshot = this.deps.kernel.createSnapshot(
          { ...base.bindings, "routing-policy": version.id },
          plan.requestedBy,
        );
        const set = this.deps.validation(plan.validationSetId);
        if (set.candidateId) throw new CompileError("正式验证计划已绑定其他候选");
        const candidate: CandidateRecord = {
          id: this.deps.ids.next(),
          organismId: this.deps.organismId,
          baseSnapshotId: plan.baseSnapshotId,
          baseRevision: plan.baseRevision,
          proposedSnapshotId: snapshot.id,
          hypothesis: `冻结示例搜索在开发 family 上提高路由准确率；正式效果未评估`,
          proposedBy: plan.requestedBy,
          sourceRefs: {
            candidateType: "compiled-policy",
            compileJobId: id,
            compilePlanDigest: job.planDigest,
            validationSetId: set.id,
            policyEvaluationPlanDigest: plan.validationPlanDigest,
            evaluatorVersionId: base.bindings["acceptance-evaluator"]!,
          },
          datasetRef: plan.train[0]!.datasetId,
          createdAt: this.deps.clock.now(),
        };
        this.deps.storage.insertCandidate(candidate);
        this.deps.storage.updateValidationSet(set.id, {
          candidateId: candidate.id,
          updatedAt: this.deps.clock.now(),
        });
        this.deps.storage.appendEvent({
          streamId: `candidate-${candidate.id}`,
          type: "candidate.proposed",
          payload: {
            candidateId: candidate.id,
            candidateType: "compiled-policy",
            compileJobId: id,
          },
          organismId: this.deps.organismId,
          occurredAt: this.deps.clock.now(),
        });
        current.candidateId = candidate.id;
      }
      current.state = "completed";
      this.deps.storage.updateCompileJob(current);
      this.event(id, "compile.completed", { candidateId: current.candidateId });
      this.saveReport(id);
    });
  }

  private saveReport(id: string): void {
    const job = this.ownedJob(id);
    job.reportRef = this.deps.blobs.write(canonicalJson(this.makeReport(id))).ref;
    this.deps.storage.updateCompileJob(job);
  }

  /** 须先停止其他进程；当前进程有活跃作业时拒绝 operator 恢复。 */
  recover(): CompileJobRecord[] {
    this.actor();
    return this.deps.storage.tx(() =>
      this.deps.storage
        .compileJobs(this.deps.organismId)
        .filter((j) => j.state === "running")
        .map((job) => {
          if (this.active.has(job.id)) throw new CompileError("先停止活跃编译 worker 再恢复");
          const trials = this.deps.storage.compileTrials(job.id);
          const uncertain = trials.some((t) => t.state === "started" || t.state === "unknown");
          for (const trial of trials.filter((t) => t.state === "started")) {
            trial.state = "unknown";
            trial.outcome = "unknown";
            trial.error = "编译进程中断，不自动重发";
            trial.endedAt = this.deps.clock.now();
            this.deps.storage.updateCompileTrial(trial);
            this.deps.storage.finishLearningCall(
              trial.callId,
              "unknown",
              null,
              trial.error,
              trial.endedAt,
            );
          }
          job.state = job.cancelRequested ? "cancelled" : uncertain ? "failed" : "queued";
          job.error = uncertain ? "编译进程中断，不自动重发；未知调用保留额度" : null;
          this.deps.storage.updateCompileJob(job);
          this.saveReport(job.id);
          return job;
        }),
    );
  }
}

function validTokens(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function usageOf(result: DecisionResult): DecisionCallUsage {
  const u = result.evidence;
  return {
    inputTokens: validTokens(u?.inputTokens) ? u.inputTokens : null,
    outputTokens: validTokens(u?.outputTokens) ? u.outputTokens : null,
    costAmount:
      typeof u?.costAmount === "number" && Number.isFinite(u.costAmount) && u.costAmount >= 0
        ? u.costAmount
        : null,
    costCurrency: u?.costCurrency ?? null,
    priceRef: u?.priceRef ?? null,
  };
}
