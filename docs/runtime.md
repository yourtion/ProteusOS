# 运行时、决策与执行合同

当前实现见 `src/runtime/`、`src/decision/` 与 `src/adapters/`。本页描述现有合同；阶段状态见 [路线图](./roadmap.md)，术语见 [领域词汇](./CONTEXT.md)。

## 1. 执行单位与版本绑定

| 对象 | 作用 |
| --- | --- |
| Task | 目标、输入、预算、能力要求和验收条件 |
| Run | 一次执行，固定 Task 修订、Organism、用途和 GenomeSnapshot |
| Process | execute 节点的执行身份；重试沿用该身份 |
| Attempt | 一次 worker 派发，使用新 attemptId 和 dispatchId |

普通 Run 在准入事务中读取 activeGenome；评估 Run 可显式绑定候选或基线快照，`purpose=evaluation`，不修改默认行为。版本依赖必须完整且可访问，运行与恢复不解析 latest。

评估计划可以固定 `evaluatorVersionId`，仅评估用途允许，保存于 Run 后沿用。能力缺口以 waiting 创建，不执行图；出路是到期 `advance` 结案，或 `supersede` 创建使用新快照的接替 Run。

## 2. Kernel 与 Runtime 的分工

Kernel 检查身份、版本、授权与快照/晋升不变量。Runtime 验证有限 DAG、安排节点、记录状态、预留预算和恢复。支持 decision、execute、verify 三类节点；依赖必须存在且无环。下游依赖未成功时跳过，必需工作和验收通过才记 Run succeeded。

准入与派发检查目标个体权限、精确版本依赖和当前预算。普通/评估 Run 分别使用 normal/evaluation 池，限制并发数、在途 Attempt 数与预留墙钟时间。决策调用额度和学习调用额度分别记账，未知费用不记为零。

## 3. DecisionProvider：结构化选择

当前图运行路径使用 choice。gate/rank 保留类型声明，规则 Adapter 有 allow/deny 分支，但未实现它们的通用图调度语义。Jev、binary/score 合同、概率证据与决策级联尚未实现；实施方向见 [架构差距](./architecture-gaps.md)。实际类型位于 `src/decision/index.ts`：

```ts
interface DecisionProvider {
  readonly name: string;
  readonly remote?: boolean;
  capabilities(): { problems: DecisionProblem[] };
  decide(request: DecisionRequest): Promise<DecisionResult>;
  // 可选 callProvenance 提供受信 Adapter 的服务与配置来源。
}
```

请求包含 options、context、精确 policy 版本、deadlineMs、remainingAttempts，以及可选受限 view 和 AbortSignal。结果是 value、abstain 或 invalid_output，并附来源和可用的用量信息。

Runtime 校验选项成员关系；未知 ID、额外字段和非 JSON 包装不会被猜测修复。弃权、非法输出、传输失败、超时和未知结果分别记录，不自动改选执行器。LLM 服务配置来自版本化策略，凭据由应用装配，模型不能授予权限。

每个决策节点有持久化 decisionId，请求/响应内容摘要、策略与视图版本、服务来源、状态和用量。调用额度按个体与个体内的 experimentId 计数：已发送或 prepared 预留的远端调用占额度，确认未发送的取消不占额度。本地规则计算不消耗远端调用额度。

| 调用状态 | 恢复行为 |
| --- | --- |
| prepared | 保留原 decisionId，重新检查授权与取消后允许首次发送 |
| started/unknown 的 model 调用 | 可能已计费，不自动重发，不派发 worker；等待明确结案 |
| value | 使用原响应证据与已记录选择，不再次推断 |
| abstain/invalid_output/transport_error/timeout/cancelled | 沿用终态，不重调模型 |
| 超时/取消后的迟到响应 | 追加证据，不覆盖终态或启动 worker |
| 请求/响应 blob 缺失或摘要漂移 | 明确不可恢复，不用新输入替代 |

合法 value、decision.recorded 和节点成功同事务提交。网络调用不跨 await 持有数据库事务；超时取单次上限与 Run 剩余时间的较小值。

## 4. 离线学习

学习由 Evolution 的 Consolidation 承担，读取本个体冻结的 development 经验投影，通过规则或受控 LLM 提议生成候选。学习作业有独立队列、累计模型调用额度、取消和崩溃恢复；不通过在线 DecisionProvider 修改正在使用的策略。完整流程见 [进化与继承](./evolution.md)。

## 5. ExecutorProvider：执行工作

当前 `start` 等待执行完成，不提供统一的远端 handle 查询、事件流或 cancel Interface。实际合同见 `src/runtime/types.ts`：

```ts
interface ExecutorProvider {
  readonly name: string;
  readonly recoveryPolicy: 'retry-safe' | 'manual';
  start(request: ExecutionRequest): Promise<ExecutionResult>;
}
```

ExecutionRequest 包含 runId/processId/attemptId、workspaceDir、prompt 与 timeoutMs；ExecutionResult 包含 ok、exitCode、stdout/stderr、durationMs 与 outputRef。执行器表示完成后仍由 verify 独立验收。

注册表包含 local-process、claude-code-acp、codex-acp、pi；缺少装配时得到 unknown_executor，不隐式回退。`capability/<name>` 从固定快照加载能力模块到独立子进程，名称、路径与超时都校验。工作区隔离不等于安全沙箱；导入能力及其派生版本必须使用真实隔离后端，缺失时以 sandbox_required 停止执行。已有 Microsandbox 后端不可用时不降级，Docker 后端未实现。

## 6. 外部 Agent 适配

Claude Code 与 Codex 使用官方 ACP agent 适配器及 TypeScript client SDK，pi 通过 SDK 直连；见 [ADR 0005](./adr/0005-external-executors.md)。ACP initialize → session/new → prompt/update 的会话语义保留在 Adapter，session ID 不替代内部 Run/Process 身份。

权限请求按注入策略处理，并连同 update 写入工作区 `.proteus/acp-trace.json`。ACP 的 end_turn 只表示交互结束；超时由 Adapter 请求取消，宽限后结束进程。权限请求和一次性工作区均不提供宿主安全隔离。pi 使用受信项目工作区，运行在当前进程中。

合同测试使用真实 ACP 协议实现的 fake agent；真实凭据 E2E 单独显式启用，结果不能由 fake 推断。

## 7. 持久化、派发与事件合同

状态、事件、预算和 outbox 使用 node:sqlite 同一事务存储，内容使用摘要寻址 blob。派发前事务保存 Attempt 与 outbox，外部执行在事务外调用，结束报告再事务保存。当前为内联派发，不存在独立的通用 outbox dispatcher 或跨机器租约。

Event 记录 eventId、streamId/seq、type/schemaVersion、payload、因果关联、归属 ID 与时间。Blob 先写临时文件再原子落位；失败事务可能留下未引用 blob，引用内容缺失时明确报错。凭据不进入版本、事件或经验导出。

外部执行与数据库没有共享事务，不能保证副作用 exactly-once。恢复必须结合持久化证据与执行器的 recoveryPolicy，不能因为 outbox 存在就盲目重派。

## 8. 取消、撤权与恢复

Run 状态为 pending/running/waiting/succeeded/failed/cancelled。Attempt 另有 dispatching、cancel_requested 和 unknown；未知执行进入等待对账。

`cancel` 持久化停止意图：pending Run 可直接结案；当前进程的决策调用通过 AbortSignal 结束等待，已发调用保留未知费用。对已经开始的 worker，本轮合同不提供统一即时停止，后续节点与重试不再派发。

新决策准备、发送与 worker 派发事务重新检查当前个体、Task.requestedBy、版本闭包及固定裁判权限。撤权以 access_revoked 阻止新动作；未发送调用的取消终态与额度释放一起提交。正在执行的工作可以结束，已有结果不会因为撤权被抹去。

| 命令/情况 | 行为 |
| --- | --- |
| recover | 扫描本个体的非终态 Run；遗留 dispatching/running 标记 unknown，其余按原快照续跑 |
| reconcile | 按完整工作区产物对账；缺产物仅 retry-safe 可判失败并有界重试，manual 保持 unknown |
| settle-decision | 操作者明确结案未知决策，保留调用与费用证据，不重新发送 |
| 缺口等待 | 等待到期或显式接替，不能在旧 Run 中热加入能力 |
| 迟到结果 | 关联原调用/Attempt，保留证据，不无条件覆盖已确认终态 |

重试沿用 Process、使用新 Attempt，受原快照、当前权限与剩余预算约束。取消与回滚不撤销已发生的外部副作用。
