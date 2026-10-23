import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { RuleDecisionProvider } from "../../src/adapters/decision-rule/index.ts";
import { LocalProcessExecutor } from "../../src/adapters/executor-process/index.ts";
import type { AppInstance } from "../../src/app/instance.ts";
import { Runtime } from "../../src/runtime/index.ts";
import type {
  ExecutionRequest,
  ExecutionResult,
  ExecutorProvider,
  RunSummary,
} from "../../src/runtime/types.ts";
import { DEFAULT_ORGANISM_BUDGET } from "../../src/runtime/types.ts";
import { bootSeededInstance, fixturePath, installCustomGenome } from "../helpers.ts";

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
  goal: "统计摘要（恢复测试）",
  budget: { maxAttempts: 3, maxWallClockSeconds: 60 },
};

const ACCEPTANCE = {
  outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
  verifier: "stats-acceptance",
};

function checkpoint<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

/** 等待真实执行边界；若 Run 提前结束或抛错，立即报告装配失败。 */
function atCheckpoint<T>(point: Promise<T>, run: Promise<RunSummary>): Promise<T> {
  return Promise.race([
    point,
    run.then((summary) => {
      throw new Error(
        `未到执行检查点 Run 已结束：${summary.state}/${summary.failureReason ?? "none"}`,
      );
    }),
  ]);
}

function runtimeWith(executor: ExecutorProvider): Runtime {
  return runtimeFor(instance(), executor);
}

function runtimeFor(app: AppInstance, executor: ExecutorProvider): Runtime {
  return new Runtime({
    storage: app.storage,
    kernel: app.kernel,
    organismId: "organism-default",
    executors: new Map([["local-process", executor]]),
    decisions: new Map([["decision-rule", new RuleDecisionProvider()]]),
    blobs: app.blobs,
    instanceRoot: app.root,
    clock: { now: Date.now },
    ids: { next: uuidv7 },
    organismBudget: DEFAULT_ORGANISM_BUDGET,
  });
}

const realExecutor = () => new LocalProcessExecutor(WORKER_PATH);

describe("M0 切片④：崩溃恢复与对账", () => {
  it("可能产生外部副作用的执行器缺少完成证据时保持 unknown，不自动重试", async () => {
    const app = bootSeededInstance();
    const dispatched = checkpoint<ExecutionRequest>();
    try {
      const sideEffecting = {
        name: "local-process",
        recoveryPolicy: "manual",
        start: (req) => {
          dispatched.resolve(req);
          return new Promise<ExecutionResult>(() => undefined);
        },
      } satisfies ExecutorProvider;
      const runtime = runtimeFor(app, sideEffecting);
      const execution = runtime.submitTask({
        ...BASE,
        inputs: [fixturePath("input-a")],
        acceptance: ACCEPTANCE,
      });
      const { runId } = await atCheckpoint(dispatched.promise, execution);

      await app.runtime.recoverRun(runId);
      const report = await app.runtime.reconcileRun(runId);

      expect(report.resolved).toMatchObject([{ verdict: "unknown" }]);
      expect(report.summary).toBeNull();
      expect(app.storage.getRun(runId)!.state).toBe("waiting");
      expect(app.runtime.getRunSummary(runId).attempts).toHaveLength(1);
      expect(app.runtime.getRunSummary(runId).attempts[0]!.state).toBe("unknown");
    } finally {
      app.close();
    }
  });

  it("可能产生外部副作用的执行器有完整产物时按原 Attempt 成功续跑", async () => {
    const app = bootSeededInstance();
    let calls = 0;
    const completed = checkpoint<{ request: ExecutionRequest; result: ExecutionResult }>();
    try {
      const sideEffecting = {
        name: "local-process",
        recoveryPolicy: "manual",
        start: async (req) => {
          calls += 1;
          const result = await realExecutor().start(req);
          completed.resolve({ request: req, result });
          await new Promise<never>(() => undefined);
          return result;
        },
      } satisfies ExecutorProvider;
      const runtime = runtimeFor(app, sideEffecting);
      const execution = runtime.submitTask({
        ...BASE,
        inputs: [fixturePath("input-a")],
        acceptance: ACCEPTANCE,
      });
      const { request, result } = await atCheckpoint(completed.promise, execution);
      expect(result.ok).toBe(true);

      await app.runtime.recoverRun(request.runId);
      const report = await app.runtime.reconcileRun(request.runId);

      expect(report.resolved).toMatchObject([{ verdict: "succeeded" }]);
      expect(report.summary?.state).toBe("succeeded");
      expect(calls).toBe(1);
      expect(app.runtime.getRunSummary(request.runId).attempts).toHaveLength(1);
    } finally {
      app.close();
    }
  });

  it("派发中崩溃：recover 标记 unknown，reconcile 无产物判 failed 并有界重试成功", async () => {
    const dispatched = checkpoint<ExecutionRequest>();
    const hanging: ExecutorProvider = {
      name: "local-process",
      recoveryPolicy: "retry-safe",
      start: (req) => {
        dispatched.resolve(req);
        return new Promise<ExecutionResult>(() => undefined);
      },
    };
    const execution = runtimeWith(hanging).submitTask({
      ...BASE,
      inputs: [fixturePath("input-a")],
      acceptance: ACCEPTANCE,
    });
    const { runId } = await atCheckpoint(dispatched.promise, execution);

    // 恢复：不假定未执行，标记 unknown 等待对账
    const actions = await instance().runtime.recoverRun();
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action).toBe("needs_reconciliation");
    expect(instance().storage.getRun(runId)!.state).toBe("waiting");

    // 对账：工作区无产物 → failed → 重试（真实执行器）→ 全链成功
    const report = await instance().runtime.reconcileRun(runId);
    expect(report.resolved).toHaveLength(1);
    expect(report.resolved[0]!.verdict).toBe("failed");
    expect(report.summary!.state).toBe("succeeded");

    const summary = instance().runtime.getRunSummary(runId);
    expect(summary.state).toBe("succeeded");
    // 第一次派发（对账判 failed）+ 一次重试
    expect(summary.attempts).toHaveLength(2);
    expect(summary.attempts.map((a) => a.state)).toEqual(["failed", "succeeded"]);
  });

  it("完成未记录即崩溃：reconcile 以工作区产物为证据判 succeeded，不重派", async () => {
    const completed = checkpoint<{ request: ExecutionRequest; result: ExecutionResult }>();
    const doneThenHang: ExecutorProvider = {
      name: "local-process",
      recoveryPolicy: "retry-safe",
      start: async (req) => {
        const result = await realExecutor().start(req);
        completed.resolve({ request: req, result });
        await new Promise<never>(() => undefined);
        return result;
      },
    };
    const execution = runtimeWith(doneThenHang).submitTask({
      ...BASE,
      inputs: [fixturePath("input-a")],
      acceptance: ACCEPTANCE,
    });
    const { request, result } = await atCheckpoint(completed.promise, execution);
    expect(result.ok).toBe(true);
    const runId = request.runId;

    await instance().runtime.recoverRun();
    const report = await instance().runtime.reconcileRun(runId);
    expect(report.resolved[0]!.verdict).toBe("succeeded");
    expect(report.summary!.state).toBe("succeeded");

    const summary = instance().runtime.getRunSummary(runId);
    expect(summary.state).toBe("succeeded");
    expect(summary.attempts).toHaveLength(1); // 无重试
    expect(summary.attempts[0]!.state).toBe("succeeded");
  });

  it("断点续跑：已成功节点跳过重派，未完成节点重试", async () => {
    installCustomGenome(instance(), {
      graph: {
        schemaVersion: 2,
        kind: "dag-v1",
        nodes: [
          { id: "e1", type: "execute", executor: "local-process", dependsOn: [] },
          { id: "e2", type: "execute", executor: "local-process", dependsOn: ["e1"] },
          {
            id: "check",
            type: "verify",
            verifier: "stats-acceptance",
            inputFrom: "e2",
            dependsOn: ["e2"],
          },
        ],
      },
    });

    let calls = 0;
    const secondDispatched = checkpoint<ExecutionRequest>();
    const firstOkThenHang: ExecutorProvider = {
      name: "local-process",
      recoveryPolicy: "retry-safe",
      start: async (req) => {
        calls += 1;
        if (calls === 1) return realExecutor().start(req);
        secondDispatched.resolve(req);
        return new Promise<ExecutionResult>(() => undefined);
      },
    };
    const execution = runtimeWith(firstOkThenHang).submitTask({
      ...BASE,
      inputs: [fixturePath("input-a")],
      acceptance: ACCEPTANCE,
    });
    const { runId } = await atCheckpoint(secondDispatched.promise, execution);

    await instance().runtime.recoverRun();
    const report = await instance().runtime.reconcileRun(runId);
    expect(report.summary!.state).toBe("succeeded");

    // e1 只派发过一次（断点续跑不重派已成功节点）；e2 两次（崩溃 + 重试）
    const processes = instance().storage.listProcesses(runId);
    const e1 = processes.find((p) => p.nodeId === "e1")!;
    const e2 = processes.find((p) => p.nodeId === "e2")!;
    expect(instance().storage.listAttempts(e1.id)).toHaveLength(1);
    const e2Attempts = instance().storage.listAttempts(e2.id);
    expect(e2Attempts).toHaveLength(2);
    expect(e2Attempts.map((a) => a.state)).toEqual(["failed", "succeeded"]);
  });
});

describe("M0 切片④：取消竞态", () => {
  // 独立实例：不沿用前面用例安装的自定义图
  let raceInst: AppInstance | undefined;
  afterAll(() => {
    raceInst?.close();
  });

  it("执行中取消：Attempt 结果如实记录，Run 取消且终态不被覆盖", async () => {
    raceInst ??= bootSeededInstance();
    const dispatched = checkpoint<ExecutionRequest>();
    const continueExecution = checkpoint<void>();
    const slow: ExecutorProvider = {
      name: "local-process",
      recoveryPolicy: "retry-safe",
      start: async (req) => {
        dispatched.resolve(req);
        await continueExecution.promise;
        return realExecutor().start(req);
      },
    };
    const promise = new Runtime({
      storage: raceInst.storage,
      kernel: raceInst.kernel,
      organismId: "organism-default",
      executors: new Map([["local-process", slow]]),
      decisions: new Map([["decision-rule", new RuleDecisionProvider()]]),
      blobs: raceInst.blobs,
      instanceRoot: raceInst.root,
      clock: { now: Date.now },
      ids: { next: uuidv7 },
      organismBudget: DEFAULT_ORGANISM_BUDGET,
    }).submitTask({ ...BASE, inputs: [fixturePath("input-a")], acceptance: ACCEPTANCE });
    const { runId } = await atCheckpoint(dispatched.promise, promise);
    const cancelResult = await raceInst.runtime.cancel(runId);
    continueExecution.resolve();

    const summary = await promise;
    expect(cancelResult.note).toContain("停止意图");
    // 已完成的 attempt 结果保留；后续节点跳过；run 取消
    expect(summary.state).toBe("cancelled");
    expect(summary.failureReason).toBe("cancelled_during_execution");
    expect(summary.attempts).toHaveLength(1);
    expect(summary.attempts[0]!.state).toBe("succeeded");
    expect(summary.nodes.find((n) => n.id === "stats")!.state).toBe("succeeded");
    expect(summary.nodes.find((n) => n.id === "check")!.state).toBe("skipped");

    // 终态不被迟到的再次取消覆盖
    const again = await raceInst.runtime.cancel(runId);
    expect(again.note).toContain("终态");
    expect(raceInst.storage.getRun(runId)!.state).toBe("cancelled");
    // 经验如实记录取消与已完成的部分
    const experience = raceInst.storage.getExperienceByRun(runId)!;
    expect(experience.outcome.result).toBe("cancelled");
    expect(experience.outcome.attemptCount).toBe(1);
  });
});
