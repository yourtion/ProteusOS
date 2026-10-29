import { createHmac } from "node:crypto";

// 示例私有协议：请求正文为 Proteus ModelRequest；响应见 docs/model-adapters.md。
// 文件可以放在仓库外。这里只依赖 Node.js，无需导入 Proteus 的运行时代码。
export default async function createModelAdapter() {
  const endpoint = process.env.MY_MODEL_ENDPOINT;
  const secret = process.env.MY_MODEL_SIGNING_KEY;
  if (!endpoint || !secret) throw new Error("Missing model configuration");
  const url = new URL(endpoint);
  return {
    version: "proteus-model-adapter-v1",
    id: "my-signed-model@1",
    serviceId: `${url.origin}${url.pathname}`,
    async generate(request, { signal }) {
      // 可替换成异步刷新 OAuth token、从凭据管理器读取密钥等逻辑。
      // 在每次调用时鉴权，并把 signal 传给鉴权请求和模型请求。
      signal?.throwIfAborted();
      const body = JSON.stringify(request);
      const timestamp = String(Date.now());
      const signature = createHmac("sha256", secret).update(`${timestamp}\n${body}`).digest("hex");
      const response = await fetch(endpoint, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          "X-Timestamp": timestamp,
          "X-Signature": signature,
        },
        body,
      });
      // 不将可能包含 token 的响应正文写进异常；一次生成请求不自动重试。
      if (!response.ok) throw new Error(`Model HTTP ${response.status}`);
      const result = await response.json();
      return {
        text: result.text,
        servedModel: result.model ?? null,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        stopReason: result.stopReason ?? null,
        refusal: result.refusal ?? false,
      };
    },
  };
}
