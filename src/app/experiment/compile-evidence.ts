import { z } from "zod";
import type { Kernel } from "../../kernel/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import type { Evolution } from "../../evolution/index.ts";
import type { Storage } from "../../storage/store.ts";
import { canonicalJson, digestOf, type BlobStore } from "../../storage/blobs.ts";
import { buildCompileReport, compileRecordDigest } from "../../evolution/compile-report.ts";
import type { CompilePlan } from "../../evolution/compile-types.ts";
import {
  parseLlmDemosPolicy,
  parseChoiceResponse,
  validateChoice,
  withLlmDemoParameters,
  type DecisionRequest,
  type DecisionCallUsage,
} from "../../decision/index.ts";
import {
  prepareLlmDemosRequest,
  llmPromptDigest,
  type buildLlmChoiceBody,
} from "../../adapters/decision-llm/request.ts";
import { readExecutionTrace } from "../../runtime/execution-evidence.ts";

export interface CompileEvidenceDeps {
  kernel: Kernel;
  runtime: Pick<Runtime, "getRunSummary">;
  evolution: Pick<Evolution, "experienceDatasetView">;
  storage: Storage;
  blobs: BlobStore;
  organismId: string;
  actorId: string;
}

const tokens = z.number().int().nonnegative().nullable().optional();
const resultFields = {
  provenance: z.strictObject({ provider: z.string(), policyVersion: z.string() }),
  raw: z.string().optional(),
  evidence: z
    .strictObject({
      inputTokens: tokens,
      outputTokens: tokens,
      costAmount: z.number().finite().nonnegative().nullable().optional(),
      costCurrency: z.string().nullable().optional(),
      priceRef: z.string().nullable().optional(),
      servedModel: z.string().nullable().optional(),
    })
    .optional(),
};
const resultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...resultFields, kind: z.literal("value"), value: z.unknown() }),
  z.strictObject({
    ...resultFields,
    kind: z.literal("abstain"),
    reason: z.string(),
    origin: z.enum(["model", "service_refusal"]).optional(),
  }),
  z.strictObject({
    ...resultFields,
    kind: z.literal("invalid_output"),
    detail: z.string(),
    raw: z.string(),
  }),
]);

function equal(actual: unknown, expected: unknown, detail: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected))
    throw new Error(`编译证据不匹配：${detail}`);
}

/**
 * 只读核验开发编译证据。无 Provider/网络调用，无正式标签访问或采用权限。
 * 输出证明本地记录互相一致；远端事实、资料独立性和正式效果仍须后续验证。
 */
export function auditCompileEvidence(deps: CompileEvidenceDeps, jobId: string) {
  return deps.storage.tx(() => {
    deps.kernel.assertOrganismAccess(deps.organismId, deps.actorId);
    const job = deps.storage.getCompileJob(jobId);
    if (!job || job.organismId !== deps.organismId) throw new Error("编译作业不存在或越界");
    if (job.state === "queued" || job.state === "running") throw new Error("编译作业尚未封闭");
    const refs = new Set<string>();
    const readRaw = (ref: string, digest = ref.split("/").at(-1)!): string => {
      const raw = deps.blobs.read(ref);
      if (!/^[a-f0-9]{64}$/.test(digest) || digestOf(raw) !== digest)
        throw new Error("编译证据 blob 摘要漂移");
      refs.add(`blob:${ref}`);
      return raw;
    };
    const read = (ref: string, digest?: string): unknown => JSON.parse(readRaw(ref, digest));
    const versionContent = (id: string) => {
      deps.kernel.assertVersionAccess(id, deps.actorId);
      const version = deps.storage.getArtifactVersion(id)!;
      refs.add(`version:${id}`);
      return read(version.contentRef, version.contentDigest);
    };
    const plan = read(job.planRef, job.planDigest) as CompilePlan;
    if (plan.version !== "policy-compile-v1") throw new Error("不支持的编译证据版本");
    const initial = parseLlmDemosPolicy(plan.initialPolicy);
    const base = deps.kernel.resolveSnapshot(plan.baseSnapshotId);
    for (const version of base.versions.values()) versionContent(version.id);
    equal(
      base.snapshot.bindings["routing-policy"],
      initial.fixed.basePolicy.versionId,
      "基线策略版本",
    );
    equal(
      versionContent(initial.fixed.basePolicy.versionId),
      initial.fixed.basePolicy.content,
      "冻结基线内容",
    );
    equal(
      versionContent(initial.fixed.decisionView.versionId),
      initial.fixed.decisionView.content,
      "冻结视图内容",
    );
    const sourceUsage = { modelCalls: 0, inputTokens: 0, outputTokens: 0 };
    const sourceCosts: Array<DecisionCallUsage | null> = [];
    const sourceIds = new Set<string>();
    for (const c of [...plan.train, ...plan.search]) {
      if (sourceIds.has(c.runId)) throw new Error("来源 Run 重复计量");
      sourceIds.add(c.runId);
      equal(compileRecordDigest(c, digestOf), c.digest, "冻结成员摘要");
      equal(deps.storage.getCompileCase(c.id), c, "来源成员记录");
      const run = deps.storage.getRun(c.runId);
      const task = run && deps.storage.getTask(run.taskId);
      if (
        !run ||
        run.organismId !== deps.organismId ||
        run.purpose !== "normal" ||
        task?.familyId !== c.familyId
      )
        throw new Error("来源 Run/任务归属或用途不匹配");
      const calls = deps.storage.listDecisionCalls(c.runId);
      if (calls.length !== 1 || calls[0]!.id !== c.decisionId)
        throw new Error("来源 Run 存在未纳入冻结预算的额外决策调用");
      const call = calls[0]!;
      equal(
        { kind: call.kind, sent: call.sent, usage: call.usage },
        { kind: c.metering.kind, sent: c.metering.sent, usage: c.metering.usage },
        "来源调用用量",
      );
      equal(
        [call.requestDigest, call.responseDigest, call.policyVersionId, call.snapshotId],
        [c.requestDigest, c.responseDigest, c.policyVersionId, run.snapshotId],
        "来源调用绑定",
      );
      if (!call.requestRef || !call.responseRef) throw new Error("来源请求/响应缺失");
      const request = read(call.requestRef, c.requestDigest) as DecisionRequest;
      const responseRaw = readRaw(call.responseRef, c.responseDigest);
      const fullResponse = resultSchema.safeParse(JSON.parse(responseRaw));
      const response = fullResponse.success
        ? fullResponse.data
        : parseChoiceResponse(responseRaw, request.options);
      if (response.kind !== "value" && response.kind !== "abstain")
        throw new Error("来源不是完整 choice 响应");
      equal(call.state, response.kind === "value" ? "value" : "abstain", "来源响应终态");
      equal(request.view, c.view, "来源视图");
      versionContent(c.policyVersionId);
      const snapshot = deps.kernel.resolveSnapshot(run.snapshotId);
      equal(snapshot.snapshot.bindings["routing-policy"], c.policyVersionId, "来源快照策略");
      equal(call.viewVersionId, snapshot.snapshot.bindings["decision-view"], "来源快照视图");
      for (const version of snapshot.versions.values()) versionContent(version.id);
      equal(
        [call.provenance.policyVersionId, call.provenance.provider],
        [c.policyVersionId, call.provider],
        "来源调用归属",
      );
      // Runtime v1 保存 raw choice 正文，通常没有响应头用量；用量只能与已冻结的 Adapter 账本核对。
      if (fullResponse.success)
        equal(
          fullResponse.data.provenance,
          { provider: call.provider, policyVersion: c.policyVersionId },
          "来源响应归属",
        );
      equal(deps.runtime.getRunSummary(c.runId).attempts, c.metering.executions, "来源执行证据");
      const { dataset, members } = deps.evolution.experienceDatasetView(c.datasetId);
      const member = members.find(
        (item) => item.experienceId === c.experienceId && item.runId === c.runId,
      );
      if (dataset.purpose !== "development" || !member)
        throw new Error("来源开发许可或经验成员缺失");
      equal(
        digestOf(
          canonicalJson({
            dataset: dataset.digest,
            member,
            call,
            taskDigest: c.taskDigest,
            executions: c.metering.executions,
          }),
        ),
        c.sourceDigest,
        "原始来源摘要",
      );
      refs.add(`experience-dataset:${dataset.id}`);
      equal(
        deps.storage.getExperienceByRun(c.runId)?.outcome.durationMs,
        c.metering.durationMs,
        "来源执行时间",
      );
      for (const attempt of c.metering.executions) {
        if (
          !attempt.evidence ||
          !["local-process", "capability/changed-file-summary"].includes(attempt.evidence.executor)
        )
          throw new Error("未知执行器内部开销未纳入核验");
        readExecutionTrace(attempt.evidence, deps.blobs);
        if (attempt.evidence.traceRef) refs.add(`blob:${attempt.evidence.traceRef}`);
        refs.add(`attempt:${attempt.id}`);
      }
      if (call.kind === "model" && call.sent) {
        if (call.usage?.inputTokens == null || call.usage.outputTokens == null)
          throw new Error("来源模型调用 tokens 不完整");
        sourceUsage.modelCalls++;
        sourceUsage.inputTokens += call.usage.inputTokens;
        sourceUsage.outputTokens += call.usage.outputTokens;
        sourceCosts.push(call.usage);
      }
      refs.add(`run:${c.runId}`);
      refs.add(`decision:${c.decisionId}`);
    }
    equal(plan.sourceUsage, sourceUsage, "累计来源预算");
    const trials = deps.storage.compileTrials(jobId);
    if (
      job.state === "completed" &&
      trials.length !== plan.parameterSets.length * plan.search.length
    )
      throw new Error("完成作业缺少计划中的编译调用");
    const learning = deps.storage
      .learningCalls(deps.organismId)
      .filter((call) => call.jobId === jobId);
    if (
      learning.length !== trials.length ||
      new Set(trials.map((trial) => trial.callId)).size !== trials.length
    )
      throw new Error("编译调用账本缺失、重复或有未计量调用");
    for (const [ordinal, trial] of trials.entries()) {
      const configuration = Math.floor(ordinal / plan.search.length);
      const c = plan.search[ordinal % plan.search.length];
      if (
        trial.ordinal !== ordinal ||
        trial.configuration !== configuration ||
        !c ||
        !plan.parameterSets[configuration]
      )
        throw new Error("编译调用顺序或配置越界");
      equal([trial.caseId, trial.familyId], [c.id, c.familyId], "编译 case/family");
      const policy = withLlmDemoParameters(initial, plan.parameterSets[configuration]!);
      equal(versionContent(trial.policyVersionId), policy, "编译策略参数");
      const request = read(trial.requestRef, trial.requestDigest) as DecisionRequest;
      equal(request.policy, { versionId: trial.policyVersionId, content: policy }, "编译请求策略");
      equal(request.view, c.view, "编译请求视图");
      const prepared = prepareLlmDemosRequest(request);
      equal(trial.prepared, prepared, "持久化请求正文");
      equal(request.prepared, prepared, "原始请求正文");
      equal(
        [trial.backendVersion, trial.provenance.adapter, trial.provenance.serviceId ?? null],
        [job.backend?.version, job.backend?.adapter, job.backend?.serviceId],
        "冻结后端",
      );
      equal(trial.provenance.requestedModel, policy.fixed.basePolicy.content.model, "请求模型");
      equal(
        trial.provenance.promptDigest,
        llmPromptDigest(prepared.body as ReturnType<typeof buildLlmChoiceBody>),
        "提示摘要",
      );
      equal(trial.provenance.sampling, policy.fixed.basePolicy.content.sampling, "采样配置");
      const ledger = learning.find((call) => call.id === trial.callId);
      if (!ledger) throw new Error("缺少学习调用账本");
      const usage =
        trial.usage?.inputTokens != null && trial.usage.outputTokens != null
          ? { inputTokens: trial.usage.inputTokens, outputTokens: trial.usage.outputTokens }
          : null;
      equal(
        [ledger.state, ledger.usage, ledger.error, ledger.endedAt],
        [
          trial.state === "prepared"
            ? "reserved"
            : trial.state === "completed"
              ? "completed"
              : "unknown",
          usage,
          trial.error,
          trial.endedAt,
        ],
        "学习调用状态/用量",
      );
      if (trial.state === "started") throw new Error("封闭作业仍有未恢复的 started 调用");
      if (trial.state === "completed") {
        if (!trial.responseRef || !trial.responseDigest) throw new Error("完成调用缺少原始响应");
        const result = resultSchema.parse(read(trial.responseRef, trial.responseDigest));
        equal(
          result.provenance,
          { provider: job.backend?.provider, policyVersion: trial.policyVersionId },
          "编译响应归属",
        );
        const validated = validateChoice(result, request.options);
        const outcome =
          result.kind === "abstain"
            ? result.origin === "model"
              ? "model_abstain"
              : result.origin === "service_refusal"
                ? "service_refusal"
                : "abstain_origin_unavailable"
            : validated.ok
              ? "value"
              : "invalid_output";
        const correct =
          result.kind === "abstain"
            ? c.expectedChoice === "abstain" && result.origin === "model"
            : validated.ok && validated.value === c.expectedChoice;
        equal(
          [trial.outcome, trial.correct, trial.servedModel],
          [outcome, correct, result.evidence?.servedModel ?? null],
          "重算结果与评分",
        );
        equal(
          trial.usage,
          {
            inputTokens: result.evidence?.inputTokens ?? null,
            outputTokens: result.evidence?.outputTokens ?? null,
            costAmount: result.evidence?.costAmount ?? null,
            costCurrency: result.evidence?.costCurrency ?? null,
            priceRef: result.evidence?.priceRef ?? null,
          },
          "原始响应与编译用量",
        );
      } else if (trial.responseRef || trial.responseDigest || trial.usage || trial.correct !== null)
        throw new Error("未完成调用不得提供可评分结果");
      refs.add(`learning-call:${trial.callId}`);
      refs.add(`compile-trial:${trial.id}`);
    }
    const report = buildCompileReport(plan, job, trials, sourceCosts);
    if (job.reportRef) equal(read(job.reportRef), report, "持久化报告与重算报告");
    if (report.winner !== null) {
      const candidate = job.candidateId && deps.storage.getCandidate(job.candidateId);
      if (!candidate || candidate.organismId !== deps.organismId)
        throw new Error("获胜编译缺少所属候选");
      equal(
        [
          candidate.baseSnapshotId,
          candidate.baseRevision,
          candidate.sourceRefs["candidateType"],
          candidate.sourceRefs["compileJobId"],
          candidate.sourceRefs["compilePlanDigest"],
          candidate.sourceRefs["validationSetId"],
          candidate.sourceRefs["policyEvaluationPlanDigest"],
        ],
        [
          plan.baseSnapshotId,
          plan.baseRevision,
          "compiled-policy",
          job.id,
          job.planDigest,
          plan.validationSetId,
          plan.validationPlanDigest,
        ],
        "候选编译来源",
      );
      equal(
        candidate.sourceRefs["evaluatorVersionId"],
        base.snapshot.bindings["acceptance-evaluator"],
        "候选裁判来源",
      );
      const validation = deps.storage.getValidationSet(plan.validationSetId);
      equal(
        [validation?.planDigest, validation?.candidateId],
        [plan.validationPlanDigest, candidate.id],
        "正式计划元数据绑定",
      );
      const proposed = deps.kernel.resolveSnapshot(candidate.proposedSnapshotId);
      equal(
        proposed.snapshot.bindings,
        {
          ...base.snapshot.bindings,
          "routing-policy": proposed.snapshot.bindings["routing-policy"],
        },
        "候选只修改路由策略",
      );
      equal(
        versionContent(proposed.snapshot.bindings["routing-policy"]!),
        withLlmDemoParameters(initial, plan.parameterSets[report.winner]!),
        "候选与获胜参数",
      );
      refs.add(`candidate:${candidate.id}`);
    } else if (job.candidateId !== null) throw new Error("零获胜配置不得绑定候选");
    const result = {
      version: "compile-evidence-audit-v1" as const,
      jobId,
      planDigest: job.planDigest,
      verification: "persisted-development-records" as const,
      declaredMode: job.backend?.mode ?? null,
      remoteExecution: "not-independently-verified" as const,
      usageVerification: {
        compiler: "response-and-learning-ledger",
        source: "frozen-adapter-ledger",
        executors: "persisted-local-execution-evidence",
      } as const,
      candidateBinding: job.candidateId ? ("verified" as const) : ("none" as const),
      sourceRuns: sourceIds.size,
      learningCalls: trials.length,
      evidenceRefs: [...refs].sort(),
      report,
      formalEvaluation: "not_run" as const,
    };
    return { ...result, digest: digestOf(canonicalJson(result)) };
  });
}
