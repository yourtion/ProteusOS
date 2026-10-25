# 编译开发开销到实验单元的映射

M6a-03-02b1，2026-10-25。实现见 [development.ts](../src/app/experiment/development.ts)。它在 [开发证据核验](./compile-evidence.md) 之后冻结任务内容，并把来源决策、来源执行和全部搜索调用映射为 `adaptive-behavior-v1` 的开发收据。

## 使用顺序

1. 调用 `prepareCompileDevelopment(deps, jobId)`，取得 `record` 和 `bundle`。依赖与 `auditCompileEvidence` 相同：kernel、runtime、evolution、storage、blobs、organismId、actorId。
2. 将 `bundle.cases`、`bundle.development`、`bundle.policies` 与已核验的 `bundle.fixed` 放入实验清单；另行冻结正式/回归资料、工具与环境。开发截止点不能早于资料包创建时间。
3. `freezeAdaptivePlan(plan)` 校验全轮预算、split 隔离及对照合同，然后 `bindCompileDevelopment(deps, jobId, frozen)` 生成引用该 manifestDigest 的开发收据。
4. 可将返回的 `observations` 交给 `app.adaptive.register`。当前普通注册不会自动保存 bundleDigest/auditDigest 关联，也不会把正式收据升级为已核验证据。

两个入口均不发送模型请求、不读取 formal/regression 文件、不领用正式验证集、不修改 active，也不创建 Evaluation 或 Promotion。fixture 演练使用相同入口，但不证明真实收益。

## 内容冻结与绑定

编译成员的 `taskDigest` 是旧评估任务指纹，包含输入树、预算和裁判资料；实验 taskDigest 则只覆盖 `{goal,inputs:[{name,content}]}`。两者不能直接替换。首次准备资料包时，先采集 Runtime `inputs/<basename>` 布局下的 UTF-8 内容，再前后核对原编译成员指纹和投影，保存两种摘要的关联。验收 schema 与期望输出只用于私有 evaluatorDigest，不进入任务投影。

目录展开后保留根目录名称与相对路径，文件顺序确定。首轮上限为 4 MiB / 512 文件，拒绝符号链接、特殊文件、空目录、输入根名称冲突和非完整 UTF-8。超过边界时拒绝，不截断或忽略输入。

migration 17 保存每个 CompileJob 唯一的内容寻址资料包。此后重启或删除输入、裁判文件及工作区，都复用原包；仍重新核验底层持久化编译证据和当前权限。摘要漂移或来源记录变化会拒绝，不能重新生成一个包来替换已冻结资料。

绑定须匹配全部 train/search case、family、任务/裁判摘要、基线/获胜策略及已知固定组件。`adapterDigest` 明确取冻结 CompileJob.backend 描述的规范 JSON 摘要；工具、环境、代码 commit、整体 sourceDigest 和资料独立性仍由整轮预注册流程负责。开发单元不能遗漏、追加或换 case，额度可以更保守，不能低于已捕获的预留。

## 计量与不确定性

每个来源决策、Attempt 和编译 Trial 各占一个开发单元。Run、DecisionCall、Attempt、LearningCall 与 Trial 引用各归属一次；共享的请求/响应 blob 保留在全局核验产物中，不因内容相同把不同调用合并，也不在多张收据中重复登记为计量项。

来源决策保留实际模型调用与已知 tokens；搜索沿用持久化完整预留，unknown 不退款，prepared 未发送仍保留其预留。Attempt 单独保留可用用量，不能因缺失执行用量而丢弃其他单元已知的 tokens，也不能将未知费用记零。来源决策单元记录整个来源 Run 的时间，Attempt 另保留自身时长；累计 duration 额度因此保守包含重叠时段，墙钟仍按最早开始至最晚结束计算。

当前执行器证据没有模型调用次数/硬上界，旧来源调用也没有独立 fixture/real 模式证明。包明确标记 `unknownBoundUnits` 与 `sourceModeVerification=unavailable`。未知执行单元的零数值预留只是 fixture 占位，不能证明零开销；**真实模式绑定被拒绝**，即使编译后端声明 real、操作者提高 allowance 或数值质量门通过。后续必须补齐受信来源与执行预算合同才能解除此门。

示例 fixture 的 3 次来源模型调用、3 次本地 Attempt、4 次搜索映射为 10 张收据。已知 7 次模型调用、110 input / 26 output tokens 保留，3 张 Attempt 的模型调用和 tokens 另列 unknown。零改善可冻结全部开发成本，但不能用占位候选启动正式比较。

## 验证与下一项

[集成测试](../tests/integration/compile-development.test.ts) 覆盖完整计量、遗漏/降额、任务/family/策略/组件错配、截止点、输入/裁判漂移、符号链接、删除资料后的重启复算、后端 real 声明不足以及零候选。

下一项是将开发包引用原子绑定到实验记录，然后实现正式 Run 的任务、快照、策略、独立裁判及多次臂选择收据。当前 Journal 的 `evidenceVerification` 仍为 `unverified-host-receipts`，正式效果和采用仍未运行。
