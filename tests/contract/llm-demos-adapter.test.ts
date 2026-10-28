import {
  buildLlmChoiceBody,
  llmPromptDigest,
  prepareLlmDemosRequest,
} from "../../src/adapters/decision-llm/request.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LLM_BASE_URL,
  LlmDecisionProvider,
} from "../../src/adapters/decision-llm/index.ts";
import {
  FROZEN_LLM_POLICY,
  llmChoicePolicyContent,
  withLlmDemoParameters,
} from "../../src/decision/index.ts";
import { canonicalJson, digestOf } from "../../src/storage/blobs.ts";
import { llmDemosRequest } from "../fixtures/decision/llm-demos.ts";

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  countTokens: vi.fn(),
  options: {} as Record<string, unknown>,
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: sdk.create, countTokens: sdk.countTokens };
    constructor(options: Record<string, unknown>) {
      sdk.options = options;
    }
  },
}));

beforeEach(() => {
  sdk.create.mockReset();
  sdk.countTokens.mockReset();
  sdk.create.mockResolvedValue({
    model: "served-fixed-model",
    stop_reason: "end_turn",
    content: [{ type: "text", text: '{"kind":"value","value":"local-process"}' }],
    usage: { input_tokens: 20, output_tokens: 5 },
  });
});

describe("LLM Adapter：保持 v1，消费 v2 的冻结正文", () => {
  it.each([
    { stop: "end_turn", text: '{"kind":"value","value":"local-process"}', kind: "value" },
    { stop: "max_tokens", text: "", kind: "invalid_output" },
    { stop: "max_tokens", text: '{"kind":"value","value":', kind: "invalid_output" },
    { stop: "end_turn", text: '{"kind":"abstain","reason":"需要任务信息"}', kind: "abstain" },
    { stop: "refusal", text: "", kind: "abstain" },
  ])("保留结束元数据：$kind / $stop / $text", async ({ stop, text, kind }) => {
    const p = new LlmDecisionProvider({ apiKey: "NEVER_PERSIST_API_KEY" });
    sdk.create.mockResolvedValueOnce({
      model: "served-fixed-model",
      stop_reason: stop,
      content: [
        { type: "thinking", thinking: "PRIVATE_HIDDEN_REASONING" },
        { type: "text", text },
      ],
      usage: { input_tokens: 20, output_tokens: 256 },
    });
    const result = await p.decide(llmDemosRequest());
    expect(result).toMatchObject({
      kind,
      evidence: {
        servedModel: "served-fixed-model",
        serviceResponse: {
          version: "llm-service-response-v1",
          stopReason: stop,
          contentBlockTypes: ["thinking", "text"],
          textBytes: Buffer.byteLength(text, "utf8"),
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_HIDDEN|NEVER_PERSIST/);
  });

  it("缺失或非法服务字段保持未知，不根据空正文或 token 上限推断结束原因", async () => {
    const p = new LlmDecisionProvider({ apiKey: "unused" });
    sdk.create.mockResolvedValueOnce({ usage: { input_tokens: 20, output_tokens: 256 } });
    expect(await p.decide(llmDemosRequest())).toMatchObject({
      kind: "invalid_output",
      evidence: {
        serviceResponse: { stopReason: null, contentBlockTypes: null, textBytes: 0 },
      },
    });
    sdk.create.mockResolvedValueOnce({ stop_reason: 1, content: [{ type: 5 }, null] });
    expect(await p.decide(llmDemosRequest())).toMatchObject({
      evidence: {
        serviceResponse: { stopReason: null, contentBlockTypes: [null, null], textBytes: 0 },
      },
    });
  });

  it("缓存读/建输入计入总量，非法服务用量保持未知", async () => {
    const p = new LlmDecisionProvider({ apiKey: "NEVER_PERSIST_API_KEY" });
    sdk.create.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"kind":"value","value":"local-process"}' }],
      usage: {
        input_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
        output_tokens: 5,
      },
    });
    expect(await p.decide(llmDemosRequest())).toMatchObject({
      evidence: { inputTokens: 90, outputTokens: 5 },
    });
    sdk.create.mockResolvedValueOnce({
      content: [],
      usage: { input_tokens: 20, cache_read_input_tokens: -1, output_tokens: NaN },
    });
    expect(await p.decide(llmDemosRequest())).toMatchObject({
      evidence: { inputTokens: null, outputTokens: null },
    });
  });
  it("计数使用同一冻结消息且不生成；无效计数或服务失败不回退估算", async () => {
    const p = new LlmDecisionProvider({ apiKey: "NEVER_PERSIST_API_KEY" });
    const r = llmDemosRequest();
    r.prepared = p.prepareRequest(r);
    sdk.countTokens.mockResolvedValueOnce({ input_tokens: 123 });
    expect(await p.countInputTokens(r)).toBe(123);
    const b = r.prepared!.body;
    expect(sdk.countTokens).toHaveBeenCalledWith(
      { model: b.model, system: b.system, messages: b.messages },
      { signal: r.signal },
    );
    expect(sdk.create).not.toHaveBeenCalled();
    sdk.countTokens.mockResolvedValueOnce({ input_tokens: -1 });
    await expect(p.countInputTokens(r)).rejects.toThrow(/invalid_service/);
    sdk.countTokens.mockRejectedValueOnce(new Error("unsupported"));
    await expect(p.countInputTokens(r)).rejects.toThrow("unsupported");
    expect(sdk.create).not.toHaveBeenCalled();
  });
  it("旧策略逐字段保持原请求和 promptDigest，关闭 SDK 重试并传递 signal", async () => {
    const provider = new LlmDecisionProvider({
      apiKey: "NEVER_PERSIST_API_KEY",
      baseUrl: "https://fixture.invalid",
    });
    const request = llmDemosRequest();
    request.policy.content = llmChoicePolicyContent();
    request.signal = new AbortController().signal;
    expect(provider.prepareRequest(request)).toBeUndefined();
    const body = buildLlmChoiceBody(FROZEN_LLM_POLICY, request.view!, request.options);
    const expectedSystem = FROZEN_LLM_POLICY.promptTemplate
      .replaceAll("{{OPTIONS}}", request.options.map((id) => `- ${id}`).join("\n"))
      .replaceAll("{{VIEW}}", canonicalJson(request.view));
    expect(body.system).toBe(expectedSystem);
    expect(await provider.decide(request)).toMatchObject({
      kind: "value",
      value: "local-process",
      evidence: { inputTokens: 20, outputTokens: 5 },
    });
    expect(sdk.create).toHaveBeenCalledWith(body, { signal: request.signal });
    expect(provider.callProvenance(request).promptDigest).toBe(digestOf(body.system));
    expect(sdk.options.maxRetries).toBe(0);
    expect(body.messages).toEqual([{ role: "user", content: "请给出决策 JSON。" }]);
  });

  it("新策略实际发送保存的全部消息，来源元数据及凭据不进入正文", async () => {
    const provider = new LlmDecisionProvider({ apiKey: "NEVER_PERSIST_API_KEY" });
    expect(sdk.options.baseURL).toBe(DEFAULT_LLM_BASE_URL);
    expect(provider.callProvenance(llmDemosRequest()).serviceId).toBe(sdk.options.baseURL);
    const request = llmDemosRequest();
    request.prepared = provider.prepareRequest(request);
    const prepared = structuredClone(request.prepared!);
    expect(await provider.decide(request)).toMatchObject({
      kind: "value",
      evidence: { servedModel: "served-fixed-model" },
    });
    expect(sdk.create).toHaveBeenCalledWith(prepared.body, { signal: undefined });
    expect(provider.callProvenance(request).promptDigest).toBe(
      llmPromptDigest(prepared.body as ReturnType<typeof buildLlmChoiceBody>),
    );
    expect(JSON.stringify(prepared)).not.toMatch(
      /PRIVATE_|NEVER_PERSIST|source-run|source-decision/,
    );
    const reversed = {
      ...request,
      prepared: undefined,
      policy: {
        ...request.policy,
        content: withLlmDemoParameters(request.policy.content, ["changes", "stats"]),
      },
    };
    expect(provider.callProvenance(reversed).promptDigest).not.toBe(
      provider.callProvenance(request).promptDigest,
    );
  });

  it("错误签名或保存正文漂移时不发送请求", async () => {
    const provider = new LlmDecisionProvider({ apiKey: "unused" });
    const request = llmDemosRequest();
    request.prepared = prepareLlmDemosRequest(request);
    request.prepared.body.messages = [];
    expect(await provider.decide(request)).toMatchObject({ kind: "invalid_output" });
    expect(sdk.create).not.toHaveBeenCalled();
    delete request.prepared;
    request.viewSource!.versionId = "changed-view";
    expect(() => provider.prepareRequest(request)).toThrow(/版本/);
    expect(await provider.decide(request)).toMatchObject({ kind: "invalid_output" });
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("服务拒绝与传输异常继续分开；新策略不修复非法输出", async () => {
    const provider = new LlmDecisionProvider({ apiKey: "unused" });
    const request = llmDemosRequest();
    sdk.create.mockResolvedValueOnce({ stop_reason: "refusal", content: [] });
    expect(await provider.decide(request)).toMatchObject({
      kind: "abstain",
      origin: "service_refusal",
    });
    sdk.create.mockResolvedValueOnce({
      content: [{ type: "text", text: '```json\n{"kind":"value","value":"local-process"}\n```' }],
    });
    expect(await provider.decide(request)).toMatchObject({ kind: "invalid_output" });
    sdk.create.mockRejectedValueOnce(new Error("network error"));
    await expect(provider.decide(request)).rejects.toThrow("network error");
    expect(sdk.create).toHaveBeenCalledTimes(3);
  });
});
