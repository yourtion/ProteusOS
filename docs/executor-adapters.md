# 从本地文件接入执行器与 ACP

个人适配器可集中放在 `~/.proteus-local/`，启动时自动发现配置；迁移步骤见 [用户级本地配置](./local-configuration.md)。

首次接入请按 [ACP 接入教程](./acp-integration.md) 完成示例复制、鉴权、启用配置、工作台验证和排错。

```bash
MY_ACP_COMMAND=/absolute/path/my-acp-agent \
  pnpm proteus web --executor-adapter ./examples/executor-adapter.mjs

# 参数按 JSON 数组传递，不经过 shell；也可启动 Node 脚本
MY_ACP_COMMAND=node MY_ACP_ARGS='["/absolute/path/agent.mjs"]' \
  PROTEUS_EXECUTOR_ADAPTER=/absolute/path/executor-adapter.mjs pnpm web
```

启动后在 Web 的执行器下拉框选择 `my-acp`。CLI 构建使用 `build --executor my-acp --executor-adapter ./my-executor.mjs`（其余 build 必填参数不变）；普通任务由快照图的 `executor` 字段选择执行器，加载模块不会改写既有图。默认 Codex、Claude、Pi 与本地执行器仍可用，自定义名称不能覆盖内置名称。模型适配器与执行器适配器可同时配置。

文件支持 `.mjs`、`.js`、`.ts`、`.mts`，命令行优先于 `PROTEUS_EXECUTOR_ADAPTER`，相对路径基于启动目录。不自动查找任务目录。默认导出对象或返回对象的异步工厂；加载失败即停止启动，不回退。模块为受信宿主代码，拥有启动进程权限。

[完整示例](../examples/executor-adapter.mjs)无需导入项目源码，复制到仓库外也可使用：

```js
export default {
  version: "proteus-executor-adapter-v1",
  name: "my-acp",
  async create({ createAcpExecutor, signal }) {
    // 每次执行都会调用，可在此刷新鉴权，signal 覆盖初始化和执行超时。
    return createAcpExecutor({
      command: "/absolute/path/acp-agent",
      agentArgs: ["--stdio"],
      env: { ...process.env },
    });
  },
};
```

ACP 接入采用 **stdio JSON-RPC**，复用现有 initialize → session/new → session/prompt、进度、事件、取消、计量与 trace。支持任意可执行命令，或通过 `agentEntry` 指定 Node 入口，二者必须只选一个。`command` 不包含参数，不使用 shell；相对可执行路径基于执行工作区，推荐绝对路径或 PATH 中的命令。远端 HTTP/WebSocket ACP 需自行桥接为 stdio，本接口不直接提供远端传输。

鉴权由文件内逻辑或 agent 自身负责，可把 token 放在子进程 `env` 中。`sessionMeta` 仅放 agent 支持的公开会话配置。适配器应避免在 stdout/stderr、错误和会话元数据中输出凭据；Proteus 不会将环境配置序列化到执行证据。模块不自动调用 ACP authenticate 方法，需要协议认证的 agent 应由接入实现完成相应处理。

`createAcpExecutor` 自动绑定执行器名称及宿主审批策略：Web 权限请求进入现有审批 UI；无人值守 CLI 默认拒绝权限请求。不要在自定义代码中绕过宿主审批。自定义非 ACP 实现也可由 `create` 返回符合 [ExecutorProvider](../src/runtime/types.ts) 的对象，`name` 必须等于注册名，`start(request)` 应传递取消并返回完整 ExecutionResult。

宿主为每次执行创建实例，初始化超时或取消后不会启动迟到的执行器，不自动重试；恢复采用 manual。执行完成仍由 Runtime/工作台独立验收，ACP end_turn 不等于任务验收通过。

## 配置可用执行器、Pi 与 OpenCode

```bash
pnpm proteus web --executors-config ./examples/executors.config.mjs
# 或
PROTEUS_EXECUTORS_CONFIG=/absolute/path/executors.config.mjs pnpm web
```

配置示例：

```js
export default {
  version: "proteus-executors-v1",
  enabled: ["pi", "opencode"],
  default: "pi",
  adapters: [],
};
```

`enabled` 控制 Web 可选择列表及 CLI 的外部执行器注册，`default` 是工作台初始选择，必须在 enabled 内。它不会改写既有快照图。`local-process` 是 Runtime 的本地基础能力，不受此列表影响；`fake-acp` 仍只由测试环境显式启用。可将多个自定义适配器对象放在 `adapters` 中，并把相应名称加入 enabled。旧单适配器文件仍受支持。

优先级：`--executors-config` > `--executor-adapter` > `PROTEUS_EXECUTORS_CONFIG` > `PROTEUS_EXECUTOR_ADAPTER` > 用户级本地入口。未发现任何入口时默认注册 Codex、Claude、Pi、OpenCode，Web 标出不可用命令，不允许提交给未启用的执行器。

Pi 使用已安装的 `@earendil-works/pi-coding-agent` SDK，默认读取 `~/.pi/agent` 的模型与鉴权配置；可通过 `PROTEUS_PI_AGENT_DIR` 指向自己的配置目录。工作台启动 Pi 前请求一次本次任务的文件/命令工具授权，获准后 SDK 执行整个会话；这不是逐工具审批。公开文本、工具活动、进度及取消接入工作台，用量沿用 SDK 实际报告。

OpenCode 复用 ACP stdio：宿主启动 `opencode acp`，见 [官方 ACP 说明](https://opencode.ai/docs/acp/)。需先在宿主安装并配置 OpenCode 的模型与鉴权；可设置 `PROTEUS_OPENCODE_COMMAND` 指向绝对可执行文件路径。Web 检查命令是否可执行，鉴权成功与否以实际运行结果为准；权限请求沿用 ACP 工作台审批。自定义参数、环境或动态 token 可通过单独的自定义适配器接入。

## 任务模型与推理强度

新任务表单会从服务端读取执行器列表；`enabled` 中未声明的执行器不可提交。启动 Web 时会构建当前前端，避免旧表单与后端配置不一致。更新代码或配置后需重启 Web 并刷新页面。

每个执行器可在配置中声明模型与推理强度建议值：

```js
import traex from "./traex-executor.mjs";
import opencodeW from "./opencode-w-executor.mjs";
export default {
  version: "proteus-executors-v1",
  enabled: ["traex", "opencode-w", "pi"],
  default: "traex",
  adapters: [traex, opencodeW],
  choices: {
    traex: {
      models: ["your-actual-model-id"],
      reasoningEfforts: ["low", "high"],
    },
  },
};
```

请替换为自己的 agent 实际支持的 ID。也可在单个适配器对象上声明 `models` 和 `reasoningEfforts`，`choices` 中同名配置优先。声明列表时，服务端会拒绝列表之外的值；未声明时可在表单手动输入，具体能力由执行器验证。列表是操作者配置，不是自动发现的模型目录。

留空表示保留执行器默认值。选择会保存到任务记录并传入本次执行，切换执行器时清空上一次模型和强度。ACP 在 session/new 后读取 agent 的 configOptions，通过 session/set_config_option 应用并检查响应确认，再发送 prompt；agent 未声明该能力、值不支持或未确认生效时明确失败，不静默改用其他设置。Pi 使用 SDK 设置实际模型与 thinking level；模型 ID 不唯一时使用 `provider/model-id`。

自定义非 ACP 执行器应消费 `ExecutionRequest.model` 和 `ExecutionRequest.reasoningEffort`。这些字段属于编码执行器，与 Proteus 决策模型的 `--model-adapter` 配置独立。
