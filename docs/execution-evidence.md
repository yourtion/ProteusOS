# 执行轨迹与用量合同

版本：`execution-evidence-v1`。Executor 可以在 ExecutionResult 中返回可选的 evidence，Runtime 将其转为 Attempt 的内容引用与事件记录。任务是否成功仍由执行状态和独立验收决定，轨迹表示宿主观察到了什么。

## 观测范围与状态

| 执行路径 | coverage | 当前观测 |
| --- | --- | --- |
| local-process | lifecycle | 进程开始、结束、退出码和超时；stdout/stderr 截断标记 |
| capability | lifecycle | 精确能力版本、沙箱后端、开始与结束 |
| ACP | agent-events | 公开文本、工具状态、权限选择与会话结束 |
| pi | agent-events | 公开文本、工具开始/结束、会话结束及 SDK 报告的 tokens |
| 旧 Adapter | none | 明确 unavailable，不推断零成本或补造工具事件 |

complete 表示该 coverage 内的观测完整，不表示拿到了外部 Agent 的全部内部过程。partial 表示超时、断连、事件溢出或截断；unavailable 表示 Adapter 未提供证据；failed 表示轨迹持久化失败。任务与轨迹状态分别记录，例如执行已成功但 trace 保存失败时，保留成功的 Attempt 并记录 failed 证据，不能据此重派。

公开事件最多保留 256 条，每个文本字段最多 2000 字符；丢弃条数与文本截断显式记录。stdout/stderr 保留最多 65536 个字符的尾部，并独立标记截断。完成时复制快照，迟到的内存事件不能更改已返回的证据。

不采集 ACP 的 agent_thought_chunk 或 pi 的 thinking 内容。新投影仅保留比较需要的工具标识/名称/状态、公开输出和权限选项；不复制工具参数与隐藏推理。ACP 兼容工作区 trace 仍作为辅助文件，写入失败时可由返回的内存投影供宿主持久化。

## Runtime 持久化

派发前对工作区 inputs 副本计算稳定内容指纹，包括相对路径、目录、文件内容和符号链接目标；符号链接不跟随到目录外。未能获取指纹时记录 null。输出摘要对应返回的 output.json；通用编码 Agent 没有该文件时保留 null，其文件交付仍由 verify 的独立证据描述。

Runtime 保存 prompt/input/output 与已捕获 stdout/stderr 的摘要、快照、执行器/Adapter 标识、用量、trace 状态/范围及 blob 引用。trace blob 先按内容寻址写入，`attempt.evidence.recorded`、Attempt 成功结果与执行节点完成事件在同一事务提交。这样在事务提交后、返回执行循环前崩溃，恢复也能跳过已成功节点。崩溃可能留下未引用 blob，恢复不会再次发送执行请求来补轨迹。

RunSummary.attempts 中提供已持久化的 evidence，实时提交结果与重开后的查询采用相同投影。删除工作区不影响 blob 读取。`readExecutionTrace` 检查摘要；内容缺失或漂移明确失败，无法读取的旧记录不以新执行替代。

历史 Attempt 缺少新事件时 evidence 缺省；新运行使用旧 Adapter 时返回 unavailable。已完成但结果尚未持久化的崩溃仍使用原恢复合同：工作区产物可以证明执行结果，却不能补造已丢失的轨迹。

## 资源语义

usage 缺省为 null。pi 从 SessionStats 读取 input/output tokens；SDK 的 cost 不包含本项目要求的币种和价格依据，因此金额继续为 null。ACP 与本地进程当前未提供可核对费用，进程退出或任务成功不表示免费。

新版策略评估明细的 trials.executions 冻结各 Attempt 当时的证据引用。既有 resources.scope 仍明确为 decision-calls-only，执行用量通过对应 Attempt 单列，不将其冒充已包含在旧汇总中。新实验的全生命周期成本比较需要在独立协议中约定完整汇总规则。

## 验证

- `tests/unit/execution-evidence.test.ts`：有界观测、截断、迟到事件及内容指纹。
- `tests/integration/execution-evidence.test.ts`：重开/清理工作区、摘要损坏、保存失败不重派、旧数据兼容及真实本地子进程截断。
- `tests/contract/executor-acp.test.ts`：真实 ACP 协议 fixture 的公开事件、断连、超时、权限和辅助 trace 写入失败。
- `tests/contract/executor-pi.test.ts`：SDK 合同替身验证公开投影、tokens、隐藏推理过滤、取消订阅及超时后的证据冻结。

这些测试证明工程合同；真实外部 Agent 与 Microsandbox 仍由显式 E2E 单独验证。
