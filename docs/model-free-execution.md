# 受约束本地执行与模型用量

2026-10-28。M6a-03-03 的首个前置切片；真实轮仍须另有模型侧预算和资料合同。

`ModelFreeProcessExecutor` 和 `ModelFreeNodeSandbox` 显式使用 Node >=26 的权限模式执行受信 JavaScript worker：仅可读入口及该次工作区、仅可写工作区，网络、子进程、Worker、FFI/WASI 均未授权，不继承宿主环境变量（macOS 可自行注入 locale 元数据）。进程超时终止；本地进程成本仍未知。此约束适用于仓库受信 worker，不作为抵御恶意代码的系统沙箱；`isolated=false` 不变，外部能力仍须真隔离。

宿主记录 Node 版本、入口内容摘要、约束类型，在原始 trace 内写入同一约束的摘要，并随 Attempt 保存。复算须核验 trace 内容、约束事件及零 input/output 用量，才能将该 Attempt 的模型调用及 tokens 记为零。旧进程、ACP/pi、未报告约束、trace 丢失/篡改的记录不能升级为零开销。开发来源、正式三臂和未结单元使用同一核验函数。

此切片不解除真实绑定拒绝门：来源模式证明、模型输入/输出约束、正式资料与 Evaluation 桥接仍需分别完成。默认执行器保持原行为，只有实验显式装配才启用约束。

验证：`tests/integration/model-free-execution.test.ts` 实际执行权限反例、正常统计 worker、持久化/清理重开及 trace 篡改反例；同时回归既有执行证据和收据集成测试。
