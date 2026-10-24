import { canonicalJson, digestOf } from "../../storage/blobs.ts";
import type { DecisionRequest, PreparedDecisionRequest } from "../../decision/index.ts";
import type { LlmChoicePolicyContent } from "../../decision/llm-policy.ts";
import {
  assertLlmDemoView,
  LLM_REQUEST_LIMIT_BYTES,
  parseLlmDemosPolicy,
  LlmDemosPolicyError,
} from "../../decision/llm-demos-policy.ts";
import type { DecisionView } from "../../decision/view.ts";

export const LLM_DEMOS_REQUEST_FORMAT = "anthropic-choice-demos-request-v1";

/** v1 保持原有逐字替换及消息布局，历史快照不受新格式影响。 */
export function buildLlmChoiceBody(
  policy: LlmChoicePolicyContent,
  view: DecisionView,
  options: string[],
) {
  const system = policy.promptTemplate
    .replaceAll("{{OPTIONS}}", options.map((id) => `- ${id}`).join("\n"))
    .replaceAll("{{VIEW}}", canonicalJson(view));
  return {
    model: policy.model,
    max_tokens: policy.sampling.maxOutputTokens,
    temperature: policy.sampling.temperature,
    system,
    messages: [{ role: "user" as "user" | "assistant", content: "请给出决策 JSON。" }],
  };
}

/** 无 SDK/存储读取/凭据的确定性渲染；来源元数据从不进入请求。 */
export function prepareLlmDemosRequest(request: DecisionRequest): PreparedDecisionRequest {
  const policy = parseLlmDemosPolicy(request.policy.content);
  if (
    request.problem !== "choice" ||
    canonicalJson(request.options) !== canonicalJson(policy.fixed.options)
  )
    throw new LlmDemosPolicyError("请求问题或选项与冻结签名不一致");
  if (
    request.viewSource?.versionId !== policy.fixed.decisionView.versionId ||
    request.viewSource.contentDigest !== policy.fixed.decisionView.contentDigest
  )
    throw new LlmDemosPolicyError("快照 decision-view 版本或摘要不一致");
  assertLlmDemoView(policy, request.view);
  const body = buildLlmChoiceBody(policy.fixed.basePolicy.content, request.view!, request.options);
  body.messages = [
    ...policy.parameters.demoIds.flatMap((selected) => {
      const demo = policy.pool.demonstrations.find((item) => item.id === selected)!;
      return [
        { role: "user" as const, content: canonicalJson(demo.view) },
        { role: "assistant" as const, content: canonicalJson(demo.response) },
      ];
    }),
    ...body.messages,
  ];
  if (Buffer.byteLength(canonicalJson(body), "utf8") > LLM_REQUEST_LIMIT_BYTES)
    throw new LlmDemosPolicyError("完整模型请求超过 64 KiB，不允许截断");
  return { format: LLM_DEMOS_REQUEST_FORMAT, body };
}

/** 已冻结请求可直接重放；若渲染实现或输入漂移，拒绝静默换请求。 */
export function resolveLlmDemosRequest(
  request: DecisionRequest,
): ReturnType<typeof buildLlmChoiceBody> {
  const prepared = prepareLlmDemosRequest(request);
  if (request.prepared && canonicalJson(request.prepared) !== canonicalJson(prepared))
    throw new LlmDemosPolicyError("冻结模型请求与策略/视图不一致");
  return (request.prepared ?? prepared).body as ReturnType<typeof buildLlmChoiceBody>;
}

export function llmPromptDigest(body: ReturnType<typeof buildLlmChoiceBody>): string {
  return digestOf(canonicalJson({ system: body.system, messages: body.messages }));
}
