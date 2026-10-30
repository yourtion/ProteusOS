# ACP 执行器接入教程

本教程将自己的 ACP agent 接入 ProteusOS：在本地文件中声明启动方式和鉴权，再通过启动参数加载。适配器代码与模型适配器一样可以放在仓库外。完整类型和配置参考见 [执行器接口说明](./executor-adapters.md)。

## 1. 准备 agent

agent 需要支持通过 stdin/stdout 交换 ACP JSON-RPC 消息，并处理 initialize、session/new、session/prompt；取消使用 session/cancel。stdout 留给协议消息，诊断日志写 stderr。Proteus 会为每次任务启动独立进程，工作目录及 session cwd 均指向任务副本。

如果已有 OpenCode，可以直接使用内置入口：

```bash
pnpm web:build
pnpm proteus web --executors-config ./examples/executors.config.mjs
```

在工作台选择 `opencode`。宿主会启动 `opencode acp`；先在自己的终端中完成 OpenCode 安装及模型/凭据配置。`PROTEUS_OPENCODE_COMMAND` 可指定绝对可执行路径。这里的模型鉴权由 OpenCode 管理，Proteus 的 `--model-adapter` 不会替换编码 agent 内部的模型。

接入自己的 agent 时继续下面的步骤。

## 2. 复制单文件适配器

在仓库根目录执行：

```bash
cp examples/executor-adapter.mjs ./my-executor.mjs
```

也可以直接使用仓库的 [完整示例](../examples/executor-adapter.mjs)，或将文件复制到仓库外。最小结构如下：

```js
export default {
  version: "proteus-executor-adapter-v1",
  name: "my-acp",
  async create({ createAcpExecutor, signal }) {
    signal.throwIfAborted();
    return createAcpExecutor({
      command: "/absolute/path/my-agent",
      agentArgs: ["--stdio"],
      env: { ...process.env },
    });
  },
};
```

`name` 是注册名，以小写字母开头，最多 64 个小写字母、数字或连字符，不能与内置名称冲突。模块也可以默认导出返回该对象的异步工厂。模块工厂在启动时调用；`create` 在每次执行时调用，适合刷新鉴权。

无需导入 Proteus 源码。宿主提供 `createAcpExecutor`，绑定注册名和权限策略。文件支持 `.mjs`、`.js`、`.ts`、`.mts`；依赖按适配器文件所在目录解析。TS 由项目现有 tsx 启动器加载。

## 3. 配置进程和鉴权

完整示例读取三个环境变量：

| 变量 | 用途 |
| --- | --- |
| `MY_ACP_COMMAND` | ACP 可执行命令或绝对路径 |
| `MY_ACP_ARGS` | 参数的 JSON 字符串数组，默认 `[]` |
| `MY_ACP_TOKEN` | 可选，示例映射为 agent 子进程的 `MY_AGENT_TOKEN` |

执行命令与参数分别传入，不经过 shell。例如 Node agent：

```bash
MY_ACP_COMMAND=node \
MY_ACP_ARGS='["/absolute/path/agent.mjs","--stdio"]' \
pnpm proteus web --executor-adapter ./my-executor.mjs
```

如果直接使用 `agentEntry: "/absolute/path/agent.mjs"`，Proteus 会用当前 Node 可执行文件启动该脚本。`agentEntry` 与 `command` 必须只选一个。不要把 `node agent.mjs` 写成一个 command 字符串。

需要动态 token 时，可在 `create` 中执行自己的鉴权请求：

```js
async create({ createAcpExecutor, signal }) {
  const response = await fetch(process.env.MY_AUTH_ENDPOINT, {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${process.env.MY_BOOTSTRAP_TOKEN}` },
  });
  if (!response.ok) throw new Error(`Auth HTTP ${response.status}`);
  const { access_token } = await response.json();
  if (typeof access_token !== "string" || !access_token)
    throw new Error("Auth response missing access_token");
  return createAcpExecutor({
    command: process.env.MY_ACP_COMMAND,
    env: { ...process.env, MY_AGENT_TOKEN: access_token },
  });
}
```

这是示例鉴权协议，按自己的服务修改请求与字段。将 `MY_AGENT_TOKEN` 改为 agent 实际识别的变量名；无需把密钥写在适配器源码中。`signal` 同时覆盖初始化和执行取消，应传给鉴权网络请求。agent 若使用自己的凭据文件，也可在此配置其环境。

`sessionMeta` 用于 agent 支持的公开会话配置，例如模型或轮数，不放 token。子进程环境不会作为配置写入快照或 trace，但 agent 自己输出的文本和 stderr 可能被记录，因此不要输出凭据。Proteus 当前不主动调用 ACP authenticate 方法；要求该方法的 agent 需要补充相应认证实现或先使用其支持的预认证方式。

## 4. 声明可用执行器

单适配器加载会在默认执行器之外追加 `my-acp`。如果希望只启用指定执行器，创建 `my-executors.config.mjs`：

```js
import myAcp from "./my-executor.mjs";

export default {
  version: "proteus-executors-v1",
  enabled: ["my-acp", "pi", "opencode"],
  default: "my-acp",
  adapters: [myAcp],
};
```

`adapters` 放适配器对象。若被导入的模块默认导出的是工厂，先调用它，例如 `adapters: [await createMyAdapter()]`。可以注册多个自定义适配器；名称不可重复，enabled 只能引用内置或已注册名称，default 必须位于 enabled 中。

启动：

```bash
MY_ACP_COMMAND=/absolute/path/my-agent \
pnpm proteus web --executors-config ./my-executors.config.mjs
```

也支持 `PROTEUS_EXECUTORS_CONFIG=/absolute/path/my-executors.config.mjs pnpm web`。优先级是 `--executors-config`、`--executor-adapter`、`PROTEUS_EXECUTORS_CONFIG`、`PROTEUS_EXECUTOR_ADAPTER`。相对启动路径以当前目录解析；配置文件中的 import 相对配置文件解析。

`default` 设置工作台初始选择。CLI 构建仍通过 `--executor <注册名>` 指定，普通 CLI 任务则使用快照图中的 executor。配置不修改已有图；`local-process` 基础执行器保留。

## 5. 在工作台验证

打开启动日志中的工作台地址，添加一个测试 Git 项目，选择 `my-acp`，提交一个范围小、产物可检查的任务。

1. 确认“执行器”选择列表显示注册名称。
2. 查看任务的公开消息、工具活动和进度。
3. agent 发出 request_permission 时，在工作台允许或拒绝相应请求。
4. 检查任务结果、差异和项目检查输出，再应用修改。
5. 提交一个耗时任务并取消，确认状态结案；取消会请求 session/cancel，宽限期后仍未停止则终止进程。

Web 权限请求由宿主审批；无人值守 CLI 的自定义 ACP 默认拒绝权限请求。Pi 通过 SDK 接入，在工作台请求一次本次任务的文件/命令工具授权。两者的审批粒度不同。

ACP 的 end_turn 只证明 agent 返回，最终成功由任务验收或工作台的检查决定。崩溃恢复不会自动重发未知的执行；需要对账。

## 6. 与模型适配器一起使用

```bash
pnpm proteus web \
  --model-adapter /absolute/path/my-model.mjs \
  --executors-config /absolute/path/my-executors.config.mjs
```

模型适配器用于 Proteus 的决策和 LLM 归纳；执行器文件配置编码 agent。两份文件各自处理鉴权，可同时加载。模型教程见 [模型接入说明](./model-adapters.md)。

## 排错与本地回归

| 现象 | 检查位置 |
| --- | --- |
| 启动提示适配器加载失败 | 文件路径、扩展名、默认导出、依赖以及初始化环境变量；模块原始异常可能包含凭据，宿主不会直接透传 |
| 名称冲突或配置不合法 | 注册名、重复项、enabled、default；加载失败会停止启动 |
| OpenCode 显示不可用 | 命令是否在 PATH、是否可执行，或设置 PROTEUS_OPENCODE_COMMAND 绝对路径 |
| agent 启动失败 / ENOENT | command 是否仅为命令名，参数是否放在 agentArgs，脚本路径是否为绝对路径 |
| 初始化停住或协议错误 | agent 是否支持 ACP stdio，stdout 是否混入日志，是否需要额外认证 |
| 没有工具执行或权限被拒 | 检查工作台待办；自定义 ACP 的 CLI 默认拒绝权限请求 |
| 进程完成但任务失败 | 查看验收/项目检查与产物，不能只看 end_turn |
| 用量为空 | agent 未提供可核对的计量字段时保留未知，不按零计费 |

仓库提供不需要用户凭据的 fake ACP 回归：

```bash
pnpm test -- tests/contract/custom-executor-adapter.test.ts \
  tests/contract/executor-acp.test.ts \
  tests/contract/executors-configuration.test.ts \
  tests/integration/custom-executor-workbench.test.ts \
  tests/acceptance/executor-adapter-startup.test.ts
```

这些测试覆盖文件加载、ACP 往返、允许/拒绝、初始化取消、坏命令、配置和工作台流程；真实服务鉴权及模型效果仍需用自己的 agent 验证。
