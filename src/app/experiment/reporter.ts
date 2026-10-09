import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, digestOf, type BlobStore } from "../../storage/blobs.ts";
import type { Storage } from "../../storage/store.ts";
import { bundleDigestFrom } from "./dataset.ts";
import { REPORT_ALGO_VERSION, type TrialRow } from "./runner.ts";

/**
 * 只读证据报告器（实验规范 §7/§8）：从 manifest、trials.jsonl 与实例数据库
 * 复算全部指标；汇总过程不调用模型。校验唯一键 (experimentId, arm, caseId,
 * repeat)、分母完整性与数据漂移——重复/缺失/损坏不静默跳过（D11/D14）。
 */

export interface ReportOutcome {
  /** engineering=passed 表示合同/恢复/预算证据链完整（fake 亦可得） */
  engineering: "passed" | "failed";
  /** realModel：是否发生真实模型调用（fake 演练固定 not_run） */
  realModel: "ran" | "not_run";
  benefit: "demonstrated_on_fixture" | "not_demonstrated" | "inconclusive" | "not_evaluated";
  gates: Array<{ id: string; requirement: string; actual: string; passed: boolean | null }>;
  problems: string[];
  reportPath: string;
}

interface ManifestShape {
  digest?: unknown;
  protocolId?: unknown;
  datasetPurpose?: unknown;
  split?: unknown;
  llmConfig?: { llmImpl?: unknown } | undefined;
  cases?: Array<{
    caseId: string;
    familyId: string;
    stratum: string;
    goalDigest: string;
    textDir: string;
    changedFiles: string;
    bundleDigest: string;
    expectedChoice: string;
    schemaDigest: string;
    expectedDigest: string | null;
  }>;
  arms?: Record<string, { snapshotId?: unknown } | undefined>;
}

export class ReportError extends Error {
  readonly code: "manifest_invalid" | "trials_invalid" | "digest_drift" | "scope_mismatch";

  constructor(code: ReportError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export function generateReport(args: {
  dir: string;
  storage: Storage;
  blobs?: BlobStore;
  datasetDir: string | null;
  organismId?: string;
  writeMarkdown?: boolean;
}): ReportOutcome {
  const { dir, storage } = args;
  const problems: string[] = [];

  // ---- manifest 装载与漂移校验（D11：修改裁判/输入/manifest 摘要须失败）----
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath))
    throw new ReportError("manifest_invalid", `缺少 manifest.json：${dir}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestShape &
    Record<string, unknown>;
  if ((manifest["organismId"] ?? "organism-default") !== (args.organismId ?? "organism-default"))
    throw new ReportError("scope_mismatch", "实验报告属于其他个体");
  const { digest: claimedDigest, ...manifestBody } = manifest;
  const recomputedDigest = digestOf(canonicalJson(manifestBody));
  if (typeof claimedDigest !== "string" || claimedDigest !== recomputedDigest) {
    throw new ReportError(
      "digest_drift",
      `manifest 摘要不匹配（声明 ${String(claimedDigest)}，复算 ${recomputedDigest}）——冻结后内容被修改`,
    );
  }
  const manifestCases = manifest.cases ?? [];
  if (manifestCases.length === 0)
    throw new ReportError("manifest_invalid", "manifest 没有 case 成员");
  if (args.datasetDir) {
    problems.push(...verifyDatasetDrift(args.datasetDir, manifestCases));
  }

  // ---- trials 装载与唯一键校验（D14：重复/缺失/损坏不静默跳过）----
  const trialsPath = join(dir, "trials.jsonl");
  if (!existsSync(trialsPath)) throw new ReportError("trials_invalid", `缺少 trials.jsonl：${dir}`);
  const rows: TrialRow[] = [];
  const corruptLines: number[] = [];
  const rawLines = readFileSync(trialsPath, "utf8").split("\n");
  rawLines.forEach((line, index) => {
    if (line.trim().length === 0) return;
    try {
      rows.push(JSON.parse(line) as TrialRow);
    } catch {
      corruptLines.push(index + 1);
    }
  });
  if (corruptLines.length > 0) {
    problems.push(`trials.jsonl 存在损坏行（行号 ${corruptLines.join(", ")}），不静默丢弃`);
  }
  if (rows.length === 0) {
    problems.push("trials.jsonl 没有可解析的有效行（无法计算任何指标）");
  }
  for (const row of rows) {
    const run = storage.getRun(row.runId);
    if (run && run.organismId !== (args.organismId ?? "organism-default"))
      throw new ReportError("scope_mismatch", "trial 关联了其他个体的私有运行");
  }
  const keys = new Map<string, TrialRow>();
  const duplicateKeys: string[] = [];
  for (const row of rows) {
    const key = `${row.experimentId}|${row.arm}|${row.caseId}|${row.repeat}`;
    if (keys.has(key)) duplicateKeys.push(key);
    keys.set(key, row);
  }
  if (duplicateKeys.length > 0) {
    problems.push(`重复 trial key ${duplicateKeys.length} 个（首个 ${duplicateKeys[0]}）`);
  }
  const manifestCaseIds = new Set(manifestCases.map((c) => c.caseId));
  for (const row of rows) {
    if (!manifestCaseIds.has(row.caseId)) {
      problems.push(`trial ${row.caseId} 不在冻结 manifest 内`);
    }
  }

  const gold = new Map(manifestCases.map((c) => [c.caseId, c]));
  const executable = manifestCases.filter((c) => c.expectedChoice !== "abstain");
  const abstainCases = manifestCases.filter((c) => c.expectedChoice === "abstain");
  const repeats = [...new Set(rows.map((r) => r.repeat))].sort((a, b) => a - b);
  // 分母的 arm 集合取实际出现的 arm：单臂运行（开发探索）是合法模式，
  // 其完整性按该臂自身校验；正式比较缺臂时收益结论记 inconclusive
  const presentArms = [...new Set(rows.map((r) => r.arm))] as Array<"R" | "L">;
  const arms: Array<"R" | "L"> = presentArms.length > 0 ? presentArms : ["R", "L"];
  const bothArmsPresent = presentArms.includes("R") && presentArms.includes("L");

  // 期望 trial 单元：case × 出现过的 arm × repeat
  const expectedKeys = new Set<string>();
  for (const c of manifestCases) {
    for (const arm of arms) {
      for (const r of repeats)
        expectedKeys.add(`${rows[0]?.experimentId ?? ""}|${arm}|${c.caseId}|${r}`);
    }
  }
  const missingTrials: string[] = [];
  for (const key of expectedKeys) {
    if (!keys.has(key) && rows[0]) missingTrials.push(key);
  }
  if (rows.length > 0 && missingTrials.length > 0) {
    problems.push(`缺失 trial ${missingTrials.length} 个（首个 ${missingTrials[0]}）`);
  }

  // ---- 数据库证据交叉核对（unknown 调用、blob 完整性）----
  const unknownCalls: string[] = [];
  for (const row of rows) {
    if (row.decisionId) {
      const call = storage.getDecisionCall(row.decisionId);
      if (!call) {
        problems.push(
          `决策调用 ${row.decisionId}（trial ${row.caseId}/${row.arm}#${row.repeat}）在实例中不存在`,
        );
        continue;
      }
      if (call.state === "unknown" || call.state === "started") {
        unknownCalls.push(call.id);
      }
      if (call.requestRef && args.blobs && !args.blobs.has(call.requestRef)) {
        problems.push(`决策调用 ${call.id} 的请求 blob 缺失`);
      }
    } else {
      problems.push(`trial ${row.caseId}/${row.arm}#${row.repeat} 没有关联决策调用`);
    }
  }
  if (unknownCalls.length > 0) {
    problems.push(`存在未结 unknown/started 决策调用 ${unknownCalls.length} 个（不虚构结果）`);
  }

  // ---- 指标（§7.1 精确定义）----
  const executableIds = new Set(executable.map((c) => c.caseId));
  const N = executable.length;
  const K = repeats.length;
  const perArmRound = (arm: "R" | "L", repeat: number) =>
    rows.filter((r) => r.arm === arm && r.repeat === repeat && executableIds.has(r.caseId));
  const successRate = (arm: "R" | "L") => {
    const eligible = rows.filter((r) => r.arm === arm && executableIds.has(r.caseId));
    return eligible.length === 0
      ? null
      : eligible.filter((r) => r.accepted).length / eligible.length;
  };
  const roundSuccess = (arm: "R" | "L") =>
    repeats.map((r) => {
      const round = perArmRound(arm, r);
      return { repeat: r, success: round.filter((x) => x.accepted).length, total: round.length };
    });
  const choiceAccuracy = (arm: "R" | "L") => {
    const eligible = rows.filter((r) => r.arm === arm && executableIds.has(r.caseId));
    return eligible.length === 0
      ? null
      : eligible.filter((r) => r.choice === gold.get(r.caseId)?.expectedChoice).length /
          eligible.length;
  };
  const abstainCorrect = (arm: "R" | "L") => {
    const eligible = rows.filter((r) => r.arm === arm && !executableIds.has(r.caseId));
    return {
      correct: eligible.filter((r) => r.callState === "abstain" && r.attempts === 0).length,
      misdispatched: eligible.filter((r) => r.choice !== null || r.attempts > 0).length,
      total: eligible.length,
    };
  };
  const coverage = (arm: "R" | "L") => {
    const eligible = rows.filter((r) => r.arm === arm);
    const byState = new Map<string, number>();
    for (const row of eligible) {
      const state = row.callState ?? "missing";
      byState.set(state, (byState.get(state) ?? 0) + 1);
    }
    return Object.fromEntries([...byState.entries()].sort());
  };
  const latency = (arm: "R" | "L") => {
    const all = rows.filter((r) => r.arm === arm && r.latencyMs !== null).map((r) => r.latencyMs!);
    const successes = rows
      .filter((r) => r.arm === arm && r.accepted && r.latencyMs !== null)
      .map((r) => r.latencyMs!);
    const p = (sorted: number[], q: number) =>
      sorted.length === 0
        ? null
        : sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
    return {
      allCount: all.length,
      successP50: p(
        [...successes].sort((a, b) => a - b),
        0.5,
      ),
      successP95: p(
        [...successes].sort((a, b) => a - b),
        0.95,
      ),
    };
  };
  const costs = () => {
    const withUsage = rows.filter((r) => r.usage !== null);
    const unknownCost = withUsage.filter(
      (r) => (r.usage as { costAmount?: unknown }).costAmount === null,
    ).length;
    const knownCost = withUsage
      .map((r) => (r.usage as { costAmount?: unknown }).costAmount)
      .filter((v): v is number => typeof v === "number");
    const realRequests = rows.filter((r) => r.arm === "L" && r.callState !== null).length;
    return {
      realRequests,
      withUsage: withUsage.length,
      unknownCostEntries: unknownCost,
      knownCostCount: knownCost.length,
    };
  };
  const stratumTable = () =>
    [...new Set(manifestCases.map((c) => c.stratum))].map((stratum) => ({
      stratum,
      perArmRound: arms.map((arm) => ({
        arm,
        rounds: repeats.map((r) => {
          const round = rows.filter(
            (row) => row.arm === arm && row.repeat === r && row.stratum === stratum,
          );
          return {
            repeat: r,
            success: round.filter((x) => x.accepted).length,
            total: round.length,
          };
        }),
      })),
    }));
  const contrastPairs = () => {
    const byFamily = new Map<string, string[]>();
    for (const c of manifestCases.filter((m) => m.stratum === "contrast")) {
      byFamily.set(c.familyId, [...(byFamily.get(c.familyId) ?? []), c.caseId]);
    }
    return [...byFamily.entries()].map(([family, caseIds]) => {
      const bothCorrect = repeats.map((r) => {
        const rowResults = caseIds.map((caseId) =>
          rows.find((row) => row.arm === "L" && row.repeat === r && row.caseId === caseId),
        );
        return { repeat: r, both: rowResults.every((row) => row?.accepted === true) };
      });
      return { family, caseIds, bothCorrectByRound: bothCorrect };
    });
  };
  const repeatStability = (arm: "R" | "L") => {
    const vectors = executable.map((c) => {
      const vector = repeats.map(
        (r) => keys.get(`${rows[0]?.experimentId ?? ""}|${arm}|${c.caseId}|${r}`)?.accepted ?? null,
      );
      const consistent = vector.every((v) => v === vector[0]);
      return { caseId: c.caseId, vector, consistent };
    });
    return {
      consistentCases: vectors.filter((v) => v.consistent).length,
      total: vectors.length,
      inconsistent: vectors.filter((v) => !v.consistent).map((v) => v.caseId),
    };
  };

  const metrics = {
    denominators: { executable: N, abstain: abstainCases.length, repeats: K, rows: rows.length },
    successRate: { R: successRate("R"), L: successRate("L") },
    deltaPoints:
      successRate("L") !== null && successRate("R") !== null
        ? successRate("L")! - successRate("R")!
        : null,
    roundSuccess: { R: roundSuccess("R"), L: roundSuccess("L") },
    choiceAccuracy: { R: choiceAccuracy("R"), L: choiceAccuracy("L") },
    abstain: { R: abstainCorrect("R"), L: abstainCorrect("L") },
    coverage: { R: coverage("R"), L: coverage("L") },
    latencyMs: { R: latency("R"), L: latency("L") },
    costs: costs(),
    strata: stratumTable(),
    contrastPairs: contrastPairs(),
    repeatStability: { R: repeatStability("R"), L: repeatStability("L") },
    llmImpl: manifest.llmConfig?.llmImpl ?? null,
    datasetPurpose: manifest.datasetPurpose ?? null,
  };

  // ---- 结论（§7.2/§7.3）----
  const engineering: ReportOutcome["engineering"] = problems.length === 0 ? "passed" : "failed";
  const realModel: ReportOutcome["realModel"] = metrics.llmImpl === "real" ? "ran" : "not_run";
  const gates: ReportOutcome["gates"] = [];
  const executablePerRound = N;
  if (realModel === "ran" && engineering === "passed") {
    const roundL = roundSuccess("L").filter((r) => r.total === executablePerRound);
    const roundR = roundSuccess("R").filter((r) => r.total === executablePerRound);
    const allRoundsComplete = roundL.length === K && roundR.length === K;
    const gate = (id: string, requirement: string, actual: string, passed: boolean | null) =>
      gates.push({ id, requirement, actual, passed });
    // 双臂完整是收益评估的前置：缺臂/缺轮 → 该门 null → 收益 inconclusive（非 not_demonstrated）
    gate(
      "both-arms-complete",
      "R 与 L 两组在全部 repeat 上完整（缺数据 → inconclusive）",
      `R 轮 ${roundR.length}/${K}，L 轮 ${roundL.length}/${K}`,
      bothArmsPresent && allRoundsComplete ? true : null,
    );
    gate(
      "overall-success",
      `L 三轮各至少 ${Math.ceil(0.9 * executablePerRound)}/${executablePerRound} 成功（90%）`,
      roundL.map((r) => `${r.success}/${r.total}`).join("; "),
      allRoundsComplete
        ? roundL.every((r) => r.success >= Math.ceil(0.9 * executablePerRound))
        : null,
    );
    gate(
      "relative-improvement",
      `L 相对 R 三轮各净增至少 ${Math.ceil(0.1 * executablePerRound)}/${executablePerRound}（10pp）`,
      roundL.map((r, i) => `Δ${r.repeat}=${r.success - (roundR[i]?.success ?? 0)}`).join("; "),
      allRoundsComplete
        ? roundL.every(
            (r, i) => r.success - (roundR[i]?.success ?? 0) >= Math.ceil(0.1 * executablePerRound),
          )
        : null,
    );
    const strata20 = stratumTable().filter((s) => s.stratum !== "abstain");
    gate(
      "stratum-floor",
      "前四组在 L 每轮各至少 80% 成功",
      strata20
        .map(
          (s) =>
            `${s.stratum}: ${s.perArmRound
              .find((a) => a.arm === "L")!
              .rounds.map((r) => `${r.success}/${r.total}`)
              .join(",")}`,
        )
        .join("; "),
      strata20.every((s) =>
        s.perArmRound
          .find((a) => a.arm === "L")!
          .rounds.every((r) => r.total > 0 && r.success >= Math.ceil(0.8 * r.total)),
      ),
    );
    const explicitAllR = executable
      .filter((c) => c.stratum === "explicit")
      .filter((c) =>
        repeats.every(
          (r) => keys.get(`${rows[0]?.experimentId}|R|${c.caseId}|${r}`)?.accepted === true,
        ),
      );
    const explicitHeldByL = explicitAllR.every((c) =>
      repeats.every(
        (r) => keys.get(`${rows[0]?.experimentId}|L|${c.caseId}|${r}`)?.accepted === true,
      ),
    );
    gate(
      "explicit-regression",
      "explicit 中 R 三次全成功的 case，L 也须三次全成功",
      `${explicitAllR.length} 个 R 全成功 case 中 L 保持 ${explicitAllR.filter((c) => repeats.every((r) => keys.get(`${rows[0]?.experimentId}|L|${c.caseId}|${r}`)?.accepted === true)).length} 个`,
      explicitHeldByL,
    );
    const abstainL = abstainCorrect("L");
    const abstainPerRound = abstainCases.length;
    gate(
      "abstain",
      `L 每轮至少 ${Math.ceil(0.9 * abstainPerRound)}/${abstainPerRound} 正确弃权（90%）`,
      `合计 ${abstainL.correct}/${abstainL.total}`,
      abstainL.total === abstainPerRound * K
        ? abstainL.correct >= Math.ceil(0.9 * abstainPerRound * K)
        : null,
    );
    const invalidL = (coverage("L")["invalid_output"] ?? 0) as number;
    gate("valid-responses", "L 正式集 invalid_output=0", `${invalidL}`, invalidL === 0);
    gate(
      "latency-p95",
      "L 成功决策 p95 ≤ 5000ms，全部调用受 15s 硬超时",
      `p95=${latency("L").successP95 ?? "null"}ms`,
      latency("L").successP95 !== null ? latency("L").successP95! <= 5000 : null,
    );
    const benefit: ReportOutcome["benefit"] = gates.every((g) => g.passed === true)
      ? "demonstrated_on_fixture"
      : gates.some((g) => g.passed === false)
        ? "not_demonstrated"
        : "inconclusive";
    return finish({ engineering, realModel, benefit, gates, problems, metrics, dir });
  }
  // fake 或工程失败：只能报告工程结论，不宣称收益
  const benefit: ReportOutcome["benefit"] =
    engineering === "failed" ? "inconclusive" : "not_evaluated";
  return finish({ engineering, realModel, benefit, gates, problems, metrics, dir });
}

function finish(inner: {
  engineering: ReportOutcome["engineering"];
  realModel: ReportOutcome["realModel"];
  benefit: ReportOutcome["benefit"];
  gates: ReportOutcome["gates"];
  problems: string[];
  metrics: Record<string, unknown>;
  dir: string;
}): ReportOutcome {
  const reportPath = join(inner.dir, "report.json");
  const report = {
    reportAlgo: REPORT_ALGO_VERSION,
    generatedAt: new Date().toISOString(),
    engineering: inner.engineering,
    realModel: inner.realModel,
    benefit: inner.benefit,
    gates: inner.gates,
    problems: inner.problems,
    metrics: inner.metrics,
    notes: [
      "实验为固定合成任务上的探索性比较；300 次调用不视为 300 个独立样本",
      "未调用真实模型时只报告工程结论（engineering），不产生收益结论",
      "收益结论不产生 Promotion，也不等价于系统已经会学习",
    ],
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const mdPath = join(inner.dir, "report.md");
  writeFileSync(mdPath, renderMarkdown(report), "utf8");
  return {
    engineering: inner.engineering,
    realModel: inner.realModel,
    benefit: inner.benefit,
    gates: inner.gates,
    problems: inner.problems,
    reportPath,
  };
}

function verifyDatasetDrift(datasetDir: string, manifestCases: ManifestShape["cases"]): string[] {
  const problems: string[] = [];
  for (const c of manifestCases ?? []) {
    try {
      const digest = bundleDigestFrom(datasetDir, c.textDir, c.changedFiles);
      if (digest !== c.bundleDigest) {
        problems.push(
          `case ${c.caseId} 的输入包摘要漂移（复算 ${digest}，冻结 ${c.bundleDigest}）`,
        );
      }
    } catch (err) {
      problems.push(`case ${c.caseId} 的输入包不可读（${String(err)}）`);
    }
  }
  return problems;
}

function renderMarkdown(report: Record<string, unknown>): string {
  const metrics = report.metrics as Record<string, unknown>;
  const lines: string[] = [];
  lines.push("# 本体决策实验报告（organism-decision-v1）");
  lines.push("");
  lines.push(`- 生成时间：${String(report.generatedAt)}`);
  lines.push(`- 数据用途：${String(metrics.datasetPurpose)}；L 实现：${String(metrics.llmImpl)}`);
  lines.push(
    `- 结论：engineering=${String(report.engineering)}，realModel=${String(report.realModel)}，benefit=${String(report.benefit)}`,
  );
  lines.push("");
  const sr = metrics.successRate as { R: number | null; L: number | null };
  lines.push(`## 主要指标`);
  lines.push("");
  lines.push(
    `- 端到端成功率：R=${fmt(sr.R)}，L=${fmt(sr.L)}，Δ=${fmt(metrics.deltaPoints as number | null)}`,
  );
  const abstain = metrics.abstain as Record<string, { correct: number; total: number }>;
  lines.push(
    `- 应弃权正确：R=${abstain.R!.correct}/${abstain.R!.total}，L=${abstain.L!.correct}/${abstain.L!.total}`,
  );
  const cov = metrics.coverage as Record<string, Record<string, number>>;
  lines.push(`- 决策状态分布：R=${JSON.stringify(cov.R)}；L=${JSON.stringify(cov.L)}`);
  const lat = metrics.latencyMs as Record<
    string,
    { successP50: number | null; successP95: number | null }
  >;
  lines.push(
    `- L 成功决策时延：p50=${lat.L!.successP50 ?? "null"}ms，p95=${lat.L!.successP95 ?? "null"}ms`,
  );
  lines.push("");
  const gates = report.gates as Array<{
    id: string;
    requirement: string;
    actual: string;
    passed: boolean | null;
  }>;
  if (gates.length > 0) {
    lines.push(`## 收益门（§7.3）`);
    lines.push("");
    lines.push(`| 条件 | 门槛 | 实际 | 结果 |`);
    lines.push(`| --- | --- | --- | --- |`);
    for (const g of gates) {
      lines.push(
        `| ${g.id} | ${g.requirement} | ${g.actual} | ${g.passed === null ? "?" : g.passed ? "✓" : "✗"} |`,
      );
    }
    lines.push("");
  }
  const problems = report.problems as string[];
  if (problems.length > 0) {
    lines.push(`## 问题清单（不静默跳过）`);
    lines.push("");
    for (const p of problems) lines.push(`- ${p}`);
    lines.push("");
  }
  lines.push(`## 局限与 M3 交接`);
  lines.push("");
  for (const n of report.notes as string[]) lines.push(`- ${n}`);
  lines.push("");
  lines.push(`复算：proteus experiment report <dir>（只读证据，不调用模型）`);
  lines.push("");
  return lines.join("\n");
}

function fmt(v: number | null): string {
  return v === null ? "null" : `${(v * 100).toFixed(1)}%`;
}
