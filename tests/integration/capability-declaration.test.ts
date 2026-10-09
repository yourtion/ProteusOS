import { afterAll, describe, expect, it } from "vitest";
import type { AppInstance } from "../../src/app/instance.ts";
import { parseCapabilityModule } from "../../src/runtime/capability.ts";
import { bootSeededInstance, fixturePath, installCustomGenome } from "../helpers.ts";

/**
 * 能力声明与缺口等待（自举故事步骤 1 与 7 的 R3 路径）。
 * Task.requires 声明的能力在快照中无 capability/<name> 槽位时，
 * Run 以 waiting 创建并携带截止点；到期 advance 结案 failed/missing_capability。
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
  goal: "变更文件分类摘要（M2 能力缺口测试）",
  budget: { maxAttempts: 3, maxWallClockSeconds: 60 },
};

function submitRequires(
  requires: string[],
  missingCapabilityWaitSeconds: number,
  inputs = [fixturePath("input-a")],
) {
  return instance().runtime.submitTask({
    ...BASE,
    inputs,
    requires,
    missingCapabilityWaitSeconds,
    acceptance: {
      outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
      verifier: "stats-acceptance",
    },
  });
}

describe("能力声明与缺口等待", () => {
  it("能力模块名称拒绝路径分隔符与上级目录逃逸", () => {
    for (const name of ["../../escaped", "nested/capability", "nested\\capability", ".", ".."]) {
      expect(
        parseCapabilityModule({
          kind: "capability-module-v1",
          name,
          entry: "index.mjs",
          files: [{ path: "index.mjs", content: "" }],
        }),
      ).toMatchObject({ ok: false });
    }
  });

  it("声明的能力在快照中缺失 → Run 以 waiting 创建并携带缺口与截止点", async () => {
    const summary = await submitRequires(["changed-file-summary"], 3600);

    expect(summary.state).toBe("waiting");
    expect(summary.nodes).toHaveLength(0); // 不执行图

    const run = instance().storage.getRun(summary.runId)!;
    expect(run.state).toBe("waiting");
    expect(run.missingCapabilities).toEqual(["changed-file-summary"]);
    expect(run.waitingUntil).toBeGreaterThan(run.createdAt);
    expect(run.waitingUntil).toBe(run.createdAt + 3600 * 1000);

    // 事件留痕：run.created payload 携带缺口信息
    const events = instance().storage.listEvents({ runId: summary.runId }, 10);
    const created = events.find((e) => e.type === "run.created")!;
    expect(created.payload["missingCapabilities"]).toEqual(["changed-file-summary"]);
    expect(created.payload["requires"]).toEqual(["changed-file-summary"]);

    // 预算已预留（waiting 是活跃 Run）
    const active = instance().storage.countActiveRuns("organism-default");
    expect(active).toBeGreaterThanOrEqual(1);
  });

  it("advance 未到期 → 保持 waiting；到期 → failed/missing_capability 结案", async () => {
    const app = instance();
    const waiting = await submitRequires(["changed-file-summary"], 3600);

    const before = await app.runtime.advanceRun(waiting.runId);
    expect(before.state).toBe("waiting");
    expect(before.note).toContain("未到");
    expect(app.storage.getRun(waiting.runId)!.state).toBe("waiting");

    // waitSeconds=0：创建即到期
    const expired = await submitRequires(["changed-file-summary"], 0);
    const after = await app.runtime.advanceRun(expired.runId);
    expect(after.state).toBe("failed");
    expect(after.note).toContain("changed-file-summary");

    const run = app.storage.getRun(expired.runId)!;
    expect(run.state).toBe("failed");
    expect(run.failureReason).toBe("missing_capability");
    expect(run.missingCapabilities).toEqual(["changed-file-summary"]);

    // 结案留 Experience 且预算结算（终态后不再占活跃额度）
    const experience = app.storage.getExperienceByRun(expired.runId)!;
    expect(experience.outcome.result).toBe("failed");

    // 终态后再 advance 无操作
    const again = await app.runtime.advanceRun(expired.runId);
    expect(again.state).toBe("failed");
    expect(again.note).toContain("无操作");
  });

  it("无 requires 的任务不受影响，照常执行到终态", async () => {
    const summary = await instance().runtime.submitTask({
      ...BASE,
      goal: "统计摘要（无能力声明）",
      inputs: [fixturePath("input-a")],
      acceptance: {
        outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
        verifier: "stats-acceptance",
      },
    });
    expect(summary.state).toBe("succeeded");
    const run = instance().storage.getRun(summary.runId)!;
    expect(run.missingCapabilities).toBeNull();
    expect(run.waitingUntil).toBeNull();
  });

  it("缺口 Run 固定自身快照：默认指针切换后 snapshotId 不变，且不能被 executeRun 续跑", async () => {
    const app = instance();
    const waiting = await submitRequires(["changed-file-summary"], 3600);
    const g0Snapshot = app.storage.getRun(waiting.runId)!.snapshotId;

    // 模拟期间发生晋升：默认指针切到新快照（revision 递增）
    installCustomGenome(app, {
      graph: {
        schemaVersion: 2,
        kind: "dag-v1",
        nodes: [
          {
            id: "route",
            type: "decision",
            provider: "decision-rule",
            problem: "choice",
            // 内容与 G0 图有差异（多一个可选项），产生新 digest 的新快照
            options: ["local-process", "local-process-alt"],
            context: { nodeType: "execute" },
          },
          { id: "stats", type: "execute", executorFrom: "route", dependsOn: ["route"] },
          {
            id: "check",
            type: "verify",
            verifier: "stats-acceptance",
            inputFrom: "stats",
            dependsOn: ["stats"],
          },
        ],
      },
    });
    const organism = app.kernel.getOrganism("organism-default")!;
    expect(organism.activeGenomeId).not.toBe(g0Snapshot);

    // 缺口 Run 仍固定 G0，缺口不会消失
    expect(app.storage.getRun(waiting.runId)!.snapshotId).toBe(g0Snapshot);

    // executeRun 拒绝执行缺口等待中的 Run
    await expect(app.runtime.executeRun(waiting.runId)).rejects.toMatchObject({
      code: "run_not_pending",
    });

    // recover 把它识别为缺口等待而非执行中断
    const actions = await app.runtime.recoverRun(waiting.runId);
    expect(actions[0]!.action).toBe("waiting_capability");
  });

  it("多个缺失能力全部记录；部分具备仍算缺口", async () => {
    const summary = await submitRequires(["changed-file-summary", "another-capability"], 3600);
    const run = instance().storage.getRun(summary.runId)!;
    expect(run.missingCapabilities).toEqual(["changed-file-summary", "another-capability"]);
  });
});
