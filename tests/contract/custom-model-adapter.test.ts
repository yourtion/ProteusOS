import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadModelAdapter } from "../../src/app/model-adapter.ts";
import { LlmDecisionProvider } from "../../src/adapters/decision-llm/index.ts";
import { LlmRouteProposer } from "../../src/adapters/consolidation-llm/index.ts";
import { checkedModelAdapter, type ModelAdapter } from "../../src/model/index.ts";
import { llmDemosRequest } from "../fixtures/decision/llm-demos.ts";

function adapter(): ModelAdapter {
  return {
    version: "proteus-model-adapter-v1",
    id: "custom@1",
    serviceId: "internal-gateway",
    generate: vi.fn(async () => ({
      text: '{"kind":"value","value":"local-process"}',
      inputTokens: 3,
    })),
  };
}

describe("本地模型适配器", () => {
  it("加载带空格路径的异步工厂，并保留 this 与逐次鉴权状态", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "proteus-model-")), "my model.mjs");
    writeFileSync(
      file,
      `export default async () => ({ version: "proteus-model-adapter-v1", id: "test@1", serviceId: "test", n: 0, async generate() { return { text: String(++this.n), secret: "PRIVATE" }; } });`,
    );
    const model = (await loadModelAdapter(file))!;
    const request = { model: "m", messages: [], temperature: 0, maxOutputTokens: 1 };
    expect(await model.generate(request, {})).toMatchObject({ text: "1", inputTokens: null });
    expect(await model.generate(request, {})).toMatchObject({ text: "2" });
    expect(JSON.stringify(await model.generate(request, {}))).not.toContain("PRIVATE");
    await expect(loadModelAdapter(`${file}.missing.mjs`)).rejects.toThrow("加载失败");
    await expect(loadModelAdapter("https://example.com/model.mjs")).rejects.toThrow("本地文件");
  });
  it("自定义决策冻结身份并透传取消；不支持计数明确失败", async () => {
    const model = adapter();
    const provider = new LlmDecisionProvider({ adapter: model });
    const request = llmDemosRequest();
    request.signal = new AbortController().signal;
    request.prepared = provider.prepareRequest(request);
    expect(request.prepared!.format).toBe("custom-model-choice-request-v1");
    expect(await provider.decide(request)).toMatchObject({
      kind: "value",
      evidence: { inputTokens: 3, outputTokens: null },
    });
    expect(model.generate).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 256 }), {
      signal: request.signal,
    });
    expect(provider.callProvenance(request)).toMatchObject({
      adapter: "custom@1",
      serviceId: "internal-gateway",
    });
    await expect(provider.countInputTokens(request)).rejects.toThrow("unsupported");
    request.prepared!.body.serviceId = "changed";
    expect(await provider.decide(request)).toMatchObject({ kind: "invalid_output" });
    expect(model.generate).toHaveBeenCalledTimes(1);
  });
  it("归纳共用适配器；缺失用量不记零，异常不吞掉或重试", async () => {
    const model = adapter();
    const generate = vi.mocked(model.generate);
    generate.mockResolvedValueOnce({ text: '{"proposals":[{"feature":"f","choose":"a"}]}' });
    const proposer = new LlmRouteProposer({ adapter: model });
    const input = {
      gapSamples: [{ goal: "x", features: { f: true }, reason: "x" }],
      options: ["a"],
      features: ["f"],
    };
    expect(await proposer.propose(input)).toMatchObject([{ feature: "f", choose: "a" }]);
    expect(proposer.lastUsage).toBeNull();
    generate.mockRejectedValueOnce(new Error("transport_failed"));
    await expect(proposer.propose(input)).rejects.toThrow("transport_failed");
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it("拒绝非法模块、带凭据身份和非法响应，已取消不派发", async () => {
    expect(() => checkedModelAdapter({})).toThrow("version");
    expect(() =>
      checkedModelAdapter({ ...adapter(), serviceId: "https://host/?token=secret" }),
    ).toThrow("凭据");
    const raw = adapter();
    const model = checkedModelAdapter(raw);
    const controller = new AbortController();
    controller.abort();
    const request = { model: "m", messages: [], temperature: 0, maxOutputTokens: 1 };
    await expect(model.generate(request, { signal: controller.signal })).rejects.toThrow();
    expect(raw.generate).not.toHaveBeenCalled();
    vi.mocked(raw.generate).mockResolvedValueOnce({ text: 1 } as never);
    await expect(model.generate(request, {})).rejects.toThrow("invalid_model_response");
  });
});
