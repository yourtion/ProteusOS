import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { digestOf } from "../../src/storage/blobs.ts";
import {
  adaptiveDevelopmentTasks,
  adaptiveTask,
  adaptiveUnits,
  freezeAdaptivePlan,
  reportAdaptiveExperiment,
  selectAdaptiveChoice,
  type AdaptivePlan,
} from "../../experiments/protocols/adaptive.ts";
import {
  rehearsalObservations,
  rehearsalPlan,
  rehearsalTask,
} from "../fixtures/adaptive-behavior/rehearsal.ts";

function changed(edit: (plan: AdaptivePlan) => void) {
  const plan = structuredClone(rehearsalPlan().plan);
  edit(plan);
  return () => freezeAdaptivePlan(plan);
}

describe("adaptive-behavior-v1：冻结、隔离和离线复算", () => {
  it("冻结可重复；同族改写和重复不增加独立 family；fixture 即使过门也无收益结论", () => {
    const frozen = rehearsalPlan();
    expect(freezeAdaptivePlan(frozen.plan)).toEqual(frozen);
    const report = reportAdaptiveExperiment(frozen, rehearsalObservations(frozen));
    expect(report.engineering).toBe("passed");
    expect(report.qualityGate).toBe(true);
    expect(report.realModel).toBe("not_run");
    expect(report.benefit).toBe("not_evaluated");
    expect(report.arms.compiled.formal).toMatchObject({ planned: 6, families: 2, successRate: 1 });
    expect(report.resources.modelCalls.knownTotal).toBe(64);
    expect(report.resources.unknownCostUnits).toBe(40);
    expect(report.reserved.modelCalls).toBe(64);
    expect(reportAdaptiveExperiment(frozen, rehearsalObservations(frozen))).toEqual(report);
    expect(
      JSON.parse(
        readFileSync(new URL("../fixtures/adaptive-behavior/report.json", import.meta.url), "utf8"),
      ),
    ).toEqual(report);
    const plan = structuredClone(frozen.plan);
    plan.cases[5]!.familyId = plan.cases[4]!.familyId;
    plan.thresholds.minFormalFamilies = 1;
    const paired = freezeAdaptivePlan(plan);
    expect(
      reportAdaptiveExperiment(paired, rehearsalObservations(paired)).arms.compiled.formal.families,
    ).toBe(1);
  });

  it("拒绝跨 split family、内容复用、重复单元和开发越界", () => {
    for (const change of [
      (p: AdaptivePlan) => {
        p.cases[4]!.familyId = p.cases[0]!.familyId;
      },
      (p: AdaptivePlan) => {
        p.cases[4]!.taskDigest = p.cases[0]!.taskDigest;
      },
      (p: AdaptivePlan) => {
        p.development.push(p.development[0]!);
      },
      (p: AdaptivePlan) => {
        p.development[0]!.caseId = "formal-0";
      },
      (p: AdaptivePlan) => {
        p.cases[1]!.id = p.cases[0]!.id;
      },
      (p: AdaptivePlan) => {
        p.developmentClosedAt = p.frozenAt + 1;
      },
      (p: AdaptivePlan) => {
        p.cases = p.cases.filter((c) => c.split !== "search");
      },
    ])
      expect(changed(change)).toThrow();
  });

  it("冻结累计上限并把所有编译/搜索开销归给候选；没有空间就不能开始", () => {
    expect(
      changed((p) => {
        p.budget.modelCalls--;
      }),
    ).toThrow(/总预算/);
    expect(
      changed((p) => {
        p.development[0]!.allowance.inputTokens = 100_000;
        p.budget.inputTokens = 1_000_000;
      }),
    ).toThrow(/同预算对照/);
    expect(
      changed((p) => {
        p.mode = "real";
      }),
    ).toThrow(/40 formal/);
    const frozen = rehearsalPlan();
    const rows = rehearsalObservations(frozen);
    rows[0]!.usage.inputTokens = 2049;
    expect(reportAdaptiveExperiment(frozen, rows)).toMatchObject({
      engineering: "incomplete",
      problems: [expect.stringContaining("inputTokens")],
    });
  });

  it("learner 不读取正式文件；worker 白名单去掉标签/角色且校验任务内容", () => {
    const frozen = rehearsalPlan();
    const read: string[] = [];
    const learner = adaptiveDevelopmentTasks(frozen, (caseId) => {
      read.push(caseId);
      return {
        ...rehearsalTask(caseId),
        expectedChoice: "SECRET",
        familyId: "PRIVATE",
        split: "formal",
      };
    });
    expect(read).toEqual(["train-0", "train-1", "search-0", "search-1"]);
    expect(JSON.stringify(learner)).not.toMatch(/SECRET|PRIVATE|expectedChoice|familyId|split/);
    expect(
      adaptiveTask(frozen, "formal-0", { ...rehearsalTask("formal-0"), label: "GOLD" }),
    ).toEqual(rehearsalTask("formal-0"));
    expect(() =>
      adaptiveTask(frozen, "formal-0", { ...rehearsalTask("formal-0"), goal: "tampered" }),
    ).toThrow(/任务内容/);
  });

  it("缺失或 unknown 不退还预留、不补考、不缩小分母；缺测时 p95 不造值", () => {
    const frozen = rehearsalPlan();
    const rows = rehearsalObservations(frozen);
    const unit = adaptiveUnits(frozen.plan).findLast(
      (u) => u.split === "regression" && u.arm === "compiled",
    )!;
    const last = rows.splice(
      rows.findIndex((r) => r.unitId === unit.id),
      1,
    )[0]!;
    const report = reportAdaptiveExperiment(frozen, rows);
    expect(report.missing).toEqual([last.unitId]);
    expect(report.arms.compiled.regression.planned).toBe(6);
    expect(report.arms.compiled.regression.p95Ms).toBeNull();
    expect(report.reserved.modelCalls).toBe(64);
    expect(report.engineering).toBe("incomplete");
    rows.push({
      ...last,
      state: "unknown",
      accepted: null,
      decision: "unknown",
      endedAt: null,
      usage: {
        modelCalls: null,
        inputTokens: null,
        outputTokens: null,
        costAmount: null,
        costCurrency: null,
        priceRef: null,
      },
    });
    const open = reportAdaptiveExperiment(frozen, rows);
    expect(open.open).toEqual([last.unitId]);
    expect(open.resources.modelCalls).toEqual({ knownTotal: 63, unknownUnits: 1 });
    expect(open.reserved.modelCalls).toBe(64);
  });

  it("拒绝重复/未计划的收据、重复计费、摘要和来源漂移", () => {
    const frozen = rehearsalPlan();
    for (const edit of [
      (rows: ReturnType<typeof rehearsalObservations>) => {
        rows.push(rows[0]!);
      },
      (rows: ReturnType<typeof rehearsalObservations>) => {
        rows[0]!.unitId = "unplanned";
      },
      (rows: ReturnType<typeof rehearsalObservations>) => {
        rows[1]!.evidenceRefs = rows[0]!.evidenceRefs;
      },
      (rows: ReturnType<typeof rehearsalObservations>) => {
        rows[0]!.manifestDigest = "0".repeat(64);
      },
      (rows: ReturnType<typeof rehearsalObservations>) => {
        rows[0]!.source = "real";
      },
      (rows: ReturnType<typeof rehearsalObservations>) => {
        rows[0]!.endedAt = 101;
      },
      (rows: ReturnType<typeof rehearsalObservations>) => {
        rows[4]!.startedAt = 100;
      },
    ]) {
      const rows = rehearsalObservations(frozen);
      edit(rows);
      expect(() => reportAdaptiveExperiment(frozen, rows)).toThrow();
    }
    frozen.plan.seed++;
    expect(() => reportAdaptiveExperiment(frozen, [])).toThrow(/摘要漂移/);
  });

  it("费用按币种分别列出，缺失价格依据不能支持费用硬上限", () => {
    const frozen = rehearsalPlan();
    const rows = rehearsalObservations(frozen);
    rows[0]!.usage = {
      modelCalls: 1,
      inputTokens: null,
      outputTokens: null,
      costAmount: 1,
      costCurrency: "USD",
      priceRef: "fixture-price-usd",
    };
    rows[1]!.usage = {
      modelCalls: 1,
      inputTokens: 10,
      outputTokens: 2,
      costAmount: 2,
      costCurrency: "CNY",
      priceRef: "fixture-price-cny",
    };
    expect(reportAdaptiveExperiment(frozen, rows).resources.knownCosts).toEqual([
      { currency: "CNY", amount: 2, units: 1, priceRefs: ["fixture-price-cny"] },
      { currency: "USD", amount: 1, units: 1, priceRefs: ["fixture-price-usd"] },
    ]);
    frozen.plan.budget.cost = { currency: "USD", maxAmount: 10 };
    const capped = freezeAdaptivePlan(frozen.plan);
    const cappedRows = rehearsalObservations(capped);
    expect(reportAdaptiveExperiment(capped, cappedRows).problems).toContain("费用硬上限不可验证");
    for (const row of cappedRows)
      Object.assign(row.usage, { costAmount: 1, costCurrency: "USD", priceRef: "fixture-price" });
    expect(reportAdaptiveExperiment(capped, cappedRows).problems).toContain("总费用超额");
  });

  it("关键回归失败阻止效果门；拒绝失败标成功，异常不能伪装正确弃权", () => {
    const frozen = rehearsalPlan();
    const rows = rehearsalObservations(frozen);
    const unit = adaptiveUnits(frozen.plan).find(
      (u) => u.split === "regression" && u.arm === "compiled",
    )!;
    const row = rows.find((r) => r.unitId === unit.id)!;
    Object.assign(row, { accepted: false, state: "failed", decision: "service_refusal" });
    expect(reportAdaptiveExperiment(frozen, rows)).toMatchObject({
      qualityGate: false,
      criticalFailures: [unit.id],
    });
    row.accepted = true;
    expect(() => reportAdaptiveExperiment(frozen, rows)).toThrow(/失败或未知/);
  });
});

it("多次执行选择器不读取标签；失败/弃权占一票，同票选最早返回", () => {
  expect(selectAdaptiveChoice(["wrong", "right", "wrong"])).toBe("wrong");
  expect(selectAdaptiveChoice([null, null, "right"])).toBeNull();
  expect(selectAdaptiveChoice(["first", "second", null])).toBe("first");
  expect(() => selectAdaptiveChoice([])).toThrow();
  expect(() => selectAdaptiveChoice(["a", "a", "a", "a"])).toThrow();
});

it("每个 case 的三次重复平衡臂执行先后；损坏 manifest 在读取数据前拒绝", () => {
  const frozen = rehearsalPlan();
  const firstArms = adaptiveUnits(frozen.plan)
    .filter((u) => u.caseId === "formal-0")
    .filter((_, i) => i % 3 === 0)
    .map((u) => u.arm);
  expect(new Set(firstArms).size).toBe(3);
  frozen.plan.cases[4]!.split = "train";
  let reads = 0;
  expect(() =>
    adaptiveDevelopmentTasks(frozen, () => {
      reads++;
      return {};
    }),
  ).toThrow(/摘要漂移/);
  expect(reads).toBe(0);
});

it("超时、主动弃权、服务拒绝分列，缺失费用不会变成零费用", () => {
  const frozen = rehearsalPlan();
  const rows = rehearsalObservations(frozen);
  const units = adaptiveUnits(frozen.plan).filter(
    (u) => u.arm === "compiled" && u.split === "formal",
  );
  for (const [i, decision] of [
    "timeout",
    "model_abstain",
    "service_refusal",
    "abstain_origin_unavailable",
  ].entries()) {
    Object.assign(
      rows.find((r) => r.unitId === units[i]!.id)!,
      { state: "failed", accepted: false, decision },
    );
  }
  const report = reportAdaptiveExperiment(frozen, rows);
  expect(report.qualityGate).toBe(false);
  expect(report.arms.compiled.decisions).toMatchObject({
    timeout: 1,
    model_abstain: 1,
    service_refusal: 1,
    abstain_origin_unavailable: 1,
  });
  expect(report.resources.knownCosts).toEqual([]);
  expect(report.resources.unknownCostUnits).toBe(rows.length);
  rows[4]!.endedAt = rows[4]!.startedAt + 1_000_000;
  expect(reportAdaptiveExperiment(frozen, rows).problems.join()).toContain("durationMs");
});

it("真实模式冻结门槛/总额，开发方可见或未调用模型时不能证明收益", () => {
  const plan = structuredClone(rehearsalPlan().plan);
  plan.mode = "real";
  plan.development = [];
  plan.cases = ["train", "search", "formal", "regression"].flatMap((split) =>
    Array.from({ length: split === "formal" ? 40 : split === "regression" ? 10 : 20 }, (_, i) => ({
      ...plan.cases[0]!,
      id: `${split}-${i}`,
      familyId: `${split}-family-${i}`,
      split: split as AdaptivePlan["cases"][number]["split"],
      taskDigest: digestOf(`${split}-${i}`),
      critical: split === "regression",
    })),
  );
  plan.budget = {
    modelCalls: 800,
    inputTokens: 1_638_400,
    outputTokens: 204_800,
    durationMs: 30_000_000,
    wallClockMs: 3_600_000,
    cost: null,
  };
  const frozen = freezeAdaptivePlan(plan);
  const rows = rehearsalObservations(frozen).map((row) => ({ ...row, source: "real" as const }));
  const report = reportAdaptiveExperiment(frozen, rows);
  expect(report.realModel).toBe("ran");
  expect(report.benefit).toBe("inconclusive");
  // 40 family 上 38/40 对 36/40，恰好提升五个百分点；只验证模拟收据的数值边界。
  const units = new Map(adaptiveUnits(plan).map((u) => [u.id, u]));
  const boundary = rows.map((row) => {
    const unit = units.get(row.unitId)!;
    const accepted =
      unit.split !== "formal" ||
      Number(unit.caseId.split("-")[1]) < (unit.arm === "compiled" ? 38 : 36);
    return { ...row, accepted, misrouted: !accepted };
  });
  expect(reportAdaptiveExperiment(frozen, boundary).qualityGate).toBe(true);
  plan.visibility = "independent-custodian";
  const independent = freezeAdaptivePlan(plan);
  const zero = rehearsalObservations(independent).map((row) => ({
    ...row,
    source: "real" as const,
    usage: { ...row.usage, modelCalls: 0 },
  }));
  expect(reportAdaptiveExperiment(independent, zero)).toMatchObject({
    realModel: "not_run",
    benefit: "inconclusive",
  });
  plan.thresholds.minSuccessRate = 0.8;
  expect(() => freezeAdaptivePlan(plan)).toThrow(/指标门槛/);
  plan.thresholds.minSuccessRate = 0.9;
  plan.budget.modelCalls = 801;
  expect(() => freezeAdaptivePlan(plan)).toThrow(/累计预算上限/);
});
