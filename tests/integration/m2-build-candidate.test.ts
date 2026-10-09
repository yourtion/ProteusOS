import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AcpExecutor } from "../../src/adapters/executor-acp/index.ts";
import type { AppInstance } from "../../src/app/instance.ts";
import { ensureCapabilityGenome } from "../../src/evolution/assets.ts";
import type { ExecutorProvider } from "../../src/runtime/types.ts";
import { bootSeededInstance, upgradeJudgeToActive, fixturePath } from "../helpers.ts";

/**
 * M2 切片③：委托构建与候选构造（自举故事步骤 2-3）。
 * 委托 fake builder（真实 ACP 协议）实现能力 → test-runner 独立验收 →
 * 采集工作区产出注册为不可变 ArtifactVersion → 组合候选快照 → Candidate 记录。
 * 测试未通过的产出不能构造候选。
 */

const FAKE_AGENT = fileURLToPath(new URL("../fixtures/acp/fake-agent.mjs", import.meta.url));
const M2 = fileURLToPath(new URL("../fixtures/m2", import.meta.url));
const SPEC = readFileSync(join(M2, "specs", "changed-file-summary-spec.md"), "utf8");
const EVAL_PLAN = {
  newCapability: {
    goal: "对变更清单生成可验证的文件分类摘要",
    inputs: [join(M2, "inputs", "changed-files.json")],
    budget: { maxAttempts: 3, maxWallClockSeconds: 60 },
    requires: ["changed-file-summary"],
    acceptance: {
      outputSchema: join(M2, "schemas", "changed-file-summary.schema.json"),
      expectedOutput: join(M2, "evals", "summary-output.json"),
      verifier: "stats-acceptance",
    },
  },
  regression: {
    goal: "统计摘要（既有能力回归）",
    inputs: [fixturePath("input-a")],
    budget: { maxAttempts: 3, maxWallClockSeconds: 60 },
    acceptance: {
      outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
      verifier: "stats-acceptance",
    },
  },
  requestedBy: "principal-local",
};

let inst: AppInstance | undefined;
afterAll(() => {
  inst?.close();
});

// M3 裁判拆分前置：组合能力候选前 active 裁判须为 hybrid（测试捷径）
beforeAll(() => {
  upgradeJudgeToActive(instance());
});

function instance(): AppInstance {
  inst ??= bootSeededInstance(
    undefined,
    new Map<string, ExecutorProvider>([
      ["fake-acp", new AcpExecutor({ name: "fake-acp", agentEntry: FAKE_AGENT })],
    ]),
  );
  return inst;
}

function build(goal: string) {
  return instance().evolution.build({
    capability: "changed-file-summary",
    goal,
    inputs: [join(M2, "capability-tests")],
    executorName: "fake-acp",
    testCommand: ["node", "--test", "inputs/capability-tests/changed-file-summary.test.mjs"],
    budget: { maxAttempts: 2, maxWallClockSeconds: 60 },
    outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
    requestedBy: "principal-local",
  });
}

describe("M2 切片③：委托构建与候选构造", () => {
  it("委托构建 → 独立测试验收 → 采集构造候选（proposed）", async () => {
    const app = instance();
    const summary = await build(SPEC);

    expect(summary.state).toBe("succeeded");
    expect(summary.nodes.map((n) => `${n.id}:${n.state}`)).toEqual([
      "dev:succeeded",
      "check:succeeded",
    ]);

    const { candidate, created } = app.evolution.collectCandidate(summary.runId, {
      capability: "changed-file-summary",
      hypothesis: "为 changed-file-summary 增加派生能力（测试）",
      proposedBy: "principal-local",
      evaluationPlan: EVAL_PLAN,
    });

    expect(created).toBe(true);
    const base = app.kernel.getOrganism("organism-default")!;
    expect(candidate.baseSnapshotId).toBe(base.activeGenomeId);
    expect(candidate.baseRevision).toBe(base.revision);
    expect(candidate.sourceRefs["builderRunId"]).toBe(summary.runId);
    expect(candidate.sourceRefs["capability"]).toBe("changed-file-summary");
    expect(candidate.sourceRefs["evaluationPlanDigest"]).toMatch(/^[a-f0-9]{64}$/);
    expect(candidate.sourceRefs["builderOutputDigest"]).toMatch(/^[a-f0-9]{64}$/);

    await expect(
      app.evolution.evaluateCandidate(candidate.id, {
        ...EVAL_PLAN,
        newCapability: { ...EVAL_PLAN.newCapability, goal: "事后替换的宽松评估任务" },
      }),
    ).rejects.toThrowError(/固定的摘要不一致/);

    // 候选快照包含能力槽位与预注册三版本
    const resolved = app.kernel.resolveSnapshot(candidate.proposedSnapshotId);
    expect(resolved.versions.has("capability/changed-file-summary")).toBe(true);
    expect(resolved.versions.has("task-graph")).toBe(true);
    expect(resolved.versions.has("routing-policy")).toBe(true);
    expect(resolved.versions.has("acceptance-evaluator")).toBe(true);

    // 事件投影：proposed
    expect(app.evolution.candidateStatus(candidate.id).status).toBe("proposed");
    const events = app.storage.listEvents({ streamId: `candidate-${candidate.id}` }, 10);
    expect(events.map((e) => e.type)).toEqual(["candidate.proposed"]);

    // active 未被候选构造触碰
    expect(app.kernel.getOrganism("organism-default")!.activeGenomeId).toBe(
      candidate.baseSnapshotId,
    );
  });

  it("同产出重复 collect 按 proposedSnapshot 去重，复用既有候选", async () => {
    const app = instance();
    const first = await build(SPEC);
    const { candidate: c1 } = app.evolution.collectCandidate(first.runId, {
      capability: "changed-file-summary",
      hypothesis: "第一次",
      proposedBy: "principal-local",
      evaluationPlan: EVAL_PLAN,
    });
    // 新 builder run 同样产出（同 fixture 实现 → 同 digest → 同快照）
    const second = await build(SPEC);
    const { candidate: c2, created } = app.evolution.collectCandidate(second.runId, {
      capability: "changed-file-summary",
      hypothesis: "第二次",
      proposedBy: "principal-local",
      evaluationPlan: EVAL_PLAN,
    });
    expect(created).toBe(false);
    expect(c2.id).toBe(c1.id);
    expect(app.storage.listCandidates("organism-default", 10)).toHaveLength(1);
  });

  it("BUGGY builder：能力测试失败 → builder Run failed → 拒绝构造候选", async () => {
    const app = instance();
    const before = app.storage.listCandidates("organism-default", 10).length;
    const summary = await build(`BUGGY\n${SPEC}`);
    expect(summary.state).toBe("failed");
    expect(summary.failureReason).toBe("acceptance_failed");
    // dev 节点执行成功（agent 完成产出），check 节点裁判不通过
    expect(summary.nodes.find((n) => n.id === "dev")!.state).toBe("succeeded");
    expect(summary.nodes.find((n) => n.id === "check")!.state).toBe("failed");

    expect(() =>
      app.evolution.collectCandidate(summary.runId, {
        capability: "changed-file-summary",
        hypothesis: "不应成功",
        proposedBy: "principal-local",
        evaluationPlan: EVAL_PLAN,
      }),
    ).toThrowError(/测试未通过的产出不能构造候选/);
    // 没有产生新候选
    expect(app.storage.listCandidates("organism-default", 10).length).toBe(before);
  });

  it("测试命令通过但未写约定产出路径 → builder 验收失败", async () => {
    const app = instance();
    // wordcount 分支：agent 写 src/wordcount.mjs；裁判恒过（此处只测采集防御）
    const summary = await app.evolution.build({
      capability: "changed-file-summary",
      goal: "实现 src/wordcount.mjs：导出 countWords(text)，按空白切分返回词数。",
      inputs: [join(M2, "capability-tests")],
      executorName: "fake-acp",
      testCommand: ["node", "-e", "process.exit(0)"],
      budget: { maxAttempts: 2, maxWallClockSeconds: 60 },
      outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
      requestedBy: "principal-local",
    });
    expect(summary.state).toBe("failed");
    expect(summary.failureReason).toBe("acceptance_failed");
    expect(() =>
      app.evolution.collectCandidate(summary.runId, {
        capability: "changed-file-summary",
        hypothesis: "不应成功",
        proposedBy: "principal-local",
        evaluationPlan: EVAL_PLAN,
      }),
    ).toThrowError(/测试未通过的产出不能构造候选/);
  });

  it("collect 不存在的 run / 未安装 active 的防御", () => {
    const app = instance();
    expect(() =>
      app.evolution.collectCandidate("run-nonexistent", {
        capability: "x",
        hypothesis: "",
        proposedBy: "principal-local",
        evaluationPlan: EVAL_PLAN,
      }),
    ).toThrowError(/不存在/);
  });

  it("builder 验收后工作区产物被修改时拒绝采集", async () => {
    const app = instance();
    const summary = await build(SPEC);
    const implPath = join(
      app.root,
      "workspaces",
      summary.runId,
      "dev",
      "src",
      "changed-file-summary.mjs",
    );
    appendFileSync(implPath, "\n// tampered after acceptance\n", "utf8");

    expect(() =>
      app.evolution.collectCandidate(summary.runId, {
        capability: "changed-file-summary",
        hypothesis: "不应采集已变化产物",
        proposedBy: "principal-local",
        evaluationPlan: EVAL_PLAN,
      }),
    ).toThrowError(/验收后.*变化|摘要不一致/);
  });

  it("基准已有其他能力时，候选评估计划必须覆盖其回归", async () => {
    const app = bootSeededInstance(
      undefined,
      new Map<string, ExecutorProvider>([
        ["fake-acp", new AcpExecutor({ name: "fake-acp", agentEntry: FAKE_AGENT })],
      ]),
    );
    try {
      upgradeJudgeToActive(app);
      const organism = app.kernel.getOrganism("organism-default")!;
      const existing = ensureCapabilityGenome(
        { kernel: app.kernel, storage: app.storage, blobs: app.blobs, clock: { now: Date.now } },
        {
          baseSnapshotId: organism.activeGenomeId!,
          capabilities: [
            {
              name: "existing-capability",
              module: {
                kind: "capability-module-v1",
                name: "existing-capability",
                entry: "index.mjs",
                files: [{ path: "index.mjs", content: "// existing fixture\n" }],
              },
            },
          ],
          createdBy: "principal-local",
        },
      );
      expect(
        app.kernel.installAsActive("organism-default", existing.snapshot.id, organism.revision).ok,
      ).toBe(true);
      const builder = await app.evolution.build({
        capability: "changed-file-summary",
        goal: SPEC,
        inputs: [join(M2, "capability-tests")],
        executorName: "fake-acp",
        testCommand: ["node", "--test", "inputs/capability-tests/changed-file-summary.test.mjs"],
        budget: { maxAttempts: 2, maxWallClockSeconds: 60 },
        outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
        requestedBy: "principal-local",
      });
      expect(builder.state).toBe("succeeded");

      expect(() =>
        app.evolution.collectCandidate(builder.runId, {
          capability: "changed-file-summary",
          hypothesis: "评估计划缺少已有能力回归",
          proposedBy: "principal-local",
          evaluationPlan: EVAL_PLAN,
        }),
      ).toThrowError(/未覆盖已有能力回归：existing-capability/);
    } finally {
      app.close();
    }
  });
});
