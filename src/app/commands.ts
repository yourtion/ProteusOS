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
  executor?: string;
}

/** 委托构建（自举故事步骤 2-3）：builder Run 内联到终态，成功则采集构造候选 */
export async function buildCommand(opts: BuildOpts): Promise<void> {
  const goal = readFileSync(resolve(opts.spec), "utf8");
  const testsDir = resolve(opts.tests);
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
      `找不到对象：${id}（支持 run/task/candidate/snapshot/version/experience/事件流 ID）`,
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
