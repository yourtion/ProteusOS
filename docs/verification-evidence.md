# JSON 验收证据与 Run 核验

本切片为 M6a-03-02b3a，是正式 Run 收据的前置。Runtime 保存当次 JSON 验收实际读取的正文；应用核验入口检查正文、实际执行输出和结案的一致性。它不生成正式 Evaluation，也不改变 activeGenome。

## 采集合同

DAG 的 stats/hybrid JSON verify 在原有 `verify.completed` 事件中增加 `verification-evidence-v1` 引用。可用记录指向内容寻址的 `json-verification-evidence-v1`，固定 Run、Task、Snapshot、verify 节点及其输入执行节点、实际生效裁判版本、算法、检查和记录时间。

输出、schema、可选 expectedOutput 保存为独立 blob。它们来自当次计算使用的同一批字符串，不在采集时重读文件。裁判使用 Run 显式钉住的版本；没有钉住时才使用快照默认版本。正文和摘要可以在资料、工作区清理及实例重开后复算。

| 状态 | 含义 | 原有验收行为 |
| --- | --- | --- |
| available | 原始正文和判定记录已保存 | 保持原判定 |
| unavailable | JSON 文档合计超过 4 MiB，或裁判为 test-runner | 保持原判定，不截断后冒充完整证据 |
| failed | blob 写入或证据装配失败 | 保持原判定，不重派执行 |

大小界限按输出、schema、expectedOutput 的 UTF-8 字节之和计算。旧事件缺少引用也属于 unavailable。历史 pipeline 路径保持原行为，没有新增 JSON 验收证据。JSON 读取或解析失败等尚未形成判定的路径仍按现有 Runtime 错误处理。

expectedOutput 属于独立验收资料，只保存到实例 blob，不加入 worker 输入或模型请求。采集证据不为执行器增加读取权限。

## 两层核验

`src/runtime/verification-evidence.ts` 的 `readJsonVerification` 是底层复算函数：核对记录、裁判和各正文摘要，以保存的 stats/hybrid 算法重新计算 checks 和 passed，拒绝只改判定或摘要损坏。它不自行执行访问授权；调用方必须持有读取这些证据的权限。

`experiments/protocols/run-verification.ts` 的 `auditRunVerification` 是应用侧只读入口：

```ts
const audit = auditRunVerification(
  { kernel: app.kernel, storage: app.storage, blobs: app.blobs, organismId, actorId },
  runId,
);
```

核验在同一数据库读事务中检查当前个体访问权、快照与裁判版本读取权及 blob 摘要，并核对：

- Run 已终态，执行图和裁判固定；验收正文的 Run/任务/快照/节点身份及事件时间一致。
- 同一 verify 节点只能有一条验收事件；未知节点、归属冲突和重复事件均拒绝。
- 输入执行节点最后一个 Attempt 已成功，存在唯一原始执行证据；其任务提示、快照和实际输出摘要与验收正文一致。
- 验收事件的 checks/passed 可由正文复算；完整可用时，最终 Experience 的结果、检查和输出摘要也一致。

事件查询不使用面向展示的数量上限。旧 Attempt 事件可缺少 organismId；归属通过 Run、Process、Attempt 关联检查，显式个体冲突仍拒绝。

结果固定 `scope: json-verification-only`。`runtimeAccepted` 只表示 Runtime 的原始成功状态；`verifiedAcceptance` 还要求存在完整可用且一致的 JSON 验收证据。`status: verified` 表示该范围内的核验通过，失败验收也能产生 verified 的负结果。缺少正文时保留 unavailable；正文存在但损坏、冲突或复算不符时抛错，不能降级成有效证明。

## 冻结任务绑定

M6a-03-02b3b1 在 JSON 验收核验之上增加 `auditAdaptiveRunTask(deps, runId, { frozen, caseId, task })`。它在同一个读事务内先核验 Run 原始证据，再校验完整冻结清单及任务白名单投影的摘要。只接受 formal/regression case、冻结时间之后开始的 evaluation Run；任务目标与修订必须一致，显式 family 声明不能冲突。

`task` 采用既有 `{goal,inputs:[{name,content}]}` 合同。核验函数不重读原文件；宿主应在执行前将冻结清单和白名单任务投影存入内容寻址 blob，之后以同一份内容复算。该入口只读，不会将调用者提交的清单自动注册到 Journal，也不证明它在执行前已登记。

`adaptiveTaskInputDigest` 把冻结文件投影为 Runtime 派发前实际输入树所用的摘要：目录按遍历顺序显式计入，文件对 UTF-8 字节的 base64 取摘要，子项顺序与 `executionInputDigest` 一致。目录从文件路径推导，文件即使不是 worker 消费的扩展名也必须计入。空目录或额外文件会导致实际摘要不一致。

投影上限为合计 4 MiB、512 个文件、64 层路径和单路径 1024 UTF-8 字节；拒绝绝对路径、`.`/`..`、空路径段、反斜杠、冒号、NUL、重复文件、文件/目录重叠及不完整 UTF-8。核验不对路径做容错归一化，也不靠原文件位置或统计结果推断内容相同。

每个执行节点的每次 Attempt 都必须有唯一、归属一致的原始输入证据，提示和快照必须一致；不能只核对最终产出 Attempt。输入摘要缺项时保留 unavailable，出现摘要冲突、重复或孤立执行证据则拒绝。没有发生执行也属于 unavailable，不能以空证据集合判定通过。

每份 JSON 验收收据还须匹配冻结 case 的 evaluatorDigest，即 `{verifier,outputSchemaDigest,expectedOutputDigest}` 规范 JSON 的摘要。裁判资料的字节即使只改变空白也不允许替换；已冻结的负验收可得到 verified 的负证据。该字段证明使用了冻结的验收资料，不能独立证明资料来源或人员独立性。

新结果使用 `adaptive-run-task-audit-v1` 和 `scope: frozen-task-and-json-verification`，分别报告输入、验收资料和原 JSON 核验。原 `auditRunVerification` 的返回内容及摘要保持不变。所有原文件和工作区清理后，只需保存的冻结内容与实例证据即可重开核验。

## 尚未完成的正式证据

原 JSON 范围的核验保留 `taskInputVerification: not_verified`。新冻结任务核验可将输入标为 verified，但仍明确保留 `registrationVerification`、`armVerification` 和 `costVerification` 为 not_verified，以及 `formalEvaluation: not_run`。它没有绑定实验预留、三臂配置、重复执行的无标签选择器、DecisionCall 及完整成本。这些独立入口不会自行升级 Journal 证据；[原始收据闭环](./adaptive-receipts.md) 在上层组合核验，真实收益结论不变。

现有 verify 事件与节点完成的提交边界没有改变。崩溃恢复可能产生重复验收事件，本入口拒绝该歧义，不通过“取最后一条”补成正式收据。后续受信 runner 需明确处理该边界。

[策略臂核验](./adaptive-arm-evidence.md) 已继续绑定固定组件、原始决策和三臂选择，并已通过 [Run 槽位](./adaptive-run-slots.md) 接入 Journal 预派发绑定。当前任务核验不因调用者提供了一个合法 frozen 对象而证明预派发注册或来源可信。

## 验证

`tests/integration/verification-evidence.test.ts` 使用真实 SQLite 和本地 worker，覆盖清理重开、负结果、正文篡改、采集失败、大小界限、旧 pipeline/test-runner、跨 Run 移用、重复事件、执行输出/结案冲突、显式裁判钉住及当前权限/终态要求。

`tests/integration/adaptive-run-task.test.ts` 覆盖冻结输入的实际派发、清理重开、同统计结果但不同内容、裁判字节替换、负验收、未执行缺测、所有 Attempt 输入、嵌套 UTF-8 目录、额外空目录、路径冲突及超额。测试仍只使用本地 worker，不运行真实模型效果实验。
