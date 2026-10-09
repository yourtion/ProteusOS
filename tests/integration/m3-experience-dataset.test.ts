import { afterAll, describe, expect, it } from "vitest";
import type { AppInstance } from "../../src/app/instance.ts";
import { bootSeededInstance, fixturePath } from "../helpers.ts";

/**
 * M3 切片③：冻结经验集（ExperienceDataset）。
 * - 显式成员清单（cutoff 或 runIds）+ 内容摘要；固定成员而非查询语句
 * - 不可变、digest 幂等；后续新经验不进入既有冻结（窗口固定）
 * - 学习投影：experience × run/task × decision_calls（选择值/弃权）× 预算
 * - 成员记录缺失如实为 null（不可回放则显式标注），不悄悄填充
 */

let inst: AppInstance | undefined;
afterAll(() => {
  inst?.close();
});

function instance(): AppInstance {
  inst ??= bootSeededInstance();
  return inst;
}

const BASE = {
  requestedBy: "principal-local",
  goal: "统计摘要（经验冻结测试）",
  inputs: [fixturePath("input-a")],
  budget: { maxAttempts: 2, maxWallClockSeconds: 60 },
  acceptance: {
    outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
    verifier: "stats-acceptance",
  },
};

describe("M3：冻结经验集", () => {
  it("cutoff 冻结：显式成员 + 摘要；新经验不进入既有窗口（幂等）", async () => {
    const app = instance();
    const first = await app.runtime.submitTask(BASE);
    expect(first.state).toBe("succeeded");

    const frozen = app.evolution.freezeExperienceWindow({
      purpose: "development",
      createdBy: "principal-local",
    });
    expect(frozen.created).toBe(true);
    expect(frozen.memberCount).toBe(1);
    expect(frozen.dataset.memberExperienceIds).toHaveLength(1);
    expect(frozen.dataset.filterVersion).toContain("cutoff");

    // 同 cutoff 再冻结：digest 幂等复用
    const again = app.evolution.freezeExperienceWindow({
      purpose: "development",
      cutoffAt: frozen.dataset.cutoffAt,
      createdBy: "principal-local",
    });
    expect(again.created).toBe(false);
    expect(again.dataset.id).toBe(frozen.dataset.id);

    // 窗口之后的新经验不进入既有冻结
    await app.runtime.submitTask({ ...BASE, goal: "统计摘要（第二批）" });
    const view = app.evolution.experienceDatasetView(frozen.dataset.id);
    expect(view.members).toHaveLength(1);
    expect(view.members[0]!.taskGoal).toBe("统计摘要（经验冻结测试）");
  });

  it("学习投影：决策选择值、弃权状态、预算与任务声明可追溯", async () => {
    const app = instance();
    const run = await app.runtime.submitTask({
      ...BASE,
      goal: "统计摘要（决策投影）",
    });
    expect(run.state).toBe("succeeded");

    const frozen = app.evolution.freezeExperienceWindow({
      purpose: "development",
      runIds: [run.runId],
      createdBy: "principal-local",
    });
    expect(frozen.dataset.filterVersion).toContain("explicit");

    const { members } = app.evolution.experienceDatasetView(frozen.dataset.id);
    expect(members).toHaveLength(1);
    const member = members[0]!;
    expect(member.runId).toBe(run.runId);
    expect(member.result).toBe("succeeded");
    expect(member.runPurpose).toBe("normal");
    expect(member.requires).toEqual([]);
    expect(member.budget).toEqual({ reservedAttempts: 2, reservedSeconds: 60 });
    // seed 图的 route 决策（decision-rule）被投影，选择 local-process
    expect(member.decisionCalls.length).toBeGreaterThanOrEqual(1);
    const route = member.decisionCalls.find((c) => c.nodeId === "route");
    expect(route?.kind).toBe("local");
    expect(route?.chosenOption).toBe("local-process");
    expect(route?.state).toBe("value");
  });

  it("数据集不可变：记录只能读取；用途许可与过滤版本入库", async () => {
    const app = instance();
    const frozen = app.evolution.freezeExperienceWindow({
      purpose: "regression",
      createdBy: "principal-local",
      permissionScope: "organism:organism-default",
    });
    const stored = app.storage.getExperienceDataset(frozen.dataset.id)!;
    expect(stored.purpose).toBe("regression");
    expect(stored.permissionScope).toBe("organism:organism-default");
    expect(app.storage.listExperienceDatasets("regression", 10)).toHaveLength(1);
    expect(app.storage.findExperienceDatasetByDigest(stored.digest)!.id).toBe(stored.id);

    // 事件留痕
    const events = app.storage.listEvents({ streamId: `dataset-${stored.id}` }, 10);
    expect(events.map((e) => e.type)).toEqual(["dataset.frozen"]);
  });
});
