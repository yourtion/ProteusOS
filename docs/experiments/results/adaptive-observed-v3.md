# 完整真实三臂观测：阶段结案

2026-10-28，Asia/Shanghai。**完整调度与证据回放已完成，当前示例策略效果退化，质量门未通过。** 本轮按用户选择的独立观测协议执行，不产生原协议的独立收益或正式采用结论。

## 执行范围与版本

从干净提交 `d0132df269fed9aeb5fffb6bdde3988800fabb42` 执行 [v3 时间延续协议](../adaptive-observed-v3.md)，模型 `GLM-5.3-Flash`，智谱 Anthropic 兼容服务。新实验 ID 为 `obs:8a50bba9-008e-4cc1-afe2-92d2a29512a7`。

父 [v2 停止轮](./adaptive-observed-v2-stopped/summary.json) 在 60 分钟截止，完成 517 Run；本段只执行剩余 313 个未开始槽位。选择、资料、正文格式、模型、额度、顺序和裁判均冻结不变，父轮最后一次用量未知的调用不退款、不重发。额外时间属于看到部分结果后的观测性修订。累计两段主动执行约 94.4 分钟，本段约 34.4 分钟；不把操作者暂停计入 Run 主动执行延迟。

全部 **830/830 Run** 封闭：40 个受约束本地来源、40 次真实开发搜索、750 次真实三臂测量。50 个测量任务 × 3 repeats × 三臂形成 **450 个完整测量单元**。40 formal 任务实际为 10 个模板 family，10 regression 任务为 5 个 family；各 family 变体等权，不能把任务数量当成独立 family 数。资料为开发方可见，语义独立性未核验。

开发搜索成功率为无示例 **70%**、双示例 **5%**，没有合格改进。因此第三臂为预注册的 `prespecified-fixed-demo-ablation`，不是编译器选出的成功策略。该判断在测量前已经冻结。

## 三臂结果

成功须同时满足无标签选择规则和实际 worker 的 JSON 验收。三次臂按包含 null 票的多数票选择，同票取首次，不用期望标签挑选输出。以下分母包含全部计划单元，未补考或删去失败。

| 臂 | formal 成功 | regression 成功 | formal p95 主动延迟 | regression p95 主动延迟 |
| --- | --- | --- | --- | --- |
| 单次基线 | 69/120，57.50% | 19/30，63.33% | 9.232 s | 8.013 s |
| 三次同预算对照 | 72/120，60.00% | 19/30，63.33% | 28.978 s | 25.722 s |
| 固定双示例消融 | 2/120，1.67% | 2/30，6.67% | 12.148 s | 9.257 s |

三次臂使用各 Run 主动时长之和；一次单元跨越延续暂停，暂停不计入该口径。两条基线的 formal 差值为 2.5 个百分点，regression 相同；这些观测不能证明稳定收益。示例臂的 30 个关键回归单元有 **28 个失败、0 个缺测**，不满足质量门。

`dispatchComplete=true`，`qualityGate=false`，`benefit=inconclusive`。由于继承一次历史用量未知，`engineering=incomplete`；不能将完成全部调度写成全部计量通过。`activeUnchanged=true`，没有 Candidate、正式 Evaluation 或 Promotion，`formalEvaluation=not_run`、`adoption=not_run`。

## 用量与费用

本轮 **790 次生成尝试、790 次计数预检**，取得 789 份服务结果，历史未知 1 次。准备阶段另有 3 次生成，总计 **793/800 次**；没有重置预算或自动重试。计数请求单列，不充当生成次数；未知计费项保留，不把缺少价格当成免费。

| 归属 | 生成尝试 | 已知输入 tokens | 已知输出 tokens |
| --- | --- | --- | --- |
| 单次基线测量 | 150 | 48,240 | 32,628 |
| 三次同预算测量 | 450 | 144,399 | 98,397 |
| 示例臂及开发搜索 | 190 | 110,528 | 43,473 |
| 本轮合计 | 790 | 303,167 | 174,498 |
| 准备阶段 | 3 | 878 | 343 |
| 含准备累计 | 793 | 304,045 | 174,841 |

输入/输出是**已知小计**，不包含历史未知调用的未取得用量。币种、价格及 CPU 等费用未核验；报告保留 2,034 个未知成本项目。只有原始约束 trace 核验完整的受信本地 worker 才计零模型调用/token。计数匹配仍不构成模型输入硬上界证明。

## 失败证据与下一轮假设

以下统计仅覆盖 750 个测量 Run，不混入开发或准备。`value` 表示决策有效，不等于三次臂最后选择一定成功。

| 臂 | value | invalid_output | 模型弃权 | timeout | 其中空正文且输出用量 256 |
| --- | --- | --- | --- | --- | --- |
| 单次 | 88 | 62 | 0 | 0 | 58 |
| 三次 | 259 | 190 | 0 | 1 | 173 |
| 双示例 | 4 | 97 | 49 | 0 | 86 |

双示例的真实请求依次是 user 示例、assistant 答案、user 示例、assistant 答案、最后 user「请给出决策 JSON。」；当前 decision-view 只在 system。保存的实际弃权响应称「本次请求未提供任何任务信息」。当前 goal 确实存在于 system，因此应优先验证**当前任务在示例对话后的呈现方式**，不能把模型的自述当成任务正文实际缺失的证明。

另有大量空正文与 256 输出用量同时出现，应单独校准输出额度。当前证据未保存原生服务 `stop_reason`，不能断言这些空输出全部由截断造成。两个[原始诊断例子](./adaptive-observed-v3/diagnostic-examples.json)为事后说明，未经代表性抽样；本轮未因此改参数或追加调用。

补充离线诊断核对了全部失败：349 次 invalid_output 都报告输出 256，其中 317 份空正文、32 份非空非法 JSON；另有 3 份 value 和 1 份 abstain 也用到 256。49 次模型弃权的理由均表示缺少当前任务信息。formal 的单次/三次配对为双方成功 57、仅单次成功 12、仅三次成功 15、双方失败 36。完整分层数据见[诊断补充](./adaptive-observed-v3-diagnosis.json)。这些是事后观测，尚未验证因果。

下一轮细化为 [O2 执行计划](../observed-iteration-plan.md)：先保存服务结束证据，再版本化请求布局；接着用最多 160 次的“布局 × 输出额度 × 示例数”开发矩阵分离两种假设，通过后做最多 120 次冻结确认。只有示例配置通过开发门才进入全规模测量。相比初步的“只在 256 下验证布局”，矩阵能避免额度问题掩盖布局改善；该调整发生在 O2 注册之前，O1 数据、参数与报告判定保持原样。

开发 280 次与后续测量 750 次必须累计为新链 1,030 次预算草案；历史 793 次另列。后续新登记必须明确该全链额度，不能沿用 O1 的 800 次上限并漏记开发成本。O2 仍未实现或派发。

本阶段停止新增模型调用，先保留可审计负结果。它表明当前模型、布局、额度与固定示例组合没有收益，不能外推为 DSPy 或任务内适应方法普遍无效。

## 可复核证据

- [执行摘要](./adaptive-observed-v3/summary.json)、[完整报告](./adaptive-observed-v3/report.json)、[冻结清单](./adaptive-observed-v3/manifest.json)、[实现版本](./adaptive-observed-v3/run.json)。
- [独立核验](./adaptive-observed-v3/independent-audit.json)：SQLite 完整性通过、外键违规 0、830 个唯一 Run/DecisionCall、450 个完整单元、2,425 个 blob 的 SHA-256 全部匹配。从原始收据独立重建全部 450 个单元的选择、成功与延迟，再复算三臂成功率，均一致。
- [原始证据包](./adaptive-observed-v3/evidence.tar.gz)与[归档校验](./adaptive-observed-v3/archive.json)：仅含封闭数据库、内容寻址 blob 和公开实验文件；不包含凭据、工作区或任务资料目录。解压到新目录后的完整报告及独立核验逐字段一致；父轮 3,462 条观测事件与原父实例逐条相同。
- 代码验证：运行前定向 9/9，lint、format、typecheck 通过；全量 **426 passed / 5 skipped**。跳过项为需另行显式启用的 Agent/Microsandbox 场景。本次实际观测使用真实模型与受约束本地 worker。

清单 SHA-256：`574cf09c7e2018bb9e4a061d6df03236667be8038fd984a993232c62a6ad8d97`。

报告 SHA-256：`5e743b9d6573b55eb58fac5cd4296feb14be7d2dc033096cb8b2e60ef7aadaac`。

证据包 SHA-256：`9b5730c6dc26c81e99d087f5d4fa524158c46ecd69b05a371205ad9a44fa7df3`，2,972,665 bytes。

离线复核不需要凭据或网络；在本项目使用 Node >=26，把证据包解压至一个新目录后执行：

```bash
python3 /absolute/replay-directory/audit.py /absolute/replay-directory
env PATH="/opt/homebrew/bin:$PATH" /opt/homebrew/bin/node \
  tests/experiments/run-observed.ts --report /absolute/replay-directory
```

这些命令只复算既有收据，不派发新模型调用。归档不依赖 `/private/tmp` 原目录长期存活。
