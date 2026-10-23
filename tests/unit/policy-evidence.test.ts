import { describe, expect, it } from "vitest";
import {
  createPolicyEvidence,
  type PolicyDecisionObservation,
  type PolicyEvidenceCase,
  type PolicyTrialObservation,
} from "../../src/evolution/policy-evidence.ts";

const validation: PolicyEvidenceCase = { id: "v1", familyId: "v-family", expectedChoice: "worker" };
const regression: PolicyEvidenceCase = {
  id: "r1",
  familyId: "r-family",
  role: "regression",
  expectedChoice: "worker",
};

function row(
  c: PolicyEvidenceCase,
  arm: "base" | "candidate",
  repeat = 1,
  state: PolicyTrialObservation["state"] = "succeeded",
): PolicyTrialObservation {
  return {
    caseId: c.id,
    familyId: c.familyId,
    role: c.role ?? "validation",
    arm,
    repeat,
    runId: `${c.id}-${repeat}-${arm}`,
    snapshotId: `${arm}-snapshot`,
    state,
    failureReason: null,
    durationMs: 10,
    chosenOption: "worker",
    decisions: [],
  };
}

function both(cases: PolicyEvidenceCase[], repeats = 1): PolicyTrialObservation[] {
  return cases
    .flatMap((c) =>
      Array.from({ length: repeats }, (_, i) => [
        row(c, "base", i + 1),
        row(c, "candidate", i + 1),
      ]),
    )
    .flat();
}

function call(
  id: string,
  state: PolicyDecisionObservation["state"],
  abstainOrigin: PolicyDecisionObservation["abstainOrigin"] = null,
): PolicyDecisionObservation {
  return {
    callId: id,
    nodeId: "route",
    kind: "model",
    state,
    sent: state !== "prepared",
    abstainOrigin,
    requestDigest: "request",
    responseDigest: null,
    usage: null,
  };
}

describe("版本化策略评估证据", () => {
  it("同一 family 的改写和重复不增加独立样本，回归不计作验证 family", () => {
    const cases = [validation, { ...validation, id: "v2" }, regression];
    const evidence = createPolicyEvidence({ cases, repeats: 3 }, both(cases, 3));
    expect(evidence.samples).toEqual({
      validationCases: 2,
      validationFamilies: 1,
      regressionCases: 1,
      regressionFamilies: 1,
      independentValidationFamilies: 1,
    });
    expect(evidence.trials).toHaveLength(18);
    expect(evidence.arms.candidate).toMatchObject({
      plannedRuns: 9,
      terminalRuns: 9,
      validationRuns: 6,
      regressionRuns: 3,
      validationSuccessRate: 1,
      regressionSuccessRate: 1,
    });
    expect(evidence.families).toHaveLength(2);
    expect(evidence.families[0]?.caseIds).toEqual(["v1", "v2"]);
    expect(createPolicyEvidence(evidence, evidence.trials)).toEqual(evidence);
  });

  it("主动弃权、服务拒绝、缺失来源与异常分别统计，null 标签不推断为正确弃权", () => {
    const c = { ...validation, expectedChoice: null };
    const trials = both([c]);
    trials[1]!.state = "failed";
    trials[1]!.chosenOption = null;
    trials[1]!.decisions = [
      call("abstain", "abstain", "model"),
      call("refusal", "abstain", "service_refusal"),
      call("old-abstain", "abstain"),
      ...(
        [
          "invalid_output",
          "transport_error",
          "timeout",
          "cancelled",
          "unknown",
          "prepared",
          "started",
        ] as const
      ).map((state) => call(state, state)),
    ];
    const evidence = createPolicyEvidence({ cases: [c], repeats: 1 }, trials);
    expect(evidence.arms.candidate.decisions).toEqual({
      value: 0,
      model_abstain: 1,
      service_refusal: 1,
      abstain_origin_unavailable: 1,
      invalid_output: 1,
      transport_error: 1,
      timeout: 1,
      cancelled: 1,
      unknown: 1,
      prepared: 1,
      started: 1,
    });
    expect(evidence.cases[0]?.expectedChoice).toBeNull();
    expect(evidence.arms.candidate.validationSuccessRate).toBe(0);
  });

  it("缺失调用用量保留 unknown，已知费用分币种汇总，未发送预留不伪装为已计费", () => {
    const trials = both([validation]);
    const usd = call("usd", "value");
    usd.usage = {
      inputTokens: 10,
      outputTokens: 4,
      costAmount: 0.3,
      costCurrency: "USD",
      priceRef: "price-usd",
    };
    const cny = call("cny", "value");
    cny.usage = {
      inputTokens: 20,
      outputTokens: null,
      costAmount: 2,
      costCurrency: "CNY",
      priceRef: "price-cny",
    };
    const invalid = call("invalid-usage", "value");
    invalid.usage = {
      inputTokens: -1,
      outputTokens: NaN,
      costAmount: Infinity,
      costCurrency: "USD",
      priceRef: null,
    };
    trials[1]!.decisions = [
      usd,
      cny,
      invalid,
      call("timeout", "timeout"),
      call("reserved", "prepared"),
    ];
    const resources = createPolicyEvidence({ cases: [validation], repeats: 1 }, trials).arms
      .candidate.resources;
    expect(resources).toMatchObject({
      scope: "decision-calls-only",
      sentModelCalls: 4,
      reservedModelCalls: 1,
      inputTokens: { knownTotal: 30, unknownCalls: 2 },
      outputTokens: { knownTotal: 4, unknownCalls: 3 },
      unknownCostCalls: 2,
    });
    expect(resources.knownCosts).toEqual([
      { currency: "CNY", amount: 2, calls: 1, priceRefs: ["price-cny"] },
      { currency: "USD", amount: 0.3, calls: 1, priceRefs: ["price-usd"] },
    ]);
    trials[1]!.decisions = [call("only-timeout", "timeout")];
    expect(
      createPolicyEvidence({ cases: [validation], repeats: 1 }, trials).arms.candidate.resources
        .inputTokens.knownTotal,
    ).toBeNull();
  });

  it("缺失 trial 保留在计划分母，未到终态不形成改善结论", () => {
    const evidence = createPolicyEvidence({ cases: [validation, regression], repeats: 2 }, [
      row(validation, "base"),
      row(validation, "candidate", 1, "waiting"),
    ]);
    expect(evidence.trials).toHaveLength(8);
    expect(evidence.problems).toHaveLength(6);
    expect(evidence.arms.candidate.notRun).toBe(3);
    expect(evidence.arms.candidate.validationSuccessRate).toBeNull();
    expect(evidence.families.every((family) => family.result === "incomplete")).toBe(true);
  });

  it("按 family 配对记录改善和退化，失败仍进入分母", () => {
    const second = { ...validation, id: "v2", familyId: "other-family" };
    const rows = [
      row(validation, "base", 1, "failed"),
      row(validation, "candidate"),
      row(second, "base"),
      row(second, "candidate", 1, "failed"),
    ];
    const evidence = createPolicyEvidence({ cases: [validation, second], repeats: 1 }, rows);
    expect(evidence.families.map(({ result, difference }) => ({ result, difference }))).toEqual([
      { result: "improved", difference: 1 },
      { result: "degraded", difference: -1 },
    ]);
    expect(evidence.arms.candidate.validationSuccessRate).toBe(0.5);
  });

  it("拒绝重复或计划外 trial、重复 Run/调用引用，暴露验证与回归 family 重叠", () => {
    const plan = { cases: [validation], repeats: 1 };
    const rows = both(plan.cases);
    expect(() => createPolicyEvidence(plan, [...rows, rows[0]!])).toThrow(/trial 重复/);
    expect(() => createPolicyEvidence(plan, [{ ...rows[0]!, familyId: "wrong" }])).toThrow(
      /不一致/,
    );
    expect(() => createPolicyEvidence(plan, [{ ...rows[0]!, repeat: 2 }])).toThrow(/不一致/);
    expect(() =>
      createPolicyEvidence(plan, [rows[0]!, { ...rows[1]!, runId: rows[0]!.runId }]),
    ).toThrow(/重复引用 Run/);
    rows[0]!.decisions = [call("shared-call", "value")];
    rows[1]!.decisions = [call("shared-call", "value")];
    expect(() => createPolicyEvidence(plan, rows)).toThrow(/重复引用 DecisionCall/);
    const cases = [validation, { ...regression, familyId: validation.familyId }];
    const evidence = createPolicyEvidence({ cases, repeats: 1 }, both(cases));
    expect(evidence.samples.independentValidationFamilies).toBe(0);
    expect(evidence.problems).toEqual([`family 同时用于验证与回归：${validation.familyId}`]);
  });
});
