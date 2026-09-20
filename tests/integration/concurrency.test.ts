import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { LocalProcessExecutor } from "../../src/adapters/executor-process/index.ts";
import { RuleDecisionProvider } from "../../src/adapters/decision-rule/index.ts";
import type { AppInstance } from "../../src/app/instance.ts";
import { openInstance } from "../../src/app/instance.ts";
import { installSeed } from "../../src/app/seed.ts";
import { Runtime } from "../../src/runtime/index.ts";
import type { ExecutorProvider, OrganismBudget } from "../../src/runtime/types.ts";
import { DEFAULT_ORGANISM_BUDGET } from "../../src/runtime/types.ts";
import {
  bootSeededInstance,
  fixturePath,
  installCustomGenome,
  tempInstanceRoot,
} from "../helpers.ts";

const WORKER_PATH = fileURLToPath(
  new URL("../../src/adapters/executor-process/stats-worker.mjs", import.meta.url),
);

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
  goal: "统计摘要（并发测试）",
  budget: { maxAttempts: 3, maxWallClockSeconds: 60 },
};

function submit(inputs = [fixturePath("input-a")]) {
  return instance().runtime.submitTask({
    ...BASE,
    inputs,
    acceptance: {
      outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
      verifier: "stats-acceptance",
    },
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 慢执行器：先睡再委托真实本地进程，用于让两个 Run 真正在时间上重叠 */
function slowExecutor(ms: number): ExecutorProvider {
  const inner = new LocalProcessExecutor(WORKER_PATH);
  return {
    name: "local-process",
    start: async (req) => {
      await sleep(ms);
      return inner.start(req);
    },
  };
}

function runtimeWith(budget: Partial<OrganismBudget>, executorMs = 250): Runtime {
  const app = instance();
  return new Runtime({
    storage: app.storage,
    kernel: app.kernel,
    organismId: "organism-default",
    executors: new Map([["local-process", slowExecutor(executorMs)]]),
    decision: new RuleDecisionProvider(),
    blobs: app.blobs,
    instanceRoot: app.root,
    clock: { now: Date.now },
    ids: { next: uuidv7 },
    organismBudget: { ...DEFAULT_ORGANISM_BUDGET, ...budget },
  });
}

function submitVia(runtime: Runtime, inputs: string[]) {
  return runtime.submitTask({
    ...BASE,
    inputs,
    acceptance: {
      outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
      verifier: "stats-acceptance",
    },
  });
}

describe("M0 切片③：并发 Run 与预算预留", () => {
  it("两个并发 Run 同时执行、各自可追溯，结算后在途预算归零", async () => {
    const [a, b] = await Promise.all([
      submit([fixturePath("input-a")]),
      submit([fixturePath("input-b")]),
    ]);

    expect(a.state).toBe("succeeded");
    expect(b.state).toBe("succeeded");
    expect(a.runId).not.toBe(b.runId);
    expect(a.taskId).not.toBe(b.taskId);
    // 各自的经验与快照固定完整
    for (const s of [a, b]) {
      const run = instance().storage.getRun(s.runId)!;
      expect(run.state).toBe("succeeded");
      expect(instance().storage.getExperienceByRun(s.runId)!.outcome.attemptCount).toBe(1);
    }
    // 结算后无在途预留
    const inFlight = instance().storage.inFlightBudget("organism-default");
    expect(inFlight).toEqual({ attempts: 0, seconds: 0 });
  });

  it("并发 Run 上限：第一个执行中时拒绝第二个准入，结算后恢复", async () => {
    const runtime = runtimeWith({ maxConcurrentRuns: 1 });
    const first = submitVia(runtime, [fixturePath("input-a")]);
    await sleep(80); // 确保 first 已通过准入并处于 running
    await expect(submitVia(runtime, [fixturePath("input-b")])).rejects.toMatchObject({
      code: "organism_budget_exceeded",
    });
    const summary = await first;
    expect(summary.state).toBe("succeeded");
    // 结算释放后可再次提交
    const next = await submitVia(runtime, [fixturePath("input-b")]);
    expect(next.state).toBe("succeeded");
  });

  it("在途墙钟预留上限：60s + 60s > 100s 时拒绝第二个并发准入", async () => {
    const runtime = runtimeWith({ maxInFlightWallClockSeconds: 100 });
    const first = submitVia(runtime, [fixturePath("input-a")]);
    await sleep(80);
    await expect(submitVia(runtime, [fixturePath("input-b")])).rejects.toMatchObject({
      code: "organism_budget_exceeded",
    });
    expect((await first).state).toBe("succeeded");
    // 第一个结算释放后，60s 预留不再超限
    const next = await submitVia(runtime, [fixturePath("input-b")]);
    expect(next.state).toBe("succeeded");
  });

  it("Run 级 Attempt 配额：maxAttempts=1 时第二个 execute 节点原子拒绝", async () => {
    installCustomGenome(instance(), {
      graph: {
        schemaVersion: 2,
        kind: "dag-v1",
        nodes: [
          { id: "e1", type: "execute", executor: "local-process", dependsOn: [] },
          { id: "e2", type: "execute", executor: "local-process", dependsOn: ["e1"] },
        ],
      },
    });
    const summary = await instance().runtime.submitTask({
      ...BASE,
      budget: { maxAttempts: 1, maxWallClockSeconds: 60 },
      inputs: [fixturePath("input-a")],
      acceptance: {
        outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
        verifier: "stats-acceptance",
      },
    });

    expect(summary.state).toBe("failed");
    expect(summary.failureReason).toBe("budget_exhausted");
    expect(summary.attempts).toHaveLength(1); // 只花费了一次配额
    expect(summary.nodes.find((n) => n.id === "e1")!.state).toBe("succeeded");
    expect(summary.nodes.find((n) => n.id === "e2")!.state).toBe("failed");
  });
});

describe("迁移兼容：v1 实例升级到 v2 账本", () => {
  it("全新实例账本带 organism 归属", async () => {
    const root = tempInstanceRoot();
    const fresh = openInstance(root);
    try {
      installSeed({
        kernel: fresh.kernel,
        storage: fresh.storage,
        blobs: fresh.blobs,
        clock: { now: Date.now },
      });
      const summary = await fresh.runtime.submitTask({
        ...BASE,
        inputs: [fixturePath("input-a")],
        acceptance: {
          outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
          verifier: "stats-acceptance",
        },
      });
      expect(summary.state).toBe("succeeded");
      expect(fresh.storage.inFlightBudget("organism-default")).toEqual({ attempts: 0, seconds: 0 });
    } finally {
      fresh.close();
    }
  });
});
