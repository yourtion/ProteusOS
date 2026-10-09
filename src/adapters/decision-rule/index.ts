import type { DecisionProvider, DecisionRequest, DecisionResult } from "../../decision/index.ts";

interface RuleRoute {
  when: Record<string, unknown>;
  choose: unknown;
}

interface RulePolicyContent {
  kind: "rule-v1";
  routes: RuleRoute[];
}

/**
 * 词法规则基线策略（实验规范 §3.3 R 组，版本化于 routing-policy 槽位）：
 * 消费 decision-view 的固定布尔特征（hasStatsIntent / hasChangeIntent），
 * 只有单侧命中时选择对应能力，双侧同时命中或都未命中时 abstain。
 * 词表本身版本化于 decision-view 槽位；本策略只定义匹配与优先级规则。
 */
interface RuleChoicePolicyContent {
  kind: "rule-choice-v1";
  /** 特征名 → 命中时选择的选项 ID */
  featureRoutes: Array<{ feature: string; choose: string }>;
}

/**
 * 混合策略（M3 策略候选）：视图特征路由优先（归纳自冻结经验的规则，
 * 单侧命中才选择），未命中时按 context 兜底路由（rule-v1 语义，保住
 * 无特征任务的既有行为——回归约束）。
 */
interface RuleHybridPolicyContent {
  kind: "rule-hybrid-v1";
  featureRoutes: Array<{ feature: string; choose: string }>;
  routes: RuleRoute[];
}

/**
 * 确定性规则决策（M0 的 RuleProvider）。
 * - rule-v1：消费快照的 routing-policy 产物，route.when 的全部键值匹配
 *   request.context 时命中，返回其 choose。没有命中或内容不合法时 abstain，绝不猜测。
 * - rule-choice-v1：实验 R 组基线，消费 decision-view 特征（见上）。
 * - rule-hybrid-v1：M3 策略候选——featureRoutes 优先、routes 兜底。
 */
export class RuleDecisionProvider implements DecisionProvider {
  readonly name = "decision-rule";

  capabilities(): { problems: Array<"choice" | "gate" | "rank"> } {
    return { problems: ["choice", "gate"] };
  }

  decide(request: DecisionRequest): Promise<DecisionResult> {
    const provenance = { provider: this.name, policyVersion: request.policy.versionId };
    const policy = parsePolicy(request.policy.content);
    if (!policy) {
      return Promise.resolve({
        kind: "abstain",
        reason: "策略内容不是合法的 rule 系策略",
        provenance,
      });
    }
    if (policy.kind === "rule-choice-v1") {
      return Promise.resolve(this.decideRuleChoice(request, policy, provenance));
    }
    if (policy.kind === "rule-hybrid-v1") {
      return Promise.resolve(this.decideRuleHybrid(request, policy, provenance));
    }
    for (const route of policy.routes) {
      if (!matches(route.when, request.context)) continue;
      if (request.problem === "choice" && typeof route.choose === "string") {
        return Promise.resolve({ kind: "value", value: route.choose, provenance });
      }
      if (request.problem === "gate" && (route.choose === "allow" || route.choose === "deny")) {
        return Promise.resolve({ kind: "value", value: route.choose, provenance });
      }
      return Promise.resolve({
        kind: "abstain",
        reason: `route 命中，但 choose=${JSON.stringify(route.choose)} 不是 ${request.problem} 的合法结果`,
        provenance,
      });
    }
    return Promise.resolve({ kind: "abstain", reason: "没有 route 命中当前上下文", provenance });
  }

  /** 混合策略：特征单侧命中优先（视图缺失/双侧/零侧命中均落到兜底路由） */
  private decideRuleHybrid(
    request: DecisionRequest,
    policy: RuleHybridPolicyContent,
    provenance: { provider: string; policyVersion: string },
  ): DecisionResult {
    if (request.view && request.problem === "choice") {
      const hits = policy.featureRoutes.filter((r) => request.view!.features[r.feature] === true);
      const missing = policy.featureRoutes.find((r) => !(r.feature in request.view!.features));
      if (missing) {
        return {
          kind: "abstain",
          reason: `decision-view 缺少特征 ${missing.feature}，拒绝猜测`,
          provenance,
        };
      }
      if (hits.length === 1 && request.options.includes(hits[0]!.choose)) {
        return { kind: "value", value: hits[0]!.choose, provenance };
      }
      if (hits.length > 1) {
        return {
          kind: "abstain",
          reason: "双侧特征同时命中（任务同时要求两种结果），当前只能选择一种",
          provenance,
        };
      }
    }
    for (const route of policy.routes) {
      if (!matches(route.when, request.context)) continue;
      if (request.problem === "choice" && typeof route.choose === "string") {
        return { kind: "value", value: route.choose, provenance };
      }
      if (request.problem === "gate" && (route.choose === "allow" || route.choose === "deny")) {
        return { kind: "value", value: route.choose, provenance };
      }
    }
    return { kind: "abstain", reason: "特征与兜底路由均未命中，信息不足", provenance };
  }

  private decideRuleChoice(
    request: DecisionRequest,
    policy: RuleChoicePolicyContent,
    provenance: { provider: string; policyVersion: string },
  ): DecisionResult {
    const view = request.view;
    if (!view) {
      return {
        kind: "abstain",
        reason: "rule-choice-v1 需要 decision-view（图节点未声明 view 槽位）",
        provenance,
      };
    }
    if (request.problem !== "choice") {
      return {
        kind: "abstain",
        reason: `rule-choice-v1 只支持 choice，实际 ${request.problem}`,
        provenance,
      };
    }
    const hits = policy.featureRoutes.filter((route) => view.features[route.feature] === true);
    const missingFeature = policy.featureRoutes.find((route) => !(route.feature in view.features));
    if (missingFeature) {
      return {
        kind: "abstain",
        reason: `decision-view 缺少特征 ${missingFeature.feature}，拒绝猜测`,
        provenance,
      };
    }
    // 匹配规则固定：恰好单侧命中才选择；双侧命中或都未命中 abstain
    if (hits.length === 1 && request.options.includes(hits[0]!.choose)) {
      return { kind: "value", value: hits[0]!.choose, provenance };
    }
    if (hits.length > 1) {
      return {
        kind: "abstain",
        reason: "双侧特征同时命中（任务同时要求两种结果），当前只能选择一种",
        provenance,
      };
    }
    return { kind: "abstain", reason: "没有特征命中，信息不足", provenance };
  }
}

function parsePolicy(
  content: unknown,
): RulePolicyContent | RuleChoicePolicyContent | RuleHybridPolicyContent | undefined {
  if (typeof content !== "object" || content === null) return undefined;
  const candidate = content as {
    kind?: unknown;
    routes?: unknown;
    featureRoutes?: unknown;
  };
  if (candidate.kind === "rule-v1" && Array.isArray(candidate.routes)) {
    return content as RulePolicyContent;
  }
  const validFeatureRoutes =
    Array.isArray(candidate.featureRoutes) &&
    candidate.featureRoutes.every(
      (r) =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as { feature?: unknown }).feature === "string" &&
        typeof (r as { choose?: unknown }).choose === "string",
    );
  if (candidate.kind === "rule-choice-v1" && validFeatureRoutes) {
    return content as RuleChoicePolicyContent;
  }
  if (
    candidate.kind === "rule-hybrid-v1" &&
    validFeatureRoutes &&
    Array.isArray(candidate.routes)
  ) {
    return content as RuleHybridPolicyContent;
  }
  return undefined;
}

function matches(
  when: Record<string, unknown> | undefined,
  context: Record<string, unknown>,
): boolean {
  if (typeof when !== "object" || when === null) return false;
  return Object.entries(when).every(([key, expected]) => context[key] === expected);
}
