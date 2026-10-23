import type { DecisionCallKind, DecisionCallState, DecisionCallUsage } from "../decision/call.ts";
import type { RunState } from "../runtime/types.ts";
import type { StoredExecutionEvidence } from "../runtime/execution-evidence.ts";

export const POLICY_EVIDENCE_VERSION = "m3-policy-evidence-v1";
export type PolicyArm = "base" | "candidate";
export type PolicyCaseRole = "validation" | "regression";

export interface PolicyEvidenceCase {
  id: string;
  familyId: string;
  role?: PolicyCaseRole;
  /** null 表示未标注选择，不表示应弃权。 */
  expectedChoice: string | null;
}

export interface PolicyDecisionObservation {
  callId: string;
  nodeId: string;
  kind: DecisionCallKind;
  state: DecisionCallState;
  sent: boolean;
  abstainOrigin: "model" | "service_refusal" | null;
  requestDigest: string | null;
  responseDigest: string | null;
  usage: DecisionCallUsage | null;
}

export interface PolicyTrialObservation {
  caseId: string;
  familyId: string;
  role: PolicyCaseRole;
  arm: PolicyArm;
  repeat: number;
  runId: string | null;
  snapshotId: string | null;
  state: RunState | "not_run";
  failureReason: string | null;
  durationMs: number | null;
  chosenOption: string | null;
  decisions: PolicyDecisionObservation[];
  /** 冻结当时的 Attempt 证据引用；旧观测缺项仍为 unavailable。 */
  executions?: Array<{ attemptId: string; evidence: StoredExecutionEvidence | null }>;
}

const DECISION_OUTCOMES = [
  "value",
  "model_abstain",
  "service_refusal",
  "abstain_origin_unavailable",
  "invalid_output",
  "transport_error",
  "timeout",
  "cancelled",
  "unknown",
  "prepared",
  "started",
] as const;
export type PolicyDecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export interface PolicyResourceSummary {
  /** 执行器用量后续单独采集；这里不能称为整个任务的总成本。 */
  scope: "decision-calls-only";
  sentModelCalls: number;
  reservedModelCalls: number;
  inputTokens: { knownTotal: number | null; unknownCalls: number };
  outputTokens: { knownTotal: number | null; unknownCalls: number };
  knownCosts: Array<{ currency: string; amount: number; calls: number; priceRefs: string[] }>;
  unknownCostCalls: number;
}

export interface PolicyEvidenceArm {
  plannedRuns: number;
  terminalRuns: number;
  notRun: number;
  validationRuns: number;
  regressionRuns: number;
  /** 任一计划运行未到终态时为 null，不能丢弃缺失行提高成功率。 */
  validationSuccessRate: number | null;
  regressionSuccessRate: number | null;
  noDecisionRuns: number;
  decisions: Record<PolicyDecisionOutcome, number>;
  resources: PolicyResourceSummary;
}

export interface PolicyFamilyComparison {
  familyId: string;
  role: PolicyCaseRole;
  caseIds: string[];
  baseSuccessRate: number | null;
  candidateSuccessRate: number | null;
  difference: number | null;
  result: "improved" | "degraded" | "unchanged" | "incomplete";
}

/** 冻结的观测投影；不改变 m3-policy-eval-v1 的 verdict 或门槛。 */
export interface PolicyEvaluationEvidence {
  version: typeof POLICY_EVIDENCE_VERSION;
  cases: PolicyEvidenceCase[];
  repeats: number;
  samples: {
    validationCases: number;
    validationFamilies: number;
    regressionCases: number;
    regressionFamilies: number;
    independentValidationFamilies: number;
  };
  trials: PolicyTrialObservation[];
  arms: Record<PolicyArm, PolicyEvidenceArm>;
  families: PolicyFamilyComparison[];
  problems: string[];
}

export function createPolicyEvidence(
  plan: { cases: PolicyEvidenceCase[]; repeats: number },
  observations: PolicyTrialObservation[],
): PolicyEvaluationEvidence {
  if (!Number.isSafeInteger(plan.repeats) || plan.repeats < 1)
    throw new Error("评估证据需要正整数重复数");
  const cases = plan.cases.map((c) => ({ ...c, role: c.role ?? ("validation" as const) }));
  const caseMap = new Map(cases.map((c) => [c.id, c]));
  if (caseMap.size !== cases.length) throw new Error("评估证据 caseId 重复");
  const observed = new Map<string, PolicyTrialObservation>();
  const seenRuns = new Set<string>();
  const seenCalls = new Set<string>();
  for (const row of observations) {
    const c = caseMap.get(row.caseId);
    if (
      !c ||
      row.familyId !== c.familyId ||
      row.role !== c.role ||
      !Number.isSafeInteger(row.repeat) ||
      row.repeat < 1 ||
      row.repeat > plan.repeats ||
      (row.arm !== "base" && row.arm !== "candidate")
    )
      throw new Error("评估证据成员、family、角色或重复序号与计划不一致");
    if ((row.state === "not_run") !== (row.runId === null))
      throw new Error("评估证据运行标识与未执行状态不一致");
    const key = trialKey(row.caseId, row.repeat, row.arm);
    if (observed.has(key)) throw new Error("评估证据 trial 重复");
    if (row.runId && seenRuns.has(row.runId)) throw new Error("评估证据重复引用 Run");
    if (row.runId) seenRuns.add(row.runId);
    for (const call of row.decisions) {
      if (seenCalls.has(call.callId)) throw new Error("评估证据重复引用 DecisionCall");
      seenCalls.add(call.callId);
    }
    observed.set(key, row);
  }
  const trials: PolicyTrialObservation[] = [];
  const problems: string[] = [];
  for (const c of cases) {
    for (let repeat = 1; repeat <= plan.repeats; repeat++) {
      for (const arm of ["base", "candidate"] as const) {
        const row = observed.get(trialKey(c.id, repeat, arm));
        if (row) trials.push(row);
        else {
          problems.push(`未执行 ${c.id}/${repeat}/${arm}`);
          trials.push({
            caseId: c.id,
            familyId: c.familyId,
            role: c.role,
            arm,
            repeat,
            runId: null,
            snapshotId: null,
            state: "not_run",
            failureReason: null,
            durationMs: null,
            chosenOption: null,
            decisions: [],
          });
        }
      }
    }
  }
  const validation = cases.filter((c) => c.role === "validation");
  const regression = cases.filter((c) => c.role === "regression");
  const validationFamilies = new Set(validation.map((c) => c.familyId));
  const regressionFamilies = new Set(regression.map((c) => c.familyId));
  const overlap = [...validationFamilies].filter((id) => regressionFamilies.has(id));
  for (const id of overlap) problems.push(`family 同时用于验证与回归：${id}`);
  const families: PolicyFamilyComparison[] = [];
  for (const role of ["validation", "regression"] as const) {
    for (const familyId of new Set(cases.filter((c) => c.role === role).map((c) => c.familyId))) {
      const rows = trials.filter((row) => row.role === role && row.familyId === familyId);
      const baseSuccessRate = successRate(rows.filter((row) => row.arm === "base"));
      const candidateSuccessRate = successRate(rows.filter((row) => row.arm === "candidate"));
      const difference =
        baseSuccessRate === null || candidateSuccessRate === null
          ? null
          : candidateSuccessRate - baseSuccessRate;
      families.push({
        familyId,
        role,
        caseIds: [...new Set(rows.map((row) => row.caseId))],
        baseSuccessRate,
        candidateSuccessRate,
        difference,
        result:
          difference === null
            ? "incomplete"
            : difference > 0
              ? "improved"
              : difference < 0
                ? "degraded"
                : "unchanged",
      });
    }
  }
  return {
    version: POLICY_EVIDENCE_VERSION,
    cases,
    repeats: plan.repeats,
    samples: {
      validationCases: validation.length,
      validationFamilies: validationFamilies.size,
      regressionCases: regression.length,
      regressionFamilies: regressionFamilies.size,
      independentValidationFamilies: validationFamilies.size - overlap.length,
    },
    trials,
    arms: {
      base: summarizeArm(trials.filter((row) => row.arm === "base")),
      candidate: summarizeArm(trials.filter((row) => row.arm === "candidate")),
    },
    families,
    problems,
  };
}

function trialKey(caseId: string, repeat: number, arm: PolicyArm): string {
  return JSON.stringify([caseId, repeat, arm]);
}

function terminal(row: PolicyTrialObservation): boolean {
  return row.state === "succeeded" || row.state === "failed" || row.state === "cancelled";
}

function successRate(rows: PolicyTrialObservation[]): number | null {
  return rows.length === 0 || !rows.every(terminal)
    ? null
    : rows.filter((row) => row.state === "succeeded").length / rows.length;
}

function summarizeArm(rows: PolicyTrialObservation[]): PolicyEvidenceArm {
  const decisions = Object.fromEntries(DECISION_OUTCOMES.map((state) => [state, 0])) as Record<
    PolicyDecisionOutcome,
    number
  >;
  const calls = rows.flatMap((row) => row.decisions);
  for (const call of calls) {
    const outcome: PolicyDecisionOutcome =
      call.state !== "abstain"
        ? call.state
        : call.abstainOrigin === "model"
          ? "model_abstain"
          : call.abstainOrigin === "service_refusal"
            ? "service_refusal"
            : "abstain_origin_unavailable";
    decisions[outcome]++;
  }
  return {
    plannedRuns: rows.length,
    terminalRuns: rows.filter(terminal).length,
    notRun: rows.filter((row) => row.state === "not_run").length,
    validationRuns: rows.filter((row) => row.role === "validation").length,
    regressionRuns: rows.filter((row) => row.role === "regression").length,
    validationSuccessRate: successRate(rows.filter((row) => row.role === "validation")),
    regressionSuccessRate: successRate(rows.filter((row) => row.role === "regression")),
    noDecisionRuns: rows.filter((row) => row.state !== "not_run" && row.decisions.length === 0)
      .length,
    decisions,
    resources: summarizeResources(calls),
  };
}

function summarizeResources(calls: PolicyDecisionObservation[]): PolicyResourceSummary {
  const sent = calls.filter((call) => call.kind === "model" && call.sent);
  const tokens = (key: "inputTokens" | "outputTokens") => {
    const known = sent.map((call) => call.usage?.[key]).filter(validAmount);
    return {
      knownTotal:
        known.length === 0 && sent.length > 0 ? null : known.reduce((sum, value) => sum + value, 0),
      unknownCalls: sent.length - known.length,
    };
  };
  const costs = new Map<string, { amount: number; calls: number; priceRefs: Set<string> }>();
  let unknownCostCalls = 0;
  for (const call of sent) {
    const usage = call.usage;
    if (!validAmount(usage?.costAmount) || !usage?.costCurrency) {
      unknownCostCalls++;
      continue;
    }
    const cost = costs.get(usage.costCurrency) ?? {
      amount: 0,
      calls: 0,
      priceRefs: new Set<string>(),
    };
    cost.amount += usage.costAmount;
    cost.calls++;
    if (usage.priceRef) cost.priceRefs.add(usage.priceRef);
    costs.set(usage.costCurrency, cost);
  }
  return {
    scope: "decision-calls-only",
    sentModelCalls: sent.length,
    reservedModelCalls: calls.filter(
      (call) => call.kind === "model" && !call.sent && call.state === "prepared",
    ).length,
    inputTokens: tokens("inputTokens"),
    outputTokens: tokens("outputTokens"),
    knownCosts: [...costs]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, cost]) => ({
        currency,
        amount: cost.amount,
        calls: cost.calls,
        priceRefs: [...cost.priceRefs].sort(),
      })),
    unknownCostCalls,
  };
}

function validAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
