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

`src/app/experiment/run-verification.ts` 的 `auditRunVerification` 是应用侧只读入口：

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

## 尚未完成的正式证据

核验输出明确保留 `taskInputVerification: not_verified` 和 `formalEvaluation: not_run`。它尚未证明输入对应冻结实验任务，也没有绑定三臂配置、重复执行的无标签选择器、DecisionCall 及完整成本。Journal 整体仍使用 `unverified-host-receipts`；真实收益结论不变。

现有 verify 事件与节点完成的提交边界没有改变。崩溃恢复可能产生重复验收事件，本入口拒绝该歧义，不通过“取最后一条”补成正式收据。后续受信 runner 需明确处理该边界。

下一切片 M6a-03-02b3b 将利用已保存的实际输出和独立验收正文，绑定冻结任务、策略、快照及三臂选择，再接入 Journal 原始收据核验。

## 验证

`tests/integration/verification-evidence.test.ts` 使用真实 SQLite 和本地 worker，覆盖清理重开、负结果、正文篡改、采集失败、大小界限、旧 pipeline/test-runner、跨 Run 移用、重复事件、执行输出/结案冲突、显式裁判钉住及当前权限/终态要求。
