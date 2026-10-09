/**
 * Consolidation（M3，evolution.md §3：离线路径从冻结经验集出发，执行整理、
 * 模式提取、假设生成与候选构建）：确定性规则归纳，纯函数、不调 LLM。
 *
 * 信号语义：
 * - 正例来源一（experience）= 决策选择了某选项且 Run 成功（验收含期望输出时，
 *   成功即路由正确）
 * - 正例来源二（gold）= 失败/弃权成员经开发集标注 join 得到的正确选项
 *   （实验文档：本轮用于调参的开发经验可作为学习来源；验证 family 不得参与）
 * - 缺口 = 决策弃权或 Run 失败且无标注可 join（当前规则未覆盖或判错）
 * 归纳：对每个视图特征统计（特征命中 ∧ 正例选择某选项）的支持数与精度，
 * 达门槛的 (feature → choose) 成为提议；弃权/失败计数进缺口统计。
 * 候选数、扫描与门槛全部为显式参数（预限制，evolution.md §6 最低证据要求）。
 */

export interface ConsolidationParams {
  /** 最小支持数：正例（特征命中且指向该选项）次数下限 */
  minSupport: number;
  /** 最小精度：该特征命中的正例中指向同一选项的比例下限 */
  minPrecision: number;
  /** 提议规则数上限（预限制） */
  maxRules: number;
}

export const DEFAULT_CONSOLIDATION_PARAMS: ConsolidationParams = {
  minSupport: 2,
  minPrecision: 0.8,
  maxRules: 4,
};

export interface RouteSample {
  runId: string;
  experienceId: string;
  /** 视图特征（来自决策请求 blob 的 view.features） */
  features: Record<string, boolean>;
  /** 决策选择；弃权/无效为 null */
  chosen: string | null;
  /** Run 终态是否成功 */
  succeeded: boolean;
  /** 正例来源：experience = 成功 Run 的实际选择；gold = 开发集标注 join */
  origin?: "experience" | "gold";
}

export interface RouteRuleProposal {
  feature: string;
  choose: string;
  support: number;
  precision: number;
  evidenceRunIds: string[];
  /** 各来源的正例数（goldBacked>0 时候选假设须声明依赖开发集标注） */
  byOrigin: { experience: number; gold: number };
}

export interface ConsolidationResult {
  proposals: RouteRuleProposal[];
  stats: {
    samples: number;
    positiveMembers: number;
    abstainMembers: number;
    failedMembers: number;
    featuresScanned: string[];
  };
  /** 零提议是正常结果（"不晋升成为正常结果"，证据不足不强凑规则） */
  hypothesis: string;
}

export function consolidateRoutes(
  samples: RouteSample[],
  params: ConsolidationParams = DEFAULT_CONSOLIDATION_PARAMS,
): ConsolidationResult {
  const positives = samples.filter(
    (s) => s.chosen !== null && (s.succeeded || s.origin === "gold"),
  );
  const abstains = samples.filter((s) => s.chosen === null && s.origin !== "gold");
  const failures = samples.filter((s) => !s.succeeded && s.chosen !== null && s.origin !== "gold");

  const featureNames = new Set<string>();
  for (const s of positives) {
    for (const [feature, hit] of Object.entries(s.features)) {
      if (hit) featureNames.add(feature);
    }
  }
  const scanned = [...featureNames].sort();

  const experienceCount = positives.filter(
    (s) => (s.origin ?? "experience") === "experience",
  ).length;
  const goldCount = positives.length - experienceCount;

  const proposals: RouteRuleProposal[] = [];
  for (const feature of scanned) {
    // 该特征命中的全部正例选择，按选项分组
    const byOption = new Map<string, string[]>();
    const byOrigin = new Map<string, { experience: number; gold: number }>();
    for (const s of positives) {
      if (s.features[feature] !== true || !s.chosen) continue;
      const runs = byOption.get(s.chosen) ?? [];
      runs.push(s.runId);
      byOption.set(s.chosen, runs);
      const key = feature + "→" + s.chosen;
      const counts = byOrigin.get(key) ?? { experience: 0, gold: 0 };
      counts[s.origin ?? "experience"] += 1;
      byOrigin.set(key, counts);
    }
    const total = [...byOption.values()].reduce((acc, runs) => acc + runs.length, 0);
    if (total === 0) continue;
    // 确定性排序后取最高支持选项；平票（精度门槛下不可分）不提议
    const ranked = [...byOption.entries()].sort(
      (a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1),
    );
    const [bestOption, bestRuns] = ranked[0]!;
    const support = bestRuns.length;
    const precision = support / total;
    if (support >= params.minSupport && precision >= params.minPrecision) {
      proposals.push({
        feature,
        choose: bestOption,
        support,
        precision,
        evidenceRunIds: [...bestRuns].sort(),
        byOrigin: byOrigin.get(feature + "→" + bestOption) ?? { experience: 0, gold: 0 },
      });
    }
  }

  proposals.sort((a, b) => b.support - a.support || (a.feature < b.feature ? -1 : 1));
  const limited = proposals.slice(0, params.maxRules);

  const summary = limited
    .map((p) => `${p.feature}→${p.choose}(支持 ${p.support}/精度 ${p.precision.toFixed(2)})`)
    .join("; ");
  return {
    proposals: limited,
    stats: {
      samples: samples.length,
      positiveMembers: positives.length,
      abstainMembers: abstains.length,
      failedMembers: failures.length,
      featuresScanned: scanned,
    },
    hypothesis:
      limited.length === 0
        ? `从 ${positives.length} 个正例未归纳出达门槛规则（弃权 ${abstains.length}、失败 ${failures.length}）：证据不足，不提议候选`
        : `从 ${positives.length} 个正例（经验 ${experienceCount} + 开发集标注 ${goldCount}）归纳 ${limited.length} 条特征路由（弃权 ${abstains.length}、失败 ${failures.length}）：${summary}`,
  };
}

/**
 * 路由规则提议者（LLM 归纳的可替换接口）：只看缺口样本（不给 gold、
 * 不给成功样本的选项分布），产出候选规则；提议必须经统计门槛重算
 * （refineProposals）——LLM 无法绕过统计证据，只能缩小搜索空间。
 */
export interface RouteProposer {
  readonly name: string;
  propose(input: {
    /** 弃权/失败样本摘要（goal + 视图特征 + 原因；不含正确答案） */
    gapSamples: Array<{ goal: string; features: Record<string, boolean>; reason: string }>;
    /** 可路由选项（图中 decision options） */
    options: string[];
    /** 可用特征名（decision-view 词表） */
    features: string[];
  }): Promise<Array<{ feature: string; choose: string; rationale: string }>>;
}

/**
 * 提议的统计门槛重算：对每条 (feature→choose) 在全部样本上重算
 * 支持数与精度（与 consolidateRoutes 相同口径），不达标丢弃并记录原因。
 * 返回的提议与统计归纳结果同构，可并入同一候选构造流程。
 */
export function refineProposals(
  samples: RouteSample[],
  proposals: Array<{ feature: string; choose: string; rationale?: string }>,
  params: ConsolidationParams,
): {
  accepted: RouteRuleProposal[];
  rejected: Array<{ feature: string; choose: string; reason: string }>;
} {
  const positives = samples.filter(
    (s) => s.chosen !== null && (s.succeeded || s.origin === "gold"),
  );
  const accepted: RouteRuleProposal[] = [];
  const rejected: Array<{ feature: string; choose: string; reason: string }> = [];
  for (const proposal of proposals) {
    if (!proposal.feature || !proposal.choose) {
      rejected.push({ ...proposal, reason: "字段缺失" });
      continue;
    }
    let support = 0;
    let total = 0;
    const evidenceRunIds: string[] = [];
    let experience = 0;
    let gold = 0;
    for (const s of positives) {
      if (s.features[proposal.feature] !== true || !s.chosen) continue;
      total += 1;
      if (s.chosen === proposal.choose) {
        support += 1;
        evidenceRunIds.push(s.runId);
        if ((s.origin ?? "experience") === "experience") experience += 1;
        else gold += 1;
      }
    }
    const precision = total === 0 ? 0 : support / total;
    if (support >= params.minSupport && precision >= params.minPrecision) {
      accepted.push({
        feature: proposal.feature,
        choose: proposal.choose,
        support,
        precision,
        evidenceRunIds: evidenceRunIds.sort(),
        byOrigin: { experience, gold },
      });
    } else {
      rejected.push({
        feature: proposal.feature,
        choose: proposal.choose,
        reason: `支持 ${support}/${params.minSupport} 或精度 ${precision.toFixed(2)}/${params.minPrecision} 未达门槛`,
      });
    }
  }
  accepted.sort((a, b) => b.support - a.support || (a.feature < b.feature ? -1 : 1));
  return { accepted: accepted.slice(0, params.maxRules), rejected };
}
