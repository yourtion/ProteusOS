import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
} from "../../../src/decision/index.ts";

/**
 * Fake LLM 决策 Provider（实验/测试替身，与真实 Adapter 同一合同与注册名）。
 * 必须能模拟传输失败、延迟取消、started 后断连（迟到返回）、永不 resolve、
 * 服务 refusal、非法输出与 Markdown 包裹——不只返回立即成功（实验规范 §9）。
 * 捕获实际收到的请求供泄漏断言（D10）。
 */

export type FakeScript =
  | { type: "value"; value: string }
  | { type: "abstain"; reason?: string }
  | { type: "service-refusal" }
  | { type: "invalid"; raw: string }
  | { type: "markdown-wrapped"; inner: string }
  | { type: "transport-error"; message?: string }
  | { type: "never" }
  | { type: "late-resolve"; afterMs: number; script: FakeScript }
  | { type: "status-429" };

export class FakeLlmDecisionProvider implements DecisionProvider {
  readonly name = "decision-llm";
  readonly remote = true;
  /** 每次调用实际收到的请求（泄漏断言用） */
  readonly capturedRequests: DecisionRequest[] = [];
  private queue: FakeScript[] = [];
  private defaultScript: FakeScript = { type: "abstain", reason: "fake 未配置脚本" };

  constructor(options: { defaultScript?: FakeScript } = {}) {
    if (options.defaultScript) this.defaultScript = options.defaultScript;
  }

  /** 推入按序消费的脚本（runner 每个 trial 前设置下一次调用行为） */
  enqueue(...scripts: FakeScript[]): void {
    this.queue.push(...scripts);
  }

  resetQueue(defaultScript?: FakeScript): void {
    this.queue = [];
    if (defaultScript) this.defaultScript = defaultScript;
  }

  capabilities(): { problems: Array<"choice" | "gate" | "rank"> } {
    return { problems: ["choice"] };
  }

  decide(request: DecisionRequest): Promise<DecisionResult> {
    this.capturedRequests.push(request);
    const script = this.queue.shift() ?? this.defaultScript;
    const provenance = { provider: this.name, policyVersion: request.policy.versionId };
    const apply = (target: FakeScript) => {
      const outcome = applyScript(target, provenance);
      if (outcome.kind === "throw") {
        const err = new Error(outcome.message);
        err.name = outcome.name ?? "FakeTransportError";
        return Promise.reject(err);
      }
      return Promise.resolve(outcome);
    };
    if (script.type === "late-resolve") {
      // 模拟"started 后断连/超时，迟到返回"：晚于 deadline 才 settle；
      // 故意不监听 abort——迟到结果仍会送达（Runtime 追加证据，不改终态）
      return new Promise<DecisionResult>((resolve, reject) => {
        setTimeout(() => {
          apply(script.script).then(resolve, reject);
        }, script.afterMs);
      });
    }
    if (script.type === "never") {
      // 永不 resolve：只有 Runtime 的超时竞速能结束本地等待（D05）
      return new Promise<DecisionResult>(() => {});
    }
    return apply(script);
  }

  callProvenance() {
    return {
      adapter: "decision-llm-fake@test",
      serviceId: "fake://llm",
      requestedModel: "fake-model",
      sampling: { temperature: 0, maxOutputTokens: 256 },
      promptDigest: null,
      reproducibility: "pinned" as const,
    };
  }
}

type ScriptOutcome = DecisionResult | { kind: "throw"; message: string; name?: string };

function applyScript(
  script: FakeScript,
  provenance: { provider: string; policyVersion: string },
): ScriptOutcome {
  switch (script.type) {
    case "value":
      return {
        kind: "value",
        value: script.value,
        provenance,
        raw: `{"kind":"value","value":${JSON.stringify(script.value)}}`,
      };
    case "abstain":
      return {
        kind: "abstain",
        reason: script.reason ?? "fake 模型弃权",
        provenance,
        origin: "model",
        raw: `{"kind":"abstain","reason":${JSON.stringify(script.reason ?? "fake 模型弃权")}}`,
      };
    case "service-refusal":
      return {
        kind: "abstain",
        reason: "fake 服务 refusal",
        provenance,
        origin: "service_refusal",
        raw: '{"stop_reason":"refusal"}',
      };
    case "invalid":
      return { kind: "invalid_output", detail: "fake 非法输出", provenance, raw: script.raw };
    case "markdown-wrapped":
      return {
        kind: "invalid_output",
        detail: "fake Markdown 包裹输出",
        provenance,
        raw: `\`\`\`json\n${script.inner}\n\`\`\``,
      };
    case "transport-error":
      return { kind: "throw", message: script.message ?? "fake 网络错误（断连）" };
    case "status-429":
      return { kind: "throw", message: "429 rate limited (fake)", name: "APIStatusError" };
    default:
      return { kind: "abstain", reason: "未处理的 fake 脚本", provenance };
  }
}
