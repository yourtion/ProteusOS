/**
 * llm-choice-v1 策略产物合同（ADR 0007 §4.1）。
 * 不可变内容：提示模板、服务/模型标识、采样参数与响应 schema。
 * 归属 decision 模块；Adapter 只消费，不定义。
 */

export interface LlmChoicePolicyContent {
  kind: "llm-choice-v1";
  service: string;
  model: string;
  sampling: {
    temperature: number;
    maxOutputTokens: number;
  };
  /** 系统提示模板；{{OPTIONS}} 与 {{VIEW}} 为仅有的占位符 */
  promptTemplate: string;
  responseSchema: { accept: string[] };
}

export const DEFAULT_LLM_PROMPT_TEMPLATE = `你是任务路由决策器。根据给定的任务信息，从候选执行能力中恰好选择一个，或者明确弃权。

候选能力（value 只能是其中之一的 ID 原文，不得改写、翻译或近似）：
{{OPTIONS}}

任务信息（decision-view，含任务目标、输入清单与公开特征）：
{{VIEW}}

输出要求（严格遵守）：
- 只输出一个 JSON 对象，不要 Markdown 围栏、解释或任何其他文本
- 选择能力：{"kind":"value","value":"<候选 ID 之一>"}
- 无法可靠作答（信息不足，或任务同时要求多种能力的结果）：{"kind":"abstain","reason":"<不超过 512 字符的中文理由>"}
- 禁止输出其他字段；禁止猜测不在候选内的 ID`;

/**
 * 冻结的 LLM 配置（E4 冻结记录，正式阶段前唯一固定）。
 * 服务协议 anthropic-messages，端点为操作者现有 Z.ai 配置的兼容入口；
 * 模型 GLM-5.3-Flash 与提示模板在开发阶段结束后不得更改——
 * 更改即新协议版本，须重走冻结流程。
 */
export const FROZEN_LLM_POLICY: LlmChoicePolicyContent = {
  kind: "llm-choice-v1",
  service: "anthropic-messages",
  model: "GLM-5.3-Flash",
  sampling: { temperature: 0, maxOutputTokens: 256 },
  promptTemplate: DEFAULT_LLM_PROMPT_TEMPLATE,
  responseSchema: {
    accept: ['{"kind":"value","value":"<option-id>"}', '{"kind":"abstain","reason":"..."}'],
  },
};

export function llmChoicePolicyContent(frozen: LlmChoicePolicyContent = FROZEN_LLM_POLICY): object {
  return { schemaVersion: 1, ...frozen };
}

export function parseLlmPolicy(content: unknown): LlmChoicePolicyContent | undefined {
  if (typeof content !== "object" || content === null) return undefined;
  const c = content as Record<string, unknown>;
  if (
    c["kind"] !== "llm-choice-v1" ||
    typeof c["service"] !== "string" ||
    typeof c["model"] !== "string" ||
    typeof c["promptTemplate"] !== "string" ||
    typeof c["sampling"] !== "object" ||
    c["sampling"] === null
  ) {
    return undefined;
  }
  return content as LlmChoicePolicyContent;
}
