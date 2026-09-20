/**
 * Decision：结构化选择合同（docs/runtime.md §3）。
 * 只回答类型化问题；不持有执行副作用，也不原地修改策略。
 * M0 切片② 实现 choice；gate/rank 类型保留在合同中。
 */

export type DecisionProblem = "choice" | "gate" | "rank";

export interface DecisionProvenance {
  provider: string;
  policyVersion: string;
}

export interface DecisionRequest {
  problem: DecisionProblem;
  /** choice / gate / rank 的候选选项 */
  options: string[];
  /** 图节点声明的静态决策上下文 */
  context: Record<string, unknown>;
  /** 快照解析出的策略内容与精确版本 */
  policy: { versionId: string; content: unknown };
  deadlineMs: number;
  remainingAttempts: number;
}

export type DecisionResult =
  | { kind: "value"; value: unknown; provenance: DecisionProvenance }
  | { kind: "abstain"; reason: string; provenance: DecisionProvenance };

export interface DecisionProvider {
  readonly name: string;
  capabilities(): { problems: DecisionProblem[] };
  decide(request: DecisionRequest): Promise<DecisionResult>;
}

export type ChoiceValidation =
  | { ok: true; value: string }
  | { ok: false; reason: "abstain" | "invalid_output"; detail: string };

/**
 * Runtime 必须独立校验决策结果（选项成员关系），不能信 provider 自述。
 * abstain 与非法输出分开：前者是"无法可靠作答"，后者按 invalid_output 处理。
 */
export function validateChoice(result: DecisionResult, options: string[]): ChoiceValidation {
  if (result.kind === "abstain") {
    return { ok: false, reason: "abstain", detail: result.reason };
  }
  if (typeof result.value !== "string" || !options.includes(result.value)) {
    return {
      ok: false,
      reason: "invalid_output",
      detail: `choice 结果 ${JSON.stringify(result.value)} 不在候选 [${options.join(", ")}] 内`,
    };
  }
  return { ok: true, value: result.value };
}
