# 用户级本地适配器与配置

个人接入代码放在 `~/.proteus-local/`，运行数据放在实例目录。更新或切换 ProteusOS 源码时，本地适配器、模型映射和鉴权逻辑可以继续复用。

```text
~/.proteus-local/
├── executors.config.mjs       # 可用执行器、默认执行器、模型/强度选项
├── traex-executor.mjs         # 自己的执行器实现
├── opencode-w-executor.mjs
├── model-adapter.mjs          # 可选：决策和归纳使用的模型服务
├── runtime-adapter.mjs        # 可选：决策、学习提议、编译和能力沙箱实现
└── .env                       # 可选：由自己的模块显式读取
```

## 安装示例

在仓库根目录执行：

```bash
mkdir -p ~/.proteus-local
cp -n examples/proteus-local/executors.config.mjs ~/.proteus-local/executors.config.mjs
pnpm web
```

示例默认启用 Pi 和 OpenCode，默认选 Pi。已有配置不会被上述复制命令覆盖。`pnpm web` 会自动构建当前前端并读取本地入口，无需再给每次启动附加适配器路径。

也可以从其他目录运行 `node /absolute/path/ProteusOS/bin/proteus.mjs web --home /absolute/path/instance`；启动器会从自身安装位置解析依赖。

## 迁移已有执行器

将自己的适配器文件移到本地目录；配置中的导入路径保持相对于配置文件：

```js
// ~/.proteus-local/executors.config.mjs
import traex from "./traex-executor.mjs";
import opencodeW from "./opencode-w-executor.mjs";

export default {
  version: "proteus-executors-v1",
  enabled: ["traex", "opencode-w", "pi"],
  default: "traex",
  adapters: [traex, opencodeW],
  // 可按 agent 实际支持的 ID 声明 choices，见执行器接口说明。
};
```

自定义 ACP 适配器使用宿主注入的 `createAcpExecutor`，无需导入项目内文件。若适配器自己依赖第三方包，依赖需要安装在 `~/.proteus-local/` 或 Node 可从该目录解析到的位置。编码 agent 自己的模型和凭据配置仍由对应 agent 管理。

需要自定义决策/归纳模型时，再添加 `model-adapter.mjs`。文件可以默认导出适配器对象或异步工厂，格式与 `--model-adapter` 完全一致。入口一旦存在就会加载；不需要模型接入时不添加此文件。

## 发现规则与覆盖

入口均支持 `.mjs`、`.js`、`.mts`、`.ts`，同名入口只保留一个扩展名。目录中的其他文件不会被自动导入，只在入口显式 import 时执行。

| 类型 | 优先级，从高到低 |
| --- | --- |
| 执行器 | `--executors-config` → `--executor-adapter` → `PROTEUS_EXECUTORS_CONFIG` → `PROTEUS_EXECUTOR_ADAPTER` → 本地 `executors.config.*` → 本地 `executor-adapter.*` |
| 模型 | `--model-adapter` → `PROTEUS_MODEL_ADAPTER` → 本地 `model-adapter.*` |
| 运行时 | `--runtime-adapter` → `PROTEUS_RUNTIME_ADAPTER` → 本地 `runtime-adapter.*` |

执行器配置入口存在时，备用的 `executor-adapter.*` 不会再合并加载；多个执行器在 `executors.config.*` 的 adapters 中声明。显式覆盖文件按启动目录解析，配置里的 import 按配置文件位置解析。`~/` 在覆盖路径中也受支持。

默认目录为 `~/.proteus-local`，可通过 `PROTEUS_LOCAL_DIR` 整体替换：

```bash
PROTEUS_LOCAL_DIR=/absolute/path/my-adapters pnpm web
pnpm proteus web --executors-config /absolute/path/another.config.mjs
```

`PROTEUS_LOCAL_DIR` 与运行数据的 `PROTEUS_HOME`、`--home` 分别配置，互不改变。目录或可选入口不存在时沿用原有默认行为；选定的入口损坏、依赖缺失、重复扩展名或格式非法时会报错，不静默切换到另一个服务。修改模块后重启 Web，再刷新页面。

## 鉴权与生命周期

这是用户级受信代码目录，入口具有启动进程权限。源码、环境及凭据不会作为配置存入任务快照或分享包。不要把凭据写入公开模型 ID、配置元数据、agent stdout/stderr 或错误正文。

`.env` 不会自动加载。如果希望把凭据放在本地目录的文件中，可在自己的入口中使用 Node 的 `process.loadEnvFile(new URL("./.env", import.meta.url))` 显式读取，或保持已有的系统环境/凭据管理器方案。

适配器工厂在实例装配时执行；执行器的 `create` 每次任务执行前调用，动态 token 可以在此刷新。具体实现教程：

- [ACP 接入教程](./acp-integration.md)
- [执行器、Pi/OpenCode 与模型选项](./executor-adapters.md)
- [模型适配器接入](./model-adapters.md)
- [决策、学习与能力沙箱适配器](./runtime-adapters.md)
