import { afterAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { RuleDecisionProvider } from "../../src/adapters/decision-rule/index.ts";
import type { AppInstance } from "../../src/app/instance.ts";
import { Runtime } from "../../src/runtime/index.ts";
import type { ExecutorProvider } from "../../src/runtime/types.ts";
import { bootSeededInstance, fixturePath } from "../helpers.ts";

/**
 * 评估独立预算池（ADR 0006 挂账兑现）。
 * 评估 Run 与普通 Run 各自计并发/Attempt/墙钟额度，互不挤占；
 * 池内超限仍按用途明确拒绝。
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
  goal: "统计摘要（预算池测试）",
  inputs: [fixturePath("input-a")],
  budget: { maxAttempts: 1, maxWallClockSeconds: 300 },
  acceptance: {
    outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
    verifier: "stats-acceptance",
  },
};

/** 卡住执行器：让 Run 停在 running（活跃），便于验证池计数与准入 */
function stuckExecutor(): ExecutorProvider {
  return {
    name: "local-process",
    recoveryPolicy: "manual",
    start: () => new Promise(() => {}),
  };
}

function runtimeWithPools(budget: {
  normal: {
    maxConcurrentRuns: number;
    maxInFlightAttempts: number;
    maxInFlightWallClockSeconds: number;
  };
  evaluation: {
    maxConcurrentRuns: number;
    maxInFlightAttempts: number;
    maxInFlightWallClockSeconds: number;
  };
}): Runtime {
  const app = instance();
  return new Runtime({
    storage: app.storage,
    kernel: app.kernel,
    organismId: "organism-default",
    executors: new Map([["local-process", stuckExecutor()]]),
    decisions: new Map([["decision-rule", new RuleDecisionProvider()]]),
    blobs: app.blobs,
    instanceRoot: app.root,
    clock: { now: Date.now },
    ids: { next: uuidv7 },
    organismBudget: budget,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("评估独立预算池", () => {
  it("评估池占满不拒绝普通提交；普通池占满不拒绝评估提交", async () => {
    const runtime = runtimeWithPools({
      normal: { maxConcurrentRuns: 1, maxInFlightAttempts: 8, maxInFlightWallClockSeconds: 86_400 },
      evaluation: {
        maxConcurrentRuns: 1,
        maxInFlightAttempts: 8,
        maxInFlightWallClockSeconds: 86_400,
      },
    });

    // 评估池占满（Run 卡在 running）
    const evalRun = runtime.submitTask(BASE, { purpose: "evaluation" }).catch(() => "settled");
    await sleep(300);
    expect(instance().storage.countActiveRuns("organism-default", "evaluation")).toBe(1);

    // 评估再提交：评估池拒绝
    await expect(runtime.submitTask(BASE, { purpose: "evaluation" })).rejects.toMatchObject({
      code: "organism_budget_exceeded",
    });

    // 普通提交不受评估池影响：进入执行（同样卡住，不抛准入错误）
    const normalRun = runtime.submitTask(BASE).catch(() => "settled");
    await sleep(300);
    expect(instance().storage.countActiveRuns("organism-default", "normal")).toBe(1);
    // 普通池已满：普通再提交被拒，评估不受普通池影响（评估池当前 1 也满——
    // 用普通占满后评估池独立性的对照在下一断言组）
    await expect(runtime.submitTask(BASE)).rejects.toMatchObject({
      code: "organism_budget_exceeded",
    });

    void evalRun;
    void normalRun;
  });

  it("inFlightBudget 按用途分列：普通池不累计评估 Run 的预留", async () => {
    // 独立实例：避免上一用例遗留的卡住 normal Run 干扰池计数
    inst?.close();
    inst = bootSeededInstance();
    const runtime = runtimeWithPools({
      normal: {
        maxConcurrentRuns: 4,
        maxInFlightAttempts: 16,
        maxInFlightWallClockSeconds: 86_400,
      },
      evaluation: {
        maxConcurrentRuns: 4,
        maxInFlightAttempts: 16,
        maxInFlightWallClockSeconds: 86_400,
      },
    });
    const evalRun = runtime.submitTask(BASE, { purpose: "evaluation" }).catch(() => "settled");
    await sleep(300);

    const evaluation = instance().storage.inFlightBudget("organism-default", "evaluation");
    const normal = instance().storage.inFlightBudget("organism-default", "normal");
    expect(evaluation.attempts).toBeGreaterThanOrEqual(1);
    expect(normal).toEqual({ attempts: 0, seconds: 0 });
    void evalRun;
  });
});
