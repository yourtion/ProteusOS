import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AppInstance } from "../../src/app/instance.ts";
import { buildExecutors } from "../../src/app/instance.ts";
import { Runtime } from "../../src/runtime/index.ts";
import type { ExecutorProvider } from "../../src/runtime/types.ts";
import { DEFAULT_ORGANISM_BUDGET } from "../../src/runtime/types.ts";
import { RuleDecisionProvider } from "../../src/adapters/decision-rule/index.ts";
import { v7 as uuidv7 } from "uuid";
import { bootSeededInstance, fixturePath, installCustomGenome } from "../helpers.ts";

/**
 * 真实 agent E2E（M1）：消耗真实凭据与费用，默认跳过。
 * 运行：PROTEUS_E2E=claude ｜ codex ｜ pi ｜ all（pnpm test -- tests/e2e）
 * 前置：本机 claude CLI 已登录 / OpenAI 凭据 / ~/.pi/agent 已配置模型。
 */

const MODE = process.env.PROTEUS_E2E ?? "";

function enabled(target: string): boolean {
  return MODE === "all" || MODE === target;
}

const GOAL =
  "在工作区实现 src/wordcount.mjs：导出 countWords(text)，按空白切分返回词数（空串为 0）。只创建 src/ 目录下的文件，不要修改 inputs/。完成后自检：node --test inputs/wordcount-tests/wordcount.test.mjs";

const GRAPH = (executor: string) => ({
  schemaVersion: 2,
  kind: "dag-v1",
  nodes: [
    { id: "dev", type: "execute", executor, dependsOn: [] },
    {
      id: "check",
      type: "verify",
      verifier: "coding-acceptance",
      inputFrom: "dev",
      dependsOn: ["dev"],
    },
  ],
});

const TEST_RUNNER = {
  schemaVersion: 1,
  kind: "test-runner-v1",
  command: ["node", "--test", "inputs/wordcount-tests/wordcount.test.mjs"],
};

const E2E_TIMEOUT = 600_000;

async function runDelegatedTask(executorName: string, inst: AppInstance): Promise<void> {
  installCustomGenome(inst, { graph: GRAPH(executorName), evaluator: TEST_RUNNER });
  const runtime = new Runtime({
    storage: inst.storage,
    kernel: inst.kernel,
    organismId: "organism-default",
    executors: buildExecutors(),
    decision: new RuleDecisionProvider(),
    blobs: inst.blobs,
    instanceRoot: inst.root,
    clock: { now: Date.now },
    ids: { next: uuidv7 },
    organismBudget: {
      ...DEFAULT_ORGANISM_BUDGET,
      maxConcurrentRuns: 1,
      maxInFlightWallClockSeconds: 1200,
    },
  });
  const summary = await runtime.submitTask({
    requestedBy: "principal-local",
    goal: GOAL,
    inputs: [fixturePath("..", "m1", "wordcount-tests")],
    budget: { maxAttempts: 1, maxWallClockSeconds: 480 },
    acceptance: {
      outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
      verifier: "coding-acceptance",
    },
  });
  expect(summary.state).toBe("succeeded");
  expect(summary.checks[0]!.passed).toBe(true);
  const impl = readFileSync(
    join(inst.root, "workspaces", summary.runId, "dev", "src", "wordcount.mjs"),
    "utf8",
  );
  expect(impl).toContain("countWords");
}

describe("M1 E2E：真实 agent（PROTEUS_E2E 显式启用）", () => {
  const inst = bootSeededInstance();
  afterAll(() => inst.close());

  it.runIf(enabled("claude"))(
    "claude-code-acp 委托实现并通过独立测试",
    async () => {
      await runDelegatedTask("claude-code-acp", inst);
    },
    E2E_TIMEOUT,
  );

  it.runIf(enabled("codex"))(
    "codex-acp 委托实现并通过独立测试",
    async () => {
      await runDelegatedTask("codex-acp", inst);
    },
    E2E_TIMEOUT,
  );

  it.runIf(enabled("pi"))(
    "pi（SDK 直连）委托实现并通过独立测试",
    async () => {
      await runDelegatedTask("pi", inst);
    },
    E2E_TIMEOUT,
  );

  it("占位：未启用时本文件除跳过项外保持绿", () => {
    expect(MODE === "" || MODE === "all" || ["claude", "codex", "pi"].includes(MODE)).toBe(true);
  });
});

export type { ExecutorProvider };
