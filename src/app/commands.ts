import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { openInstance, resolveInstanceRoot, type AppInstance } from "./instance.ts";
import { ORGANISM_ID, PRINCIPAL_ID, installSeed } from "./seed.ts";
import type { PolicyEvaluationPlan } from "../evolution/index.ts";
import { loadTaskFile, resolveFrom } from "./task-file.ts";

export interface CommonOpts {
  home?: string;
  json?: boolean;
  organism?: string;
  actor?: string;
}

function federationFor(opts: CommonOpts) {
  const instance = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  return { instance, federation: instance.federation };
}

function printRecord(record: unknown, opts: CommonOpts): void {
  if (opts.json) console.log(JSON.stringify(record, null, 2));
  else console.log(JSON.stringify(record, null, 2));
}

function validateForkScope(scope: string, organismId: string): void {
  if (scope !== "public" && !/^team:[^:]+$/.test(scope) && scope !== `organism:${organismId}`) {
    throw new Error("scope 必须为 public、team:<id> 或当前 organism:<id>");
  }
}

function validatePublicationScope(scope: string): void {
  if (scope !== "public" && !/^team:[^:]+$/.test(scope)) {
    throw new Error("发布 scope 必须为 public 或 team:<id>");
  }
}

export async function teamCreateCommand(teamId: string, opts: CommonOpts): Promise<void> {
  const { instance, federation } = federationFor(opts);
  try {
    printRecord(federation.createTeam(teamId, { createdBy: opts.actor ?? PRINCIPAL_ID }), opts);
  } finally {
    instance.close();
  }
}

export async function teamGrantCommand(
  teamId: string,
  principalId: string,
  opts: CommonOpts & { permission: string },
): Promise<void> {
  if (!["read", "publish", "manage"].includes(opts.permission)) {
    throw new Error("permission 必须为 read、publish 或 manage");
  }
  const { instance, federation } = federationFor(opts);
  try {
    printRecord(
      federation.grantTeam(teamId, principalId, opts.permission as "read" | "publish" | "manage", {
        authorizedBy: opts.actor ?? PRINCIPAL_ID,
      }),
      opts,
    );
  } finally {
    instance.close();
  }
}

export async function shareForkCommand(
  opts: CommonOpts & { versions: string[]; scope: string },
): Promise<void> {
  const organismId = opts.organism ?? ORGANISM_ID;
  validateForkScope(opts.scope, organismId);
  const { instance, federation } = federationFor(opts);
  try {
    printRecord(
      federation.fork({
        versionIds: opts.versions,
        scope: opts.scope,
        createdBy: opts.actor ?? PRINCIPAL_ID,
      }),
      opts,
    );
  } finally {
    instance.close();
  }
}

export async function publishCommand(
  opts: CommonOpts & {
    team: string;
    versions: string[];
    scope: string;
    evidence?: string[];
  },
): Promise<void> {
  validatePublicationScope(opts.scope);
  const { instance, federation } = federationFor(opts);
  try {
    printRecord(
      federation.publish({
        teamId: opts.team,
        versionIds: opts.versions,
        scope: opts.scope,
        evidenceRefs: opts.evidence ?? [],
        createdBy: opts.actor ?? PRINCIPAL_ID,
      }),
      opts,
    );
  } finally {
    instance.close();
  }
}

export async function shareExportCommand(
  publicationId: string,
  opts: CommonOpts & { out: string },
): Promise<void> {
  const { instance, federation } = federationFor(opts);
  try {
    const envelope = federation.exportPublication(publicationId, opts.actor ?? PRINCIPAL_ID);
    writeFileSync(resolve(opts.out), `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    if (opts.json) printRecord(envelope, opts);
    else console.log(`已导出 ${publicationId} → ${resolve(opts.out)}（${envelope.digest}）`);
  } finally {
    instance.close();
  }
}

export async function shareImportCommand(file: string, opts: CommonOpts): Promise<void> {
  const envelope = JSON.parse(readFileSync(resolve(file), "utf8"));
  const { instance, federation } = federationFor(opts);
  try {
    printRecord(federation.importBundle(envelope, { createdBy: opts.actor ?? PRINCIPAL_ID }), opts);
  } finally {
    instance.close();
  }
}

export async function inheritCommand(
  importId: string,
  opts: CommonOpts & { validationSet: string; versions?: string[]; hypothesis?: string },
): Promise<void> {
  const { instance, federation } = federationFor(opts);
  try {
    printRecord(
      federation.inherit(importId, {
        validationSetId: opts.validationSet,
        versionIds: opts.versions,
        createdBy: opts.actor ?? PRINCIPAL_ID,
        hypothesis: opts.hypothesis,
      }),
      opts,
    );
  } finally {
    instance.close();
  }
}

export async function shareRejectCommand(
  importId: string,
  opts: CommonOpts & { note?: string },
): Promise<void> {
  const { instance, federation } = federationFor(opts);
  try {
    printRecord(
      federation.rejectImport(importId, {
        createdBy: opts.actor ?? PRINCIPAL_ID,
        note: opts.note,
      }),
      opts,
    );
  } finally {
    instance.close();
  }
}

export async function organismsCommand(opts: CommonOpts): Promise<void> {
  const { instance } = federationFor(opts);
  try {
    printRecord(instance.storage.listOrganisms(opts.actor ?? PRINCIPAL_ID), opts);
  } finally {
    instance.close();
  }
}

export async function initCommand(opts: CommonOpts): Promise<void> {
  const root = resolveInstanceRoot(opts.home);
  const inst = openInstance(root, { organismId: opts.organism, actorId: opts.actor });
  try {
    const result = installSeed(
      {
        kernel: inst.kernel,
        storage: inst.storage,
        blobs: inst.blobs,
        clock: { now: Date.now },
      },
      { organismId: opts.organism, ownerId: opts.actor },
    );
    if (opts.json) {
      console.log(JSON.stringify({ root, ...result }, null, 2));
      return;
    }
    console.log(`实例目录   ${root}`);
    console.log(`Principal  ${result.principalId}`);
    console.log(`Organism   ${result.organismId}`);
    console.log(
      `默认快照   ${result.snapshotId} (revision ${result.revision}${result.installed ? "，本次安装" : "，幂等复用"})`,
    );
    console.log("seed 版本:");
    for (const v of result.versions) {
      console.log(`  ${v.artifactId.padEnd(20)} ${v.versionId}  ${v.digest.slice(0, 12)}…`);
    }
  } finally {
    inst.close();
  }
}

export async function submitCommand(taskPath: string, opts: CommonOpts): Promise<void> {
  const { file, budget, baseDir } = loadTaskFile(taskPath);
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const summary = await inst.runtime.submitTask({
      requestedBy: opts.actor ?? PRINCIPAL_ID,
      goal: file.goal,
      inputs: file.inputs.map((p) => resolveFrom(baseDir, p)),
      budget,
      requires: file.requires,
      missingCapabilityWaitSeconds: file.constraints?.missingCapabilityWaitSeconds,
      acceptance: {
        outputSchema: resolveFrom(baseDir, file.acceptance.outputSchema),
        expectedOutput: file.acceptance.expectedOutput
          ? resolveFrom(baseDir, file.acceptance.expectedOutput)
          : undefined,
        verifier: file.acceptance.verifier,
      },
    });
    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    const icon = summary.state === "succeeded" ? "✓" : summary.state === "failed" ? "✗" : "·";
    console.log(`${icon} run ${summary.runId} → ${summary.state}`);
    console.log(`  task       ${summary.taskId}`);
    console.log(`  snapshot   ${summary.snapshotId} (${summary.graphSource})`);
    const run = inst.storage.getRun(summary.runId);
    if (run?.missingCapabilities) {
      console.log(`  waiting    缺少能力 ${run.missingCapabilities.join(", ")}`);
      if (run.waitingUntil) {
        console.log(`  deadline   ${new Date(run.waitingUntil).toISOString()}`);
      }
    }
    for (const n of summary.nodes) {
      console.log(`  node       ${n.id.padEnd(10)} ${n.type.padEnd(8)} ${n.state}`);
    }
    for (const d of summary.decisions) {
      console.log(
        `  decision   ${d.nodeId} → ${d.value} (${d.provider}, policy ${d.policyVersion})`,
      );
    }
    for (const a of summary.attempts) {
      console.log(`  attempt#${a.ordinal}  ${a.state} (exit=${a.exitCode})`);
    }
    for (const c of summary.checks) {
      console.log(
        `  check      ${c.passed ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`,
      );
    }
    if (summary.failureReason) console.log(`  reason     ${summary.failureReason}`);
    console.log(`  experience ${summary.experienceId}`);
  } finally {
    inst.close();
  }
}

export async function runsCommand(id: string | undefined, opts: CommonOpts): Promise<void> {
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    if (!id) {
      const runs = inst.storage.listRuns(20, opts.organism ?? ORGANISM_ID);
      if (opts.json) {
        console.log(JSON.stringify(runs, null, 2));
        return;
      }
      if (runs.length === 0) {
        console.log("（无 Run）");
        return;
      }
      for (const r of runs) {
        console.log(
          `${r.id}  ${r.state.padEnd(10)} ${new Date(r.createdAt).toISOString()}  ${r.goal.slice(0, 50)}`,
        );
      }
      return;
    }

    const run = inst.storage.getRun(id);
    if (!run || run.organismId !== (opts.organism ?? ORGANISM_ID))
      throw new Error(`run ${id} 不存在或属于其他个体`);
    const processes = inst.storage.listProcesses(run.id);
    const attempts = processes.flatMap((p) => inst.storage.listAttempts(p.id));
    const events = inst.storage.listEvents({ runId: run.id }, 100);
    const experience = inst.storage.getExperienceByRun(run.id);

    if (opts.json) {
      console.log(JSON.stringify({ run, processes, attempts, events, experience }, null, 2));
      return;
    }
    console.log(`run        ${run.id}`);
    console.log(`state      ${run.state}${run.failureReason ? ` (${run.failureReason})` : ""}`);
    console.log(`task       ${run.taskId} — ${inst.storage.getTask(run.taskId)?.goal ?? "?"}`);
    console.log(`snapshot   ${run.snapshotId}`);
    console.log(`created    ${new Date(run.createdAt).toISOString()}`);
    for (const a of attempts) {
      console.log(`attempt#${a.ordinal}  ${a.state} exit=${a.exitCode} dispatch=${a.dispatchId}`);
    }
    console.log(`experience ${experience?.id ?? "—"}`);
    console.log(`events (${events.length}):`);
    for (const e of events.slice(-12)) {
      console.log(`  ${String(e.seq).padStart(3)}  ${e.type}`);
    }
  } finally {
    inst.close();
  }
}

export async function cancelCommand(id: string, opts: CommonOpts): Promise<void> {
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const result = await inst.runtime.cancel(id);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`run ${result.runId} → ${result.state}`);
    console.log(`  ${result.note}`);
  } finally {
    inst.close();
  }
}

export async function advanceCommand(id: string, opts: CommonOpts): Promise<void> {
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const result = await inst.runtime.advanceRun(id);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`run ${result.runId} → ${result.state}`);
    console.log(`  ${result.note}`);
  } finally {
    inst.close();
  }
}

export interface BuildOpts extends CommonOpts {
  capability: string;
  spec: string;
  tests: string;
  newCapabilityTask: string;
  regressionTask: string | string[];
  executor?: string;
}

/** 委托构建（自举故事步骤 2-3）：builder Run 内联到终态，成功则采集构造候选 */
export async function buildCommand(opts: BuildOpts): Promise<void> {
  const goal = readFileSync(resolve(opts.spec), "utf8");
  const testsDir = resolve(opts.tests);
  const evaluationPlan = {
    newCapability: taskSubmissionFrom(opts.newCapabilityTask, process.cwd()),
    regression: optionFiles(opts.regressionTask).map((file) =>
      taskSubmissionFrom(file, process.cwd()),
    ),
    requestedBy: opts.actor ?? PRINCIPAL_ID,
  };
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const summary = await inst.evolution.build({
      capability: opts.capability,
      goal,
      inputs: [testsDir],
      executorName: opts.executor ?? "claude-code-acp",
      // Node 26 的 --test 需要具体测试文件；约定测试目录含 <capability>.test.mjs
      testCommand: [
        "node",
        "--test",
        join("inputs", basename(testsDir), `${opts.capability}.test.mjs`),
      ],
      budget: { maxAttempts: 3, maxWallClockSeconds: 600 },
      outputSchema: resolve(opts.spec), // test-runner 裁判不消费 schema；仅满足路径校验
      requestedBy: opts.actor ?? PRINCIPAL_ID,
    });
    if (summary.state !== "succeeded") {
      if (opts.json) {
        console.log(JSON.stringify({ builderRun: summary, candidate: null }, null, 2));
      } else {
        console.log(
          `✗ builder run ${summary.runId} → ${summary.state}（${summary.failureReason}）`,
        );
        console.log("  测试未通过的产出不能构造候选；请修正规范或实现后重试");
      }
      process.exitCode = 1;
      return;
    }
    const { candidate, created } = inst.evolution.collectCandidate(summary.runId, {
      capability: opts.capability,
      hypothesis: `为 ${opts.capability} 增加派生能力（构建来源 run ${summary.runId}）`,
      proposedBy: opts.actor ?? PRINCIPAL_ID,
      evaluationPlan,
    });
    const status = inst.evolution.candidateStatus(candidate.id);
    if (opts.json) {
      console.log(
        JSON.stringify({ builderRun: summary.runId, candidate, status, created }, null, 2),
      );
      return;
    }
    console.log(`✓ builder run ${summary.runId} → succeeded`);
    console.log(
      `${created ? "✓" : "·"} candidate ${candidate.id} → ${status.status}${created ? "" : "（快照去重，复用既有候选）"}`,
    );
    console.log(`  基准       ${candidate.baseSnapshotId} (revision ${candidate.baseRevision})`);
    console.log(`  候选快照   ${candidate.proposedSnapshotId}`);
  } finally {
    inst.close();
  }
}

export interface JudgeUpgradeOpts extends CommonOpts {
  regressionTask: string;
  as?: string;
}

/**
 * 裁判候选升级（M3 裁判拆分）：构造只升 acceptance-evaluator 的候选并
 * 做判定等价评估（能力不变回归集 + 基线对照）；晋升仍由 operator 显式
 * `proteus promote`。能力候选自此基于升级后的基准组合。
 */
export async function judgeUpgradeCommand(opts: JudgeUpgradeOpts): Promise<void> {
  const regression = taskSubmissionFrom(opts.regressionTask, process.cwd());
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const { HYBRID_EVALUATOR_CONTENT } = await import("../evolution/assets.ts");
    const { candidate, created } = inst.evolution.proposeJudgeCandidate({
      evaluatorContent: HYBRID_EVALUATOR_CONTENT,
      hypothesis:
        "裁判升级为 hybrid-acceptance-v1（stats 形态判定与 v1 等价，新增混合输出 schema 校验）",
      proposedBy: opts.as ?? opts.actor ?? PRINCIPAL_ID,
    });
    const { evaluation, status } = await inst.evolution.evaluateJudgeCandidate(candidate.id, {
      regression,
      requestedBy: opts.as ?? opts.actor ?? PRINCIPAL_ID,
    });
    if (opts.json) {
      console.log(JSON.stringify({ candidate, evaluation, status, created }, null, 2));
      return;
    }
    console.log(
      `${created ? "✓" : "·"} judge candidate ${candidate.id}${created ? "" : "（快照去重，复用既有候选）"}`,
    );
    console.log(`evaluation ${evaluation.id} → ${evaluation.verdict}（${status}）`);
    for (const run of evaluation.runs) {
      console.log(
        `  ${run.role.padEnd(10)} run ${run.runId} → ${run.state}${run.failureReason ? ` (${run.failureReason})` : ""}`,
      );
    }
    if (evaluation.verdict === "eligible") {
      console.log(
        `  可晋升：proteus promote ${candidate.id} --as ${opts.as ?? opts.actor ?? PRINCIPAL_ID}`,
      );
    } else if (evaluation.verdict === "rejected") {
      console.log("  ✗ 新裁判破坏既有判定：禁止晋升，旧默认行为继续有效");
      process.exitCode = 1;
    } else {
      console.log("  ? 基线对照失败（inconclusive）：评估环境不可信，可修复后重评");
      process.exitCode = 1;
    }
  } finally {
    inst.close();
  }
}

export async function datasetFreezeCommand(
  opts: CommonOpts & {
    purpose: string;
    cutoff?: string;
  },
): Promise<void> {
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const cutoffAt = opts.cutoff ? Date.parse(opts.cutoff) : undefined;
    if (opts.cutoff && Number.isNaN(cutoffAt))
      throw new Error(`--cutoff 不是合法时间：${opts.cutoff}`);
    const result = inst.evolution.freezeExperienceWindow({
      purpose: opts.purpose as "development" | "validation" | "regression",
      cutoffAt,
      createdBy: opts.actor ?? PRINCIPAL_ID,
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `${result.created ? "✓" : "·"} dataset ${result.dataset.id}${result.created ? "" : "（digest 幂等，复用既有冻结）"}`,
    );
    console.log(`  purpose    ${result.dataset.purpose}`);
    console.log(`  members    ${result.memberCount} 条 experience`);
    console.log(`  cutoff     ${new Date(result.dataset.cutoffAt).toISOString()}`);
    console.log(`  digest     ${result.dataset.digest.slice(0, 16)}…`);
  } finally {
    inst.close();
  }
}

export async function datasetListCommand(opts: CommonOpts): Promise<void> {
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const datasets = inst.storage
      .listExperienceDatasets(undefined, 20, opts.organism ?? ORGANISM_ID)
      .filter((dataset) => dataset.organismId === (opts.organism ?? ORGANISM_ID));
    if (opts.json) {
      console.log(JSON.stringify(datasets, null, 2));
      return;
    }
    if (datasets.length === 0) {
      console.log("（无冻结经验集）");
      return;
    }
    for (const d of datasets) {
      console.log(
        `${d.id}  ${d.purpose.padEnd(12)} ${String(d.memberExperienceIds.length).padStart(4)} 条  ${new Date(d.createdAt).toISOString()}`,
      );
    }
  } finally {
    inst.close();
  }
}

export async function datasetInspectCommand(id: string, opts: CommonOpts): Promise<void> {
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const view = inst.evolution.experienceDatasetView(id);
    if (opts.json) {
      console.log(JSON.stringify(view, null, 2));
      return;
    }
    const { dataset, members } = view;
    console.log(`dataset     ${dataset.id}`);
    console.log(`purpose     ${dataset.purpose}  filter ${dataset.filterVersion}`);
    console.log(`digest      ${dataset.digest}`);
    console.log(`cutoff      ${new Date(dataset.cutoffAt).toISOString()}`);
    console.log(`members (${members.length}):`);
    for (const m of members) {
      const decisions = m.decisionCalls
        .map((c) => `${c.nodeId}→${c.chosenOption ?? `(${c.state})`}`)
        .join(", ");
      console.log(
        `  ${m.experienceId}  ${m.result.padEnd(9)} ${m.taskGoal.slice(0, 40)}${decisions ? `  [${decisions}]` : ""}`,
      );
    }
  } finally {
    inst.close();
  }
}

export interface ConsolidateOpts extends CommonOpts {
  gold?: string;
  validationSet?: string;
}

/**
 * 策略候选提议（M3）：冻结经验集（development）→ 确定性规则归纳 →
 * 只改 routing-policy 的候选。--gold 为开发集标注文件（JSON 数组
 * [{goal, choice}]；验证 family 不得传入）。零提议是正常结果。
 */
export async function consolidateCommand(datasetId: string, opts: ConsolidateOpts): Promise<void> {
  let goldMatches: Array<{ goal: string; choice: string }> | undefined;
  if (opts.gold) {
    goldMatches = JSON.parse(readFileSync(resolve(opts.gold), "utf8")) as Array<{
      goal: string;
      choice: string;
    }>;
  }
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const result = await inst.evolution.proposePolicyCandidate({
      datasetId,
      goldMatches,
      createdBy: opts.actor ?? PRINCIPAL_ID,
      validationSetId: opts.validationSet,
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (!result.candidate) {
      console.log("· 未归纳出达门槛规则：证据不足，不提议候选（正常结果）");
      console.log(`  ${result.consolidation.hypothesis}`);
      return;
    }
    console.log(`✓ candidate ${result.candidate.id}（policy，来源 dataset ${datasetId}）`);
    console.log(`  hypothesis ${result.candidate.hypothesis}`);
    for (const p of result.consolidation.proposals) {
      console.log(
        `  rule       ${p.feature} → ${p.choose}（支持 ${p.support}，精度 ${p.precision.toFixed(2)}，经验 ${p.byOrigin.experience} + 标注 ${p.byOrigin.gold}）`,
      );
    }
    console.log(`  候选快照   ${result.candidate.proposedSnapshotId}`);
  } finally {
    inst.close();
  }
}

export interface ValidationRegisterOpts extends CommonOpts {
  cases: string;
  repeats?: string;
  devFamily?: string[];
  source?: string;
}

export async function validationRegisterCommand(opts: ValidationRegisterOpts): Promise<void> {
  const cases = JSON.parse(
    readFileSync(resolve(opts.cases), "utf8"),
  ) as PolicyEvaluationPlan["cases"];
  const plan: PolicyEvaluationPlan = {
    cases,
    repeats: opts.repeats ? Math.max(1, Number.parseInt(opts.repeats, 10)) : 1,
    thresholds: { minSuccessRate: 0.75, minImprovement: 0.25, minSamples: 4 },
    requestedBy: opts.actor ?? PRINCIPAL_ID,
  };
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const record = inst.evolution.registerValidationSet({
      familyIds: [...new Set(cases.map((c) => c.familyId))],
      devFamilyIds: opts.devFamily ?? [],
      sourceRef: opts.source ?? resolve(opts.cases),
      preparedBy: opts.actor ?? PRINCIPAL_ID,
      plan,
    });
    console.log(JSON.stringify({ validationSet: record }, null, 2));
  } finally {
    inst.close();
  }
}

export interface EvaluatePolicyOpts extends CommonOpts {
  cases?: string;
  repeats?: string;
}

/** 策略候选评估（m3-policy-eval-v1）：双臂 × 验证集 × 重复，指标分列 */
export async function evaluatePolicyCommand(
  candidateId: string,
  opts: EvaluatePolicyOpts,
): Promise<void> {
  const cases = opts.cases
    ? (JSON.parse(readFileSync(resolve(opts.cases), "utf8")) as PolicyEvaluationPlan["cases"])
    : undefined;
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const frozenPlan = cases ? await inst.evolution.policyEvaluationPlan(candidateId) : undefined;
    const plan = frozenPlan
      ? {
          ...frozenPlan,
          cases: cases ?? frozenPlan.cases,
          repeats: opts.repeats
            ? Math.max(1, Number.parseInt(opts.repeats, 10))
            : frozenPlan.repeats,
          requestedBy: opts.actor ?? PRINCIPAL_ID,
        }
      : undefined;
    const { evaluation, status } = await inst.evolution.evaluatePolicyCandidate(candidateId, plan);
    if (opts.json) {
      console.log(JSON.stringify({ evaluation, status }, null, 2));
      return;
    }
    console.log(
      `evaluation ${evaluation.id} → ${evaluation.verdict}（candidate ${candidateId} → ${status}）`,
    );
    if (evaluation.policy) {
      const fmt = (m: {
        runs: number;
        successRate: number;
        routeAccuracy: number | null;
        abstainRate: number;
        latencyP50Ms: number;
        latencyP95Ms: number;
        successRateVariance: number;
      }) =>
        `成功率 ${(m.successRate * 100).toFixed(0)}%、路由准确 ${m.routeAccuracy === null ? "n/a" : `${(m.routeAccuracy * 100).toFixed(0)}%`}、无选择 ${(m.abstainRate * 100).toFixed(0)}%、p50/p95 ${m.latencyP50Ms}/${m.latencyP95Ms}ms、方差 ${m.successRateVariance.toFixed(3)}`;
      console.log(`  基线臂   ${fmt(evaluation.policy.base)}`);
      console.log(`  候选臂   ${fmt(evaluation.policy.candidate)}`);
      console.log(
        `  门槛     成功率 ≥ ${(evaluation.policy.thresholds.minSuccessRate * 100).toFixed(0)}%、改善 ≥ ${(evaluation.policy.thresholds.minImprovement * 100).toFixed(0)}pp、样本 ≥ ${evaluation.policy.thresholds.minSamples}`,
      );
    }
    if (evaluation.policyEvidence) {
      const evidence = evaluation.policyEvidence;
      const samples = evidence.samples;
      console.log(
        `  样本     验证 ${samples.validationCases} 项/${samples.independentValidationFamilies} 个独立 family；回归 ${samples.regressionCases} 项；各重复 ${evidence.repeats} 次`,
      );
      for (const arm of ["base", "candidate"] as const) {
        const { decisions, resources } = evidence.arms[arm];
        const errors = decisions.invalid_output + decisions.transport_error + decisions.timeout;
        console.log(
          `  ${arm === "base" ? "基线" : "候选"}明细 明确弃权 ${decisions.model_abstain}、服务拒绝 ${decisions.service_refusal}、异常 ${errors}、unknown ${decisions.unknown}；已发送模型调用 ${resources.sentModelCalls}、费用未知 ${resources.unknownCostCalls} 次（仅决策调用）`,
        );
      }
    } else if (evaluation.policy) {
      console.log("  明细证据不可用（历史评估）");
    }
    console.log(
      evaluation.verdict === "eligible"
        ? "  ✓ 达标：可 proteus promote"
        : evaluation.verdict === "rejected"
          ? "  ✗ 未达标：禁止晋升，旧默认行为继续有效"
          : "  ? 证据不足（inconclusive）：不判通过，可补充验证后重评",
    );
  } finally {
    inst.close();
  }
}

export interface ConsolidateSubmitOpts extends CommonOpts {
  gold?: string;
  validationSet?: string;
  mode?: string;
  minSupport?: string;
  minPrecision?: string;
  maxRules?: string;
}

function readConsolidationParams(opts: {
  minSupport?: string;
  minPrecision?: string;
  maxRules?: string;
}): { params: { minSupport: number; minPrecision: number; maxRules: number }; overrides: boolean } {
  const minSupport = opts.minSupport ? Number.parseInt(opts.minSupport, 10) : undefined;
  const minPrecision = opts.minPrecision ? Number.parseFloat(opts.minPrecision) : undefined;
  const maxRules = opts.maxRules ? Number.parseInt(opts.maxRules, 10) : undefined;
  const invalid =
    (minSupport !== undefined && (Number.isNaN(minSupport) || minSupport < 1)) ||
    (minPrecision !== undefined &&
      (Number.isNaN(minPrecision) || minPrecision <= 0 || minPrecision > 1)) ||
    (maxRules !== undefined && (Number.isNaN(maxRules) || maxRules < 1));
  if (invalid)
    throw new Error("归纳参数不合法（--min-support ≥1、0<--min-precision≤1、--max-rules ≥1）");
  return {
    params: {
      minSupport: minSupport ?? 2,
      minPrecision: minPrecision ?? 0.8,
      maxRules: maxRules ?? 4,
    },
    overrides: Boolean(minSupport || minPrecision || maxRules),
  };
}

function readGoldMatches(file?: string): Array<{ goal: string; choice: string }> | undefined {
  if (!file) return undefined;
  return JSON.parse(readFileSync(resolve(file), "utf8")) as Array<{ goal: string; choice: string }>;
}

/** 异步提交 Consolidation 作业（提交即返回；执行用 consolidate-run 驱动） */
export async function consolidateSubmitCommand(
  datasetId: string,
  opts: ConsolidateSubmitOpts,
): Promise<void> {
  const { params } = readConsolidationParams(opts);
  const mode = opts.mode === "llm" ? "llm" : "rule";
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const { job, created } = inst.evolution.submitConsolidationJob({
      datasetId,
      params,
      goldMatches: readGoldMatches(opts.gold),
      mode,
      createdBy: opts.actor ?? PRINCIPAL_ID,
      validationSetId: opts.validationSet,
    });
    if (opts.json) {
      console.log(JSON.stringify({ job, created }, null, 2));
      return;
    }
    console.log(
      `${created ? "✓" : "·"} job ${job.id}${created ? "" : "（同参数作业已存在，幂等复用）"} → ${job.state}`,
    );
    console.log(`  dataset    ${job.datasetId}（mode=${job.mode}）`);
    console.log(`  驱动       proteus consolidate-run`);
  } finally {
    inst.close();
  }
}

/** 驱动队列：queued → running → completed/failed（串行，operator 显式） */
export async function consolidateRunCommand(
  opts: CommonOpts & { limit?: string; learningCalls?: string },
): Promise<void> {
  const limit = opts.limit ? Number.parseInt(opts.limit, 10) : 1;
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    if (opts.learningCalls !== undefined) {
      const maxCalls = Number(opts.learningCalls);
      if (!Number.isSafeInteger(maxCalls) || maxCalls < 0)
        throw new Error("学习调用额度必须是非负整数");
      inst.storage.tx(() =>
        inst.storage.setLearningCallLimit(opts.organism ?? ORGANISM_ID, maxCalls),
      );
    }
    const results = await inst.evolution.runPendingConsolidationJobs(
      Number.isNaN(limit) ? 1 : limit,
    );
    if (opts.json) {
      console.log(JSON.stringify({ results }, null, 2));
      return;
    }
    if (results.length === 0) {
      console.log("（队列空闲，没有待执行作业）");
      return;
    }
    for (const r of results) {
      console.log(`job ${r.jobId} → ${r.outcome}：${r.detail}`);
    }
  } finally {
    inst.close();
  }
}

export async function consolidateRecoverCommand(opts: CommonOpts): Promise<void> {
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const actions = inst.evolution.recoverConsolidationJobs();
    if (opts.json) console.log(JSON.stringify({ actions }, null, 2));
    else
      for (const action of actions)
        console.log(`job ${action.jobId} → ${action.state}（未知调用未重发）`);
  } finally {
    inst.close();
  }
}

export async function consolidateJobsCommand(
  datasetId: string | undefined,
  opts: CommonOpts,
): Promise<void> {
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const jobs = inst.storage.listConsolidationJobs(
      { ...(datasetId ? { datasetId } : {}), organismId: opts.organism ?? ORGANISM_ID },
      20,
    );
    if (opts.json) {
      console.log(JSON.stringify(jobs, null, 2));
      return;
    }
    if (jobs.length === 0) {
      console.log("（无作业）");
      return;
    }
    for (const j of jobs) {
      console.log(
        `${j.id}  ${j.state.padEnd(9)} ${j.mode.padEnd(4)} ${new Date(j.createdAt).toISOString()}  ${j.result?.hypothesis?.slice(0, 50) ?? j.error?.slice(0, 50) ?? ""}`,
      );
    }
  } finally {
    inst.close();
  }
}

export async function consolidateJobCommand(id: string, opts: CommonOpts): Promise<void> {
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const job = inst.evolution.consolidationJob(id);
    const events = inst.storage.listEvents({ streamId: `job-${id}` }, 50);
    console.log(JSON.stringify({ job, events }, null, 2));
  } finally {
    inst.close();
  }
}

export async function consolidateCancelCommand(id: string, opts: CommonOpts): Promise<void> {
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const result = inst.evolution.cancelConsolidationJob(id);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`job ${result.jobId} → ${result.state}`);
    console.log(`  ${result.note}`);
  } finally {
    inst.close();
  }
}

export async function candidatesCommand(id: string | undefined, opts: CommonOpts): Promise<void> {
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    if (id) {
      const candidate = inst.storage.getCandidate(id);
      if (!candidate) throw new Error(`candidate ${id} 不存在`);
      const status = inst.evolution.candidateStatus(id);
      const events = inst.storage.listEvents({ streamId: `candidate-${id}` }, 100);
      if (opts.json) {
        console.log(JSON.stringify({ candidate, status, events }, null, 2));
        return;
      }
      console.log(`candidate  ${candidate.id}`);
      console.log(`status     ${status.status} — ${status.detail}`);
      console.log(`基准       ${candidate.baseSnapshotId} (revision ${candidate.baseRevision})`);
      console.log(`候选快照   ${candidate.proposedSnapshotId}`);
      console.log(`hypothesis ${candidate.hypothesis}`);
      console.log(
        `proposedBy ${candidate.proposedBy}  ${new Date(candidate.createdAt).toISOString()}`,
      );
      console.log(`source     ${JSON.stringify(candidate.sourceRefs)}`);
      console.log(`events:`);
      for (const e of events) {
        console.log(`  ${String(e.seq).padStart(3)}  ${e.type}`);
      }
      return;
    }
    const candidates = inst.storage.listCandidates(opts.organism ?? ORGANISM_ID, 20);
    if (opts.json) {
      console.log(
        JSON.stringify(
          candidates.map((c) => ({ ...c, status: inst.evolution.candidateStatus(c.id).status })),
          null,
          2,
        ),
      );
      return;
    }
    if (candidates.length === 0) {
      console.log("（无候选）");
      return;
    }
    for (const c of candidates) {
      const status = inst.evolution.candidateStatus(c.id);
      console.log(
        `${c.id}  ${status.status.padEnd(10)} ${new Date(c.createdAt).toISOString()}  ${c.hypothesis.slice(0, 50)}`,
      );
    }
  } finally {
    inst.close();
  }
}

export async function inspectCommand(id: string, opts: CommonOpts): Promise<void> {
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const found =
      withKind("run", inst.storage.getRun(id)) ??
      withKind("task", inst.storage.getTask(id)) ??
      withKind("candidate", inst.storage.getCandidate(id)) ??
      withKind("evaluation", inst.storage.getEvaluation(id)) ??
      withKind("promotion", inst.storage.getPromotion(id)) ??
      withKind("snapshot", inst.kernel.getSnapshot(id)) ??
      withKind("snapshot", inst.storage.findSnapshotByDigest(id)) ??
      withKind("artifact-version", inst.storage.getArtifactVersion(id)) ??
      withKind("experience", inst.storage.getExperienceByRun(id)) ??
      withKind("dataset", inst.storage.getExperienceDataset(id)) ??
      withKind("validation-set", inst.storage.getValidationSet(id)) ??
      withKind("import", inst.storage.getSharedImport(id));

    if (found) {
      assertObjectVisible(
        inst,
        found.kind,
        found.value as unknown as Record<string, unknown>,
        opts,
      );
      console.log(JSON.stringify({ kind: found.kind, id, value: found.value }, null, 2));
      return;
    }
    const events = inst.storage.listEvents({ streamId: id }, 100);
    if (events.length > 0) {
      if (
        events.some(
          (e) =>
            e.organismId !== (opts.organism ?? ORGANISM_ID) &&
            !(e.streamId === "seed" && e.organismId === null),
        )
      )
        throw new Error("事件流属于其他个体");
      console.log(JSON.stringify({ kind: "events", streamId: id, events }, null, 2));
      return;
    }
    throw new Error(
      `找不到对象：${id}（支持 run/task/candidate/evaluation/promotion/snapshot/version/experience/事件流 ID）`,
    );
  } finally {
    inst.close();
  }
}

export async function recoverCommand(id: string | undefined, opts: CommonOpts): Promise<void> {
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const actions = await inst.runtime.recoverRun(id);
    if (opts.json) {
      console.log(JSON.stringify({ actions }, null, 2));
      return;
    }
    if (actions.length === 0) {
      console.log("没有需要恢复的 Run");
      return;
    }
    for (const a of actions) {
      const label =
        a.action === "resumed"
          ? `已续跑 → ${a.summary?.state ?? "?"}${a.summary?.failureReason ? ` (${a.summary.failureReason})` : ""}`
          : a.action === "needs_reconciliation"
            ? `存在 unknown Attempt（${a.unknownAttempts.length} 个），等待 proteus reconcile <runId>`
            : "已终态，跳过";
      console.log(`run ${a.runId}  ${label}`);
    }
  } finally {
    inst.close();
  }
}

export async function reconcileCommand(id: string, opts: CommonOpts): Promise<void> {
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const report = await inst.runtime.reconcileRun(id);
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`run ${report.runId}  ${report.note}`);
    for (const r of report.resolved) {
      console.log(`  attempt ${r.attemptId} (${r.nodeId}) → ${r.verdict}：${r.evidence}`);
    }
    if (report.summary) {
      console.log(
        `  续跑结果 → ${report.summary.state}${report.summary.failureReason ? ` (${report.summary.failureReason})` : ""}`,
      );
    }
  } finally {
    inst.close();
  }
}

function assertObjectVisible(
  inst: AppInstance,
  kind: string,
  value: Record<string, unknown>,
  opts: CommonOpts,
): void {
  const organismId = opts.organism ?? ORGANISM_ID;
  const actor = opts.actor ?? PRINCIPAL_ID;
  if (["run", "candidate", "promotion", "dataset", "validation-set", "import"].includes(kind)) {
    if (value["organismId"] !== organismId) throw new Error("对象属于其他个体");
  } else if (kind === "task") {
    if (!inst.storage.taskBelongsToOrganism(String(value["id"]), organismId))
      throw new Error("任务属于其他个体");
  } else if (kind === "evaluation") {
    if (inst.storage.getCandidate(String(value["candidateId"]))?.organismId !== organismId)
      throw new Error("评估属于其他个体");
  } else if (kind === "experience") {
    if (inst.storage.getRun(String(value["runId"]))?.organismId !== organismId)
      throw new Error("经验属于其他个体");
  } else if (kind === "artifact-version") {
    inst.kernel.assertVersionAccess(String(value["id"]), actor);
  } else if (kind === "snapshot") {
    for (const v of inst.kernel.resolveSnapshot(String(value["id"])).versions.values())
      inst.kernel.assertVersionAccess(v.id, actor);
  }
}

function withKind<T>(kind: string, value: T | undefined): { kind: string; value: T } | undefined {
  return value === undefined ? undefined : { kind, value };
}

function taskSubmissionFrom(file: string, baseDir: string) {
  const loaded = loadTaskFile(resolve(baseDir, file));
  return {
    goal: loaded.file.goal,
    inputs: loaded.file.inputs.map((p) => resolveFrom(loaded.baseDir, p)),
    budget: loaded.budget,
    requires: loaded.file.requires,
    missingCapabilityWaitSeconds: loaded.file.constraints?.missingCapabilityWaitSeconds,
    acceptance: {
      outputSchema: resolveFrom(loaded.baseDir, loaded.file.acceptance.outputSchema),
      expectedOutput: loaded.file.acceptance.expectedOutput
        ? resolveFrom(loaded.baseDir, loaded.file.acceptance.expectedOutput)
        : undefined,
      verifier: loaded.file.acceptance.verifier,
    },
  };
}

export interface EvaluateOpts extends CommonOpts {
  newCapabilityTask: string;
  regressionTask: string | string[];
}

export async function evaluateCommand(id: string, opts: EvaluateOpts): Promise<void> {
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const { evaluation, status } = await inst.evolution.evaluateCandidate(id, {
      newCapability: taskSubmissionFrom(opts.newCapabilityTask, process.cwd()),
      regression: optionFiles(opts.regressionTask).map((file) =>
        taskSubmissionFrom(file, process.cwd()),
      ),
      requestedBy: opts.actor ?? PRINCIPAL_ID,
    });
    if (opts.json) {
      console.log(JSON.stringify({ evaluation, status }, null, 2));
      return;
    }
    console.log(
      `evaluation ${evaluation.id} → ${evaluation.verdict}（candidate ${id} → ${status}）`,
    );
    for (const run of evaluation.runs) {
      console.log(
        `  ${run.role.padEnd(15)} run ${run.runId} → ${run.state}${run.failureReason ? ` (${run.failureReason})` : ""}  ${run.durationMs}ms`,
      );
    }
    console.log(
      evaluation.verdict === "eligible"
        ? "  ✓ 新能力验收与既有能力回归均通过，可 proteus promote"
        : evaluation.verdict === "rejected"
          ? "  ✗ 证据不满足：禁止晋升，旧默认行为继续有效"
          : "  ? 基线对照失败：评估环境不可信（inconclusive），可修复后重评",
    );
  } finally {
    inst.close();
  }
}

function optionFiles(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

export interface PromoteOpts extends CommonOpts {
  as: string;
  operationId?: string;
  note?: string;
}

export async function promoteCommand(id: string, opts: PromoteOpts): Promise<void> {
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const outcome = inst.evolution.promote(id, {
      authorizedBy: opts.as,
      operationId: opts.operationId,
      note: opts.note,
    });
    if (opts.json) {
      console.log(JSON.stringify(outcome, null, 2));
      return;
    }
    if (outcome.result === "stale") {
      console.log(
        `✗ candidate ${id} → stale：基准已过期（当前 revision ${outcome.currentRevision}），须基于新基准重构重评`,
      );
      process.exitCode = 1;
      return;
    }
    const label = outcome.result === "already" ? "（幂等读回，revision 未再次增加）" : "";
    console.log(
      `✓ candidate ${id} → ${outcome.promotion.kind} ${label}revision ${outcome.promotion.expectedRevision} → ${outcome.promotion.resultRevision}`,
    );
    console.log(`  promotion  ${outcome.promotion.id}`);
    console.log(
      `  快照       ${outcome.promotion.fromSnapshotId} → ${outcome.promotion.toSnapshotId}`,
    );
  } finally {
    inst.close();
  }
}

export async function rollbackCommand(opts: PromoteOpts & { to: string }): Promise<void> {
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const target = inst.kernel.getSnapshot(opts.to) ?? inst.storage.findSnapshotByDigest(opts.to);
    if (!target) throw new Error(`快照 ${opts.to}（id 或 digest）不存在`);
    const outcome = inst.evolution.rollback({
      toSnapshotId: target.id,
      authorizedBy: opts.as,
      operationId: opts.operationId,
      note: opts.note,
    });
    if (opts.json) {
      console.log(JSON.stringify(outcome, null, 2));
      return;
    }
    if (outcome.result === "stale") {
      console.log(`✗ 回滚 → stale：revision 已变化（当前 ${outcome.currentRevision}），请重试`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `✓ rollback revision ${outcome.promotion.expectedRevision} → ${outcome.promotion.resultRevision}（回滚不倒退 revision，只影响后续 Run）`,
    );
    console.log(`  promotion  ${outcome.promotion.id}`);
  } finally {
    inst.close();
  }
}

export async function supersedeCommand(
  id: string,
  opts: CommonOpts & { note?: string },
): Promise<void> {
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const { superseded, successor } = await inst.evolution.supersedeAndReplace(id, {
      note: opts.note,
    });
    if (opts.json) {
      console.log(JSON.stringify({ superseded, successor }, null, 2));
      return;
    }
    console.log(`run ${id} → failed/superseded（能力缺失且被新运行接替）`);
    console.log(
      `run ${successor.runId} → ${successor.state}（接替，绑定快照 ${successor.snapshotId}）`,
    );
    if (successor.state === "waiting") {
      console.log("  接替 Run 仍在能力缺口等待——请确认默认快照已含所需能力");
      process.exitCode = 1;
    }
  } finally {
    inst.close();
  }
}

export interface ExperimentRunOpts extends CommonOpts {
  dataset: string;
  out: string;
  llm: "fake" | "real";
  arm: string[];
  repeats: number;
  experimentId?: string;
  seed: number;
  organismCalls: number;
  experimentCalls: number;
  wallClockMinutes: number;
  capabilityModule: string;
  oracle: boolean;
  skipOracle?: boolean;
}

/**
 * 实验入口（ADR 0007 §8）：manifest 驱动执行。
 * 退出码：0 完成（收益结论可能未证明）；2 工程/预检失败；3 不完整（inconclusive）。
 */
export async function experimentRunCommand(opts: ExperimentRunOpts): Promise<void> {
  const { runExperiment } = await import("./experiment/runner.ts");
  const { v7: uuidv7 } = await import("uuid");
  const result = await runExperiment({
    home: resolveInstanceRoot(opts.home),
    organismId: opts.organism,
    actorId: opts.actor,
    datasetDir: resolve(opts.dataset),
    outDir: resolve(opts.out),
    llm: opts.llm,
    arms: (opts.arm.length > 0 ? opts.arm : ["R", "L"]) as Array<"R" | "L">,
    repeats: opts.repeats,
    experimentId: opts.experimentId ?? `exp-${uuidv7().slice(0, 8)}`,
    seed: opts.seed,
    organismCallLimit: opts.organismCalls,
    experimentCallLimit: opts.experimentCalls,
    wallClockLimitMs: opts.wallClockMinutes * 60 * 1000,
    capabilityModulePath: resolve(opts.capabilityModule),
    withOracle: opts.oracle,
    skipOracle: opts.skipOracle,
  });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`实验 ${result.experimentId} → ${result.status}（${result.trials} trials）`);
    if (result.oraclePassed !== null) {
      console.log(`  oracle 预检：${result.oraclePassed ? "通过" : "失败"}`);
    }
    if (result.incompleteReason) console.log(`  ${result.incompleteReason}`);
    if (result.manifestPath) console.log(`  manifest   ${result.manifestPath}`);
  }
  process.exitCode =
    result.status === "complete" ? 0 : result.status === "preflight_failed" ? 2 : 3;
}

export async function experimentReportCommand(
  dir: string,
  opts: CommonOpts & { dataset?: string },
): Promise<void> {
  const { generateReport } = await import("./experiment/reporter.ts");
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const outcome = generateReport({
      dir: resolve(dir),
      organismId: opts.organism ?? ORGANISM_ID,
      storage: inst.storage,
      blobs: inst.blobs,
      datasetDir: opts.dataset ? resolve(opts.dataset) : null,
    });
    if (opts.json) {
      console.log(JSON.stringify(outcome, null, 2));
    } else {
      console.log(
        `engineering=${outcome.engineering} realModel=${outcome.realModel} benefit=${outcome.benefit}`,
      );
      for (const g of outcome.gates) {
        console.log(
          `  ${g.passed === null ? "?" : g.passed ? "✓" : "✗"} ${g.id}: ${g.requirement}（实际 ${g.actual}）`,
        );
      }
      for (const p of outcome.problems) console.log(`  ! ${p}`);
      console.log(`  报告 ${outcome.reportPath}`);
    }
    process.exitCode = outcome.engineering === "passed" ? 0 : 2;
  } finally {
    inst.close();
  }
}

export async function settleDecisionCommand(
  decisionId: string,
  opts: CommonOpts & { note?: string },
): Promise<void> {
  const inst = openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
  try {
    const result = inst.runtime.settleDecisionCall(decisionId, { note: opts.note });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`run ${result.runId} → ${result.state}`);
    console.log(`  ${result.note}`);
  } finally {
    inst.close();
  }
}
