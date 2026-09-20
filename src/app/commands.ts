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

export async function inspectCommand(id: string, opts: CommonOpts): Promise<void> {
  const inst = openInstance(resolveInstanceRoot(opts.home));
  try {
    const found =
      withKind("run", inst.storage.getRun(id)) ??
      withKind("task", inst.storage.getTask(id)) ??
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
    throw new Error(`找不到对象：${id}（支持 run/task/snapshot/version/experience/事件流 ID）`);
  } finally {
    inst.close();
  }
}

function withKind<T>(kind: string, value: T | undefined): { kind: string; value: T } | undefined {
  return value === undefined ? undefined : { kind, value };
}
