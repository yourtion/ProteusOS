import { canonicalJson } from "../storage/blobs.ts";
import type { DecisionCallUsage } from "../decision/index.ts";
import type {
  CompileJobRecord,
  CompilePlan,
  CompileReport,
  CompileTrial,
} from "./compile-types.ts";

/** 纯投影；未完成的配置保持完整计划分母，不参与获胜候选选择。 */
export function buildCompileReport(
  plan: CompilePlan,
  job: CompileJobRecord,
  trials: CompileTrial[],
  sourceUsage: Array<DecisionCallUsage | null>,
): CompileReport {
  const configurations = plan.parameterSets.map((demoIds, index) => {
    const rows = trials.filter((t) => t.configuration === index);
    const families = [...new Set(plan.search.map((c) => c.familyId))];
    return {
      demoIds,
      planned: plan.search.length,
      completed: rows.filter((t) => t.state === "completed").length,
      families: families.length,
      accuracy:
        families.reduce((total, family) => {
          const cases = plan.search.filter((c) => c.familyId === family);
          return (
            total +
            cases.filter((c) => rows.some((r) => r.caseId === c.id && r.correct)).length /
              cases.length
          );
        }, 0) / families.length,
    };
  });
  const complete =
    configurations.every((c) => c.completed === c.planned) &&
    !trials.some((t) => t.error) &&
    !job.cancelRequested &&
    job.state !== "failed" &&
    job.state !== "cancelled";
  const ranked = configurations
    .map((c, index) => ({ ...c, index }))
    .sort(
      (a, b) => b.accuracy - a.accuracy || a.demoIds.length - b.demoIds.length || a.index - b.index,
    );
  const best = ranked[0]!;
  const winner =
    complete &&
    best.index !== 0 &&
    best.accuracy + 1e-12 >= plan.thresholds.minAccuracy &&
    best.accuracy - configurations[0]!.accuracy + 1e-12 >= plan.thresholds.minImprovement
      ? best.index
      : null;
  const usage = [...sourceUsage, ...trials.map((t) => t.usage)];
  const costs = new Map<string, { amount: number; refs: Set<string> }>();
  let unknownCostCalls = 0;
  for (const u of usage) {
    if (u?.costAmount == null || !u.costCurrency || !u.priceRef) {
      unknownCostCalls++;
      continue;
    }
    const cost = costs.get(u.costCurrency) ?? { amount: 0, refs: new Set<string>() };
    cost.amount += u.costAmount;
    cost.refs.add(u.priceRef);
    costs.set(u.costCurrency, cost);
  }
  return {
    version: "compile-report-v1",
    executionMode: job.backend?.mode ?? null,
    jobId: job.id,
    planDigest: job.planDigest,
    state: job.state,
    candidateId: job.candidateId,
    error: job.error,
    selection: "family-accuracy-then-fewer-demos-then-plan-order",
    winner,
    configurations,
    sourceCases: [...plan.train, ...plan.search].map((c) => ({
      id: c.id,
      digest: c.digest,
      runId: c.runId,
      decisionId: c.decisionId,
      split: c.split,
    })),
    trials,
    resources: {
      scope: "source-decision-calls-and-compiler-calls",
      source: plan.sourceUsage,
      sourceExecutions: [...plan.train, ...plan.search].map((c) => ({
        runId: c.runId,
        durationMs: c.metering.durationMs,
        attempts: c.metering.executions,
      })),
      unknownExecutionCostAttempts: [...plan.train, ...plan.search]
        .flatMap((c) => c.metering.executions)
        .filter((a) => a.evidence?.usage?.costAmount == null).length,
      reserved: {
        calls: plan.sourceUsage.modelCalls + trials.length,
        inputTokens:
          plan.sourceUsage.inputTokens + trials.reduce((n, t) => n + t.reservation.inputTokens, 0),
        outputTokens:
          plan.sourceUsage.outputTokens +
          trials.reduce((n, t) => n + t.reservation.outputTokens, 0),
      },
      knownInputTokens: usage.reduce((n, u) => n + (u?.inputTokens ?? 0), 0),
      knownOutputTokens: usage.reduce((n, u) => n + (u?.outputTokens ?? 0), 0),
      unknownTokenCalls: usage.filter((u) => u?.inputTokens == null || u.outputTokens == null)
        .length,
      knownCosts: [...costs]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, cost]) => ({
          currency,
          amount: cost.amount,
          priceRefs: [...cost.refs].sort(),
        })),
      unknownCostCalls,
    },
    formalEvaluation: "not_run",
    adoption: "requires-adaptive-formal-evaluation-and-operator-promotion",
  };
}

export function compileRecordDigest(record: object, digestOf: (s: string) => string): string {
  return digestOf(canonicalJson({ ...record, digest: undefined }));
}
