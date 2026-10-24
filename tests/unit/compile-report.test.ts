import { describe, expect, it } from "vitest";
import { buildCompileReport } from "../../src/evolution/compile-report.ts";
import type {
  CompileCaseRecord,
  CompileJobRecord,
  CompilePlan,
  CompileTrial,
} from "../../src/evolution/compile-types.ts";
import { llmDemosFixture } from "../fixtures/decision/llm-demos.ts";

function fixture() {
  const initialPolicy = llmDemosFixture();
  const search: CompileCaseRecord[] = ["a1", "a2", "a3", "b"].map((id) => ({
    id,
    organismId: "org",
    datasetId: "dataset",
    experienceId: id,
    runId: id,
    decisionId: id,
    policyVersionId: "source-policy",
    caseId: id,
    familyId: id.startsWith("a") ? "family-a" : "family-b",
    split: "search",
    permission: "synthetic",
    expectedChoice: "local-process",
    view: initialPolicy.pool.demonstrations[0]!.view,
    requestDigest: "digest",
    responseDigest: "digest",
    taskDigest: "digest",
    sourceDigest: "digest",
    verifiedBy: "operator",
    createdAt: 0,
    digest: "digest",
    metering: { kind: "local", sent: false, usage: null, durationMs: 10, executions: [] },
  }));
  const plan: CompilePlan = {
    version: "policy-compile-v1",
    baseSnapshotId: "base",
    baseRevision: 1,
    validationSetId: "formal",
    validationPlanDigest: "digest",
    train: [],
    search,
    initialPolicy,
    parameterSets: [[], ["one", "two"], ["one"]],
    budget: {
      maxCalls: 12,
      maxInputTokens: 1200,
      maxOutputTokens: 120,
      wallClockMs: 1000,
      callTimeoutMs: 100,
    },
    thresholds: { minAccuracy: 0.9, minImprovement: 0.05 },
    requestedBy: "operator",
    sourceUsage: { modelCalls: 0, inputTokens: 0, outputTokens: 0 },
  };
  const job: CompileJobRecord = {
    id: "job",
    organismId: "org",
    planDigest: "digest",
    planRef: "ref",
    backend: null,
    state: "running",
    cancelRequested: false,
    candidateId: null,
    reportRef: null,
    error: null,
    requestedBy: "operator",
    createdAt: 0,
    startedAt: 0,
    deadlineAt: 1000,
  };
  const trials: CompileTrial[] = plan.parameterSets.flatMap((_, configuration) =>
    search.map((c, index) => ({
      id: `${configuration}-${c.id}`,
      jobId: "job",
      ordinal: configuration * 4 + index,
      configuration,
      caseId: c.id,
      familyId: c.familyId,
      policyVersionId: "policy",
      callId: `call-${configuration}-${c.id}`,
      requestRef: "ref",
      requestDigest: "digest",
      prepared: { format: "fixture", body: {} },
      backendVersion: "fake",
      provenance: { adapter: "fake" },
      reservation: { inputTokens: 100, outputTokens: 10 },
      state: "completed",
      responseRef: "response",
      responseDigest: "digest",
      servedModel: null,
      outcome: "value",
      correct: configuration > 0 || c.familyId === "family-a",
      usage: null,
      error: null,
      startedAt: 0,
      endedAt: 1,
    })),
  );
  return { plan, job, trials };
}

describe("编译报告离线选择", () => {
  it("同族多样本不压过独立 family；同分优先更少示例，其次冻结顺序", () => {
    const { plan, job, trials } = fixture();
    const report = buildCompileReport(plan, job, trials, []);
    expect(report.configurations[0]).toMatchObject({ planned: 4, families: 2, accuracy: 0.5 });
    expect(report.winner).toBe(2);
    plan.parameterSets[1] = ["other-single"];
    expect(buildCompileReport(plan, job, trials, []).winner).toBe(1);
    expect(report.resources).toMatchObject({
      reserved: { calls: 12, inputTokens: 1200, outputTokens: 120 },
      unknownTokenCalls: 12,
      unknownCostCalls: 12,
    });
  });

  it("缺失、unknown、异常、取消或失败不从部分结果选候选；不放大已完成子集", () => {
    const { plan, job, trials } = fixture();
    expect(buildCompileReport(plan, job, trials.slice(0, -1), []).winner).toBeNull();
    trials[0]!.state = "unknown";
    trials[0]!.correct = null;
    expect(buildCompileReport(plan, job, trials, []).winner).toBeNull();
    trials[0]!.state = "completed";
    trials[0]!.error = "bound violated";
    expect(buildCompileReport(plan, job, trials, []).winner).toBeNull();
    trials[0]!.error = null;
    job.state = "cancelled";
    expect(buildCompileReport(plan, job, trials, []).winner).toBeNull();
    job.state = "failed";
    expect(buildCompileReport(plan, job, trials, []).winner).toBeNull();
  });

  it("费用按币种分别累计，缺失价格依据不按零费用", () => {
    const { plan, job, trials } = fixture();
    trials[0]!.usage = {
      inputTokens: 1,
      outputTokens: 1,
      costAmount: 0.1,
      costCurrency: "USD",
      priceRef: "price-usd",
    };
    trials[1]!.usage = {
      inputTokens: null,
      outputTokens: null,
      costAmount: 2,
      costCurrency: "CNY",
      priceRef: "price-cny",
    };
    const resources = buildCompileReport(plan, job, trials, []).resources;
    expect(resources.knownCosts).toEqual([
      { currency: "CNY", amount: 2, priceRefs: ["price-cny"] },
      { currency: "USD", amount: 0.1, priceRefs: ["price-usd"] },
    ]);
    expect(resources.unknownCostCalls).toBe(10);
    expect(resources.knownInputTokens).toBe(1);
    expect(resources.unknownTokenCalls).toBe(11);
  });
});
