import { checkedModelAdapter, type ModelAdapter } from "../../model/index.ts";
import Anthropic from "@anthropic-ai/sdk";
import type { RouteProposer } from "../../evolution/consolidation.ts";
import { digestOf } from "../../storage/blobs.ts";
import { DEFAULT_LLM_BASE_URL, type LlmAdapterConfig } from "../decision-llm/index.ts";

/**
 * LLM 路由规则提议者（M3+ LLM 归纳，与规则统计归纳互为对照）。
 *
 * 复用决策实验的单一真实后端合同（ADR 0007：Anthropic Messages 协议经
 * 操作者端点，冻结 GLM-5.3-Flash、temperature 0；env 只注入凭据）。
 * 关键防放水：LLM 只看缺口样本（弃权/失败的 goal+特征+原因，不含
 * 正确答案），提议必须经 refineProposals 的统计门槛重算——LLM 缩小
 * 搜索空间，不产生证据。响应严格解析；传输/解析异常如实抛出，
 * 绝不映射为空提议。
 */
export const CONSOLIDATION_LLM_MODEL = "GLM-5.3-Flash";

export class LlmRouteProposer implements RouteProposer {
  readonly name = "consolidation-llm";
  readonly remote = true;
  private readonly client?: Anthropic;
  private readonly adapter?: ModelAdapter;
  private readonly model: string;
  private readonly config: LlmAdapterConfig;
  /** 最近一次调用的 provenance（evolution 记入候选 sourceRefs） */
  lastProvenance: {
    promptDigest: string;
    responseDigest: string;
    servedModel: string | null;
  } | null = null;
  lastUsage: { inputTokens: number; outputTokens: number } | null = null;

  constructor(config: LlmAdapterConfig | { adapter: ModelAdapter; model?: string }) {
    this.model =
      "adapter" in config ? (config.model ?? CONSOLIDATION_LLM_MODEL) : CONSOLIDATION_LLM_MODEL;
    if ("adapter" in config) {
      this.adapter = checkedModelAdapter(config.adapter);
      this.config = { apiKey: "", baseUrl: this.adapter.serviceId };
      return;
    }
    this.config = config;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      maxRetries: 0,
      timeout: config.requestTimeoutMs ?? 30_000,
    });
  }

  async propose(
    input: {
      gapSamples: Array<{ goal: string; features: Record<string, boolean>; reason: string }>;
      options: string[];
      features: string[];
    },
    options?: { signal?: AbortSignal },
  ): Promise<Array<{ feature: string; choose: string; rationale: string }>> {
    this.lastProvenance = null;
    this.lastUsage = null;
    if (input.gapSamples.length === 0) return [];
    const prompt = this.buildPrompt(input);
    const custom = this.adapter
      ? await this.adapter.generate(
          {
            model: this.model,
            maxOutputTokens: 512,
            temperature: 0,
            messages: [{ role: "user", content: prompt }],
          },
          { signal: options?.signal },
        )
      : undefined;
    if (custom?.refusal) throw new Error("model_service_refusal");
    const response = custom
      ? undefined
      : await this.client!.messages.create(
          {
            model: CONSOLIDATION_LLM_MODEL,
            max_tokens: 512,
            temperature: 0,
            messages: [{ role: "user", content: prompt }],
          },
          { signal: options?.signal },
        );
    const text = custom
      ? custom.text
      : response!.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("");
    this.lastProvenance = {
      promptDigest: digestOf(prompt),
      responseDigest: digestOf(text),
      servedModel: custom ? (custom.servedModel ?? null) : response!.model,
    };
    this.lastUsage = custom
      ? custom.inputTokens != null && custom.outputTokens != null
        ? { inputTokens: custom.inputTokens, outputTokens: custom.outputTokens }
        : null
      : { inputTokens: response!.usage.input_tokens, outputTokens: response!.usage.output_tokens };
    return this.parseProposals(text, input);
  }

  private buildPrompt(input: {
    gapSamples: Array<{ goal: string; features: Record<string, boolean>; reason: string }>;
    options: string[];
    features: string[];
  }): string {
    const samples = input.gapSamples
      .map(
        (s, i) =>
          `${i + 1}. goal=${JSON.stringify(s.goal)} features=${JSON.stringify(s.features)} 弃权原因=${JSON.stringify(s.reason)}`,
      )
      .join("\n");
    return [
      "以下是一个路由决策系统的失败样本：任务目标本应路由到某个执行选项，但当前规则弃权或失败。",
      "",
      "可用特征（布尔，来自词表匹配）：",
      JSON.stringify(input.features),
      "",
      "可路由选项：",
      JSON.stringify(input.options),
      "",
      "失败样本：",
      samples,
      "",
      "请从失败模式中归纳最多 4 条路由规则（feature → choose）。只输出一个 JSON 对象，格式：",
      '{"proposals":[{"feature":"<特征名>","choose":"<选项>","rationale":"<一句依据>"}]}',
      "要求：feature 必须来自可用特征列表；choose 必须来自可路由选项；不确定就不提议（允许空数组）。不要输出其他内容。",
    ].join("\n");
  }

  /** 严格解析：单一 JSON 对象、无围栏、字段类型校验、成员关系校验 */
  private parseProposals(
    text: string,
    input: { options: string[]; features: string[] },
  ): Array<{ feature: string; choose: string; rationale: string }> {
    let parsed: { proposals?: unknown };
    try {
      parsed = JSON.parse(text.trim()) as { proposals?: unknown };
    } catch {
      throw new Error(`LLM 归纳响应不是合法 JSON：${text.slice(0, 200)}`);
    }
    if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.proposals)) {
      throw new Error("LLM 归纳响应缺少 proposals 数组");
    }
    const featureSet = new Set(input.features);
    const optionSet = new Set(input.options);
    const proposals: Array<{ feature: string; choose: string; rationale: string }> = [];
    for (const item of parsed.proposals) {
      if (typeof item !== "object" || item === null) continue;
      const { feature, choose, rationale } = item as Record<string, unknown>;
      if (typeof feature !== "string" || typeof choose !== "string") continue;
      if (!featureSet.has(feature) || !optionSet.has(choose)) continue;
      proposals.push({
        feature,
        choose,
        rationale: typeof rationale === "string" ? rationale.slice(0, 256) : "",
      });
    }
    return proposals;
  }
}

export function llmProposerFromEnv(): LlmRouteProposer | null {
  const apiKey = process.env.PROTEUS_LLM_API_KEY;
  if (!apiKey) return null;
  return new LlmRouteProposer({
    apiKey,
    baseUrl: process.env.PROTEUS_LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL,
    requestTimeoutMs: 30_000,
  });
}
