import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppInstance } from "../../src/app/instance.ts";
import { ensureCapabilityGenome } from "../../src/evolution/assets.ts";
import type { CapabilityGenome } from "../../src/evolution/assets.ts";
import type { CapabilityModule } from "../../src/runtime/capability.ts";
import { canonicalJson } from "../../src/storage/blobs.ts";
import { bootSeededInstance, upgradeJudgeToActive, fixturePath } from "../helpers.ts";

/**
 * 评估 Run 入口与能力执行。
 * - submitTask options：purpose=evaluation 显式绑定快照，不改变 activeGenome
 * - capability/<name> 执行器：快照槽位产物经独立子进程加载执行
 * - 回归语义：G1 下 stats 任务仍路由 local-process
 * - evaluatorVersionId：评估计划钉住裁判，normal 用途拒绝
 */

let inst: AppInstance | undefined;
afterAll(() => {
  inst?.close();
});

function instance(): AppInstance {
  inst ??= bootSeededInstance();
  return inst;
}

const CFS = fileURLToPath(new URL("../fixtures/changed-file-summary", import.meta.url));

const CAPABILITY_MODULE: CapabilityModule = {
  kind: "capability-module-v1",
  name: "changed-file-summary",
  entry: "index.mjs",
  files: [
    {
      path: "index.mjs",
      content: readFileSync(join(CFS, "implementation.mjs"), "utf8"),
    },
  ],
};

let g1: CapabilityGenome | undefined;
let judgeSnapshot: string | undefined;

function candidateGenome(): CapabilityGenome {
  const app = instance();
  judgeSnapshot ??= upgradeJudgeToActive(app);
  g1 ??= ensureCapabilityGenome(
    { kernel: app.kernel, storage: app.storage, blobs: app.blobs, clock: { now: Date.now } },
    {
      baseSnapshotId: app.kernel.getOrganism("organism-default")!.activeGenomeId!,
      capabilities: [{ name: "changed-file-summary", module: CAPABILITY_MODULE }],
      createdBy: "principal-local",
    },
  );
  return g1;
}

const SUMMARY_TASK = {
  requestedBy: "principal-local",
  goal: "对变更清单生成可验证的文件分类摘要",
  inputs: [join(CFS, "inputs", "changed-files.json")],
  budget: { maxAttempts: 3, maxWallClockSeconds: 60 },
  requires: ["changed-file-summary"],
  acceptance: {
    outputSchema: join(CFS, "schema.json"),
    verifier: "stats-acceptance",
  },
};

const STATS_TASK = {
  requestedBy: "principal-local",
  goal: "统计摘要（G1 回归）",
  inputs: [fixturePath("input-a")],
  budget: { maxAttempts: 3, maxWallClockSeconds: 60 },
  acceptance: {
    outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
    verifier: "stats-acceptance",
  },
};

describe("评估 Run 入口与能力执行", () => {
  it("评估 Run 绑定候选快照执行新能力，不改变 activeGenome", async () => {
    const app = instance();
    const genome = candidateGenome();
    const activeBefore = app.kernel.getOrganism("organism-default")!.activeGenomeId;

    const summary = await app.runtime.submitTask(SUMMARY_TASK, {
      purpose: "evaluation",
      snapshotId: genome.snapshot.id,
    });

    expect(summary.state).toBe("succeeded");
    const run = app.storage.getRun(summary.runId)!;
    expect(run.purpose).toBe("evaluation");
    expect(run.snapshotId).toBe(genome.snapshot.id);
    expect(run.evaluatorVersionId).toBeNull();
    expect(app.kernel.getOrganism("organism-default")!.activeGenomeId).toBe(activeBefore);

    // 路由把声明该能力的任务交给 capability 执行器
    const decision = summary.decisions.find((d) => d.nodeId === "route")!;
    expect(decision.value).toBe("capability/changed-file-summary");

    // 独立子进程产物：工作区 capability/ 目录 + output.json 分类结果
    const workspace = join(app.root, "workspaces", summary.runId, "work");
    const output = JSON.parse(readFileSync(join(workspace, "output.json"), "utf8")) as {
      summary: { total: number; files: Array<{ path: string; category: string }> };
    };
    expect(output.summary.total).toBe(5);
    expect(Object.fromEntries(output.summary.files.map((f) => [f.path, f.category]))).toEqual({
      "src/index.ts": "source",
      "src/wordcount.test.mjs": "test",
      "docs/guide.md": "docs",
      "package.json": "config",
      LICENSE: "other",
    });
  });

  it("回归语义：G1 下无能力声明的 stats 任务仍走 local-process 并通过既有验收", async () => {
    const app = instance();
    const genome = candidateGenome();
    const summary = await app.runtime.submitTask(STATS_TASK, {
      purpose: "evaluation",
      snapshotId: genome.snapshot.id,
    });

    expect(summary.state).toBe("succeeded");
    const decision = summary.decisions.find((d) => d.nodeId === "route")!;
    expect(decision.value).toBe("local-process");
    // hybrid 裁判对 stats 形态输出仍做 totals 一致性校验（与 v1 等价）
    expect(summary.checks.map((c) => c.name).sort()).toEqual(["json-schema", "totals-consistency"]);
  });

  it("evaluatorVersionId 钉住评估裁判：评估 Run 用指定版本而非快照槽位", async () => {
    const app = instance();
    const genome = candidateGenome();
    // 另一个裁判版本（test-runner 型），评估计划钉住它
    const { digest, ref } = app.blobs.write(
      canonicalJson({
        schemaVersion: 1,
        kind: "test-runner-v1",
        command: ["node", "-e", "process.exit(0)"],
      }),
    );
    const pinned = app.kernel.registerVersion({
      artifact: app.storage.getArtifact("stats-acceptance")!,
      schemaVersion: 2,
      contentDigest: digest,
      contentRef: ref,
      parents: [genome.evaluatorVersion.id],
      dependencies: [],
      createdBy: "principal-local",
    });

    const summary = await app.runtime.submitTask(SUMMARY_TASK, {
      purpose: "evaluation",
      snapshotId: genome.snapshot.id,
      evaluatorVersionId: pinned.id,
    });

    expect(summary.state).toBe("succeeded");
    const run = app.storage.getRun(summary.runId)!;
    expect(run.evaluatorVersionId).toBe(pinned.id);
    // 裁判按钉住版本分发（tests check），而非快照槽位的 hybrid（json-schema check）
    expect(summary.checks.map((c) => c.name)).toEqual(["tests"]);
  });

  it("evaluatorVersionId 在普通用途被拒绝；supersedesRunId 写入接替关系", async () => {
    const app = instance();
    const genome = candidateGenome();

    await expect(
      app.runtime.submitTask(STATS_TASK, {
        snapshotId: genome.snapshot.id,
        evaluatorVersionId: genome.evaluatorVersion.id,
      }),
    ).rejects.toMatchObject({ code: "run_not_pending" });

    // R1 缺口等待 → 接替 Run 记录 supersedesRunId
    const r1 = await app.runtime.submitTask(SUMMARY_TASK);
    expect(r1.state).toBe("waiting");
    const r2 = await app.runtime.submitTask(SUMMARY_TASK, {
      purpose: "evaluation",
      snapshotId: genome.snapshot.id,
      supersedesRunId: r1.runId,
    });
    expect(app.storage.getRun(r2.runId)!.supersedesRunId).toBe(r1.runId);
    await expect(
      app.runtime.submitTask(STATS_TASK, { supersedesRunId: "run-nonexistent" }),
    ).rejects.toMatchObject({ code: "unknown_run" });
  });

  it("能力模块内容不合法时按合同失败，不产生副作用", async () => {
    const app = instance();
    const bad = ensureCapabilityGenome(
      { kernel: app.kernel, storage: app.storage, blobs: app.blobs, clock: { now: Date.now } },
      {
        baseSnapshotId: app.kernel.getOrganism("organism-default")!.activeGenomeId!,
        capabilities: [
          {
            name: "broken-capability",
            // entry/files 路径越界（../escape）：类型合法但内容不合法，
            // 运行时按能力模块合同拒绝执行
            module: {
              kind: "capability-module-v1",
              name: "broken-capability",
              entry: "../escape.mjs",
              files: [{ path: "../escape.mjs", content: "process.exit(0)" }],
            },
          },
        ],
        createdBy: "principal-local",
      },
    );
    const summary = await app.runtime.submitTask(
      {
        ...SUMMARY_TASK,
        requires: ["broken-capability"],
        inputs: [join(CFS, "inputs", "changed-files.json")],
      },
      { purpose: "evaluation", snapshotId: bad.snapshot.id },
    );
    expect(summary.state).toBe("failed");
    // 内容解析阶段即拒绝，无进程执行（exitCode=null → execution_aborted）
    expect(summary.failureReason).toBe("execution_aborted");
  });
});
