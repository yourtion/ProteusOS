import {
  ADAPTIVE_PROTOCOL,
  adaptiveUnits,
  freezeAdaptivePlan,
  type AdaptivePlan,
  type AdaptiveObservation,
  type FrozenAdaptivePlan,
} from "../../../experiments/protocols/adaptive.ts";
import { canonicalJson, digestOf } from "../../../src/storage/blobs.ts";

/** 完全公开的协议演练，不是独立正式集，不实现未来的编译器。 */
export function rehearsalPlan(): FrozenAdaptivePlan {
  const cases = ["train", "search", "formal", "regression"].flatMap((split) =>
    Array.from({ length: 2 }, (_, i) => ({
      id: `${split}-${i}`,
      familyId: `${split}-family-${i}`,
      split: split as AdaptivePlan["cases"][number]["split"],
      taskDigest: digestOf(canonicalJson(rehearsalTask(`${split}-${i}`))),
      evaluatorDigest: digestOf(`private-evaluator:${split}-${i}`),
      critical: split === "regression",
    })),
  );
  const small = { modelCalls: 1, inputTokens: 2048, outputTokens: 256, durationMs: 30_000 };
  return freezeAdaptivePlan({
    protocol: ADAPTIVE_PROTOCOL,
    stage: "compile",
    mode: "fixture",
    visibility: "developer-visible",
    source: "synthetic",
    sourceDigest: digestOf(canonicalJson(cases)),
    sourceCommit: "fixture-no-real-implementation",
    developmentClosedAt: 100,
    frozenAt: 200,
    seed: 20261024,
    repeats: 3,
    fixed: Object.fromEntries([
      ["model", "fake-no-network"],
      ...["adapter", "view", "instruction", "schema", "tools", "graph", "judge", "environment"].map(
        (key) => [`${key}Digest`, digestOf(`fixture-${key}-v1`)],
      ),
    ]),
    policies: { baseDigest: digestOf("base"), candidateDigest: digestOf("candidate-demos") },
    mutable: ["demo-selection", "demo-order"],
    selector: "plurality-first-tie-no-gold-v1",
    cases,
    development: cases
      .filter((c) => c.split === "train" || c.split === "search")
      .map((c) => ({ id: `development-${c.id}`, caseId: c.id, allowance: small })),
    perTrial: {
      single: small,
      "budget-matched": { modelCalls: 3, inputTokens: 6144, outputTokens: 768, durationMs: 90_000 },
      compiled: small,
    },
    budget: {
      modelCalls: 64,
      inputTokens: 131072,
      outputTokens: 16384,
      durationMs: 1_920_000,
      wallClockMs: 1_920_000,
      cost: null,
    },
    thresholds: {
      minFormalFamilies: 2,
      minRegressionFamilies: 2,
      minSuccessRate: 0.9,
      minImprovement: 0.05,
      maxMisrouteRate: 0.05,
      maxFailureRate: 0.05,
      maxP95Ms: 30_000,
    },
  });
}

export function rehearsalTask(caseId: string) {
  const [split, index] = caseId.split("-");
  const ordinal =
    ["train", "search", "formal", "regression"].indexOf(split!) * 2 + Number(index) + 1;
  return {
    goal: "统计该文本的行数和词数。",
    inputs: [{ name: "file-a.md", content: `# Sample ${ordinal}\nfixture content\n` }],
  };
}

export function rehearsalObservations(frozen = rehearsalPlan()): AdaptiveObservation[] {
  return adaptiveUnits(frozen.plan).map((unit, i) => ({
    unitId: unit.id,
    manifestDigest: frozen.digest,
    source: "fixture",
    startedAt: unit.repeat === 0 ? i * 10 : 200 + i * 10,
    endedAt: unit.repeat === 0 ? i * 10 + 5 : 205 + i * 10,
    state: "succeeded",
    accepted: unit.repeat === 0 ? null : unit.arm === "compiled" || unit.split === "regression",
    decision: "value",
    misrouted: unit.repeat === 0 ? null : unit.arm !== "compiled" && unit.split === "formal",
    evidenceRefs: [`fixture-receipt-${i}`],
    usage: {
      modelCalls: unit.allowance.modelCalls,
      inputTokens: unit.allowance.modelCalls * 10,
      outputTokens: unit.allowance.modelCalls * 2,
      costAmount: null,
      costCurrency: null,
      priceRef: null,
    },
  }));
}
