# 决策、学习与能力沙箱适配器

Decision 已使用 `DecisionProvider` 接口：`decision-rule` 是规则实现，`decision-llm` 是模型实现。模型适配器负责鉴权、请求协议与服务地址，Decision 负责构造决策请求、解析结构化结果；Runtime 独立检查选项、预算、截止时间并记录证据。

此前自定义 Decision、学习提议者、编译后端和能力沙箱只能通过 `openInstance` 的代码参数注入。现在可以在用户目录用一个运行时模块装配，CLI、分享命令和 Web 共用加载流程。

## 安装与加载

```sh
mkdir -p ~/.proteus-local
cp -n examples/runtime-adapter.mjs ~/.proteus-local/runtime-adapter.mjs
pnpm web
```

默认导出对象或异步工厂。只需配置需要扩展的字段：

```js
import decision from "./decision.mjs";
import learner from "./learner.mjs";

export default async (context) => ({
  version: "proteus-runtime-adapter-v1",
  id: "company-runtime@1",
  decisions: [decision],
  routeProposer: learner,
  // compileBackend: myCompiler,
  // capabilitySandbox: mySandbox,
});
```

`id` 是可公开的实现版本标识，不能包含凭据；实现变化时更新。字段拼写错误、重复决策名称、非法接口会阻止启动。导入与工厂初始化的原始异常不向终端透传，避免暴露鉴权响应。方法保留原对象的 `this`、状态和动态计量 getter。

优先级：`--runtime-adapter <file>` → `PROTEUS_RUNTIME_ADAPTER` → `~/.proteus-local/runtime-adapter.*`。支持 `.mjs/.js/.mts/.ts`，同名多个扩展名报错。`PROTEUS_LOCAL_DIR` 可替换整个接入目录；相邻 import 按模块位置解析。入口缺省时保留原行为，入口存在但出错时不回退。

```sh
pnpm proteus init --runtime-adapter /absolute/path/runtime-adapter.mjs
PROTEUS_RUNTIME_ADAPTER=/absolute/path/runtime-adapter.mjs pnpm web
```

适配器在实例打开前加载，每次 CLI 命令或 Web 启动调用一次工厂。动态鉴权应在 `decide`、`propose` 或模型 `generate` 中逐次刷新。模块由用户信任并以宿主权限运行，不扫描任务目录、不将代码或凭据写入快照。修改后需要重启 Web。模块没有后台启动/销毁钩子，网络请求应随调用取消，避免工厂创建无法回收的后台循环。

## 自定义决策

完整可复制例子见 [runtime-adapter.mjs](../examples/runtime-adapter.mjs)。每个 provider 必须提供：

- `name`：小写字母开头，可包含数字和连字符，最多 64 字符。不能覆盖 `decision-rule`；同一模块不能重复名称。
- `remote`：显式声明是否有远端调用。远端必须为 `true`，从而参与模型调用额度和未知结果记账。
- `capabilities()`：同步返回 `{ problems: ["choice"] }` 等能力声明。声明能力不代表当前 Runtime 已支持所有问题类型，现有主流程验证的是 choice。
- `decide(request)`：返回 `value`、`abstain` 或 `invalid_output`，并带实际 provider 名称和 `request.policy.versionId`。传输失败抛异常；不将其伪装为弃权或成功。

请求包含候选 `options`、静态 `context`、冻结策略 `policy`、可选的受限 `view` 和取消 `signal`。不要自动重试远端调用；将 `signal` 传给网络层。可选 `prepareRequest` 必须同步且无副作用；`callProvenance` 返回可公开的服务/模型来源，不能夹带密钥。详细类型见 [DecisionProvider](../src/decision/index.ts)。

安装模块只注册实现。使用它还需要在通过既有版本/候选流程安装的任务图中明确引用名称，例如：

```json
{
  "schemaVersion": 2,
  "kind": "dag-v1",
  "nodes": [
    {"id":"route","type":"decision","provider":"custom-decision","problem":"choice","options":["local-process"],"context":{}},
    {"id":"stats","type":"execute","executorFrom":"route","dependsOn":["route"]},
    {"id":"check","type":"verify","verifier":"stats-acceptance","inputFrom":"stats","dependsOn":["stats"]}
  ]
}
```

示例 provider 从冻结策略内容读取 `preferredExecutor`，例如 `{ "preferredExecutor": "local-process" }`。候选之外的返回值仍由 Runtime 拒绝，不派发执行器。注册决策不自动修改任何快照或默认行为，也不会改变 Web 新任务表单中的执行器选择；Web 编码任务目前直接使用所选执行器。

## 复用自己的模型服务

如果只是更换模型服务或鉴权策略，继续使用 [模型适配器](./model-adapters.md)，无需重写决策解析。已有 `model-adapter.mjs` 会自动供默认 LLM 决策和归纳使用。

如果需要单独指定归纳模型或给学习编译器复用决策实现，可用工厂上下文；这些帮助函数不需要导入仓库文件：

```js
export default ({ createLlmDecisionProvider, createLlmRouteProposer }) => ({
  version: "proteus-runtime-adapter-v1",
  id: "company-learning@1",
  decisions: [createLlmDecisionProvider()],
  routeProposer: createLlmRouteProposer({ model: "my-learning-model" }),
});
```

帮助函数默认使用先加载的模型适配器，也可通过 `{ adapter: otherModelAdapter }` 按用途指定另一个模型接入。未提供任何模型适配器时调用帮助函数会阻止启动。`createLlmDecisionProvider()` 注册名为 `decision-llm`，可明确替换模型适配器默认创建的同名实现；它的模型仍来自冻结策略。直接调用 `openInstance` 时，显式 `decisions`、`routeProposer`、`compileBackend`、`capabilitySandbox` 参数优先于运行时模块。

## 其他扩展点

| 字段 | 实现合同 | 约束与范围 |
| --- | --- | --- |
| `routeProposer` | `name`、异步 `propose(input, { signal })`；可选动态 `lastUsage` | 输入仅为缺口摘要、可选特征与选项。输出 `{ feature, choose, rationale }[]`；Evolution 重算统计门槛，只有独立证据支持的规则才能进入候选。用量未知时保留未知。 |
| `compileBackend` | `mode: "real" \| "fixture"`、`version`、`provider`、同步 `bounds(request)` | 用于有界示例编译。provider 遵循上述决策接口；真实编译还需提供可冻结请求和来源。`bounds` 必须返回宿主可保证的 token 上界，无法保证则返回 `null`，编译器拒绝发请求。不能用字符估算冒充上界。 |
| `capabilitySandbox` | `name`、`isolated`、同步 `available()` 和 `run(execution)` | 只影响 Runtime 能力模块执行，不自动包裹 ACP/Pi 等外部 Agent。声明 `isolated: true` 必须实际限制网络与宿主文件访问。后端不可用时拒绝执行，不降级。 |

详细接口：[RouteProposer](../src/evolution/consolidation.ts)、[CompileBackend](../src/evolution/compile-types.ts)、[SandboxBackend](../src/runtime/sandbox.ts)。沙箱接口当前是同步合同；异步远端容器服务需要自行适配现有调用方式，不能直接返回 Promise。

存储事务、BlobStore、签名信任、权限与候选采用规则仍由核心模块管理。它们没有本次用户级插件入口；迁移数据库或权限机制需要独立验证一致性，而不是仅替换一个初始化对象。

## 验证

```sh
pnpm exec vitest run tests/contract/runtime-adapter.test.ts tests/integration/runtime-adapter.test.ts tests/integration/consolidation-queue.test.ts tests/acceptance/runtime-adapter-startup.test.ts
pnpm check
```

专项覆盖仓库外 CLI/Web 加载、路径优先级、坏模块阻止启动、模型上下文、自定义决策驱动真实任务、非法选择拒绝执行、学习提议流程、有界编译和能力沙箱调用。测试模型/后端为受控实现，不调用私人远端服务。Web 的 `/api/settings` 返回运行时模块 ID 与实现名称，不返回实现对象或凭据。
