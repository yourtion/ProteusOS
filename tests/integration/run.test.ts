import { afterAll, describe, expect, it } from "vitest";
import type { AppInstance } from "../../src/app/instance.ts";
import { bootSeededInstance, fixturePath } from "../helpers.ts";

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
  goal: "统计摘要（集成测试）",
  budget: { maxAttempts: 3, maxWallClockSeconds: 60 },
};

function submit(
  inputs: string[],
  outputSchema = fixturePath("schemas", "stats-summary.schema.json"),
  verifier = "stats-acceptance",
) {
  return instance().runtime.submitTask({ ...BASE, inputs, acceptance: { outputSchema, verifier } });
}

describe("M0 切片①：单节点 Run 完整落库", () => {
  it("成功路径：succeeded + 全量记录", async () => {
    const inst = instance();
    const summary = await submit([fixturePath("input-a")]);

    expect(summary.state).toBe("succeeded");
    expect(summary.failureReason).toBeNull();
    expect(summary.checks.map((c) => c.name).sort()).toEqual(["json-schema", "totals-consistency"]);
    expect(summary.checks.every((c) => c.passed)).toBe(true);
    expect(summary.experienceId).toBeTruthy();

    // Run 固定快照 = organism 当前默认快照
    const run = inst.storage.getRun(summary.runId)!;
    const organism = inst.kernel.getOrganism("organism-default")!;
    expect(run.snapshotId).toBe(organism.activeGenomeId);
    expect(run.state).toBe("succeeded");

    // 事件齐全且每流 seq 严格递增
    const events = inst.storage.listEvents({ runId: summary.runId }, 100);
    const types = events.map((e) => e.type);
    for (const expected of [
      "run.created",
      "run.state.changed",
      "process.created",
      "attempt.dispatching",
      "attempt.succeeded",
      "experience.recorded",
    ]) {
      expect(types).toContain(expected);
    }
    const runStreamSeqs = events
      .filter((e) => e.streamId === `run-${summary.runId}`)
      .map((e) => e.seq);
    expect(runStreamSeqs).toEqual([...runStreamSeqs].sort((a, b) => a - b));
    expect(new Set(runStreamSeqs).size).toBe(runStreamSeqs.length);

    // Attempt 与 outbox 记录
    const processes = inst.storage.listProcesses(summary.runId);
    expect(processes).toHaveLength(1);
    const attempts = inst.storage.listAttempts(processes[0]!.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.state).toBe("succeeded");
    expect(attempts[0]!.exitCode).toBe(0);
    const dispatches = inst.storage.listDispatches();
    expect(
      dispatches.filter((d) => d.runId === summary.runId).every((d) => d.state === "completed"),
    ).toBe(true);

    // Experience：成功、一次尝试、输出摘要
    const experience = inst.storage.getExperienceByRun(summary.runId)!;
    expect(experience.outcome.result).toBe("succeeded");
    expect(experience.outcome.attemptCount).toBe(1);
    expect(experience.outcome.outputDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("第二个任务独立成 Run，各自可追溯", async () => {
    const s1 = await submit([fixturePath("input-a")]);
    const s2 = await submit([fixturePath("input-b")]);
    expect(s1.runId).not.toBe(s2.runId);
    expect(s1.taskId).not.toBe(s2.taskId);
    const runs = instance().storage.listRuns(10);
    expect(runs.map((r) => r.id)).toEqual(expect.arrayContaining([s1.runId, s2.runId]));
  });

  it("verifier 与快照绑定不一致：拒绝准入且不留 Run", async () => {
    const before = instance().storage.listRuns(10).length;
    await expect(
      submit([fixturePath("input-a")], undefined, "wrong-verifier"),
    ).rejects.toMatchObject({
      code: "verifier_mismatch",
    });
    expect(instance().storage.listRuns(10).length).toBe(before);
  });

  it("验收失败：Run failed 但 Attempt 证据保留", async () => {
    const summary = await submit(
      [fixturePath("input-a")],
      fixturePath("schemas", "strict-extra-field.schema.json"),
    );
    expect(summary.state).toBe("failed");
    expect(summary.failureReason).toBe("acceptance_failed");
    const jsonSchemaCheck = summary.checks.find((c) => c.name === "json-schema")!;
    expect(jsonSchemaCheck.passed).toBe(false);

    // 执行本身成功：attempt succeeded；失败在裁判，不在执行器
    const processes = instance().storage.listProcesses(summary.runId);
    const attempt = instance().storage.listAttempts(processes[0]!.id)[0]!;
    expect(attempt.state).toBe("succeeded");

    const experience = instance().storage.getExperienceByRun(summary.runId)!;
    expect(experience.outcome.result).toBe("failed");
  });

  it("取消已终态 Run 无效果", async () => {
    const summary = await submit([fixturePath("input-a")]);
    const result = await instance().runtime.cancel(summary.runId);
    expect(result.state).toBe("succeeded");
    expect(result.note).toContain("终态");
    expect(instance().storage.getRun(summary.runId)!.state).toBe("succeeded");
  });

  it("不存在的 Run 报 unknown_run", async () => {
    await expect(instance().runtime.cancel("nope")).rejects.toMatchObject({ code: "unknown_run" });
  });
});
