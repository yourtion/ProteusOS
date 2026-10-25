# 策略臂与选择器的只读核验

本切片完成 M6a-03-02b3b2 的策略臂、原始决策与选择器部分。`auditAdaptiveArm(deps, input)` 在同一数据库事务中读取固定组件、Run、DecisionCall、Attempt 及 JSON 验收，复算一个 formal/regression 单元。它不派发调用、不创建正式 Evaluation，也不修改 activeGenome。

## 输入与范围

依赖与 [Run 核验](./verification-evidence.md) 相同：kernel、storage、blobs、organismId、actorId。输入包括：

- `frozen`、`unitId`、白名单 `task` 投影，均须匹配冻结清单；开发单元不能使用此入口。
- `snapshots: {base, compiled}`：基线和候选的精确快照 ID。
- `backend`：与编译后端记录相同形状的 `{mode,version,provider,adapter,serviceId}`，规范 JSON 摘要必须匹配 `fixed.adapterDigest`。
- `runIds`：single/compiled 为 1 个槽位，budget-matched 为 3 个槽位；缺测在原槽位保留 null，不能缩短数组、重复 Run 或移除失败后补选。

宿主可将上述冻结内容和槽位列表保存为内容寻址 blob，清理工作区后重新读取同一份输入复算。此入口本身只读，不会把输入登记到 Journal。

## 固定组件与原始证据

两组快照须在冻结前创建，绑定只能在 routing-policy 不同。每个版本检查当前读取权限及内容摘要。基线和候选摘要匹配清单；候选必须是合法 `llm-choice-demos-v1`，其中冻结的基线、模型、指令、采样、响应 schema 和 decision-view 与基线精确匹配。图、视图和生效裁判也须匹配冻结摘要；显式钉住的裁判不能替换版本。

首轮只接受一个 choice、一个从 choice 取执行器的 execute、一个验收该 execute 的 verify。新增决策或执行节点不能隐藏在原预算里。所有非策略快照绑定相同，也包含能力版本；这只证明两臂工具绑定相同，尚不证明外部环境或清单 toolsDigest 的来源。

每个 Run 复用冻结任务及 JSON 验收核验，再检查唯一 DecisionCall 的 Run/节点/快照/策略/视图/Provider 归属。请求视图由冻结文件名称和 UTF-8 字节数重建，不读取原文件或裁判资料。新增纯函数 `buildDecisionViewFromInputs` 与 Runtime 的文件路径入口共用同一视图装配逻辑。

原请求的 problem、options、context、view 必须完全一致；编译策略还核对保存的 prepared 正文及 viewSource。调用来源核对 Adapter、端点、请求模型、采样、提示摘要及响应 schema 摘要。基线沿用旧请求布局和提示摘要算法，编译策略沿用示例请求算法，不改写历史请求。

原始响应摘要、value/abstain/invalid_output/transport_error 等终态和成功选择事件必须一致。完整 value 响应还核对来源；标准 raw choice 继续严格解析，不从 Markdown 或解释中提取。模型弃权与已知服务拒绝分别保留；超时、取消和 unknown 不借迟到正文变成成功。非 value 决策不能关联执行 Attempt。

value 还须对应实际执行器。全部 Attempt 的输入证据继续核验，可用轨迹须通过摘要检查；不能只留下被选中 Run 的执行证据。

## 选择器不使用验收分数

每个槽位根据决策与 worker 状态形成 choice：合法 value 且 worker 成功时使用该选项；worker 失败、决策失败、弃权或缺测时使用 null。**独立 JSON 裁判的负结果不会把 choice 改成 null**，否则会通过裁判分数间接使用 gold。

选择器使用冻结的 `plurality-first-tie-no-gold-v1`：所有槽位投票，同票取最早出现的 choice；对非 null 的结果取它首次出现的 Run。随后才使用该产物的已核验验收结论。相同选项的首次产物验收失败，即使后续同选项产物通过，也保留首次负结果。

选择器不读取 caller 自报的 accepted、expectedChoice 或 preferredRunId。已知倒排或并发时序会拒绝，但 `orderVerification` 仍为 not_verified：同毫秒时间和调用者提供的槽位顺序，不能证明它们在派发前已登记。后续 Journal 需冻结真实的槽位、Run 身份及单次派发顺序。

## 全开销与未核验项

结果使用 `adaptive-arm-audit-v1`，范围为 `recorded-policy-choice-and-supplied-order`。`proofs` 保留各槽位的原始 Run 核验；`choices`、选择位置和所选 Run 可离线复算。`selectedAcceptance` 是所选产物的验收事实，不是正式单元 accepted；缺测时即使已有产物通过，单元仍为 incomplete。输入或验收缺证时为 unavailable，完整可复算时才为 verified；坏摘要、冲突或漂移则拒绝。

资源报告逐项列出全部 DecisionCall 与 Attempt，分开保存已知模型调用、tokens、各币种价格依据及未知项。未选中的 Run 和失败调用同样计量。缺失值不会记零，也不会因执行用量未知而丢掉决策调用的已知部分。负数、非整数 token 或不完整用量结构被拒绝。

当前仍有以下限制，因此不能从本结果生成正式收益或采用结论：

- `registrationVerification` 和 `orderVerification` 为 not_verified：尚未绑定 Journal 预留及派发前 Run 槽位。
- `sourceModeVerification` 为 unavailable：后端 mode/version 是冻结声明，不是 Runtime 独立保存的真实来源证明，也未在此核验 CompileJob 来源。
- `environmentVerification` 为 not_verified；`toolsVerification` 仅为 snapshot-equality-only。
- `costVerification` 为 partial：Attempt 尚无完整模型调用次数及硬上界。没有完整预算证明，不用于解除真实运行门。
- 尚未核验独立的误派标签；本结果不直接生成 `AdaptiveObservation`，不会把 selectedAcceptance 直接转成 accepted/misrouted。

Journal 整体仍是 `unverified-host-receipts`，`formalEvaluation` 保持 not_run。下一项是持久化预派发槽位、Run 身份和顺序，并将完整原始收据接入 Journal；之后才推进受信 runner 与独立正式 Evaluation。

## 验证

[集成测试](../tests/integration/adaptive-arm-evidence.test.ts) 使用持久化 SQLite、真实 Adapter 的纯请求逻辑和本地 worker，网络发送由 fixture 替换。覆盖三臂、首次负验收不可跳过、null 投票、模型/服务弃权、非法响应、传输和 worker 失败、缺测、倒排、跨策略臂、组件变化、正文/选择事件/来源漂移、额外调用和清理重开。fixture 不证明真实模型兼容或收益。
