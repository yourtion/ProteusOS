# 编译到三臂证据闭环：阶段验收结果

2026-10-28（Asia/Shanghai），从干净提交 `167b67aeba66cc42c393d7d5cd782371b96a76f7` 独立运行验证命令。完整数据见 [机器可读摘要](./adaptive-stage-v1.json)，实现合同见 [原始收据闭环](../../adaptive-receipts.md)。

本次验证的对象是工程闭环：编译作业 → 原始开发来源绑定 → 冻结路由标签 → 预派发槽位 → 三臂实际本地执行 → 原始收据结案 → 清理重开复算。决策行为由公开脚本 fixture 控制，本地 worker 实际执行；没有真实模型请求。这些数字验证效果测量、对照和停止机制，不证明模型泛化或真实收益。

## 场景结果

每个完整场景包含 3 个开发来源 Run、4 次编译搜索调用、2 个 formal / 2 个 regression family、3 次重复，共 36 个三臂单元和 60 次正式/回归脚本决策。路由标签在首个 Run 计划前冻结，选择器不读取标签。

| 场景 | formal：single / 同预算 / compiled | compiled regression | 数值质量门 | 结论 |
| --- | --- | --- | --- | --- |
| 改善脚本 | 0% / 0% / 100% | 100% | 通过 | 能识别预设改善，保留完整三臂和开发成本 |
| 无改善脚本 | 100% / 100% / 100% | 100% | 不通过 | 基线已好时，不把“全对”当作编译改善 |
| 回归退化脚本 | 0% / 0% / 100% | 0% | 不通过 | 6 个关键回归失败阻止采用，即使 formal 全对 |
| 中断脚本 | 不完整，保留全部计划分母 | 缺测 | 不通过 | 第 8 个 Run 派发前中断，停止且不重发 |

前三个场景工程验收 passed，全部单元的证据分类为 persisted-development-and-runtime-records。中断场景为 incomplete / partial-persisted-runtime-records：4 张已结案原始收据、1 个 unknown 单元、31 个缺测单元。p95 在完整样本不足时保持 null。

## 开销和故障验证

完整场景各保留 60 次已知正式/回归决策、1,200 input / 300 output tokens；开发侧另有 7 次已知决策/搜索调用、110 input / 26 output tokens。这些 tokens 是 fixture 注入的用量字段，用于验证计量，不是实际模型消耗。正式执行的 60 个 Attempt 和开发来源的 3 个 Attempt，其内部模型调用/用量仍为未知，不记作免费。

改善场景的 formal p95：single 126 ms、同预算 370 ms、compiled 126 ms。这是本机 fixture 的实测延迟，不能外推为真实模型性能。

中断场景实际已发送 7 次决策。首次端到端验证发现报告只保留已结案单元的 6 次，修复后额外 1 次未结单元调用及其 Attempt 也被纳入：runtimeResources 保留 7 次、140 input / 35 output tokens；unsettledResources 单列已知 1 次及其未知执行用量。所有预留继续保留，不以中断隐藏成本或退还额度。

四场景均通过以下验收：

- 实际发送数与报告已知决策数一致，失败和未选中的 Run 不遗漏。
- 再次调用运行器不会补跑已完成或已封闭的任务。
- 模型正文不包含冻结路由标签、独立期望输出路径或 family 标记。
- 删除原开发/正式资料及工作区、重开实例，报告逐字段完全一致。
- activeGenome 不变，正式验证集 usageCount 始终为 0。

## 复现与证据

```bash
env -u PROTEUS_E2E -u PROTEUS_SANDBOX PATH="/opt/homebrew/bin:$PATH" \
  /opt/homebrew/bin/node tests/experiments/validate-adaptive-stage.ts
```

命令创建新目录并打印路径；每个场景保存 SQLite 实例、内容寻址原始证据、manifest.json 和 report.json，根目录保存 summary.json。本次本机证据目录为 `/var/folders/t4/c013c4kx2mx55szjf79wy7v40000gn/T/proteus-adaptive-stage-cPQfPt`；机器可读摘要保存每份报告的 SHA-256 和实例位置。临时目录可能被系统清理，可重新执行命令生成新一轮证据。

阶段代码同时通过 lint、format、typecheck 和 67 个测试文件：413 passed / 5 skipped。跳过项仍为显式启用的真实 Agent / Microsandbox 测试。

## 下一阶段门

本轮 realModel=not_run、benefit=not_evaluated、adoption=not_run；没有创建正式 Evaluation 或晋升 Candidate。

下一步进入 M6a-03-03 的真实运行前置：提供可核验的模型输入/输出和执行器内部调用硬上界，独立证明来源模式及资料保管，再冻结至少 40 formal / 10 regression family 和完整预算。现有真实绑定拒绝门保持有效；不能因本轮工程通过就直接开展未受限的真实调用，或将 fixture 的 100% 当作真实收益。
