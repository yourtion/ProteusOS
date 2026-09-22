import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { openInstance, resolveInstanceRoot } from "./instance.ts";
import { PRINCIPAL_ID, installSeed } from "./seed.ts";
import { loadTaskFile, resolveFrom } from "./task-file.ts";

export interface CommonOpts {
  home?: string;
  json?: boolean;
}

export async function initCommand(opts: CommonOpts): Promise<void> {
  const root = resolveInstanceRoot(opts.home);
  const inst = openInstance(root);
  try {
    const result = installSeed({
      kernel: inst.kernel,
      storage: inst.storage,
      blobs: inst.blobs,
      clock: { now: Date.now },
    });
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
  const inst = openInstance(resolveInstanceRoot(opts.home));
  try {
    const summary = await inst.runtime.submitTask({
      requestedBy: PRINCIPAL_ID,
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
  const inst = openInstance(resolveInstanceRoot(opts.home));
  try {
    if (!id) {
      const runs = inst.storage.listRuns(20);
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
    if (!run) throw new Error(`run ${id} 不存在`);
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
  const inst = openInstance(resolveInstanceRoot(opts.home));
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
  const inst = openInstance(resolveInstanceRoot(opts.home));
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
    requestedBy: PRINCIPAL_ID,
  };
  const inst = openInstance(resolveInstanceRoot(opts.home));
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
      requestedBy: PRINCIPAL_ID,
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
      proposedBy: PRINCIPAL_ID,
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

export async function candidatesCommand(id: string | undefined, opts: CommonOpts): Promise<void> {
  const inst = openInstance(resolveInstanceRoot(opts.home));
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
    const candidates = inst.storage.listCandidates("organism-default", 20);
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
  const inst = openInstance(resolveInstanceRoot(opts.home));
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
      withKind("experience", inst.storage.getExperienceByRun(id));

    if (found) {
      console.log(JSON.stringify({ kind: found.kind, id, value: found.value }, null, 2));
      return;
    }
    const events = inst.storage.listEvents({ streamId: id }, 100);
    if (events.length > 0) {
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
  const inst = openInstance(resolveInstanceRoot(opts.home));
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
  const inst = openInstance(resolveInstanceRoot(opts.home));
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
  const inst = openInstance(resolveInstanceRoot(opts.home));
  try {
    const { evaluation, status } = await inst.evolution.evaluateCandidate(id, {
      newCapability: taskSubmissionFrom(opts.newCapabilityTask, process.cwd()),
      regression: optionFiles(opts.regressionTask).map((file) =>
        taskSubmissionFrom(file, process.cwd()),
      ),
      requestedBy: PRINCIPAL_ID,
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
  const inst = openInstance(resolveInstanceRoot(opts.home));
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
  const inst = openInstance(resolveInstanceRoot(opts.home));
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
  const inst = openInstance(resolveInstanceRoot(opts.home));
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
  const inst = openInstance(resolveInstanceRoot(opts.home));
  try {
    const outcome = generateReport({
      dir: resolve(dir),
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
  const inst = openInstance(resolveInstanceRoot(opts.home));
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
