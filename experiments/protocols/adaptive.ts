import { z } from "zod";
import { canonicalJson, digestOf } from "../../src/storage/blobs.ts";

/** P0-04 的离线冻结/复算合同；不发送请求、不创建 Evaluation 或 Promotion。 */
export const ADAPTIVE_PROTOCOL = "adaptive-behavior-v1";
export const ADAPTIVE_ARMS = ["single", "budget-matched", "compiled"] as const;
const splits = ["train", "search", "formal", "regression"] as const;
const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
const amount = z.number().nonnegative().finite();
const usageSchema = z.strictObject({
  modelCalls: count.nullable(),
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  costAmount: amount.nullable(),
  costCurrency: id.nullable(),
  priceRef: id.nullable(),
});
const allowanceSchema = z.strictObject({
  modelCalls: count,
  inputTokens: count,
  outputTokens: count,
  durationMs: count.positive(),
});
const caseSchema = z.strictObject({
  id,
  familyId: id,
  split: z.enum(splits),
  /** 只对交付的任务内容取摘要，不以 caseId、split、路径或标签制造独立性。 */
  taskDigest: digest,
  evaluatorDigest: digest,
  critical: z.boolean(),
});
const planSchema = z.strictObject({
  protocol: z.literal(ADAPTIVE_PROTOCOL),
  stage: z.literal("compile"),
  mode: z.enum(["fixture", "real"]),
  visibility: z.enum(["developer-visible", "independent-custodian"]),
  source: z.enum(["synthetic", "permitted"]),
  sourceDigest: digest,
  sourceCommit: id,
  developmentClosedAt: count,
  frozenAt: count,
  seed: count,
  repeats: count.positive(),
  /** 相同模型、视图、指令、schema、工具、图、裁判与环境；仅示例参数可变。 */
  fixed: z.strictObject({
    model: id,
    adapterDigest: digest,
    viewDigest: digest,
    instructionDigest: digest,
    schemaDigest: digest,
    toolsDigest: digest,
    graphDigest: digest,
    judgeDigest: digest,
    environmentDigest: digest,
  }),
  policies: z.strictObject({ baseDigest: digest, candidateDigest: digest }),
  mutable: z.tuple([z.literal("demo-selection"), z.literal("demo-order")]),
  selector: z.literal("plurality-first-tie-no-gold-v1"),
  cases: z.array(caseSchema).min(1),
  /** search/编译全开销归入 compiled；formal 开始后不得追加开发单元。 */
  development: z.array(z.strictObject({ id, caseId: id, allowance: allowanceSchema })),
  perTrial: z.strictObject({
    single: allowanceSchema,
    "budget-matched": allowanceSchema,
    compiled: allowanceSchema,
  }),
  budget: allowanceSchema.extend({
    wallClockMs: count.positive(),
    cost: z.strictObject({ currency: id, maxAmount: amount }).nullable(),
  }),
  thresholds: z.strictObject({
    minFormalFamilies: count.positive(),
    minRegressionFamilies: count.positive(),
    minSuccessRate: z.number().min(0).max(1),
    minImprovement: z.number().positive().max(1),
    maxMisrouteRate: z.number().min(0).max(1),
    maxFailureRate: z.number().min(0).max(1),
    maxP95Ms: count.positive(),
  }),
});
export type AdaptivePlan = z.infer<typeof planSchema>;
export interface FrozenAdaptivePlan {
  plan: AdaptivePlan;
  digest: string;
}
export interface AdaptiveUnit {
  id: string;
  caseId: string;
  split: (typeof splits)[number];
  arm: (typeof ADAPTIVE_ARMS)[number];
  repeat: number;
  allowance: z.infer<typeof allowanceSchema>;
}

export function adaptiveUnits(plan: AdaptivePlan): AdaptiveUnit[] {
  return [
    ...plan.development.map((unit) => ({
      ...unit,
      split: plan.cases.find((c) => c.id === unit.caseId)!.split,
      arm: "compiled" as const,
      repeat: 0,
    })),
    ...plan.cases
      .filter((c) => c.split === "formal" || c.split === "regression")
      .flatMap((c) =>
        Array.from({ length: plan.repeats }, (_, i) =>
          ADAPTIVE_ARMS.map((_, position) => {
            const arm = ADAPTIVE_ARMS[(position + i + plan.seed) % ADAPTIVE_ARMS.length]!;
            return {
              id: canonicalJson([c.id, i + 1, arm]),
              caseId: c.id,
              split: c.split,
              arm,
              repeat: i + 1,
              allowance: plan.perTrial[arm],
            };
          }),
        ).flat(),
      ),
  ];
}

export function freezeAdaptivePlan(input: unknown): FrozenAdaptivePlan {
  const plan = planSchema.parse(input);
  if (plan.developmentClosedAt > plan.frozenAt) throw new Error("development 截止点晚于冻结时间");
  if (plan.policies.baseDigest === plan.policies.candidateDigest)
    throw new Error("候选与基线内容相同，不构成编译对照");
  const ids = new Set<string>();
  const families = new Map<string, string>();
  const tasks = new Map<string, string>();
  for (const c of plan.cases) {
    if (ids.has(c.id)) throw new Error("caseId 重复");
    ids.add(c.id);
    for (const [key, map] of [
      [c.familyId, families],
      [c.taskDigest, tasks],
    ] as const) {
      if (map.has(key) && map.get(key) !== c.split)
        throw new Error("family 或任务内容跨 split 重叠");
      map.set(key, c.split);
    }
  }
  for (const split of splits) {
    if (!plan.cases.some((c) => c.split === split)) throw new Error(`缺少 ${split} split`);
  }
  for (const unit of plan.development) {
    const c = plan.cases.find((c) => c.id === unit.caseId);
    if (!c || (c.split !== "train" && c.split !== "search"))
      throw new Error("开发单元不得访问 formal/regression");
  }
  if (
    plan.mode === "real" &&
    (plan.thresholds.minSuccessRate !== 0.9 ||
      plan.thresholds.minImprovement !== 0.05 ||
      plan.thresholds.maxMisrouteRate !== 0.05 ||
      plan.thresholds.maxFailureRate !== 0.05 ||
      plan.thresholds.maxP95Ms !== 30_000)
  )
    throw new Error("真实协议的指标门槛已冻结");
  const units = adaptiveUnits(plan);
  if (new Set(units.map((unit) => unit.id)).size !== units.length)
    throw new Error("执行单元 ID 重复");
  for (const key of ["modelCalls", "inputTokens", "outputTokens", "durationMs"] as const) {
    if (units.reduce((sum, unit) => sum + unit.allowance[key], 0) > plan.budget[key])
      throw new Error(`计划预留超出总预算：${key}`);
    const total = (arm: AdaptiveUnit["arm"]) =>
      units.filter((u) => u.arm === arm).reduce((sum, u) => sum + u.allowance[key], 0);
    if (total("compiled") > total("budget-matched"))
      throw new Error(`编译总额度超过同预算对照：${key}`);
  }
  const formalFamilies = new Set(
    plan.cases.filter((c) => c.split === "formal").map((c) => c.familyId),
  );
  const regressionFamilies = new Set(
    plan.cases.filter((c) => c.split === "regression").map((c) => c.familyId),
  );
  if (
    formalFamilies.size < plan.thresholds.minFormalFamilies ||
    regressionFamilies.size < plan.thresholds.minRegressionFamilies
  )
    throw new Error("独立 family 数不足");
  if (
    plan.mode === "real" &&
    (formalFamilies.size < 40 || regressionFamilies.size < 10 || plan.repeats !== 3)
  )
    throw new Error("真实协议需要至少 40 formal / 10 regression family 及 3 次重复");
  if (plan.mode === "real") {
    if (
      plan.budget.modelCalls > 800 ||
      plan.budget.inputTokens > 1_638_400 ||
      plan.budget.outputTokens > 204_800 ||
      plan.budget.wallClockMs > 3_600_000
    )
      throw new Error("真实协议的累计预算上限已冻结");
    for (const split of ["train", "search"] as const) {
      if (new Set(plan.cases.filter((c) => c.split === split).map((c) => c.familyId)).size < 20)
        throw new Error("真实协议需要至少 20 train / 20 search family");
    }
    if (
      plan.perTrial.single.modelCalls !== 1 ||
      plan.perTrial.compiled.modelCalls !== 1 ||
      plan.perTrial["budget-matched"].modelCalls !== 3
    )
      throw new Error("真实协议固定单次 / 三次 / 编译单次对照");
  }
  return { plan, digest: digestOf(canonicalJson(plan)) };
}

const observationSchema = z.strictObject({
  unitId: id,
  manifestDigest: digest,
  /** fixture 收据不能冒充真实运行。 */
  source: z.enum(["fixture", "real"]),
  startedAt: count,
  endedAt: count.nullable(),
  state: z.enum(["succeeded", "failed", "cancelled", "unknown"]),
  /** 由隔离 evaluator 产生；开发单元必须为 null，不接受模型自报。 */
  accepted: z.boolean().nullable(),
  decision: z
    .enum([
      "value",
      "model_abstain",
      "service_refusal",
      "abstain_origin_unavailable",
      "invalid_output",
      "transport_error",
      "timeout",
      "cancelled",
      "unknown",
    ])
    .nullable(),
  misrouted: z.boolean().nullable(),
  /** Run/DecisionCall/Attempt/学习调用的原始引用，每项计量只归属一个单元。 */
  evidenceRefs: z.array(id).min(1),
  usage: usageSchema,
});
export type AdaptiveObservation = z.infer<typeof observationSchema>;

/** 持久化宿主收据也使用同一严格边界；不把解析通过当成原始证据核验。 */
export function parseAdaptiveObservation(input: unknown): AdaptiveObservation {
  return observationSchema.parse(input);
}

/** 对冻结后的收据复算；不补跑，不用完成子集替代计划分母。 */
export function reportAdaptiveExperiment(frozen: FrozenAdaptivePlan, input: unknown[]) {
  const checked = freezeAdaptivePlan(frozen.plan);
  if (checked.digest !== frozen.digest) throw new Error("manifest 摘要漂移");
  const units = adaptiveUnits(checked.plan);
  const byId = new Map(units.map((u) => [u.id, u]));
  const rows = input.map(parseAdaptiveObservation);
  const observed = new Map<string, AdaptiveObservation>();
  const refs = new Set<string>();
  const problems: string[] = [];
  for (const row of rows) {
    const unit = byId.get(row.unitId);
    if (!unit || observed.has(row.unitId)) throw new Error("未知或重复执行单元");
    if (row.manifestDigest !== checked.digest || row.source !== checked.plan.mode)
      throw new Error("收据来源或 manifest 不匹配");
    if (row.endedAt !== null && row.endedAt < row.startedAt) throw new Error("时间顺序非法");
    const development = unit.repeat === 0;
    if (
      development &&
      (row.endedAt === null ||
        row.endedAt > checked.plan.developmentClosedAt ||
        row.accepted !== null)
    )
      throw new Error("开发截止点或标签用途不合法");
    if (!development && row.startedAt < checked.plan.frozenAt) throw new Error("正式执行早于冻结");
    if (
      !development &&
      row.accepted === true &&
      (row.state !== "succeeded" || row.decision !== "value" || row.misrouted !== false)
    )
      throw new Error("失败或未知执行、异常/弃权或误派不能标记成功");
    for (const ref of row.evidenceRefs) {
      if (refs.has(ref)) throw new Error("证据引用重复计量");
      refs.add(ref);
    }
    for (const key of ["modelCalls", "inputTokens", "outputTokens"] as const) {
      const value = row.usage[key];
      if (value !== null && value > unit.allowance[key]) problems.push(`${row.unitId} 超额 ${key}`);
    }
    if (row.endedAt !== null && row.endedAt - row.startedAt > unit.allowance.durationMs)
      problems.push(`${row.unitId} 超额 durationMs`);
    observed.set(row.unitId, row);
  }
  const missing = units.filter((u) => !observed.has(u.id)).map((u) => u.id);
  const open = rows.filter((r) => r.state === "unknown" || r.endedAt === null).map((r) => r.unitId);
  const resources = (subset: AdaptiveObservation[]) => {
    const sum = (key: "modelCalls" | "inputTokens" | "outputTokens") => {
      const known = subset.map((r) => r.usage[key]).filter((v) => v !== null);
      return {
        knownTotal: known.length ? known.reduce((a, b) => a + b, 0) : null,
        unknownUnits: subset.length - known.length,
      };
    };
    const currencies = [
      ...new Set(subset.map((r) => r.usage.costCurrency).filter((c) => c !== null)),
    ].sort();
    const knownCosts = currencies.map((currency) => {
      const known = subset.filter(
        (r) => r.usage.costCurrency === currency && r.usage.costAmount !== null && r.usage.priceRef,
      );
      return {
        currency,
        amount: known.reduce((total, r) => total + r.usage.costAmount!, 0),
        units: known.length,
        priceRefs: [...new Set(known.map((r) => r.usage.priceRef!))].sort(),
      };
    });
    return {
      modelCalls: sum("modelCalls"),
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      unknownCostUnits: subset.filter(
        (r) => r.usage.costAmount === null || !r.usage.costCurrency || !r.usage.priceRef,
      ).length,
      knownCosts,
    };
  };
  const totalResources = resources(rows);
  if (checked.plan.budget.cost) {
    if (
      totalResources.unknownCostUnits ||
      rows.some((r) => r.usage.costCurrency !== checked.plan.budget.cost!.currency)
    )
      problems.push("费用硬上限不可验证");
    else if (
      (totalResources.knownCosts.find((c) => c.currency === checked.plan.budget.cost!.currency)
        ?.amount ?? 0) > checked.plan.budget.cost.maxAmount
    )
      problems.push("总费用超额");
  }
  const started = rows.map((r) => r.startedAt);
  const ended = rows.map((r) => r.endedAt ?? r.startedAt);
  const elapsedMs = rows.length ? Math.max(...ended) - Math.min(...started) : 0;
  if (elapsedMs > checked.plan.budget.wallClockMs) problems.push("实验墙钟超额");
  const summarizeArm = (arm: AdaptiveUnit["arm"]) => {
    const armUnits = units.filter((u) => u.arm === arm);
    const armRows = rows.filter((r) => byId.get(r.unitId)!.arm === arm);
    const score = (split: "formal" | "regression") => {
      const planned = armUnits.filter((u) => u.split === split);
      const families = [
        ...new Set(planned.map((u) => checked.plan.cases.find((c) => c.id === u.caseId)!.familyId)),
      ];
      // 每个 family 等权；重复、同族改写和回归不增加独立泛化样本。
      const familyScores = families.map((family) => {
        const members = planned.filter(
          (u) => checked.plan.cases.find((c) => c.id === u.caseId)!.familyId === family,
        );
        return members.filter((u) => observed.get(u.id)?.accepted === true).length / members.length;
      });
      const durations = planned
        .map((u) => observed.get(u.id))
        .filter((r) => r && r.endedAt !== null)
        .map((r) => r!.endedAt! - r!.startedAt)
        .sort((a, b) => a - b);
      return {
        planned: planned.length,
        families: families.length,
        successRate: familyScores.reduce((a, b) => a + b, 0) / familyScores.length,
        misrouteRate:
          planned.filter((u) => observed.get(u.id)?.misrouted === true).length / planned.length,
        failureRate:
          planned.filter((u) => observed.get(u.id)?.state !== "succeeded").length / planned.length,
        p95Ms:
          durations.length === planned.length
            ? durations[Math.ceil(0.95 * durations.length) - 1]!
            : null,
      };
    };
    const decisions = Object.fromEntries(
      [...new Set(armRows.map((r) => r.decision ?? "not_observed"))]
        .sort()
        .map((state) => [
          state,
          armRows.filter((r) => (r.decision ?? "not_observed") === state).length,
        ]),
    );
    const repeatSuccessRates = Array.from({ length: checked.plan.repeats }, (_, i) => {
      const planned = armUnits.filter((u) => u.split === "formal" && u.repeat === i + 1);
      const familyIds = [
        ...new Set(planned.map((u) => checked.plan.cases.find((c) => c.id === u.caseId)!.familyId)),
      ];
      return (
        familyIds.reduce((sum, family) => {
          const members = planned.filter(
            (u) => checked.plan.cases.find((c) => c.id === u.caseId)!.familyId === family,
          );
          return (
            sum +
            members.filter((u) => observed.get(u.id)?.accepted === true).length / members.length
          );
        }, 0) / familyIds.length
      );
    });
    const mean = repeatSuccessRates.reduce((a, b) => a + b, 0) / repeatSuccessRates.length;
    return {
      repeatSuccessRates,
      repeatVariance:
        repeatSuccessRates.reduce((sum, rate) => sum + (rate - mean) ** 2, 0) /
        repeatSuccessRates.length,
      formal: score("formal"),
      regression: score("regression"),
      resources: resources(armRows),
      decisions,
    };
  };
  const arms = {
    single: summarizeArm("single"),
    "budget-matched": summarizeArm("budget-matched"),
    compiled: summarizeArm("compiled"),
  };
  const candidate = arms.compiled.formal;
  const thresholds = checked.plan.thresholds;
  const families = ["formal", "regression"].flatMap((split) =>
    [...new Set(checked.plan.cases.filter((c) => c.split === split).map((c) => c.familyId))].map(
      (familyId) => {
        const familyUnits = units.filter(
          (u) => checked.plan.cases.find((c) => c.id === u.caseId)!.familyId === familyId,
        );
        const rate = (arm: AdaptiveUnit["arm"]) => {
          const members = familyUnits.filter((u) => u.arm === arm);
          return (
            members.filter((u) => observed.get(u.id)?.accepted === true).length / members.length
          );
        };
        return {
          split,
          familyId,
          single: rate("single"),
          budgetMatched: rate("budget-matched"),
          compiled: rate("compiled"),
          differenceVsSingle: rate("compiled") - rate("single"),
          differenceVsBudgetMatched: rate("compiled") - rate("budget-matched"),
        };
      },
    ),
  );
  const criticalFailures = units
    .filter(
      (u) =>
        u.arm === "compiled" &&
        u.split === "regression" &&
        checked.plan.cases.find((c) => c.id === u.caseId)!.critical &&
        observed.get(u.id)?.accepted !== true,
    )
    .map((u) => u.id);
  // family 平均产生浮点数；95%−90% 应满足恰好 5 个百分点的门槛。
  const atLeast = (value: number, threshold: number) => value + 1e-12 >= threshold;
  const qualityGate =
    atLeast(candidate.successRate, thresholds.minSuccessRate) &&
    atLeast(candidate.successRate - arms.single.formal.successRate, thresholds.minImprovement) &&
    atLeast(
      candidate.successRate - arms["budget-matched"].formal.successRate,
      thresholds.minImprovement,
    ) &&
    candidate.misrouteRate <= thresholds.maxMisrouteRate &&
    candidate.failureRate <= thresholds.maxFailureRate &&
    candidate.p95Ms !== null &&
    candidate.p95Ms <= thresholds.maxP95Ms &&
    arms.compiled.regression.successRate >= arms.single.regression.successRate &&
    arms.compiled.regression.successRate >= arms["budget-matched"].regression.successRate &&
    !criticalFailures.length;
  const complete =
    !missing.length &&
    !open.length &&
    !problems.length &&
    rows.every(
      (r) =>
        byId.get(r.unitId)!.repeat === 0 ||
        (r.accepted !== null && r.decision !== null && r.misrouted !== null),
    );
  const metered = [
    totalResources.modelCalls,
    totalResources.inputTokens,
    totalResources.outputTokens,
  ].every((v) => !v.unknownUnits);
  const ran = rows.some((r) => r.source === "real" && (r.usage.modelCalls ?? 0) > 0);
  return {
    protocol: ADAPTIVE_PROTOCOL,
    manifestDigest: checked.digest,
    engineering: complete ? "passed" : "incomplete",
    realModel: ran
      ? "ran"
      : rows.some((r) => r.source === "real" && r.usage.modelCalls === null)
        ? "unknown"
        : "not_run",
    benefit:
      checked.plan.mode === "fixture"
        ? "not_evaluated"
        : !complete || !metered || !ran || checked.plan.visibility !== "independent-custodian"
          ? "inconclusive"
          : qualityGate
            ? "supported"
            : "not_demonstrated",
    adoption: "requires-independent-evaluation-and-operator-promotion",
    qualityGate,
    missing,
    open,
    problems,
    criticalFailures,
    elapsedMs,
    reserved: Object.fromEntries(
      ["modelCalls", "inputTokens", "outputTokens", "durationMs"].map((key) => [
        key,
        units.reduce((sum, u) => sum + u.allowance[key as keyof AdaptiveUnit["allowance"]], 0),
      ]),
    ),
    resources: totalResources,
    arms,
    families,
  };
}

/** 显式白名单投影；不把 case/family/split、标签或验收资料传入 learner/worker。 */
const taskSchema = z.object({
  goal: z.string().min(1),
  inputs: z.array(z.object({ name: id, content: z.string() })),
});
export function adaptiveTask(frozen: FrozenAdaptivePlan, caseId: string, raw: unknown) {
  if (digestOf(canonicalJson(frozen.plan)) !== frozen.digest) throw new Error("manifest 摘要漂移");
  const c = frozen.plan.cases.find((item) => item.id === caseId);
  const task = taskSchema.parse(raw);
  if (!c || digestOf(canonicalJson(task)) !== c.taskDigest) throw new Error("任务内容摘要漂移");
  return task;
}

export function adaptiveDevelopmentTasks(
  frozen: FrozenAdaptivePlan,
  load: (caseId: string) => unknown,
) {
  if (digestOf(canonicalJson(frozen.plan)) !== frozen.digest) throw new Error("manifest 摘要漂移");
  return frozen.plan.cases
    .filter((c) => c.split === "train" || c.split === "search")
    .map((c) => adaptiveTask(frozen, c.id, load(c.id)));
}

/** 不访问裁判或标签；同票保留最早返回的选择，失败/弃权记作 null 一票。 */
export function selectAdaptiveChoice(choices: ReadonlyArray<string | null>): string | null {
  if (!choices.length || choices.length > 3) throw new Error("对照仅允许 1–3 次执行");
  const counts = new Map<string | null, number>();
  for (const choice of choices) counts.set(choice, (counts.get(choice) ?? 0) + 1);
  let selected: string | null = choices[0] ?? null;
  for (const [choice, votes] of counts) if (votes > counts.get(selected)!) selected = choice;
  return selected;
}
