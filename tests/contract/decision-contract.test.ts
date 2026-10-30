import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RuleDecisionProvider } from "../../src/adapters/decision-rule/index.ts";
import {
  DecisionViewError,
  buildDecisionView,
  parseChoiceResponse,
  parseDecisionViewContent,
  validateChoice,
  type DecisionRequest,
  type DecisionResult,
} from "../../src/decision/index.ts";
import {
  DECISION_VIEW_CONTENT,
  RULE_CHOICE_POLICY_CONTENT,
} from "../../experiments/protocols/assets.ts";
import { DEV_DATASET } from "../fixtures/decision/harness.ts";

/**
 * 本体决策实验合同测试（D01/D03/D04/D10 的合同层）：
 * - 严格响应 schema：未知 ID、错误类型、额外字段、Markdown 包裹均 invalid_output
 * - abstain 与传输类失败严格分离（不得把网络错误映射为弃权）
 * - rule-choice-v1 基线：单侧命中选择、双侧/零侧弃权
 * - decision-view：泄漏标记不可见、大小上限、特征计算
 */

const OPTIONS = ["local-process", "capability/changed-file-summary"];

describe("D03：严格响应解析", () => {
  it("合法 value / abstain 通过", () => {
    expect(parseChoiceResponse('{"kind":"value","value":"local-process"}', OPTIONS)).toEqual({
      kind: "value",
      value: "local-process",
    });
    const abstain = parseChoiceResponse(
      '{"kind":"abstain","reason":"任务同时要求两种结果，当前只能选择一种"}',
      OPTIONS,
    );
    expect(abstain.kind).toBe("abstain");
  });

  it("有效 JSON 但未知 ID / 错误类型 / 额外字段 → invalid", () => {
    const unknown = parseChoiceResponse('{"kind":"value","value":"stats-worker"}', OPTIONS);
    expect(unknown.kind).toBe("invalid");
    const wrongType = parseChoiceResponse('{"kind":"value","value":123}', OPTIONS);
    expect(wrongType.kind).toBe("invalid");
    const extra = parseChoiceResponse(
      '{"kind":"value","value":"local-process","confidence":0.9}',
      OPTIONS,
    );
    expect(extra.kind).toBe("invalid");
    const abstainExtra = parseChoiceResponse('{"kind":"abstain"}', OPTIONS);
    expect(abstainExtra.kind).toBe("invalid");
  });

  it("Markdown 围栏包裹与解释文本 → invalid（禁止提取）", () => {
    const fenced = parseChoiceResponse(
      '```json\n{"kind":"value","value":"local-process"}\n```',
      OPTIONS,
    );
    expect(fenced.kind).toBe("invalid");
    const chatty = parseChoiceResponse(
      '我认为应该选统计能力。\n{"kind":"value","value":"local-process"}',
      OPTIONS,
    );
    expect(chatty.kind).toBe("invalid");
  });

  it("近似 ID / 大小写变体 / reason 超限 → invalid", () => {
    expect(parseChoiceResponse('{"kind":"value","value":"Local-Process"}', OPTIONS).kind).toBe(
      "invalid",
    );
    expect(parseChoiceResponse('{"kind":"value","value":"local_process"}', OPTIONS).kind).toBe(
      "invalid",
    );
    const long = parseChoiceResponse(`{"kind":"abstain","reason":"${"长".repeat(513)}"}`, OPTIONS);
    expect(long.kind).toBe("invalid");
  });

  it("D01：Runtime 独立校验 provider 自述 value（成员关系）", () => {
    const result: DecisionResult = {
      kind: "value",
      value: "not-an-option",
      provenance: { provider: "x", policyVersion: "v1" },
    };
    expect(validateChoice(result, OPTIONS)).toMatchObject({ ok: false, reason: "invalid_output" });
    const ok: DecisionResult = {
      kind: "value",
      value: "local-process",
      provenance: { provider: "x", policyVersion: "v1" },
    };
    expect(validateChoice(ok, OPTIONS)).toEqual({ ok: true, value: "local-process" });
  });
});

describe("D04：abstain 与传输失败严格分离（合同层）", () => {
  it("服务 refusal 映射为带来源标记的 abstain；网络错误不是 abstain", () => {
    // 合同：invalid_output/transport_error 不允许出现在 abstain 语义里——
    // parseChoiceResponse 只产生 value/abstain/invalid 三类，传输错误由
    // provider 异常承载（integration 测试覆盖），这里锁定类型区分
    const refusalLike = parseChoiceResponse('{"kind":"value","value":"local-process"}', OPTIONS);
    expect(refusalLike.kind).not.toBe("abstain");
    expect(() =>
      parseChoiceResponse('{"kind":"abstain","reason":"network error, retry?"}', OPTIONS),
    ).not.toThrow();
    const parsed = parseChoiceResponse(
      '{"kind":"abstain","reason":"network error, retry?"}',
      OPTIONS,
    );
    expect(parsed.kind).toBe("abstain"); // 模型文本可以自称任何理由；来源标记由 adapter 区分
  });
});

describe("rule-choice-v1 基线（R 组）", () => {
  const provider = new RuleDecisionProvider();
  const policy = { versionId: "ver-rule-choice-test", content: RULE_CHOICE_POLICY_CONTENT };

  const decide = async (features: Record<string, boolean>) =>
    provider.decide({
      problem: "choice",
      options: OPTIONS,
      context: {},
      policy,
      deadlineMs: 1000,
      remainingAttempts: 1,
      view: {
        viewVersion: "decision-view-v1",
        goal: "g",
        options: [],
        inputs: [],
        features,
      },
    });

  it("单侧命中选择该能力；双侧同时命中 abstain；都未命中 abstain", async () => {
    const stats = await decide({ hasStatsIntent: true, hasChangeIntent: false });
    expect(stats).toMatchObject({ kind: "value", value: "local-process" });
    const change = await decide({ hasStatsIntent: false, hasChangeIntent: true });
    expect(change).toMatchObject({ kind: "value", value: "capability/changed-file-summary" });
    const both = await decide({ hasStatsIntent: true, hasChangeIntent: true });
    expect(both.kind).toBe("abstain");
    const neither = await decide({ hasStatsIntent: false, hasChangeIntent: false });
    expect(neither.kind).toBe("abstain");
  });

  it("缺少视图特征时拒绝猜测（abstain）", async () => {
    const missing = await decide({ hasStatsIntent: true });
    expect(missing.kind).toBe("abstain");
  });

  it("旧 rule-v1 语义保持不变（回归）", async () => {
    const legacy = await provider.decide({
      problem: "choice",
      options: ["local-process"],
      context: { nodeType: "execute" },
      policy: {
        versionId: "ver-legacy",
        content: {
          schemaVersion: 2,
          kind: "rule-v1",
          routes: [{ when: { nodeType: "execute" }, choose: "local-process" }],
        },
      },
      deadlineMs: 1000,
      remainingAttempts: 1,
    });
    expect(legacy).toMatchObject({ kind: "value", value: "local-process" });
  });
});

describe("decision-view（D10：泄漏与大小）", () => {
  const content = parseDecisionViewContent(DECISION_VIEW_CONTENT);
  const bundleDir = join(DEV_DATASET, "bundles", "b01");
  const changedFiles = join(DEV_DATASET, "changed-files", "b01", "changed-files.json");

  it("视图只含 goal/选项描述/输入清单/特征；泄漏标记完全不可见", () => {
    const goal = "统计这批文本文件的字数、行数与标题数";
    const view = buildDecisionView({
      content,
      goal,
      options: OPTIONS,
      taskInputs: [bundleDir, changedFiles],
    });
    const serialized = JSON.stringify(view);
    // 答案/schema 内容/caseId/familyId/期望输出路径不进入视图
    for (const marker of [
      "dev-expl-01",
      "family-dev",
      "expected/",
      "outputSchema",
      "expectedChoice",
      "caseId",
    ]) {
      expect(serialized).not.toContain(marker);
    }
    // 输入清单只有名称/类型/字节数，没有正文内容
    const textEntry = view.inputs.find((i) => i.name.endsWith(".md"))!;
    expect(textEntry).toMatchObject({ type: "text", bytes: expect.any(Number) });
    expect(view.inputs.map((i) => i.name)).toContain("changed-files.json");
    expect(view.features).toEqual({ hasStatsIntent: true, hasChangeIntent: false });
  });

  it("大小写/Unicode 归一化命中词表（英文 goal 小写匹配）", () => {
    const view = buildDecisionView({
      content,
      goal: "Please Count Words and LINES for these notes",
      options: OPTIONS,
      taskInputs: [bundleDir, changedFiles],
    });
    expect(view.features).toEqual({ hasStatsIntent: true, hasChangeIntent: false });
  });

  it("超限输入在网络调用前被拒绝（input_too_large，禁止截断）", () => {
    expect(() =>
      buildDecisionView({
        content: { ...content, inputViewLimitBytes: 10 },
        goal: "统计字数",
        options: OPTIONS,
        taskInputs: [bundleDir, changedFiles],
      }),
    ).toThrow(DecisionViewError);
    try {
      buildDecisionView({
        content: { ...content, inputViewLimitBytes: 10 },
        goal: "统计字数",
        options: OPTIONS,
        taskInputs: [bundleDir, changedFiles],
      });
    } catch (err) {
      expect(err instanceof DecisionViewError && err.code).toBe("input_too_large");
    }
  });

  it("选项缺描述 → unknown_option 拒绝（不能让模型看到未描述选项）", () => {
    expect(() =>
      buildDecisionView({
        content,
        goal: "任意",
        options: ["local-process", "capability/not-described"],
        taskInputs: [bundleDir],
      }),
    ).toThrow(/unknown_option|描述/);
  });

  it("成对样本除 goal 派生特征外视图一致（contrast 防泄漏）", () => {
    const cases = JSON.parse(readFileSync(join(DEV_DATASET, "cases.json"), "utf8")) as {
      cases: Array<{ caseId: string; goal: string; textDir: string; changedFiles: string }>;
    };
    const a1 = cases.cases.find((c) => c.caseId === "dev-con-a1")!;
    const a2 = cases.cases.find((c) => c.caseId === "dev-con-a2")!;
    const build = (goal: string) =>
      buildDecisionView({
        content,
        goal,
        options: OPTIONS,
        taskInputs: [join(DEV_DATASET, a1.textDir), join(DEV_DATASET, a1.changedFiles)],
      });
    const v1 = build(a1.goal);
    const v2 = build(a2.goal);
    expect(v1.inputs).toEqual(v2.inputs);
    expect(v1.options).toEqual(v2.options);
    expect(v1.features).not.toEqual(v2.features); // 仅由 goal 派生的特征允许不同
  });
});

describe("DecisionRequest 合同", () => {
  it("视图与取消信号作为可选扩展进入请求（旧调用方不受影响）", () => {
    const request: DecisionRequest = {
      problem: "choice",
      options: OPTIONS,
      context: {},
      policy: { versionId: "v", content: {} },
      deadlineMs: 15_000,
      remainingAttempts: 1,
    };
    expect(request.view).toBeUndefined();
    expect(request.signal).toBeUndefined();
  });
});
