import { describe, expect, it } from "vitest";
import {
  consolidateRoutes,
  DEFAULT_CONSOLIDATION_PARAMS,
  type RouteSample,
} from "../../src/evolution/consolidation.ts";
import { RuleDecisionProvider } from "../../src/adapters/decision-rule/index.ts";
import type { DecisionRequest } from "../../src/decision/index.ts";

/**
 * M3 切片④：确定性规则归纳（纯函数）与 rule-hybrid-v1 策略合同。
 * 零提议是正常结果（"不晋升成为正常结果"）。
 */

function sample(partial: Partial<RouteSample> & { runId: string }): RouteSample {
  return {
    experienceId: `exp-${partial.runId}`,
    features: {},
    chosen: null,
    succeeded: false,
    ...partial,
  };
}

describe("consolidateRoutes：归纳器", () => {
  it("正例归纳：特征命中且选项一致达门槛 → 提议（含来源计数）", () => {
    const result = consolidateRoutes(
      [
        sample({
          runId: "r1",
          features: { hasChangeIntent: true },
          chosen: "capability/x",
          succeeded: true,
          origin: "experience",
        }),
        sample({
          runId: "r2",
          features: { hasChangeIntent: true },
          chosen: "capability/x",
          succeeded: false,
          origin: "gold",
        }),
        sample({
          runId: "r3",
          features: { hasStatsIntent: true },
          chosen: "local-process",
          succeeded: true,
        }),
      ],
      { minSupport: 2, minPrecision: 0.8, maxRules: 4 },
    );
    expect(result.proposals).toHaveLength(1);
    const rule = result.proposals[0]!;
    expect(rule.feature).toBe("hasChangeIntent");
    expect(rule.choose).toBe("capability/x");
    expect(rule.support).toBe(2);
    expect(rule.precision).toBe(1);
    expect(rule.byOrigin).toEqual({ experience: 1, gold: 1 });
    expect(rule.evidenceRunIds).toEqual(["r1", "r2"]);
    // hasStatsIntent 只有 1 个正例：低于 minSupport 不提议
    expect(result.stats.featuresScanned).toEqual(["hasChangeIntent", "hasStatsIntent"]);
    expect(result.hypothesis).toContain("经验 2 + 开发集标注 1");
  });

  it("门槛不足：支持数或精度未达 → 零提议（正常结果）", () => {
    const supportShort = consolidateRoutes([
      sample({ runId: "r1", features: { f: true }, chosen: "a", succeeded: true }),
    ]);
    expect(supportShort.proposals).toHaveLength(0);
    expect(supportShort.hypothesis).toContain("证据不足");

    const precisionShort = consolidateRoutes([
      sample({ runId: "r1", features: { f: true }, chosen: "a", succeeded: true }),
      sample({ runId: "r2", features: { f: true }, chosen: "b", succeeded: true }),
      sample({ runId: "r3", features: { f: true }, chosen: "a", succeeded: true }),
      sample({ runId: "r4", features: { f: true }, chosen: "b", succeeded: true }),
    ]);
    expect(precisionShort.proposals).toHaveLength(0); // 精度 0.5 < 0.8
  });

  it("maxRules 预限制：按支持数降序截断", () => {
    const samples: RouteSample[] = [];
    for (let i = 0; i < 3; i++)
      samples.push(
        sample({ runId: `a${i}`, features: { fa: true }, chosen: "x", succeeded: true }),
      );
    for (let i = 0; i < 2; i++)
      samples.push(
        sample({ runId: `b${i}`, features: { fb: true }, chosen: "y", succeeded: true }),
      );
    const result = consolidateRoutes(samples, { minSupport: 2, minPrecision: 0.8, maxRules: 1 });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.feature).toBe("fa");
  });

  it("弃权与无标注失败只进缺口统计", () => {
    const result = consolidateRoutes([
      sample({ runId: "abstain", features: { f: true }, chosen: null, succeeded: false }),
      sample({ runId: "unlabeled-fail", features: { f: true }, chosen: "wrong", succeeded: false }),
    ]);
    expect(result.proposals).toHaveLength(0);
    expect(result.stats.abstainMembers).toBe(1);
    expect(result.stats.failedMembers).toBe(1);
  });
});

describe("rule-hybrid-v1 策略合同", () => {
  const provider = new RuleDecisionProvider();
  const policy = {
    versionId: "v-hybrid",
    content: {
      schemaVersion: 1,
      kind: "rule-hybrid-v1",
      featureRoutes: [{ feature: "hasChangeIntent", choose: "capability/changed-file-summary" }],
      routes: [{ when: { nodeType: "execute" }, choose: "local-process" }],
    },
  };

  function decide(
    view: DecisionRequest["view"],
    context: Record<string, unknown> = { nodeType: "execute" },
  ) {
    return provider.decide({
      problem: "choice",
      options: ["local-process", "capability/changed-file-summary"],
      context,
      policy,
      deadlineMs: 1000,
      remainingAttempts: 1,
      view,
    });
  }

  it("特征单侧命中优先于兜底", async () => {
    const result = await decide({
      viewVersion: "decision-view-v1",
      goal: "对变更清单生成分类摘要",
      options: [],
      inputs: [],
      features: { hasStatsIntent: false, hasChangeIntent: true },
    });
    expect(result).toMatchObject({ kind: "value", value: "capability/changed-file-summary" });
  });

  it("零侧命中落兜底路由", async () => {
    const fallback = await decide({
      viewVersion: "decision-view-v1",
      goal: "统计摘要",
      options: [],
      inputs: [],
      features: { hasStatsIntent: false, hasChangeIntent: false },
    });
    expect(fallback).toMatchObject({ kind: "value", value: "local-process" });
  });

  it("多条规则各自命中特征（双侧）→ abstain，不猜测", async () => {
    const both = await provider.decide({
      problem: "choice",
      options: ["local-process", "capability/changed-file-summary"],
      context: { nodeType: "execute" },
      policy: {
        versionId: "v-two-rules",
        content: {
          schemaVersion: 1,
          kind: "rule-hybrid-v1",
          featureRoutes: [
            { feature: "hasStatsIntent", choose: "local-process" },
            { feature: "hasChangeIntent", choose: "capability/changed-file-summary" },
          ],
          routes: [{ when: { nodeType: "execute" }, choose: "local-process" }],
        },
      },
      deadlineMs: 1000,
      remainingAttempts: 1,
      view: {
        viewVersion: "decision-view-v1",
        goal: "既要统计也要分类",
        options: [],
        inputs: [],
        features: { hasStatsIntent: true, hasChangeIntent: true },
      },
    });
    expect(both).toMatchObject({ kind: "abstain" });
  });

  it("无视图（图未声明 view）走兜底路由", async () => {
    const result = await decide(undefined);
    expect(result).toMatchObject({ kind: "value", value: "local-process" });
  });

  it("视图缺特征拒绝猜测", async () => {
    const result = await decide({
      viewVersion: "decision-view-v1",
      goal: "x",
      options: [],
      inputs: [],
      features: {},
    });
    expect(result).toMatchObject({ kind: "abstain" });
  });
});

describe("默认参数预限制", () => {
  it("显式记录（构造候选前固定，评估可复核）", () => {
    expect(DEFAULT_CONSOLIDATION_PARAMS).toEqual({ minSupport: 2, minPrecision: 0.8, maxRules: 4 });
  });
});
