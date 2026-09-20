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
 * 确定性规则决策（M0 的 RuleProvider）。
 * 消费快照的 routing-policy 产物：route.when 的全部键值匹配 request.context
 * 时命中，返回其 choose。没有命中或内容不合法时 abstain，绝不猜测。
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
      return Promise.resolve({ kind: "abstain", reason: "策略内容不是合法的 rule-v1", provenance });
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
}

function parsePolicy(content: unknown): RulePolicyContent | undefined {
  if (typeof content !== "object" || content === null) return undefined;
  const candidate = content as { kind?: unknown; routes?: unknown };
  if (candidate.kind !== "rule-v1" || !Array.isArray(candidate.routes)) return undefined;
  return content as RulePolicyContent;
}

function matches(
  when: Record<string, unknown> | undefined,
  context: Record<string, unknown>,
): boolean {
  if (typeof when !== "object" || when === null) return false;
  return Object.entries(when).every(([key, expected]) => context[key] === expected);
}
