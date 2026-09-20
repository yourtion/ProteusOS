import { describe, expect, it } from "vitest";
import { RuleDecisionProvider } from "../../src/adapters/decision-rule/index.ts";
import { validateChoice, type DecisionResult } from "../../src/decision/index.ts";

const provider = new RuleDecisionProvider();
const POLICY = {
  versionId: "policy-v9",
  content: {
    schemaVersion: 2,
    kind: "rule-v1",
    routes: [
      { when: { nodeType: "execute" }, choose: "local-process" },
      { when: { nodeType: "execute", env: "ci" }, choose: "ci-runner" },
    ],
  },
};

function decide(
  context: Record<string, unknown>,
  content: unknown = POLICY.content,
  options = ["local-process", "ci-runner"],
) {
  return provider.decide({
    problem: "choice",
    options,
    context,
    policy: { versionId: "policy-v9", content },
    deadlineMs: 1000,
    remainingAttempts: 3,
  });
}

describe("RuleDecisionProvider", () => {
  it("首条命中的 route 决定结果", async () => {
    const result = await decide({ nodeType: "execute" });
    expect(result).toMatchObject({ kind: "value", value: "local-process" });
  });

  it("无 route 命中时 abstain，绝不猜测", async () => {
    const result = await decide({ nodeType: "decision" });
    expect(result.kind).toBe("abstain");
  });

  it("策略内容不合法时 abstain", async () => {
    const result = await decide({ nodeType: "execute" }, { kind: "something-else" });
    expect(result.kind).toBe("abstain");
  });

  it("choose 非字符串时 abstain（choice 语义）", async () => {
    const result = await decide(
      { nodeType: "execute" },
      { kind: "rule-v1", routes: [{ when: { nodeType: "execute" }, choose: 42 }] },
    );
    expect(result.kind).toBe("abstain");
  });

  it("capabilities 声明 choice 与 gate", () => {
    expect(provider.capabilities().problems).toContain("choice");
  });
});

describe("validateChoice：Runtime 独立校验", () => {
  const provenance = { provider: "p", policyVersion: "v" };

  it("候选内字符串通过", () => {
    const result: DecisionResult = { kind: "value", value: "b", provenance };
    expect(validateChoice(result, ["a", "b"])).toEqual({ ok: true, value: "b" });
  });

  it("候选外字符串是 invalid_output，不是 abstain", () => {
    const result: DecisionResult = { kind: "value", value: "ghost", provenance };
    expect(validateChoice(result, ["a"])).toMatchObject({ ok: false, reason: "invalid_output" });
  });

  it("非字符串值是 invalid_output", () => {
    const result: DecisionResult = { kind: "value", value: 42, provenance };
    expect(validateChoice(result, ["a"])).toMatchObject({ ok: false, reason: "invalid_output" });
  });

  it("abstain 与非法输出分开", () => {
    const result: DecisionResult = { kind: "abstain", reason: "no route", provenance };
    expect(validateChoice(result, ["a"])).toMatchObject({ ok: false, reason: "abstain" });
  });
});
