import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AppInstance } from "../../src/app/instance.ts";
import { buildExecutors } from "../../src/app/instance.ts";
import { Runtime } from "../../src/runtime/index.ts";
import type { ExecutorProvider } from "../../src/runtime/types.ts";
import { DEFAULT_ORGANISM_BUDGET } from "../../src/runtime/types.ts";
import { RuleDecisionProvider } from "../../src/adapters/decision-rule/index.ts";
import { Evolution } from "../../src/evolution/index.ts";
import { v7 as uuidv7 } from "uuid";
import { bootSeededInstance, fixturePath, installCustomGenome } from "../helpers.ts";
import { HYBRID_EVALUATOR_CONTENT } from "../../src/evolution/assets.ts";

/**
 * 真实 agent E2E（M1/M2）：消耗真实凭据与费用，默认跳过。
 * 运行：PROTEUS_E2E=claude ｜ codex ｜ pi ｜ bootstrap ｜ all（pnpm test -- tests/e2e）
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
    decisions: new Map([["decision-rule", new RuleDecisionProvider()]]),
    blobs: inst.blobs,
    instanceRoot: inst.root,
    clock: { now: Date.now },
    ids: { next: uuidv7 },
    organismBudget: {
      normal: {
        ...DEFAULT_ORGANISM_BUDGET.normal,
        maxConcurrentRuns: 1,
        maxInFlightWallClockSeconds: 1200,
      },
      evaluation: DEFAULT_ORGANISM_BUDGET.evaluation,
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

  it.runIf(enabled("bootstrap"))(
    "M2 自举故事（真实 Claude Code 作为 builder）：缺口等待 → 委托构建 → 评估 → 晋升 → 接替 Run 完成",
    async () => {
      const M2 = fileURLToPath(new URL("../fixtures/m2", import.meta.url));
      const runtime = new Runtime({
        storage: inst.storage,
        kernel: inst.kernel,
        organismId: "organism-default",
        executors: buildExecutors(),
        decisions: new Map([["decision-rule", new RuleDecisionProvider()]]),
        blobs: inst.blobs,
        instanceRoot: inst.root,
        clock: { now: Date.now },
        ids: { next: uuidv7 },
        organismBudget: {
          normal: {
            ...DEFAULT_ORGANISM_BUDGET.normal,
            maxConcurrentRuns: 4,
            maxInFlightWallClockSeconds: 3600,
          },
          evaluation: DEFAULT_ORGANISM_BUDGET.evaluation,
        },
      });
      const evo = new Evolution({
        kernel: inst.kernel,
        storage: inst.storage,
        blobs: inst.blobs,
        runtime,
        organismId: "organism-default",
        instanceRoot: inst.root,
        clock: { now: Date.now },
        ids: { next: uuidv7 },
      });

      // ⓪ 裁判拆分（M3）：先升级裁判为 hybrid（独立候选 + 等价评估 + operator 晋升）
      const { candidate: judgeCandidate } = evo.proposeJudgeCandidate({
        evaluatorContent: HYBRID_EVALUATOR_CONTENT,
        hypothesis: "裁判升级为 hybrid（E2E 两阶段自举）",
        proposedBy: "principal-local",
      });
      const judgeEval = await evo.evaluateJudgeCandidate(judgeCandidate.id, {
        regression: {
          goal: "统计摘要（裁判等价回归）",
          inputs: [fixturePath("input-a")],
          budget: { maxAttempts: 3, maxWallClockSeconds: 120 },
          acceptance: {
            outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
            verifier: "stats-acceptance",
          },
        },
        requestedBy: "principal-local",
      });
      expect(judgeEval.evaluation.verdict).toBe("eligible");
      const judgePromoted = evo.promote(judgeCandidate.id, { authorizedBy: "principal-local" });
      expect(judgePromoted.result).toBe("promoted");

      // ① R1 缺口等待
      const r1 = await runtime.submitTask({
        requestedBy: "principal-local",
        goal: "对变更清单生成可验证的文件分类摘要",
        inputs: [join(M2, "inputs", "changed-files.json")],
        budget: { maxAttempts: 3, maxWallClockSeconds: 120 },
        requires: ["changed-file-summary"],
        acceptance: {
          outputSchema: join(M2, "schemas", "changed-file-summary.schema.json"),
          expectedOutput: join(M2, "evals", "summary-output.json"),
          verifier: "stats-acceptance",
        },
      });
      expect(r1.state).toBe("waiting");

      // ②③ 真实 Claude Code 构建 → 独立测试验收 → 候选
      const builder = await evo.build({
        capability: "changed-file-summary",
        goal: readFileSync(join(M2, "specs", "changed-file-summary-spec.md"), "utf8"),
        inputs: [join(M2, "capability-tests")],
        executorName: "claude-code-acp",
        testCommand: ["node", "--test", "inputs/capability-tests/changed-file-summary.test.mjs"],
        budget: { maxAttempts: 2, maxWallClockSeconds: 480 },
        outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
        requestedBy: "principal-local",
      });
      expect(builder.state).toBe("succeeded");
      const evaluationPlan = {
        newCapability: {
          goal: "对变更清单生成可验证的文件分类摘要",
          inputs: [join(M2, "inputs", "changed-files.json")],
          budget: { maxAttempts: 3, maxWallClockSeconds: 120 },
          requires: ["changed-file-summary"],
          acceptance: {
            outputSchema: join(M2, "schemas", "changed-file-summary.schema.json"),
            expectedOutput: join(M2, "evals", "summary-output.json"),
            verifier: "stats-acceptance",
          },
        },
        regression: {
          goal: "统计摘要（回归）",
          inputs: [fixturePath("input-a")],
          budget: { maxAttempts: 3, maxWallClockSeconds: 120 },
          acceptance: {
            outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
            verifier: "stats-acceptance",
          },
        },
        requestedBy: "principal-local",
      };
      const { candidate } = evo.collectCandidate(builder.runId, {
        capability: "changed-file-summary",
        hypothesis: "真实 Claude Code 构建的派生能力",
        proposedBy: "principal-local",
        evaluationPlan,
      });

      // ④ 独立评估 → ⑤ 晋升 → ⑥ 接替
      const evalOut = await evo.evaluateCandidate(candidate.id, evaluationPlan);
      expect(evalOut.evaluation.verdict).toBe("eligible");

      const promoted = evo.promote(candidate.id, { authorizedBy: "principal-local" });
      expect(promoted.result).toBe("promoted");

      const { superseded, successor } = await evo.supersedeAndReplace(r1.runId);
      expect(superseded.state).toBe("failed");
      expect(successor.state).toBe("succeeded");

      const output = JSON.parse(
        readFileSync(join(inst.root, "workspaces", successor.runId, "work", "output.json"), "utf8"),
      ) as { summary: { files: Array<{ path: string; category: string }> } };
      const expected = JSON.parse(
        readFileSync(join(M2, "evals", "summary-expected.json"), "utf8"),
      ) as Record<string, string>;
      expect(Object.fromEntries(output.summary.files.map((f) => [f.path, f.category]))).toEqual(
        expected,
      );
    },
    E2E_TIMEOUT,
  );

  it("占位：未启用时本文件除跳过项外保持绿", () => {
    expect(
      MODE === "" || MODE === "all" || ["claude", "codex", "pi", "bootstrap"].includes(MODE),
    ).toBe(true);
  });
});

export type { ExecutorProvider };
