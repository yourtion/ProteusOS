import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AppInstance } from "../../src/app/instance.ts";
import { ensureCapabilityGenome } from "../../src/evolution/assets.ts";
import type { CapabilityModule } from "../../src/runtime/capability.ts";
import { bootSeededInstance, fixturePath, upgradeJudgeToActive } from "../helpers.ts";

/**
 * 从冻结经验归纳策略候选（"从历史失败提出改进"）。
 * 场景：能力已就位但任务未声明 requires——summary 任务（特征 hasChangeIntent）
 * 被 rule-v1 兜底路由到 local-process 而失败；stats 任务成功。
 * 冻结经验 + 开发集 gold join → 归纳 hasChangeIntent→capability 规则 →
 * 只改 routing-policy 的候选快照（图/能力/裁判固定）。
 */

const CFS = fileURLToPath(new URL("../fixtures/changed-file-summary", import.meta.url));

let inst: AppInstance | undefined;
afterAll(() => {
  inst?.close();
});

function instance(): AppInstance {
  inst ??= bootSeededInstance();
  return inst;
}

const SUMMARY_GOAL = "对变更清单生成可验证的文件分类摘要";
const SUMMARY_TASK = {
  requestedBy: "principal-local",
  goal: SUMMARY_GOAL,
  inputs: [join(CFS, "inputs", "changed-files.json")],
  budget: { maxAttempts: 1, maxWallClockSeconds: 60 },
  // 有意不声明 requires：模拟语义需要能力但未显式声明的任务——
  // 现行策略按 context 兜底 local-process 而失败，构成"历史失败"经验
  acceptance: {
    outputSchema: join(CFS, "schema.json"),
    verifier: "stats-acceptance",
  },
};
const STATS_TASK = {
  requestedBy: "principal-local",
  goal: "统计摘要（经验样本）",
  inputs: [fixturePath("input-a")],
  budget: { maxAttempts: 1, maxWallClockSeconds: 60 },
  acceptance: {
    outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
    verifier: "stats-acceptance",
  },
};

/** 装配：裁判升级 + 能力组合并激活（G_cap：view 图 + rule-v1 兜底策略） */
function bootstrapCapabilityActive(app: AppInstance): string {
  upgradeJudgeToActive(app);
  const module: CapabilityModule = {
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
  const genome = ensureCapabilityGenome(
    { kernel: app.kernel, storage: app.storage, blobs: app.blobs, clock: { now: Date.now } },
    {
      baseSnapshotId: app.kernel.getOrganism("organism-default")!.activeGenomeId!,
      capabilities: [{ name: "changed-file-summary", module }],
      createdBy: "principal-local",
    },
  );
  app.storage.tx(() => {
    const fresh = app.kernel.getOrganism("organism-default")!;
    const result = app.kernel.installAsActive(
      "organism-default",
      genome.snapshot.id,
      fresh.revision,
    );
    if (!result.ok) throw new Error("测试装配 CAS 冲突");
  });
  return genome.snapshot.id;
}

describe("策略候选归纳", () => {
  it("失败经验 + gold join → 只改 routing-policy 的候选；零提议是正常结果", async () => {
    const app = instance();
    const baseSnapshotId = bootstrapCapabilityActive(app);

    // 历史失败：summary 任务被兜底路由到 local-process → 验收失败 ×2
    for (const goal of [SUMMARY_GOAL, `${SUMMARY_GOAL}（第二次）`]) {
      const failed = await app.runtime.submitTask({ ...SUMMARY_TASK, goal });
      expect(failed.state).toBe("failed");
    }
    // 成功经验：stats 任务 ×1（特征 hasStatsIntent 单正例，低于门槛）
    const ok = await app.runtime.submitTask(STATS_TASK);
    expect(ok.state).toBe("succeeded");

    const frozen = app.evolution.freezeExperienceWindow({
      purpose: "development",
      createdBy: "principal-local",
    });
    expect(frozen.memberCount).toBe(3);

    // 无 gold：失败成员无正例 → 零提议（正常结果，不提议候选）
    const noGold = await app.evolution.proposePolicyCandidate({
      datasetId: frozen.dataset.id,
      createdBy: "principal-local",
    });
    expect(noGold.candidate).toBeNull();
    expect(noGold.consolidation.proposals).toHaveLength(0);
    expect(noGold.consolidation.hypothesis).toContain("证据不足");

    // gold join：两个失败成员的 goal 关联正确选项 → 归纳出特征路由
    const proposed = await app.evolution.proposePolicyCandidate({
      datasetId: frozen.dataset.id,
      goldMatches: [
        { goal: SUMMARY_GOAL, choice: "capability/changed-file-summary" },
        { goal: `${SUMMARY_GOAL}（第二次）`, choice: "capability/changed-file-summary" },
      ],
      createdBy: "principal-local",
    });
    expect(proposed.candidate).not.toBeNull();
    const candidate = proposed.candidate!;
    expect(proposed.consolidation.proposals).toHaveLength(1);
    expect(proposed.consolidation.proposals[0]).toMatchObject({
      feature: "hasChangeIntent",
      choose: "capability/changed-file-summary",
      byOrigin: { experience: 0, gold: 2 },
    });
    expect(candidate.hypothesis).toContain("开发集标注 2");
    expect(candidate.sourceRefs["candidateType"]).toBe("policy");
    expect(candidate.sourceRefs["datasetId"]).toBe(frozen.dataset.id);
    expect(app.evolution.candidateStatus(candidate.id).status).toBe("proposed");

    // 候选快照：仅 routing-policy 版本变化（图/能力/裁判/视图固定）
    const baseBindings = app.kernel.resolveSnapshot(baseSnapshotId).snapshot.bindings;
    const candidateBindings = app.kernel.resolveSnapshot(candidate.proposedSnapshotId).snapshot
      .bindings;
    expect(Object.keys(candidateBindings).sort()).toEqual(Object.keys(baseBindings).sort());
    expect(candidateBindings["routing-policy"]).not.toBe(baseBindings["routing-policy"]);
    for (const slot of [
      "task-graph",
      "acceptance-evaluator",
      "decision-view",
      "capability/changed-file-summary",
    ]) {
      expect(candidateBindings[slot]).toBe(baseBindings[slot]);
    }

    // 策略内容：rule-hybrid-v1，归纳规则 + 基准兜底 routes 继承
    const policyContent = JSON.parse(
      app.blobs.read(
        app.kernel.resolveSnapshot(candidate.proposedSnapshotId).versions.get("routing-policy")!
          .contentRef,
      ),
    ) as { kind: string; featureRoutes: unknown[]; routes: unknown[] };
    expect(policyContent.kind).toBe("rule-hybrid-v1");
    expect(policyContent.featureRoutes).toEqual([
      { feature: "hasChangeIntent", choose: "capability/changed-file-summary" },
    ]);
    // 兜底继承基准两条路由：显式 requires 声明路由 + nodeType 兜底
    expect(policyContent.routes).toEqual([
      {
        when: { "capability:changed-file-summary": true },
        choose: "capability/changed-file-summary",
      },
      { when: { nodeType: "execute" }, choose: "local-process" },
    ]);
  });

  it("非 development 许可的数据集拒绝作为学习来源", async () => {
    const app = instance();
    const regression = app.evolution.freezeExperienceWindow({
      purpose: "regression",
      createdBy: "principal-local",
    });
    await expect(
      app.evolution.proposePolicyCandidate({
        datasetId: regression.dataset.id,
        createdBy: "principal-local",
      }),
    ).rejects.toThrowError(/仅 development 许可/);
  });
});
