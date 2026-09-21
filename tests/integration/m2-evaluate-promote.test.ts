import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AcpExecutor } from "../../src/adapters/executor-acp/index.ts";
import { LocalProcessExecutor } from "../../src/adapters/executor-process/index.ts";
import type { AppInstance } from "../../src/app/instance.ts";
import { evaluationPlanDigest } from "../../src/evolution/index.ts";
import { ensureCapabilityGenome, makeCapabilityPolicyContent } from "../../src/evolution/assets.ts";
import type { CapabilityModule } from "../../src/runtime/capability.ts";
import type { ExecutorProvider } from "../../src/runtime/types.ts";
import { canonicalJson } from "../../src/storage/blobs.ts";
import { bootSeededInstance, fixturePath, installCustomGenome } from "../helpers.ts";

/**
 * M2 切片④：独立评估 → operator 晋升 → 接替（自举故事步骤 4-6）。
 * 失败场景（roadmap §4）：
 * - 候选评估失败禁止晋升，旧默认行为继续有效
 * - 候选更换 evaluator 降低门槛 → 评估计划钉住的裁判阻止自我放行
 * - 双候选同基准同时晋升：一胜一 stale，stale 候选与证据保留
 * - Promotion 提交成功响应丢失 → operationId 读回，revision 不再增加
 */

const FAKE_AGENT = fileURLToPath(new URL("../fixtures/acp/fake-agent.mjs", import.meta.url));
const M2 = fileURLToPath(new URL("../fixtures/m2", import.meta.url));
const SPEC = readFileSync(join(M2, "specs", "changed-file-summary-spec.md"), "utf8");

let inst: AppInstance | undefined;
afterAll(() => {
  inst?.close();
});

function instance(): AppInstance {
  // 评估闭环同时需要：fake-acp（builder 委托）与 local-process（stats 回归/基线）
  inst ??= bootSeededInstance(
    undefined,
    new Map<string, ExecutorProvider>([
      ["fake-acp", new AcpExecutor({ name: "fake-acp", agentEntry: FAKE_AGENT })],
      [
        "local-process",
        new LocalProcessExecutor(
          fileURLToPath(
            new URL("../../src/adapters/executor-process/stats-worker.mjs", import.meta.url),
          ),
        ),
      ],
    ]),
  );
  return inst;
}

const SUMMARY_TASK = {
  requestedBy: "principal-local",
  goal: "对变更清单生成可验证的文件分类摘要",
  inputs: [join(M2, "inputs", "changed-files.json")],
  budget: { maxAttempts: 3, maxWallClockSeconds: 60 },
  requires: ["changed-file-summary"],
  acceptance: {
    outputSchema: join(M2, "schemas", "changed-file-summary.schema.json"),
    expectedOutput: join(M2, "evals", "summary-output.json"),
    verifier: "stats-acceptance",
  },
};

const REGRESSION_TASK = {
  goal: "统计摘要（既有能力回归）",
  inputs: [fixturePath("input-a")],
  budget: { maxAttempts: 3, maxWallClockSeconds: 60 },
  acceptance: {
    outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
    verifier: "stats-acceptance",
  },
};

const EVAL_PLAN = {
  newCapability: SUMMARY_TASK,
  regression: REGRESSION_TASK,
  requestedBy: "principal-local",
};

async function buildCandidate(hypothesis: string) {
  const app = instance();
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
  if (builder.state !== "succeeded") {
    throw new Error(`builder run 失败：${builder.failureReason}`);
  }
  return app.evolution.collectCandidate(builder.runId, {
    capability: "changed-file-summary",
    hypothesis,
    proposedBy: "principal-local",
    evaluationPlan: EVAL_PLAN,
  }).candidate;
}

/** 人工构造候选（不经 builder）：给定能力模块与可选的快照槽位覆盖 */
function manualCandidate(
  module: CapabilityModule,
  opts: { id: string; hypothesis: string; overrideEvaluatorWith?: object },
) {
  const app = instance();
  const base = app.kernel.getOrganism("organism-default")!;
  const genome = ensureCapabilityGenome(
    { kernel: app.kernel, storage: app.storage, blobs: app.blobs, clock: { now: Date.now } },
    {
      baseSnapshotId: base.activeGenomeId!,
      capabilities: [{ name: "changed-file-summary", module }],
      createdBy: "principal-local",
    },
  );
  const proposedSnapshotId = opts.overrideEvaluatorWith
    ? (() => {
        const { digest, ref } = app.blobs.write(canonicalJson(opts.overrideEvaluatorWith));
        const version = app.kernel.registerVersion({
          artifact: app.storage.getArtifact("stats-acceptance")!,
          schemaVersion: 2,
          contentDigest: digest,
          contentRef: ref,
          parents: [],
          dependencies: [],
          createdBy: "principal-local",
        });
        return app.kernel.createSnapshot(
          { ...genome.snapshot.bindings, "acceptance-evaluator": version.id },
          "principal-local",
        ).id;
      })()
    : genome.snapshot.id;

  app.storage.tx(() => {
    app.storage.insertCandidate({
      id: opts.id,
      organismId: "organism-default",
      baseSnapshotId: base.activeGenomeId!,
      baseRevision: base.revision,
      proposedSnapshotId,
      hypothesis: opts.hypothesis,
      proposedBy: "principal-local",
      sourceRefs: {
        capability: "changed-file-summary",
        manual: "true",
        evaluationPlanDigest: evaluationPlanDigest(EVAL_PLAN),
      },
      datasetRef: null,
      createdAt: Date.now(),
    });
    app.storage.appendEvent({
      streamId: `candidate-${opts.id}`,
      type: "candidate.proposed",
      payload: { candidateId: opts.id, capability: "changed-file-summary" },
      organismId: "organism-default",
      occurredAt: Date.now(),
    });
  });
  return app.storage.getCandidate(opts.id)!;
}

async function expectEvaluationRejected(candidateId: string) {
  const result = await instance().evolution.evaluateCandidate(candidateId, EVAL_PLAN);
  expect(result.evaluation.verdict).toBe("rejected");
  return result;
}

/** 好实现的内容变体（尾部注释保证 digest 不同，避开候选去重） */
function goodModuleVariant(tag: string): CapabilityModule {
  return {
    kind: "capability-module-v1",
    name: "changed-file-summary",
    entry: "index.mjs",
    files: [
      {
        path: "index.mjs",
        content: `${readFileSync(join(M2, "capability", "changed-file-summary.mjs"), "utf8")}\n// variant ${tag}\n`,
      },
    ],
  };
}

describe("M2 切片④：独立评估与晋升", () => {
  it("评估 eligible → operator 晋升 → active 切换、revision 前进、候选 adopted", async () => {
    const app = instance();
    const candidate = await buildCandidate("标准候选 A");
    const g0 = app.kernel.getOrganism("organism-default")!.activeGenomeId;

    const { evaluation, status } = await app.evolution.evaluateCandidate(candidate.id, EVAL_PLAN);
    expect(evaluation.verdict).toBe("eligible");
    expect(status).toBe("eligible");
    expect(evaluation.runs.map((r) => `${r.role}:${r.state}`)).toEqual([
      "new-capability:succeeded",
      "regression:succeeded",
      "baseline:succeeded",
    ]);
    // 评估 Run 都是 purpose=evaluation 且不改变 active
    expect(app.kernel.getOrganism("organism-default")!.activeGenomeId).toBe(g0);
    // 评估记录与事件留痕
    expect(app.storage.getEvaluation(evaluation.id)).toBeDefined();
    expect(
      app.storage.listEvents({ streamId: `candidate-${candidate.id}` }, 20).map((e) => e.type),
    ).toEqual(["candidate.proposed", "candidate.evaluating", "candidate.evaluated"]);

    const outcome = app.evolution.promote(candidate.id, {
      authorizedBy: "principal-local",
      operationId: "op-e2e-1",
      note: "operator 验收自举故事",
    });
    expect(outcome.result).toBe("promoted");
    if (outcome.result !== "promoted") return;
    const organism = app.kernel.getOrganism("organism-default")!;
    expect(organism.activeGenomeId).toBe(candidate.proposedSnapshotId);
    // seed 安装是 revision 1，晋升前进到 2；CAS 以候选基准 revision 为条件
    expect(organism.revision).toBe(2);
    expect(outcome.promotion.expectedRevision).toBe(candidate.baseRevision);
    expect(outcome.promotion.resultRevision).toBe(2);
    expect(outcome.promotion.evaluationRef).toBe(evaluation.id);
    expect(app.evolution.candidateStatus(candidate.id).status).toBe("adopted");
  });

  it("未评估 / 非 eligible 的候选禁止晋升；operationId 幂等读回不重复加 revision", async () => {
    const app = instance();
    // 独立变体（内容不同 → 不同快照，避开 digest 去重）
    const fresh = manualCandidate(goodModuleVariant("-fresh"), {
      id: "cand-unEvaluated",
      hypothesis: "未评估候选",
    });
    expect(() => app.evolution.promote(fresh.id, { authorizedBy: "principal-local" })).toThrowError(
      /缺少 eligible 评估/,
    );

    // 已晋升候选同 operationId 重试：already 读回
    const adopted = app.storage
      .listCandidates("organism-default", 10)
      .find((c) => app.evolution.candidateStatus(c.id).status === "adopted")!;
    const before = app.kernel.getOrganism("organism-default")!.revision;
    const retried = app.evolution.promote(adopted.id, {
      authorizedBy: "principal-local",
      operationId: "op-e2e-1",
    });
    expect(retried.result).toBe("already");
    expect(app.kernel.getOrganism("organism-default")!.revision).toBe(before);
    expect(app.storage.listPromotions("organism-default", 10)).toHaveLength(1);
  });

  it("放水候选：裁判槽位换成恒过命令 + 坏输出 → 钉住的裁判判负 → rejected 且禁止晋升", async () => {
    const app = instance();
    const activeBefore = app.kernel.getOrganism("organism-default")!.activeGenomeId;
    const badModule: CapabilityModule = {
      kind: "capability-module-v1",
      name: "changed-file-summary",
      entry: "index.mjs",
      files: [
        {
          path: "index.mjs",
          content:
            'import { writeFileSync } from "node:fs";\nwriteFileSync("output.json", JSON.stringify({ garbage: true }));\n',
        },
      ],
    };
    const candidate = manualCandidate(badModule, {
      id: "cand-evil-evaluator",
      hypothesis: "放水裁判 + 坏输出",
      overrideEvaluatorWith: {
        schemaVersion: 1,
        kind: "test-runner-v1",
        command: ["node", "-e", "process.exit(0)"],
      },
    });

    const { evaluation, status } = await app.evolution.evaluateCandidate(candidate.id, EVAL_PLAN);
    // 评估 Run 钉住 hybrid 裁判：坏输出 schema 校验失败 → rejected
    expect(evaluation.verdict).toBe("rejected");
    expect(status).toBe("rejected");
    expect(evaluation.runs.find((r) => r.role === "new-capability")!.state).toBe("failed");
    // 证据保留；旧默认行为继续有效
    expect(app.storage.getEvaluation(evaluation.id)).toBeDefined();
    expect(app.kernel.getOrganism("organism-default")!.activeGenomeId).toBe(activeBefore);

    expect(() =>
      app.evolution.promote(candidate.id, { authorizedBy: "principal-local" }),
    ).toThrowError(/缺少 eligible 评估/);
  });

  it("schema 合法但内容错误的新能力输出不能通过固定期望结果验收", async () => {
    const badModule: CapabilityModule = {
      kind: "capability-module-v1",
      name: "changed-file-summary",
      entry: "index.mjs",
      files: [
        {
          path: "index.mjs",
          content:
            'import { writeFileSync } from "node:fs";\nwriteFileSync("output.json", JSON.stringify({ summary: { total: 999, files: [{ path: "nonexistent.ts", category: "docs" }] } }));\n',
        },
      ],
    };
    const candidate = manualCandidate(badModule, {
      id: "cand-schema-valid-wrong-answer",
      hypothesis: "格式正确但语义错误",
    });

    const { evaluation } = await expectEvaluationRejected(candidate.id);
    expect(evaluation.runs.find((r) => r.role === "new-capability")!.failureReason).toBe(
      "acceptance_failed",
    );
  });

  it("新能力任务未声明候选能力时拒绝评估计划", async () => {
    const candidate = manualCandidate(goodModuleVariant("-plan-bypass"), {
      id: "cand-plan-bypass",
      hypothesis: "评估计划不能绕过候选能力",
    });
    const bypassPlan = {
      newCapability: REGRESSION_TASK,
      regression: REGRESSION_TASK,
      requestedBy: "principal-local",
    };

    await expect(
      instance().evolution.evaluateCandidate(candidate.id, bypassPlan),
    ).rejects.toThrowError(/new-capability.*changed-file-summary|候选能力/);
  });

  it("候选能力组合保留基准快照中的既有能力路由", () => {
    const app = bootSeededInstance();
    try {
      const base = app.kernel.getOrganism("organism-default")!.activeGenomeId!;
      const first = ensureCapabilityGenome(
        { kernel: app.kernel, storage: app.storage, blobs: app.blobs, clock: { now: Date.now } },
        {
          baseSnapshotId: base,
          capabilities: [{ name: "first-capability", module: goodModuleVariant("-first") }],
          createdBy: "principal-local",
        },
      );
      const second = ensureCapabilityGenome(
        { kernel: app.kernel, storage: app.storage, blobs: app.blobs, clock: { now: Date.now } },
        {
          baseSnapshotId: first.snapshot.id,
          capabilities: [{ name: "second-capability", module: goodModuleVariant("-second") }],
          createdBy: "principal-local",
        },
      );
      const policy = JSON.parse(
        app.blobs.read(second.versions.get("routing-policy")!.contentRef),
      ) as ReturnType<typeof makeCapabilityPolicyContent>;

      expect(policy).toEqual(
        makeCapabilityPolicyContent(["first-capability", "second-capability"]),
      );
    } finally {
      app.close();
    }
  });

  it("rollback 拒绝从未被采用的候选快照", () => {
    const app = instance();
    const candidate = manualCandidate(goodModuleVariant("-never-adopted"), {
      id: "cand-never-adopted",
      hypothesis: "未采用候选",
    });

    expect(() =>
      app.evolution.rollback({
        toSnapshotId: candidate.proposedSnapshotId,
        authorizedBy: "principal-local",
      }),
    ).toThrowError(/历史.*采用|不能回滚/);
  });

  it("基线对照失败 → inconclusive（评估环境不可信，不判 rejected）", async () => {
    const app = instance();
    // 坏基准：图引用未装配执行器 → 基线 Run 必失败；候选图（组合模板）不受影响
    installCustomGenome(app, {
      graph: {
        schemaVersion: 2,
        kind: "dag-v1",
        nodes: [
          { id: "work", type: "execute", executor: "ghost-executor", dependsOn: [] },
          {
            id: "check",
            type: "verify",
            verifier: "stats-acceptance",
            inputFrom: "work",
            dependsOn: ["work"],
          },
        ],
      },
    });
    const goodModule: CapabilityModule = {
      kind: "capability-module-v1",
      name: "changed-file-summary",
      entry: "index.mjs",
      files: [
        {
          path: "index.mjs",
          content: readFileSync(join(M2, "capability", "changed-file-summary.mjs"), "utf8"),
        },
      ],
    };
    const candidate = manualCandidate(goodModule, {
      id: "cand-inconclusive",
      hypothesis: "基线环境损坏场景",
    });

    const { evaluation, status } = await app.evolution.evaluateCandidate(candidate.id, EVAL_PLAN);
    expect(evaluation.verdict).toBe("inconclusive");
    expect(evaluation.runs.find((r) => r.role === "baseline")!.state).toBe("failed");
    expect(evaluation.runs.find((r) => r.role === "new-capability")!.state).toBe("succeeded");
    expect(status).toBe("rejected"); // 投影显示已评估未通过；verdict 区分 inconclusive
    // inconclusive 也禁止晋升
    expect(() =>
      app.evolution.promote(candidate.id, { authorizedBy: "principal-local" }),
    ).toThrowError(/缺少 eligible 评估/);
  });

  it("双候选同基准先后晋升：一胜一 stale；stale 候选与证据保留", async () => {
    const app = instance();
    // 恢复可运行基准（上一测试装了坏图）：回滚到 adopted 候选的基准（seed G0）
    const rollback = app.evolution.rollback({
      toSnapshotId: findSeedSnapshot(app),
      authorizedBy: "principal-local",
      note: "恢复可运行基准",
    });
    expect(rollback.result).toBe("promoted");

    // 同基准、不同产出的两个候选（variant 注释保证 digest 不同）
    const a = manualCandidate(goodModuleVariant("-race-a"), {
      id: "cand-race-a",
      hypothesis: "并发候选 A",
    });
    const b = manualCandidate(goodModuleVariant("-race-b"), {
      id: "cand-race-b",
      hypothesis: "并发候选 B",
    });
    expect(a.baseSnapshotId).toBe(b.baseSnapshotId);
    expect(a.baseRevision).toBe(b.baseRevision);
    expect(a.proposedSnapshotId).not.toBe(b.proposedSnapshotId);

    const evalA = await app.evolution.evaluateCandidate(a.id, EVAL_PLAN);
    const evalB = await app.evolution.evaluateCandidate(b.id, EVAL_PLAN);
    expect(evalA.evaluation.verdict).toBe("eligible");
    expect(evalB.evaluation.verdict).toBe("eligible");

    const first = app.evolution.promote(a.id, { authorizedBy: "principal-local" });
    expect(first.result).toBe("promoted");

    const second = app.evolution.promote(b.id, { authorizedBy: "principal-local" });
    expect(second.result).toBe("stale");
    expect(app.evolution.candidateStatus(b.id).status).toBe("stale");
    // 旧候选记录与评估证据保留
    expect(app.storage.getCandidate(b.id)).toBeDefined();
    expect(app.storage.listEvaluationsByCandidate(b.id, 5)).toHaveLength(1);
  });

  it("接替：R1 缺口 waiting → 晋升后 supersedeAndReplace → R2 用新能力完成原任务", async () => {
    const app = instance();
    // 当前 active = 候选 A 的快照（含能力）。先回滚到不含能力的基准制造缺口
    const candidateA = app.storage
      .listCandidates("organism-default", 10)
      .find((c) => app.evolution.candidateStatus(c.id).status === "adopted")!;
    const rollbackToBase = app.evolution.rollback({
      toSnapshotId: candidateA.baseSnapshotId,
      authorizedBy: "principal-local",
      note: "接替测试：回到缺能力基准",
    });
    expect(rollbackToBase.result).toBe("promoted");
    const g0 = app.kernel.getOrganism("organism-default")!.activeGenomeId;

    // R1：缺能力等待
    const r1 = await app.runtime.submitTask(SUMMARY_TASK);
    expect(r1.state).toBe("waiting");

    // 能力经 rollback 方式恢复（revision 继续前进，不倒退）
    const restore = app.evolution.rollback({
      toSnapshotId: candidateA.proposedSnapshotId,
      authorizedBy: "principal-local",
      note: "接替测试：恢复能力快照",
    });
    expect(restore.result).toBe("promoted");
    const g1 = app.kernel.getOrganism("organism-default")!.activeGenomeId;
    expect(g1).not.toBe(g0);

    const { superseded, successor } = await app.evolution.supersedeAndReplace(r1.runId, {
      note: "能力已由新快照提供",
    });
    expect(superseded.state).toBe("failed");
    const r1Record = app.storage.getRun(r1.runId)!;
    expect(r1Record.failureReason).toBe("superseded");
    expect(r1Record.snapshotId).toBe(g0); // R1 固定原快照

    expect(successor.state).toBe("succeeded"); // R2 用新能力完成摘要
    const r2 = app.storage.getRun(successor.runId)!;
    expect(r2.supersedesRunId).toBe(r1.runId);
    expect(r2.snapshotId).toBe(g1);
    expect(r2.taskRevision).toBe(r1Record.taskRevision + 1);
    expect(r2.purpose).toBe("normal");

    // 接替事件留痕
    const events = app.storage.listEvents({ runId: r1.runId }, 200);
    expect(events.some((e) => e.type === "run.superseded")).toBe(true);
  });
});

function findSeedSnapshot(app: AppInstance): string {
  const organism = app.kernel.getOrganism("organism-default")!;
  // 找回最初含三槽位的 seed 快照：沿候选 A 基准链
  const candidates = app.storage.listCandidates("organism-default", 20);
  const adopted = candidates.find((c) => app.evolution.candidateStatus(c.id).status === "adopted");
  if (adopted) return adopted.baseSnapshotId;
  return organism.activeGenomeId!;
}
