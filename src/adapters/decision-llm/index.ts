import { checkedModelAdapter, type ModelAdapter, type ModelRequest } from "../../model/index.ts";
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  DecisionView,
  DecisionServiceResponseEvidence,
} from "../../decision/index.ts";
import { parseChoiceResponse, parseLlmPolicy, isLlmDemosPolicy } from "../../decision/index.ts";
import {
  prepareLlmDemosRequest,
  resolveLlmDemosRequest,
  buildLlmChoiceBody,
  llmPromptDigest,
} from "./request.ts";
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
 * llm-choice-v1 或 llm-choice-demos-v1 产物（版本化冻结，合同归 Decision），
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
  private readonly client?: Anthropic;
  private readonly adapter?: ModelAdapter;
  private readonly config: LlmAdapterConfig;

  constructor(config: LlmAdapterConfig | { adapter: ModelAdapter }) {
    if ("adapter" in config) {
      this.adapter = checkedModelAdapter(config.adapter);
      this.config = { apiKey: "", baseUrl: this.adapter.serviceId };
      return;
    }
    this.config = { ...config, baseUrl: config.baseUrl ?? DEFAULT_LLM_BASE_URL };
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: this.config.baseUrl,
      maxRetries: 0,
      timeout: config.requestTimeoutMs ?? 30_000,
    });
  }

  capabilities(): { problems: Array<"choice" | "gate" | "rank"> } {
    return { problems: ["choice"] };
  }

  /** 服务计数是独立的无生成请求；兼容服务不支持时拒绝，不回退为字符估算。 */
  async countInputTokens(request: DecisionRequest): Promise<number> {
    const body = this.resolveBody(request);
    if (this.adapter) {
      if (!this.adapter.countInputTokens) throw new Error("model_token_count_unsupported");
      return this.adapter.countInputTokens(modelRequest(body), { signal: request.signal });
    }
    const result = await this.client!.messages.countTokens(
      {
        model: body.model,
        system: body.system,
        messages: body.messages,
      },
      { signal: request.signal },
    );
    if (!Number.isSafeInteger(result.input_tokens) || result.input_tokens < 0)
      throw new Error("invalid_service_input_token_count");
    return result.input_tokens;
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const provenance = { provider: this.name, policyVersion: request.policy.versionId };
    const demos = isLlmDemosPolicy(request.policy.content);
    const policy = demos ? undefined : parseLlmPolicy(request.policy.content);
    if (!policy && !demos) {
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
    let body;
    try {
      body = this.resolveBody(request);
    } catch (error) {
      return {
        kind: "invalid_output",
        detail: String(error),
        provenance,
        raw: canonicalJson({ error: "invalid-llm-demos-request" }),
      };
    }

    // 网络调用：自动重试关闭；取消经 signal 传播；错误向上抛（Runtime 分类 transport_error）
    const result = this.adapter
      ? await this.adapter.generate(modelRequest(body), { signal: request.signal })
      : undefined;
    const response = result
      ? {
          model: result.servedModel,
          stop_reason: result.refusal ? "refusal" : result.stopReason,
          content: [{ type: "text", text: result.text }],
          usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens },
        }
      : await this.client!.messages.create(body, { signal: request.signal });

    const text: string = extractText(response);
    const stopReason = readStopReason(response);
    const usageHint = {
      ...readUsage(response, readServedModel(response)),
      serviceResponse: {
        ...readServiceResponse(response, text),
        ...(result ? { contentBlockTypes: result.contentBlockTypes ?? null } : {}),
      },
    };
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

  private resolveBody(request: DecisionRequest) {
    if (this.adapter) {
      const prepared = this.prepareRequest(request)!;
      if (request.prepared && canonicalJson(request.prepared) !== canonicalJson(prepared))
        throw new Error("冻结模型请求与适配器/策略/视图不一致");
      return prepared.body.request as ReturnType<typeof buildLlmChoiceBody>;
    }
    return isLlmDemosPolicy(request.policy.content)
      ? resolveLlmDemosRequest(request)
      : buildLlmChoiceBody(parseLlmPolicy(request.policy.content)!, request.view!, request.options);
  }

  prepareRequest(request: DecisionRequest) {
    const prepared = isLlmDemosPolicy(request.policy.content)
      ? prepareLlmDemosRequest(request)
      : undefined;
    if (!this.adapter) return prepared;
    return {
      format: "custom-model-choice-request-v1",
      body: {
        adapter: this.adapter.id,
        serviceId: this.adapter.serviceId,
        sourceFormat: prepared?.format ?? "llm-choice-v1",
        request:
          prepared?.body ??
          buildLlmChoiceBody(
            parseLlmPolicy(request.policy.content)!,
            request.view!,
            request.options,
          ),
      },
    };
  }

  callProvenance(request: DecisionRequest) {
    if (isLlmDemosPolicy(request.policy.content)) {
      const body = this.resolveBody(request);
      return {
        adapter: this.adapter?.id ?? "anthropic-messages@sdk-0.127.0",
        serviceId: this.config.baseUrl ?? DEFAULT_LLM_BASE_URL,
        requestedModel: body.model,
        sampling: { temperature: body.temperature, maxOutputTokens: body.max_tokens },
        promptDigest: llmPromptDigest(body),
        reproducibility: "recorded-inputs-only" as const,
      };
    }
    const policy = parseLlmPolicy(request.policy.content);
    return {
      adapter: this.adapter?.id ?? "anthropic-messages@sdk-0.127.0",
      serviceId: this.config.baseUrl ?? DEFAULT_LLM_BASE_URL,
      requestedModel: policy?.model ?? null,
      sampling: policy
        ? {
            temperature: policy.sampling.temperature,
            maxOutputTokens: policy.sampling.maxOutputTokens,
          }
        : null,
      promptDigest: policy
        ? digest(buildLlmChoiceBody(policy, request.view ?? emptyView(), request.options).system)
        : null,
      reproducibility: "recorded-inputs-only" as const,
    };
  }
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
  return typeof reason === "string" && reason.length <= 128 ? reason : null;
}

function readServiceResponse(response: unknown, text: string): DecisionServiceResponseEvidence {
  const content =
    typeof response === "object" && response !== null
      ? (response as { content?: unknown }).content
      : undefined;
  return {
    version: "llm-service-response-v1",
    stopReason: readStopReason(response),
    contentBlockTypes:
      Array.isArray(content) && content.length <= 128
        ? content.map((block: unknown) => {
            const type =
              typeof block === "object" && block !== null
                ? (block as { type?: unknown }).type
                : null;
            return typeof type === "string" && type.length <= 128 ? type : null;
          })
        : null,
    textBytes: Buffer.byteLength(text, "utf8"),
  };
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
  const record = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : {};
  const tokens = (v: unknown): number | null =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
  // Anthropic 的 input_tokens 不包括缓存读/建输入；不能把命中缓存当成未消费输入。
  const inputs = [
    tokens(record.input_tokens),
    tokens(record.cache_read_input_tokens ?? 0),
    tokens(record.cache_creation_input_tokens ?? 0),
  ];
  const inputSum = inputs.reduce<number>((sum, v) => sum + (v ?? 0), 0);
  const inputTokens =
    inputs.some((v) => v === null) || !Number.isSafeInteger(inputSum) ? null : inputSum;
  const outputTokens = tokens(record.output_tokens);
  // 费用未知：不虚构金额，未知不按零计（实验规范 §4.2/§7.1）
  return { inputTokens, outputTokens, servedModel };
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function modelRequest(body: ReturnType<typeof buildLlmChoiceBody>): ModelRequest {
  return {
    model: body.model,
    system: body.system,
    messages: body.messages,
    temperature: body.temperature,
    maxOutputTokens: body.max_tokens,
  };
}
