# Journal 预派发槽位与 Run 绑定

M6a-03-02b3b2 的本轮切片将实验单元连接到实际 Runtime 准入与启动。`app.adaptiveRuns` 在派发前冻结 1/3/1 个槽位，将 Run、任务、预算和槽位绑定原子提交；同一启动许可只能消费一次。当前仅装配 fixture，不解除真实模型或执行器预算门。

## 使用顺序

```ts
const reservation = app.adaptive.prepare(experimentId)!;
const slots = app.adaptiveRuns.bind(experimentId, reservation.id, {
  task: frozenTask, // {goal, inputs:[{name,content}]}，匹配冻结 case
  submission,       // Runtime TaskSubmission，输入/schema/expected 为绝对路径
  snapshots: { base: baseSnapshotId, compiled: compiledSnapshotId },
  backend,
});
app.adaptive.start(experimentId, reservation.id);
for (const slot of slots) {
  const run = app.adaptiveRuns.admit(experimentId, reservation.id, slot.ordinal);
  await app.runtime.executeRun(run.runId);
}
const proof = app.adaptiveRuns.audit(experimentId, reservation.id);
```

示例只表达首次正常执行；Host 恢复后先读取已有 Run/槽位状态。`admit` 返回原 Run 不代表可以再次执行它。不要循环重试 `executeRun` 来恢复已消费的启动许可。

`bind` 只能在 prepared 阶段首次执行。它保存 `adaptive-run-plan-v1` 内容寻址包及全部空槽位；相同合同可幂等读取，不能替换合同或将已开始的宿主收据事后升级。migration 18 新增 `adaptive_run_slots`，Run ID 在全表唯一；原预留 JSON 的可选 `runPlan` 缺项表示旧记录。

包固定任务正文、TaskSubmission、两组快照、后端描述和已核验开发来源的版本 ID。先核对当前个体及版本权限、冻结任务与独立裁判摘要，再复用 [策略臂核验](./adaptive-arm-evidence.md) 校验固定组件。目录内容按路径比较，但保留原冻结文件列表顺序及 taskDigest，不改写旧协议。

首次仅允许每个 Run 一次 Attempt、正整数墙钟额度和有界 UTF-8 输入。私有裁判/期望输出文件不能进入输入投影，文件身份检查也覆盖硬链接。原文件路径留在受控任务包中，不进入模型正文；本轮不将原文件变成不可变文件系统。准入、启动和派发均重查实际资料，最终仍以实际副本摘要与 JSON 验收核验是否匹配冻结内容。

## 原子准入与截止点

Runtime 新增同步的 `admitTask(input, options, bind?)`，只创建 pending/waiting Run，不调用 Provider 或 Executor。受信应用的 bind 回调在同一个准入事务内执行；Run、Task、预算、run.created、槽位 Run ID 与准入事件一起提交或回滚。常规 `submitTask` 继续准入后内联执行，历史任务保持原路径。

`adaptiveRuns.admit` 从冻结包读取提交内容，不接受调用者指定现成 Run ID。重复准入返回原 Run，不生成新任务、不重复占预算。两个连接同时竞争时只有一个能绑定；另一连接可能收到竞争错误，重读同一槽位即可取得原绑定，不重发外部调用。

`SubmitOptions.deadlineAt` 只允许截短 Run 自身截止点。槽位准入将它设为原预留的绝对截止，不因准入耗时、秒数取整或后续等待而延长单元期限。尚未开始、剩余不足一秒的槽位拒绝新准入；预留额度不退款。

下一个槽位只能在前一个已取得启动许可且明确结案后准入。终态 Run 若仍有 prepared/started/unknown 决策调用，或未结 Attempt，也不能继续。已绑定预留未全部明确结案时，`Journal.complete` 拒绝宿主提前封闭；不能通过伪造成功收据领取下一单元。

## 单次启动、取消与恢复

应用装配 Runtime 的同步事务守卫，在准入、启动、决策发送和 worker 派发前检查 Journal。对于已注册的 Journal 实验，裸调用 Runtime 创建实验 Run 会因没有槽位绑定而回滚；旧协议的其他 experimentId 保持原行为。

槽位状态为 `reserved → admitted → started`。启动在第一次 Provider/Executor 调用之前原子消费许可；第二个执行入口即使看到 Run 仍为 pending/running，也不能再取得许可。每个派发点继续核对实验/预留状态、权限、固定组件、实际资料和绝对期限。

启动许可已经提交但 Host 随后崩溃时，不猜测外部调用是否发生，不恢复发送。显式 `Journal.recover` 将 started 单元封为 unknown、停止本轮，并保存已绑定的 Run/DecisionCall/Attempt 引用。取消与到期同样阻止后续派发；未发送的原预留仍不退款。尚未消费启动许可且资料临时漂移时，可恢复原内容后执行第一次启动。

Journal 取消/恢复沿用现有职责边界：Host 负责停止实际执行器，并通过 Runtime 的取消/结案入口处理尚未终态的 Run。Journal 不自行把已经占用的 Runtime 预算标成已释放；未决调用和费用继续保持 unknown。已在途响应可按 Runtime 原合同留证，不能取得新的派发许可。

## 只读证明与剩余边界

`adaptiveRuns.audit` 从已持久化的槽位取得 Run 数组，不接收调用者提供的选择顺序。它核对原子准入事件、唯一启动事件、同一 Journal 流内递增的事件序号、实际 Run 合同及前序结案边界；同毫秒时间不会被当作排序依据。跳过、替换、重复或错绑事件均拒绝。没有启动许可却出现调用/Attempt 也会拒绝。

所有已准入 Run 已终态时，再在同一个读事务复算原 [策略臂证据](./adaptive-arm-evidence.md)。仍在途时保留 incomplete；缺测和缺证沿用原分类。结果为 `adaptive-run-slots-audit-v1`，分别记录 `registrationVerification=persisted-admission-bindings` 和 `orderVerification=persisted-single-start-order`；完整性仍由 status 和逐槽位记录表达。清理原文件和工作区、重开实例后，可以仅凭包、事件和原始验收证据得到相同结果。

该证明尚不等于正式成绩：

- 现有 `Journal.complete` 仍接收严格的宿主收据；只增加全槽位结案守卫，不将其自报 accepted、misrouted 或费用升级为事实。整体 `evidenceVerification` 仍为 unverified-host-receipts。
- 尚未装配独立误派标签及从原始账本生成正式收据的提交入口。
- 原始后端模式、执行器内模型调用次数和 token 硬上界仍不可独立核验，因此 `bind` 拒绝 real 清单。工具环境与完整成本边界沿用策略臂文档。
- 不领用正式验证集、不创建 Evaluation、不晋升 Candidate；真实兼容和独立效果仍未运行。

下一项是独立误派资料及原始收据结案，并补齐可信来源/预算合同，再推进受信 runner 和一次领用的正式 Evaluation。

## 验证

[SQLite 集成测试](../tests/integration/adaptive-run-slots.test.ts) 覆盖三臂、事务插入后崩溃、准入末尾崩溃、双连接竞争、重复准入/启动、越序、同毫秒顺序、unknown 不可提前结案、重启不重发、取消、权限/期限/文件漂移、事件篡改及清理重开。请求用 fixture 替换，worker 使用实际本地执行器；不调用真实模型服务。
