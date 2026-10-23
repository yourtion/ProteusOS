import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AppInstance } from "../../src/app/instance.ts";
import { ensureCapabilityGenome } from "../../src/evolution/assets.ts";
import type { PolicyEvaluationPlan } from "../../src/evolution/index.ts";
import type { CapabilityModule } from "../../src/runtime/capability.ts";
import { SqliteDb } from "../../src/storage/sqlite.ts";
import {
  bootSeededInstance,
  fixturePath,
  registerPolicyValidationSet,
  REPO_ROOT,
  upgradeJudgeToActive,
} from "../helpers.ts";

const CFS = join(REPO_ROOT, "tests/fixtures/changed-file-summary");
const summaryGoal = "将这些改动文件按源码、测试与文档分类汇总";
const goldMatches = [
  { goal: summaryGoal, choice: "capability/changed-file-summary" },
  { goal: `${summaryGoal}（另一批）`, choice: "capability/changed-file-summary" },
];

const statsRegression = {
  id: "policy-regression-stats",
  familyId: "policy-regression-stats-family",
  role: "regression" as const,
  task: {
    goal: "统计独立回归文本样本的字数和行数",
    inputs: [fixturePath("input-a")],
    budget: { maxAttempts: 1, maxWallClockSeconds: 60 },
    acceptance: {
      outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
      verifier: "stats-acceptance",
    },
  },
  expectedChoice: "local-process",
};

function plan(cases: PolicyEvaluationPlan["cases"], repeats = 1): PolicyEvaluationPlan {
  return {
    cases,
    repeats,
    thresholds: { minSuccessRate: 0.5, minImprovement: 0, minSamples: 1 },
    requestedBy: "principal-local",
  };
}

function summaryValidation(id = "policy-validation-summary") {
  return {
    id,
    familyId: `${id}-family`,
    role: "validation" as const,
    task: {
      goal: "根据改动文件清单整理各类文件的职责",
      inputs: [join(CFS, "inputs", "changed-files.json")],
      budget: { maxAttempts: 1, maxWallClockSeconds: 60 },
      acceptance: { outputSchema: join(CFS, "schema.json"), verifier: "stats-acceptance" },
    },
    expectedChoice: "capability/changed-file-summary",
  };
}

function installCapability(app: AppInstance): void {
  upgradeJudgeToActive(app);
  const module: CapabilityModule = {
    kind: "capability-module-v1",
    name: "changed-file-summary",
    entry: "index.mjs",
    files: [{ path: "index.mjs", content: readFileSync(join(CFS, "implementation.mjs"), "utf8") }],
  };
  const genome = ensureCapabilityGenome(
    { kernel: app.kernel, storage: app.storage, blobs: app.blobs, clock: { now: Date.now } },
    {
      baseSnapshotId: app.kernel.getOrganism("organism-default")!.activeGenomeId!,
      capabilities: [{ name: "changed-file-summary", module }],
      createdBy: "principal-local",
    },
  );
  app.storage.tx(() => {
    const organism = app.kernel.getOrganism("organism-default")!;
    if (!app.kernel.installAsActive("organism-default", genome.snapshot.id, organism.revision).ok) {
      throw new Error("测试装配 CAS 冲突");
    }
  });
}

async function candidateWith(planToFreeze: PolicyEvaluationPlan): Promise<{
  app: AppInstance;
  candidateId: string;
  validationSetId: string;
}> {
  const app = bootSeededInstance();
  installCapability(app);
  for (const goal of [summaryGoal, `${summaryGoal}（另一批）`]) {
    const run = await app.runtime.submitTask({
      requestedBy: "principal-local",
      goal,
      inputs: [join(CFS, "inputs", "changed-files.json")],
      budget: { maxAttempts: 1, maxWallClockSeconds: 60 },
      acceptance: { outputSchema: join(CFS, "schema.json"), verifier: "stats-acceptance" },
    });
    expect(run.state).toBe("failed");
  }
  const dev = app.evolution.freezeExperienceWindow({
    purpose: "development",
    createdBy: "principal-local",
  });
  const validationSetId = registerPolicyValidationSet(app, planToFreeze);
  const proposed = await app.evolution.proposePolicyCandidate({
    datasetId: dev.dataset.id,
    validationSetId,
    goldMatches,
    createdBy: "principal-local",
  });
  expect(proposed.candidate).not.toBeNull();
  return { app, candidateId: proposed.candidate!.id, validationSetId };
}

describe("冻结策略验证证据", () => {
  let open: AppInstance[] = [];
  afterAll(() => open.forEach((app) => app.close()));

  it("单 regression 连续三次成功的跨重复方差为零，评估幂等且 evaluation run 不进入 development", async () => {
    const frozenPlan = plan([statsRegression], 3);
    const { app, candidateId, validationSetId } = await candidateWith(frozenPlan);
    open.push(app);
    const first = await app.evolution.evaluatePolicyCandidate(candidateId);
    expect(first.evaluation.verdict).toBe("eligible");
    expect(first.evaluation.policy?.candidate.successRate).toBe(1);
    expect(first.evaluation.policy?.candidate.successRateVariance).toBe(0);
    expect(first.evaluation.datasetRef).toBe(validationSetId);
    expect(first.evaluation.datasetSplitRefs).toEqual([statsRegression.id]);
    const evidence = first.evaluation.policyEvidence!;
    expect(evidence.version).toBe("m3-policy-evidence-v1");
    expect(evidence.samples).toMatchObject({
      validationCases: 0,
      independentValidationFamilies: 0,
      regressionCases: 1,
      regressionFamilies: 1,
    });
    expect(evidence.trials).toHaveLength(6);
    expect(
      evidence.trials.every((trial) => trial.executions?.[0]?.evidence?.traceStatus === "complete"),
    ).toBe(true);
    expect(evidence.arms.candidate.decisions.value).toBe(3);
    expect(evidence.arms.candidate.resources.sentModelCalls).toBe(0);
    expect(app.storage.getEvaluation(first.evaluation.id)?.policyEvidence).toEqual(evidence);
    expect(app.storage.getRun(first.evaluation.runs[0]!.runId)?.purpose).toBe("evaluation");
    expect(app.evolution.validationSet(validationSetId).usageCount).toBe(1);
    const repeatedSetPlan = {
      ...frozenPlan,
      cases: frozenPlan.cases.map((c) => ({ ...c, id: `${c.id}-repacked` })),
    };
    expect(() => registerPolicyValidationSet(app, repeatedSetPlan, "repacked-source")).toThrow(
      /family.*已使用|family.*验证/,
    );

    const replay = await app.evolution.evaluatePolicyCandidate(candidateId, frozenPlan);
    expect(replay.evaluation.id).toBe(first.evaluation.id);
    expect(app.evolution.validationSet(validationSetId).usageCount).toBe(1);

    const development = app.evolution.freezeExperienceWindow({
      purpose: "development",
      createdBy: "principal-local",
    });
    const members = app.evolution.experienceDatasetView(development.dataset.id).members;
    expect(members.some((m) => first.evaluation.runs.some((r) => r.runId === m.runId))).toBe(false);
    expect(() =>
      app.evolution.freezeExperienceWindow({
        purpose: "development",
        runIds: first.evaluation.runs.map((r) => r.runId),
        createdBy: "principal-local",
      }),
    ).toThrow(/验证经历不得作为 development/);

    // 已有包装记录和更早的裸 metrics 记录都允许缺失新版证据，不伪造补齐。
    const legacyDb = new SqliteDb(join(app.root, "metadata.sqlite"));
    try {
      legacyDb.run(
        "UPDATE evaluations SET metrics = ? WHERE id = ?",
        JSON.stringify({
          metrics: first.evaluation.metrics,
          policy: first.evaluation.policy,
          datasetSplitRefs: first.evaluation.datasetSplitRefs,
        }),
        first.evaluation.id,
      );
      const oldWrapped = app.storage.getEvaluation(first.evaluation.id)!;
      expect(oldWrapped.policyEvidence).toBeUndefined();
      expect(oldWrapped.policy).toEqual(first.evaluation.policy);
      legacyDb.run(
        "UPDATE evaluations SET metrics = ? WHERE id = ?",
        JSON.stringify(first.evaluation.metrics),
        first.evaluation.id,
      );
      const oldBare = app.storage.getEvaluation(first.evaluation.id)!;
      expect(oldBare.policyEvidence).toBeUndefined();
      expect(oldBare.metrics).toEqual(first.evaluation.metrics);
    } finally {
      legacyDb.close();
    }
  });

  it("基线所有 case 失败时结果 inconclusive；plan/task/schema/threshold 漂移在领用前拒绝", async () => {
    const frozenPlan = plan([{ ...summaryValidation("drift-validation"), role: "regression" }]);
    const { app, candidateId, validationSetId } = await candidateWith(frozenPlan);
    open.push(app);
    const changedGoal: PolicyEvaluationPlan = {
      ...frozenPlan,
      cases: frozenPlan.cases.map((c) => ({
        ...c,
        task: { ...c.task, goal: `${c.task.goal} 改写` },
      })),
    };
    const changedSchema: PolicyEvaluationPlan = {
      ...frozenPlan,
      cases: frozenPlan.cases.map((c) => ({
        ...c,
        task: {
          ...c.task,
          acceptance: {
            ...c.task.acceptance,
            outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
          },
        },
      })),
    };
    const changedThreshold: PolicyEvaluationPlan = {
      ...frozenPlan,
      thresholds: { ...frozenPlan.thresholds, minSuccessRate: 0.9 },
    };
    await expect(app.evolution.evaluatePolicyCandidate(candidateId, changedGoal)).rejects.toThrow(
      /不得在候选生成后修改/,
    );
    await expect(app.evolution.evaluatePolicyCandidate(candidateId, changedSchema)).rejects.toThrow(
      /不得在候选生成后修改/,
    );
    await expect(
      app.evolution.evaluatePolicyCandidate(candidateId, changedThreshold),
    ).rejects.toThrow(/不得在候选生成后修改/);
    expect(app.evolution.validationSet(validationSetId).usageCount).toBe(0);
    const result = await app.evolution.evaluatePolicyCandidate(candidateId);
    expect(result.evaluation.verdict).toBe("inconclusive");
    expect(result.evaluation.policy?.base.successRate).toBe(0);
  });

  it("schema 验收通过但标注路由选择错误时仍 rejected", async () => {
    const mislabeledStats = {
      id: "mislabeled-stats-route",
      familyId: "mislabeled-stats-route-family",
      role: "validation" as const,
      task: {
        goal: "汇总此文本集合的词数和行数",
        inputs: [fixturePath("input-a")],
        budget: { maxAttempts: 1, maxWallClockSeconds: 60 },
        acceptance: {
          outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
          verifier: "stats-acceptance",
        },
      },
      // Task succeeds via local-process, but this was fixed as the expected route.
      expectedChoice: "capability/changed-file-summary",
    };
    const frozenPlan = plan([statsRegression, mislabeledStats]);
    const { app, candidateId } = await candidateWith(frozenPlan);
    open.push(app);
    const result = await app.evolution.evaluatePolicyCandidate(candidateId);
    expect(result.evaluation.runs.every((run) => run.state === "succeeded")).toBe(true);
    expect(result.evaluation.policy?.candidate.successRate).toBe(1);
    expect(result.evaluation.policy?.candidate.routeAccuracy).toBeLessThan(1);
    expect(result.evaluation.verdict).toBe("rejected");
  });

  it("拒绝无 regression、重复 ID 与无效 plan；正式使用的 family 不能重新包装", async () => {
    const app = bootSeededInstance();
    open.push(app);
    const invalidPlans = [
      plan([summaryValidation("missing-regression")]),
      plan([statsRegression, { ...statsRegression, id: statsRegression.id }]),
      plan([
        {
          ...statsRegression,
          task: {
            ...statsRegression.task,
            acceptance: {
              ...statsRegression.task.acceptance,
              outputSchema: "/missing/schema.json",
            },
          },
        },
      ]),
    ];
    for (const invalid of invalidPlans) {
      expect(() => registerPolicyValidationSet(app, invalid)).toThrow();
    }
  });

  it("拒绝显式引用缺失成员，并在冻结后检测成员投影摘要漂移", async () => {
    const app = bootSeededInstance();
    open.push(app);
    const run = await app.runtime.submitTask({
      requestedBy: "principal-local",
      goal: "统计冻结成员缺失与摘要漂移测试样本",
      inputs: [fixturePath("input-a")],
      budget: { maxAttempts: 1, maxWallClockSeconds: 60 },
      acceptance: {
        outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
        verifier: "stats-acceptance",
      },
    });
    expect(run.state).toBe("succeeded");
    expect(() =>
      app.evolution.freezeExperienceWindow({
        purpose: "development",
        runIds: ["run-does-not-exist"],
        createdBy: "principal-local",
      }),
    ).toThrow(/成员不存在/);

    const frozen = app.evolution.freezeExperienceWindow({
      purpose: "development",
      runIds: [run.runId],
      createdBy: "principal-local",
    });
    const saved = app.storage.getExperienceByRun(run.runId)!;
    app.storage.insertExperience({
      ...saved,
      outcome: { ...saved.outcome, durationMs: saved.outcome.durationMs + 1 },
    });
    expect(() => app.evolution.experienceDatasetView(frozen.dataset.id)).toThrow(/内容已漂移/);
  });
});
