# ProteusOS

承载长期、可适应智能的运行基质：让具有持续身份的个体执行任务、积累经验，并通过可验证、可继承、可回滚的产物变化改进行为。

## 当前状态

M0–M4 的本地闭环已实现：任务执行与恢复、外部委托、能力自举、经验驱动策略改进、团队版本发布与本地继承。后续已加入 Ed25519 签名、来源信任与撤销、HTTP registry，以及派发前的实时权限检查。

日常验收使用固定 fixture、真实 SQLite 和本机 HTTP。真实外部 agent 测试需显式启用；真实 LLM 收益、外网部署与共进化仍待验证或开发。各阶段完成范围和剩余工作统一见 [路线图](./docs/roadmap.md)。

决策层目前只在有限 choice 上接通规则与通用 LLM；Jev Adapter、概率校准与决策级联尚未实现。原始架构还包含预测、记忆、归因和更完整的经验适应闭环，具体差距与后续顺序见 [架构差距](./docs/architecture-gaps.md) 和 [迭代规划](./docs/iteration-plan.md)。

交互方向确定为 Web 优先、CLI 保留，未来 TUI 复用共享应用 Interface。已有本地代码工作台，支持项目、任务、执行审批、结果审阅和应用修改；已完成核心流程浏览器验收与真实 Codex ACP 小任务闭环，并接通首批规则学习和版本治理页面；页面与合同见 [交互设计](./docs/interaction.md)，参考 DSH 的项目、任务、diff 和应用修改流程见 [Web 代码工作台实施计划](./docs/web-workbench-plan.md)。

## 快速开始

```bash
pnpm install
pnpm check                          # lint + format + typecheck + 全量测试
pnpm proteus init                   # 初始化实例（默认 ~/.proteus），安装 seed 并装载 G0
pnpm proteus submit <task.yaml>     # 提交任务并内联执行到终态
pnpm proteus runs [id]              # 列出 / 查看 Run
pnpm proteus recover [runId]        # 崩溃恢复，省略 ID 时扫描当前个体
pnpm proteus reconcile <runId>      # unknown Attempt 对账
pnpm proteus inspect <id>           # 查看当前个体有权读取的对象
```

真实外部 agent 的 E2E 测试默认跳过（消耗凭据）：`PROTEUS_E2E=claude|codex|pi|all pnpm test -- tests/e2e`。

## 多个体与团队版本

各命令支持 `--home`、`--organism` 和 `--actor`。例如在同一实例创建两个不同归属的个体：

```bash
pnpm proteus init --home ./instance --organism alice-organism --actor alice
pnpm proteus init --home ./instance --organism bob-organism --actor bob
pnpm proteus team-create contributors --home ./instance --organism alice-organism --actor alice
pnpm proteus team-grant contributors bob --permission read --home ./instance --organism alice-organism --actor alice
```

用 `share-fork --versions <版本ID...> --scope public` 或 `team:<团队ID>` 明确准备可共享版本；`publish --team <团队ID> --versions <版本ID...> --scope <范围>` 发布精确版本。`share-export <发布ID> --out <文件>` 与 `share-import <文件>` 交换包，默认不共享经历或评估明细，导入不切换默认行为。

接收方先 `validation-register --cases <验证计划JSON> --repeats <次数>`，随后 `inherit <导入ID> --validation-set <验证集ID>`、`evaluate-policy <候选ID>`，验证通过后由本地操作者 `promote <候选ID> --as <操作者>`。验证用例需要稳定 `id`/`familyId`、任务、期望路由，至少包含一个 `role: "regression"` 的健康基线回归任务。拒绝用 `share-reject <导入ID>`，不影响其他个体的选择；所有操作应带目标个体和操作者选项。

学习作业使用 `consolidate-submit` / `consolidate-run` / `consolidate-cancel`；`consolidate-run --learning-calls <上限>` 配置独立累计调用额度。停止其他学习进程后可用 `consolidate-recover` 结案崩溃遗留作业，未知调用不自动重发或退还额度。

## 签名来源与网络交换

已实现 Ed25519 发布签名、按个体登记公钥信任、永久撤信、团队权限撤销和 HTTP registry。`sharing-key-create`、`sharing-key-trust`、`sharing-key-revoke` 管理来源，`publication-sign` 导出签名离线包；`registry serve/token-create/token-revoke/publish/import` 提供精确版本交换。团队包读取和全部写入需要有效凭据，接收方仍须独立验签与本地评估。详见 [使用说明](./docs/sharing-registry.md) 与 [ADR 0010](./docs/adr/0010-signed-sharing-and-registry.md)。

CLI 服务仅监听 loopback；远端部署通过 HTTPS 反向代理接入。撤权会阻止新决策发送与 worker 派发，已采用行为不会自动回滚。工程验收使用实际本机 HTTP，未部署外网服务。

## 文档

- 设计文档入口：[docs/README.md](./docs/README.md)
- 领域词汇：[docs/CONTEXT.md](./docs/CONTEXT.md)
- 自举路线、已决策事项与实现进度：[docs/roadmap.md](./docs/roadmap.md)

License：Apache-2.0

## 本地 Web 代码工作台

运行 `pnpm web:build` 后执行 `pnpm web`，打开终端打印的完整地址。添加 Git 项目后，可提交代码任务、处理执行权限、查看结果和检查，审阅后应用修改。默认使用独立实例 `.proteus-web/`。输入限制、认证、恢复及 DSH 复用核对见 [Web 说明](./web/README.md)。

## 自定义模型适配器

使用 `pnpm proteus web --model-adapter ./my-model.mjs`，或设置 `PROTEUS_MODEL_ADAPTER`，在启动时加载自己的模型实现。模块可自行执行动态 token、请求签名等鉴权，供决策与 LLM 归纳复用。完整合同与生效范围见 [模型接入说明](./docs/model-adapters.md)，可从 [签名示例](./examples/model-adapter.mjs) 开始。

## 自定义执行器与 ACP

使用 `pnpm proteus web --executor-adapter ./my-executor.mjs`，或设置 `PROTEUS_EXECUTOR_ADAPTER`。自定义执行器会出现在工作台选择列表；文件中可准备动态鉴权，再通过宿主提供的 `createAcpExecutor` 启动 ACP stdio 命令。参见 [ACP 接入教程](./docs/acp-integration.md)、[接口说明](./docs/executor-adapters.md) 和 [ACP 示例](./examples/executor-adapter.mjs)。

可使用 `pnpm proteus web --executors-config ./examples/executors.config.mjs` 配置 `enabled` 列表和默认执行器。内置 Pi（SDK）与 OpenCode（ACP）已接入工作台；[配置示例](./examples/executors.config.mjs)也支持同时注册多个自定义适配器。
