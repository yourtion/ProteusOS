# 原始收据结案与完整三臂运行

本阶段将编译来源、预派发 Run、无标签选择、冻结路由标签与实际 JSON 验收连成可复算闭环。当前仅开放 fixture 工程验证；真实来源、执行预算硬上界和独立资料门继续保留。

## 预先冻结标签

实验注册后、任何 Run 计划绑定前调用 `app.adaptiveRuns.registerJudgments(experimentId, document)`：

```ts
{
  version: "adaptive-judgments-v1",
  manifestDigest: frozen.digest,
  sourceRef: "资料来源说明",
  cases: [{ caseId, taskDigest, evaluatorDigest, expectedChoice }]
}
```

标签必须完整覆盖 formal/regression，不能包含开发 case、重复项或摘要不匹配项。expectedChoice 为固定选项或 null；首个 Run 计划绑定时检查选项成员关系。引用原子保存在实验记录，相同文档幂等，不能替换或给已开始的实验事后升级。

标签只由应用侧裁判读取，不进入白名单任务、worker 输入或模型正文。这里的“独立”表示独立于 worker 和选择器；fixture 仍由开发方可见，`labelIndependence=not_verified`，不宣称独立 held-out 真实验证。

## 以原始证据结案

`app.adaptive.completeFromRuns(experimentId, reservationId)` 不接受 accepted、misrouted、source 或 usage 参数。它在一个数据库事务中核验冻结标签、预派发槽位、Run/DecisionCall/Attempt、选择器及验收正文，推导 `adaptive-run-receipt-v1` 和观察记录，再一起提交收据引用、观察、单元/实验状态和事件。

选择先按无标签规则完成，之后才比较 expectedChoice，并读取所选产物的验收。误派、弃权、非法响应、传输或 worker 失败可形成明确负结果；首次选中产物验收失败不会换成后续通过者。选中正确路由但验收证据不可用时保留 unknown 并停止。坏摘要和证据冲突直接拒绝。

标签绑定的单元不能再用 complete 导入宿主成绩。旧实验保留原入口及未核验分类，旧宿主收据不能原地升级。重复结案只重读记录，不重跑模型/worker；提交故障整体回滚。

收据保存全部 Run 和计量项引用。原观察 usage 保持旧协议：合计不完整时为 null；新报告另外保留 `evidence.runtimeResources` 的已知部分和未知项，不因 Attempt 用量缺失而抹掉已知决策 tokens。开发开销另列 `evidence.developmentResources`，未选中和失败执行同样计量。

report 每次将已提交收据与原始记录重新核对，支持资料/工作区清理和实例重开；损坏时拒绝，不静默重新生成。所有正式单元均有原始收据时为 persisted-runtime-records；开发来源也绑定时为 persisted-development-and-runtime-records；部分覆盖单列。fixture 的 realModel/benefit 始终为 not_run/not_evaluated。

## 串行运行器

`app.adaptiveRuns.runNext(id, loadCase)` 完成一个单元；`runAll(id, loadCase)` 顺序推进至结束或首个不可恢复错误。loader 按 caseId 返回原 RunSlotPlanInput，不接收标签；新单元先 bind，再取得唯一 start，逐槽位准入/执行，最后调用 completeFromRuns。

不重试已经开始的调用。只有本调用取得 start 后，才会在异常时 recover 封存 unknown 并取消尚未终态的 Run；竞争失败的另一个 Host 无权封闭当前运行者。prepared 可继续首次执行，started 恢复仍不重发。缺测保留完整计划分母。

端到端验收由独立验证脚本和集成测试驱动。工程闭环完成不等于真实模型收益通过；不创建正式 Evaluation、不领用正式验证集、不修改 activeGenome，也不跳过真实预算/资料门。
