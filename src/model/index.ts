/** 模型通信合同。鉴权与协议转换归 Adapter；业务提示、解析和预算归调用者。 */
export interface ModelRequest {
  model: string;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  temperature: number;
  maxOutputTokens: number;
}

export interface ModelResponse {
  text: string;
  servedModel?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  stopReason?: string | null;
  refusal?: boolean;
  contentBlockTypes?: Array<string | null> | null;
}

export interface ModelAdapter {
  readonly version: "proteus-model-adapter-v1";
  /** 稳定的实现版本；实现/模型映射变化时更新，不得包含凭据。 */
  readonly id: string;
  /** 可公开的服务标识；不得包含 token、签名或其他鉴权信息。 */
  readonly serviceId: string;
  /** 一次生成；不得自动重试。鉴权可在每次请求时刷新，取消须传递至网络层。 */
  generate(request: ModelRequest, options: { signal?: AbortSignal }): Promise<ModelResponse>;
  /** 可选的真实服务计数；不支持时省略，不允许用估算冒充精确计数。 */
  countInputTokens?(request: ModelRequest, options: { signal?: AbortSignal }): Promise<number>;
}

export type ModelAdapterFactory = () => ModelAdapter | Promise<ModelAdapter>;

export function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512;
}

/** 固定公开身份，保留方法的 this；只投影合同字段，不传播服务额外返回的鉴权数据。 */
export function checkedModelAdapter(value: unknown): ModelAdapter {
  if (typeof value !== "object" || value === null) throw new Error("模型适配器必须返回一个对象");
  const adapter = value as ModelAdapter;
  if (
    adapter.version !== "proteus-model-adapter-v1" ||
    !identifier(adapter.id) ||
    !identifier(adapter.serviceId) ||
    typeof adapter.generate !== "function" ||
    (adapter.countInputTokens !== undefined && typeof adapter.countInputTokens !== "function")
  )
    throw new Error("模型适配器需要 version、id、serviceId 和 generate 方法");
  if (/^https?:/i.test(adapter.serviceId)) {
    const url = new URL(adapter.serviceId);
    if (url.username || url.password || url.search || url.hash)
      throw new Error("模型适配器 serviceId 不得包含凭据、查询参数或片段");
  }
  const generate = adapter.generate.bind(adapter);
  const count = adapter.countInputTokens?.bind(adapter);
  return Object.freeze({
    version: "proteus-model-adapter-v1" as const,
    id: adapter.id,
    serviceId: adapter.serviceId,
    async generate(request: ModelRequest, options: { signal?: AbortSignal }) {
      options.signal?.throwIfAborted();
      const response: unknown = await generate(request, options);
      if (typeof response !== "object" || response === null)
        throw new Error("invalid_model_response");
      const r = response as Record<string, unknown>;
      if (typeof r.text !== "string" || (r.refusal !== undefined && typeof r.refusal !== "boolean"))
        throw new Error("invalid_model_response");
      return {
        text: r.text,
        servedModel: identifier(r.servedModel) ? r.servedModel : null,
        inputTokens: tokenCount(r.inputTokens),
        outputTokens: tokenCount(r.outputTokens),
        stopReason:
          typeof r.stopReason === "string" && r.stopReason.length <= 128 ? r.stopReason : null,
        refusal: r.refusal === true,
        contentBlockTypes:
          Array.isArray(r.contentBlockTypes) && r.contentBlockTypes.length <= 128
            ? r.contentBlockTypes.map((type: unknown) =>
                typeof type === "string" && type.length <= 128 ? type : null,
              )
            : null,
      };
    },
    ...(count
      ? {
          async countInputTokens(request: ModelRequest, options: { signal?: AbortSignal }) {
            options.signal?.throwIfAborted();
            const result = await count(request, options);
            if (tokenCount(result) === null) throw new Error("invalid_service_input_token_count");
            return result;
          },
        }
      : {}),
  });
}
