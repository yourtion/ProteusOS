import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  DecisionView,
  LlmChoicePolicyContent,
} from "../../decision/index.ts";
import { parseChoiceResponse, parseLlmPolicy } from "../../decision/index.ts";
import { canonicalJson } from "../../storage/blobs.ts";

/**
 * 单一真实 LLM 决策 Adapter（ADR 0007：首个实验只实现一个真实后端）。
 *
 * 服务协议：Anthropic Messages（官方 @anthropic-ai/sdk），经 baseURL 指向
 * 操作者现有配置的兼容端点（默认 https://api.z.ai/api/anthropic，即 Z.ai
 * coding plan 的 GLM 系列入口）。SDK 自动重试关闭（maxRetries=0）；
 * 取消经 AbortSignal 传播；超时由 Runtime 的 deadline 竞速兜底。
 *
 * 提示模板、服务/模型标识与采样参数全部来自快照 routing-policy 槽位的
 * llm-choice-v1 产物（版本化冻结，合同见 src/decision/llm-policy.ts），
 * env 只注入凭据与端点，避免配置漂移：
 * - PROTEUS_LLM_API_KEY（必需）
 * - PROTEUS_LLM_BASE_URL（默认 https://api.z.ai/api/anthropic）
 * 代理：Node ≥24 需 NODE_USE_ENV_PROXY=1 与 HTTPS_PROXY（见实验执行说明）。
 */

export const LLM_PROVIDER_NAME = "decision-llm";
export const DEFAULT_LLM_BASE_URL = "https://api.z.ai/api/anthropic";

export interface LlmAdapterConfig {
  apiKey: string;
  baseUrl?: string;
  /** SDK 侧硬性请求超时（大于协议 15s 上限的后备保护） */
  requestTimeoutMs?: number;
}

export function llmConfigFromEnv(): LlmAdapterConfig | null {
  const apiKey = process.env.PROTEUS_LLM_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: process.env.PROTEUS_LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL,
    requestTimeoutMs: 30_000,
  };
}

export class LlmDecisionProvider implements DecisionProvider {
  readonly name = LLM_PROVIDER_NAME;
  readonly remote = true;
  private readonly client: Anthropic;
  private readonly config: LlmAdapterConfig;

  constructor(config: LlmAdapterConfig) {
    this.config = config;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      maxRetries: 0,
      timeout: config.requestTimeoutMs ?? 30_000,
    });
  }

  capabilities(): { problems: Array<"choice" | "gate" | "rank"> } {
    return { problems: ["choice"] };
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const provenance = { provider: this.name, policyVersion: request.policy.versionId };
    const policy = parseLlmPolicy(request.policy.content);
    if (!policy) {
      return {
        kind: "invalid_output",
        detail: `策略内容不是合法的 llm-choice-v1（版本 ${request.policy.versionId}）`,
        provenance,
        raw: canonicalJson({ policyError: "invalid-llm-choice-v1" }),
      };
    }
    if (!request.view) {
      return {
        kind: "invalid_output",
        detail: "llm-choice-v1 需要 decision-view（图节点未声明 view）",
        provenance,
        raw: canonicalJson({ error: "missing-decision-view" }),
      };
    }
    const { system, user } = buildPrompt(policy, request.view, request.options);

    // 网络调用：自动重试关闭；取消经 signal 传播；错误向上抛（Runtime 分类 transport_error）
    const response = await this.client.messages.create(
      {
        model: policy.model,
        max_tokens: policy.sampling.maxOutputTokens,
        temperature: policy.sampling.temperature,
        system,
        messages: [{ role: "user", content: user }],
      },
      { signal: request.signal },
    );

    const text: string = extractText(response);
    const stopReason = readStopReason(response);
    const usageHint = readUsage(response, readServedModel(response));
    // 服务 refusal 单独保存原始类型，映射为带明确来源的 abstain；
    // 网络错误/429/超时不在此路径（它们经异常抛出，绝不映射为 abstain）
    if (stopReason === "refusal" || (text.length === 0 && hasRefusalBlock(response))) {
      return {
        kind: "abstain",
        reason: "模型服务返回 refusal，按服务弃权处理（原始类型已保存）",
        provenance,
        origin: "service_refusal",
        raw: canonicalJson({ stopReason, refusal: true }),
        evidence: usageHint,
      };
    }
    const parsed = parseChoiceResponse(text, request.options);
    if (parsed.kind === "value") {
      return {
        kind: "value",
        value: parsed.value,
        provenance,
        raw: text,
        evidence: usageHint,
      };
    }
    if (parsed.kind === "abstain") {
      return {
        kind: "abstain",
        reason: parsed.reason,
        provenance,
        origin: parsed.origin,
        raw: text,
        evidence: usageHint,
      };
    }
    return {
      kind: "invalid_output",
      detail: parsed.detail,
      provenance,
      raw: text,
      evidence: usageHint,
    };
  }

  callProvenance(request: DecisionRequest) {
    const policy = parseLlmPolicy(request.policy.content);
    return {
      adapter: `anthropic-messages@sdk-0.127.0`,
      serviceId: this.config.baseUrl ?? DEFAULT_LLM_BASE_URL,
      requestedModel: policy?.model ?? null,
      sampling: policy
        ? {
            temperature: policy.sampling.temperature,
            maxOutputTokens: policy.sampling.maxOutputTokens,
          }
        : null,
      promptDigest: policy
        ? digest(buildPrompt(policy, request.view ?? emptyView(), request.options).system)
        : null,
      reproducibility: "recorded-inputs-only" as const,
    };
  }
}

function buildPrompt(
  policy: LlmChoicePolicyContent,
  view: DecisionView,
  options: string[],
): { system: string; user: string } {
  const system = policy.promptTemplate
    .replaceAll("{{OPTIONS}}", options.map((id) => `- ${id}`).join("\n"))
    .replaceAll("{{VIEW}}", canonicalJson(view));
  return { system, user: "请给出决策 JSON。" };
}

function emptyView(): DecisionView {
  return {
    viewVersion: "decision-view-v1",
    goal: "",
    options: [],
    inputs: [],
    features: {},
  };
}

/** 运行时解析响应（不信任 SDK 类型静态形状之外的网络数据） */
function extractText(response: unknown): string {
  if (typeof response !== "object" || response === null) return "";
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}

function hasRefusalBlock(response: unknown): boolean {
  if (typeof response !== "object" || response === null) return false;
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "refusal",
  );
}

function readStopReason(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const reason = (response as { stop_reason?: unknown }).stop_reason;
  return typeof reason === "string" ? reason : null;
}

function readServedModel(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const model = (response as { model?: unknown }).model;
  return typeof model === "string" ? model : null;
}

function readUsage(response: unknown, servedModel: string | null) {
  const usage =
    typeof response === "object" && response !== null
      ? (response as { usage?: unknown }).usage
      : undefined;
  const inputTokens =
    usage &&
    typeof usage === "object" &&
    typeof (usage as { input_tokens?: unknown }).input_tokens === "number"
      ? (usage as { input_tokens: number }).input_tokens
      : null;
  const outputTokens =
    usage &&
    typeof usage === "object" &&
    typeof (usage as { output_tokens?: unknown }).output_tokens === "number"
      ? (usage as { output_tokens: number }).output_tokens
      : null;
  // 费用未知：不虚构金额，未知不按零计（实验规范 §4.2/§7.1）
  return { inputTokens, outputTokens, servedModel };
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
