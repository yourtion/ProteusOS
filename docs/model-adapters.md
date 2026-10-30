# 从本地文件接入模型

也支持自动加载 `~/.proteus-local/model-adapter.mjs`，将个人代码与项目分开；目录约定见 [用户级本地配置](./local-configuration.md)。

CLI 和 Web 启动时可加载操作者指定的本地 `.mjs`、`.js`、`.ts` 或 `.mts` 模块。相对路径以启动目录解析；不自动搜索项目或任务目录。模块默认导出一个适配器对象，或返回该对象的异步工厂。工厂在本次启动装配实例时调用，长驻 Web 复用该对象。

```bash
pnpm proteus web --model-adapter ./my-model.mjs
pnpm proteus submit task.yaml --model-adapter ./my-model.mjs
PROTEUS_MODEL_ADAPTER=/absolute/path/my-model.ts pnpm web
```

命令行路径优先于 `PROTEUS_MODEL_ADAPTER`，两者均未设置时查找用户级本地入口；未发现入口时保持原有行为。指定文件不存在、导出不合法或初始化失败时直接报错，不回退到默认服务。TS 文件由现有 tsx 启动器加载；依赖按该文件所在目录解析。模块是受信宿主代码，拥有启动进程的权限，只加载自己的文件。代码/凭据不写入实例快照。

可复制 [完整签名示例](../examples/model-adapter.mjs)，设置 `MY_MODEL_ENDPOINT` 和 `MY_MODEL_SIGNING_KEY` 后按自己的协议修改请求与响应映射。示例使用时间戳加请求正文的 HMAC 签名，这是示例私有协议，服务端须采用相同验签约定。可以在 `generate` 中刷新 token、自定义 headers、调用内部 SDK 或执行其他鉴权逻辑。

## 模块合同

类型见 [src/model/index.ts](../src/model/index.ts)。最小实现：

```js
export default async function () {
  return {
    version: "proteus-model-adapter-v1",
    id: "company-model@1",
    serviceId: "company-model-gateway",
    async generate(request, { signal }) {
      // request: { model, system?, messages, temperature, maxOutputTokens }
      // 完成鉴权和一次模型请求后，返回：
      return {
        text: '模型响应文本',
        servedModel: '实际模型版本',
        inputTokens: null,
        outputTokens: null,
      };
    },
  };
}
```

`text` 必须为字符串；可选 `stopReason`、`refusal`、`contentBlockTypes` 用于保留服务元数据。未知用量省略或填 `null`，不能填零。输入 tokens 应包含缓存读写输入。Proteus 只投影合同字段；适配器应避免把凭据放进文本、错误、模型名或公开身份。鉴权 headers 不属于请求快照。

`generate` 不自动重试；取消信号必须传递给底层请求，超时/传输失败应抛错，服务拒绝用 `refusal: true`。可选 `countInputTokens(request, { signal })` 仅用于真实计数，不支持时省略，需要计数的流程会明确拒绝。它不等同于可证明的输入预算上界。

`id` 是实现版本，`serviceId` 是不带凭据的公开服务标识。改变协议、模型映射或目标服务时更新身份；URL 形式的 `serviceId` 不接受用户名、密码、查询参数或片段。自定义适配器使用新的请求快照格式，记录适配器身份、服务和请求正文，恢复时拒绝漂移；历史 Anthropic 请求格式保持原样，不能用自定义适配器接着发送历史冻结请求。

## 生效范围

适配器注入 `decision-llm` 和 LLM 路由归纳。决策模型名及采样参数仍来自版本化策略；默认归纳请求模型为 `GLM-5.3-Flash`。私有服务需要不同名称时，应创建对应策略，或在适配器中明确映射并返回真实 `servedModel`，映射变化须更新适配器 `id`。

注册适配器不会修改已有快照或把规则 seed 自动改成 LLM 路由。选择 `decision-llm` 的图和 `--mode llm` 的归纳作业才会调用它。`experiment run --llm real` 支持此文件；`--llm fake` 仍使用测试实现。专用研究脚本需自行通过 `loadModelAdapter` 或构造器显式注入。

Web 中此配置用于同一实例的决策和归纳。编码 Agent（ACP/Pi）仍由 `ExecutorProvider` 管理，不会自动切换其模型或鉴权。执行器的单文件加载与鉴权接入见 [ACP 接入教程](./acp-integration.md)。
