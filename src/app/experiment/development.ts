import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { evaluationPlanDigest } from "../../evolution/index.ts";
import type { CompilePlan } from "../../evolution/compile-types.ts";
import type { TaskRecord } from "../../runtime/types.ts";
import { canonicalJson, digestOf } from "../../storage/blobs.ts";
import { auditCompileEvidence, type CompileEvidenceDeps } from "./compile-evidence.ts";
import {
  freezeAdaptivePlan,
  reportAdaptiveExperiment,
  type AdaptiveObservation,
  type FrozenAdaptivePlan,
} from "./adaptive.ts";
import type { CompileDevelopmentBundle, CompileDevelopmentRecord } from "./development-types.ts";

/** 与 Runtime 的 inputs/<basename> 布局一致；只接受有界 UTF-8 普通文件树。 */
export function captureTaskProjection(task: Pick<TaskRecord, "goal" | "inputs" | "acceptance">) {
  const inputs: Array<{ name: string; content: string }> = [];
  let bytes = 0;
  const roots = new Set<string>();
  const privateFiles = new Set(
    [task.acceptance.outputSchema, task.acceptance.expectedOutput]
      .filter((path): path is string => !!path)
      .map((path) => {
        const stat = statSync(path);
        return `${stat.dev}:${stat.ino}`;
      }),
  );
  const visit = (path: string, name: string): void => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      const names = readdirSync(path).sort();
      if (!names.length) throw new Error("开发任务投影暂不支持空目录");
      for (const child of names) visit(join(path, child), posix.join(name, child));
    } else if (stat.isFile()) {
      if (privateFiles.has(`${stat.dev}:${stat.ino}`))
        throw new Error("裁判或期望输出文件不能进入任务输入投影");
      if (stat.size > 4 * 1024 * 1024 - bytes || inputs.length >= 512)
        throw new Error("开发任务输入超过 4 MiB / 512 文件上限");
      const raw = readFileSync(path);
      const content = raw.toString("utf8");
      if (!Buffer.from(content, "utf8").equals(raw))
        throw new Error("开发任务输入不是完整 UTF-8 文本");
      bytes += raw.length;
      if (bytes > 4 * 1024 * 1024) throw new Error("开发任务输入超额");
      inputs.push({ name, content });
    } else throw new Error("开发任务输入不支持符号链接或特殊文件");
  };
  for (const path of task.inputs) {
    const root = basename(path);
    if (!root || root === "." || root === ".." || root.includes("\\"))
      throw new Error("开发输入根名称不合法");
    if (roots.has(root)) throw new Error("开发任务输入根名称冲突");
    roots.add(root);
    visit(path, root);
  }
  inputs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { goal: task.goal, inputs };
}

function sourceFingerprint(task: TaskRecord): string {
  return evaluationPlanDigest({
    newCapability: task,
    regression: task,
    requestedBy: task.requestedBy,
  });
}

const unknownUsage: AdaptiveObservation["usage"] = {
  modelCalls: null,
  inputTokens: null,
  outputTokens: null,
  costAmount: null,
  costCurrency: null,
  priceRef: null,
};

function readBundle(
  deps: CompileEvidenceDeps,
  record: CompileDevelopmentRecord,
  audit: ReturnType<typeof auditCompileEvidence>,
) {
  if (record.organismId !== deps.organismId) throw new Error("开发证据属于其他个体");
  const raw = deps.blobs.read(record.ref);
  if (digestOf(raw) !== record.digest) throw new Error("开发证据包摘要漂移");
  const bundle = JSON.parse(raw) as CompileDevelopmentBundle;
  if (
    bundle.version !== "compile-development-v1" ||
    bundle.jobId !== record.jobId ||
    bundle.auditDigest !== audit.digest
  )
    throw new Error("开发证据包与核验结果不匹配");
  return {
    record,
    bundle,
    versionIds: audit.evidenceRefs
      .filter((ref) => ref.startsWith("version:"))
      .map((ref) => ref.slice("version:".length)),
  };
}

/** 首次读取原始开发资料并冻结；此后使用原包，不依赖工作区或外部输入文件。 */
export function prepareCompileDevelopment(deps: CompileEvidenceDeps, jobId: string) {
  const audit = auditCompileEvidence(deps, jobId);
  const existing = deps.storage.compileDevelopmentBundle(jobId);
  if (existing) return readBundle(deps, existing, audit);
  const job = deps.storage.getCompileJob(jobId)!;
  const planRaw = deps.blobs.read(job.planRef);
  if (digestOf(planRaw) !== job.planDigest) throw new Error("编译清单摘要漂移");
  const plan = JSON.parse(planRaw) as CompilePlan;
  const base = deps.kernel.resolveSnapshot(plan.baseSnapshotId);
  const candidate = job.candidateId ? deps.storage.getCandidate(job.candidateId)! : null;
  const candidateVersion = candidate
    ? deps.kernel.resolveSnapshot(candidate.proposedSnapshotId).versions.get("routing-policy")!
    : null;
  const bundle: CompileDevelopmentBundle = {
    version: "compile-development-v1",
    jobId,
    auditDigest: audit.digest,
    mode: audit.declaredMode,
    sourceModeVerification: "unavailable",
    source: [...plan.train, ...plan.search].some((c) => c.permission === "permitted")
      ? "permitted"
      : "synthetic",
    candidateId: job.candidateId,
    policies: {
      baseDigest: plan.initialPolicy.fixed.basePolicy.contentDigest,
      candidateDigest: candidateVersion?.contentDigest ?? null,
    },
    fixed: {
      model: plan.initialPolicy.fixed.basePolicy.content.model,
      viewDigest: plan.initialPolicy.fixed.decisionView.contentDigest,
      instructionDigest: digestOf(plan.initialPolicy.fixed.basePolicy.content.promptTemplate),
      schemaDigest: plan.initialPolicy.fixed.responseSchemaDigest,
      graphDigest: base.versions.get("task-graph")!.contentDigest,
      judgeDigest: base.versions.get("acceptance-evaluator")!.contentDigest,
      adapterDigest: digestOf(canonicalJson(job.backend)),
    },
    cases: [],
    tasks: [],
    development: [],
    observations: [],
    unknownBoundUnits: [],
  };
  const add = (
    caseId: string,
    row: Omit<AdaptiveObservation, "manifestDigest">,
    allowance: CompileDevelopmentBundle["development"][number]["allowance"],
  ) => {
    bundle.development.push({ id: row.unitId, caseId, allowance });
    bundle.observations.push(row);
  };
  for (const c of [...plan.train, ...plan.search]) {
    const run = deps.storage.getRun(c.runId)!;
    const task = deps.storage.getTask(run.taskId)!;
    const projected = captureTaskProjection(task);
    if (sourceFingerprint(task) !== c.taskDigest) throw new Error("开发任务输入或裁判资料已漂移");
    const evaluatorDigest = digestOf(
      canonicalJson({
        verifier: task.acceptance.verifier,
        outputSchemaDigest: digestOf(readFileSync(task.acceptance.outputSchema, "utf8")),
        expectedOutputDigest: task.acceptance.expectedOutput
          ? digestOf(readFileSync(task.acceptance.expectedOutput, "utf8"))
          : null,
      }),
    );
    if (
      sourceFingerprint(task) !== c.taskDigest ||
      canonicalJson(captureTaskProjection(task)) !== canonicalJson(projected)
    )
      throw new Error("开发资料在冻结期间发生变化");
    bundle.cases.push({
      id: c.caseId,
      familyId: c.familyId,
      split: c.split,
      taskDigest: digestOf(canonicalJson(projected)),
      evaluatorDigest,
      critical: false,
    });
    bundle.tasks.push({ caseId: c.caseId, sourceFingerprint: c.taskDigest, task: projected });
    const call = deps.storage.getDecisionCall(c.decisionId)!;
    const modelCalls = call.kind === "model" && call.sent ? 1 : 0;
    const usage = call.usage;
    const response = JSON.parse(deps.blobs.read(call.responseRef!)) as { origin?: string };
    const row: Omit<AdaptiveObservation, "manifestDigest"> = {
      unitId: `compile-source:${c.id}`,
      source: bundle.mode ?? "fixture",
      startedAt: run.createdAt,
      endedAt: run.createdAt + c.metering.durationMs,
      state:
        run.state === "succeeded"
          ? "succeeded"
          : run.state === "cancelled"
            ? "cancelled"
            : "failed",
      accepted: null,
      decision:
        call.state === "value"
          ? "value"
          : response.origin === "model"
            ? "model_abstain"
            : response.origin === "service_refusal"
              ? "service_refusal"
              : "abstain_origin_unavailable",
      misrouted: null,
      evidenceRefs: [`run:${run.id}`, `decision:${call.id}`],
      usage: {
        modelCalls,
        inputTokens: modelCalls ? usage!.inputTokens : 0,
        outputTokens: modelCalls ? usage!.outputTokens : 0,
        costAmount: usage?.costAmount ?? null,
        costCurrency: usage?.costCurrency ?? null,
        priceRef: usage?.priceRef ?? null,
      },
    };
    add(c.caseId, row, {
      modelCalls,
      inputTokens: row.usage.inputTokens!,
      outputTokens: row.usage.outputTokens!,
      durationMs: Math.max(1, c.metering.durationMs),
    });
    const attempts = deps.storage
      .listProcesses(run.id)
      .flatMap((p) => deps.storage.listAttempts(p.id));
    for (const attempt of attempts) {
      const evidence = c.metering.executions.find((a) => a.id === attempt.id)!.evidence!;
      if (attempt.startedAt === null || attempt.endedAt === null)
        throw new Error("来源 Attempt 缺少完整时间");
      const id = `compile-execution:${attempt.id}`;
      bundle.unknownBoundUnits.push(id);
      add(
        c.caseId,
        {
          unitId: id,
          source: row.source,
          startedAt: attempt.startedAt,
          endedAt: attempt.endedAt,
          state:
            attempt.state === "succeeded"
              ? "succeeded"
              : attempt.state === "cancelled"
                ? "cancelled"
                : attempt.state === "unknown"
                  ? "unknown"
                  : "failed",
          accepted: null,
          decision: null,
          misrouted: null,
          evidenceRefs: [`attempt:${attempt.id}`],
          usage: { ...unknownUsage, ...evidence.usage },
        },
        {
          modelCalls: 0,
          inputTokens: evidence.usage?.inputTokens ?? 0,
          outputTokens: evidence.usage?.outputTokens ?? 0,
          durationMs: Math.max(1, attempt.endedAt - attempt.startedAt),
        },
      );
    }
  }
  const learning = deps.storage.learningCalls(deps.organismId);
  for (const trial of audit.report.trials) {
    const c = plan.search.find((c) => c.id === trial.caseId)!;
    const call = learning.find((call) => call.id === trial.callId)!;
    const prepared = trial.state === "prepared";
    add(
      c.caseId,
      {
        unitId: `compile-trial:${trial.id}`,
        source: bundle.mode ?? "fixture",
        startedAt: trial.startedAt ?? call.createdAt,
        endedAt: trial.endedAt ?? call.createdAt,
        state:
          trial.state === "unknown"
            ? "unknown"
            : trial.state === "completed" && trial.outcome === "value"
              ? "succeeded"
              : "failed",
        accepted: null,
        decision: trial.outcome,
        misrouted: null,
        evidenceRefs: [`compile-trial:${trial.id}`, `learning-call:${trial.callId}`],
        usage: {
          ...unknownUsage,
          ...trial.usage,
          modelCalls: prepared ? 0 : 1,
          inputTokens: prepared ? 0 : (trial.usage?.inputTokens ?? null),
          outputTokens: prepared ? 0 : (trial.usage?.outputTokens ?? null),
        },
      },
      { modelCalls: 1, ...trial.reservation, durationMs: plan.budget.callTimeoutMs },
    );
  }
  // I/O 期间不允许本地来源或编译记录悄悄变化。
  if (auditCompileEvidence(deps, jobId).digest !== audit.digest)
    throw new Error("冻结期间编译证据发生变化");
  const blob = deps.blobs.write(canonicalJson(bundle));
  const record = deps.storage.tx(() => {
    deps.kernel.assertOrganismAccess(deps.organismId, deps.actorId);
    const concurrent = deps.storage.compileDevelopmentBundle(jobId);
    if (concurrent) return concurrent;
    const record = {
      jobId,
      organismId: deps.organismId,
      digest: blob.digest,
      ref: blob.ref,
      createdAt: Date.now(),
      createdBy: deps.actorId,
    };
    deps.storage.insertCompileDevelopmentBundle(record);
    return record;
  });
  return readBundle(deps, record, audit);
}

/** 把全部开发开销绑定到冻结清单；不会读取 formal/regression 资料或创建 Evaluation。 */
export function bindCompileDevelopment(
  deps: CompileEvidenceDeps,
  jobId: string,
  frozen: FrozenAdaptivePlan,
) {
  const checked = freezeAdaptivePlan(frozen.plan);
  if (checked.digest !== frozen.digest) throw new Error("manifest 摘要漂移");
  const { record, bundle, versionIds } = prepareCompileDevelopment(deps, jobId);
  if (!bundle.candidateId || !bundle.policies.candidateDigest)
    throw new Error("没有获胜候选，不能开始正式比较");
  if (bundle.mode !== checked.plan.mode || bundle.source !== checked.plan.source)
    throw new Error("开发来源模式或许可不匹配");
  if (
    checked.plan.mode === "real" &&
    (bundle.sourceModeVerification === "unavailable" || bundle.unknownBoundUnits.length)
  )
    throw new Error("来源模式或执行器模型调用上界不可核验，不能绑定真实轮");
  if (record.createdAt > checked.plan.developmentClosedAt)
    throw new Error("开发包冻结晚于开发截止点");
  const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
  if (!same(bundle.policies, checked.plan.policies)) throw new Error("冻结策略与编译候选不匹配");
  for (const [key, value] of Object.entries(bundle.fixed)) {
    if (!same(checked.plan.fixed[key as keyof typeof bundle.fixed], value))
      throw new Error(`冻结组件不匹配：${key}`);
  }
  const actualCases = checked.plan.cases.filter((c) => c.split === "train" || c.split === "search");
  const sorted = (items: Array<{ id: string }>) =>
    [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!same(sorted(actualCases), sorted(bundle.cases)))
    throw new Error("开发 case、family、输入或裁判绑定不匹配");
  if (checked.plan.development.length !== bundle.development.length)
    throw new Error("开发调用或执行开销被遗漏/追加");
  for (const unit of bundle.development) {
    const planned = checked.plan.development.find((item) => item.id === unit.id);
    if (!planned || planned.caseId !== unit.caseId) throw new Error("开发单元绑定不匹配");
    for (const key of ["modelCalls", "inputTokens", "outputTokens", "durationMs"] as const)
      if (planned.allowance[key] < unit.allowance[key]) throw new Error(`开发预留不足：${key}`);
  }
  const observations = bundle.observations.map((row) => ({
    ...row,
    manifestDigest: checked.digest,
  }));
  const report = reportAdaptiveExperiment(checked, observations);
  if (report.problems.length || report.open.length) throw new Error("开发收据未知、超额或尚未闭合");
  return {
    bundleDigest: record.digest,
    auditDigest: bundle.auditDigest,
    observations,
    versionIds,
    evidenceVerification: "persisted-development-records" as const,
  };
}
