import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { AcpExecutor } from "../../src/adapters/executor-acp/index.ts";
import { RuleDecisionProvider } from "../../src/adapters/decision-rule/index.ts";
import type { AppInstance } from "../../src/app/instance.ts";
import { Runtime } from "../../src/runtime/index.ts";
import type { ExecutorProvider } from "../../src/runtime/types.ts";
import { DEFAULT_ORGANISM_BUDGET } from "../../src/runtime/types.ts";
import { bootSeededInstance, fixturePath, installCustomGenome } from "../helpers.ts";

const FAKE_AGENT = fileURLToPath(new URL("../fixtures/acp/fake-agent.mjs", import.meta.url));

/**
 * M1 验收故事（CI 版，agent 侧为 fake；E2E 版见 tests/e2e/）：
 * 委托实现固定测试功能 → agent 在工作区写代码 → 独立 test-runner 裁判验收。
 * 测试失败不能标为任务成功（roadmap M1 完成判据）。
 */

let inst: AppInstance | undefined;
afterAll(() => {
  inst?.close();
});

function instance(): AppInstance {
  inst ??= bootSeededInstance();
  return inst;
}

const M1_GRAPH = {
  schemaVersion: 2,
  kind: "dag-v1",
  nodes: [
    { id: "dev", type: "execute", executor: "fake-acp", dependsOn: [] },
    {
      id: "check",
      type: "verify",
      verifier: "coding-acceptance",
      inputFrom: "dev",
      dependsOn: ["dev"],
    },
  ],
};

const TEST_RUNNER = {
  schemaVersion: 1,
  kind: "test-runner-v1",
  command: ["node", "--test", "inputs/wordcount-tests/wordcount.test.mjs"],
};

function runtimeWithExecutors(executors: Array<[string, ExecutorProvider]>): Runtime {
  const app = instance();
  return new Runtime({
    storage: app.storage,
    kernel: app.kernel,
    organismId: "organism-default",
    executors: new Map(executors),
    decision: new RuleDecisionProvider(),
    blobs: app.blobs,
    instanceRoot: app.root,
    clock: { now: Date.now },
    ids: { next: uuidv7 },
    organismBudget: DEFAULT_ORGANISM_BUDGET,
  });
}

function fakeAcpExecutor(): ExecutorProvider {
  return new AcpExecutor({ name: "fake-acp", agentEntry: FAKE_AGENT });
}

describe("M1：外部委托闭环（fake agent 版）", () => {
  it("委托 → 产出可定位代码与 trace → 独立测试验收通过", async () => {
    installCustomGenome(instance(), { graph: M1_GRAPH, evaluator: TEST_RUNNER });
    const runtime = runtimeWithExecutors([["fake-acp", fakeAcpExecutor()]]);

    const summary = await runtime.submitTask({
      requestedBy: "principal-local",
      goal: "在工作区实现 src/wordcount.mjs：导出 countWords(text)，按空白切分返回词数（空串为 0）。",
      inputs: [fixturePath("..", "m1", "wordcount-tests")],
      budget: { maxAttempts: 2, maxWallClockSeconds: 60 },
      acceptance: {
        outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
        verifier: "coding-acceptance",
      },
    });

    expect(summary.state).toBe("succeeded");
    expect(summary.nodes.map((n) => `${n.id}:${n.state}`)).toEqual([
      "dev:succeeded",
      "check:succeeded",
    ]);
    expect(summary.checks).toHaveLength(1);
    expect(summary.checks[0]!.name).toBe("tests");
    expect(summary.checks[0]!.passed).toBe(true);

    // 产出可定位：代码在工作区，trace 记录 agent 行为
    const workspace = join(instance().root, "workspaces", summary.runId, "dev");
    const impl = readFileSync(join(workspace, "src", "wordcount.mjs"), "utf8");
    expect(impl).toContain("countWords");
    const trace = JSON.parse(
      readFileSync(join(workspace, ".proteus", "acp-trace.json"), "utf8"),
    ) as {
      stopReason: string;
    };
    expect(trace.stopReason).toBe("end_turn");
  });

  it("测试失败不能标为任务成功：agent 产出错误实现 → acceptance_failed", async () => {
    const runtime = runtimeWithExecutors([["fake-acp", fakeAcpExecutor()]]);

    const summary = await runtime.submitTask({
      requestedBy: "principal-local",
      goal: "BUGGY 变体：实现一个恒返回 0 的 countWords。",
      inputs: [fixturePath("..", "m1", "wordcount-tests")],
      budget: { maxAttempts: 1, maxWallClockSeconds: 60 },
      acceptance: {
        outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
        verifier: "coding-acceptance",
      },
    });

    expect(summary.state).toBe("failed");
    expect(summary.failureReason).toBe("acceptance_failed");
    expect(summary.nodes.find((n) => n.id === "dev")!.state).toBe("succeeded"); // 执行本身完成
    expect(summary.nodes.find((n) => n.id === "check")!.state).toBe("failed"); // 裁判不通过
    expect(summary.checks[0]!.passed).toBe(false);
    expect(summary.checks[0]!.detail).toContain("退出码");

    const experience = instance().storage.getExperienceByRun(summary.runId)!;
    expect(experience.outcome.result).toBe("failed");
  });

  it("执行器注册表：图中引用未装配执行器得到明确错误", async () => {
    installCustomGenome(instance(), {
      graph: {
        ...M1_GRAPH,
        nodes: [{ id: "dev", type: "execute", executor: "claude-code-acp", dependsOn: [] }],
      },
    });
    const runtime = runtimeWithExecutors([["fake-acp", fakeAcpExecutor()]]); // 未装配 claude-code-acp

    const summary = await runtime.submitTask({
      requestedBy: "principal-local",
      goal: "引用未装配执行器",
      inputs: [fixturePath("..", "m1", "wordcount-tests")],
      budget: { maxAttempts: 1, maxWallClockSeconds: 30 },
      acceptance: {
        outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
        verifier: "coding-acceptance",
      },
    });
    expect(summary.state).toBe("failed");
    expect(summary.failureReason).toBe("unknown_executor");
    expect(summary.nodes.find((n) => n.id === "dev")!.state).toBe("failed");
  });
});
