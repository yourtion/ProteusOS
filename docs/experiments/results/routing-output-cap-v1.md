# 输出上限 1024 / 2048：真实开发对照结案

2026-10-28。**1024 已通过本轮预登记质量门，推荐作为后续开发实验基线；2048 未显示额外成功收益。** 两臂各完成 60 次，JSON 均 100%、关键任务全过、零截断、无新增未知。1024 成功 60/60，2048 成功 59/60。

从干净提交 `0647295e8c93f1d24c6c387876f8350e39f49c83` 按 [O2-R2 协议](../output-cap-v1.md)运行。复用父轮冻结的 20 个开发任务、10 个模板 family ×2 变体、3 repeats，固定 GLM-5.3-Flash、旧 v1 布局、零示例与组件；两臂统一 Run 90 秒 /决策 85 秒。全部 120 份请求与父轮对应请求除 max_tokens 外一致，只发送合成路由目标、虚构文件名/字节数和固定能力描述，不包含正文、标签或源码。

## 完整结果

| 输出上限 | 真实 worker 验收 | 合法 JSON | 关键失败 /误派 | 达上限结束 | 已知 input /output tokens | 中位 Run 延迟 | p95 Run 延迟 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1024 | 60/60，100% | 60/60，100% | 0/12 /0 | 0 | 18,876 /16,177 | 6.073 s | 13.132 s |
| 2048 | 59/60，98.33% | 60/60，100% | 0/12 /0 | 0 | 18,876 /15,553 | 5.986 s | 15.338 s |

两臂全部 60 次均为服务自然结束 `end_turn`。1024 实际输出中位数 218.5、最大 974 tokens；2048 中位数 210.5、最大 1074。较高上限并未必然消费更多，本轮 2048 输出比 1024 少 624（3.86%），p95 多 2.206 秒。费用/币种未核验，不能据此宣称任一配置确定更省钱或普遍更快。

60 个同任务/同 repeat 配对：两者成功 59、仅 1024 成功 1、仅 2048 成功 0、两者失败 0。1024 每个 family 均为 6/6；2048 在 family 5 为 5/6，其余 6/6。重复和资料变体不当作独立 family，不给出独立统计收益结论。

唯一失败为 `diagnostic-confirmation-5-0` 第 3 repeat 的 2048 条件：服务 30.071 秒自然返回、1074 output tokens、合法 JSON 弃权。模型将“逐条分类并汇总文件数量”解读为需要两种能力，同时认为两个 false 意图特征与目标不符。原始能力实际上可输出清单与总数，因此按失败计入；它不是截断、超时或服务错误，不重试、不删除。

## 判定与范围

两臂均满足 JSON ≥95%、实际成功 ≥90%、误派 ≤5%、关键任务零失败，且当前计量完整；`qualityGates` 两项 true。按事前的“达门时优先较小上限”规则，`developmentRecommendation=v1-t1024-d0`。这是满足当前开发门槛的配置建议，未证明 1024 在所有任务规模下都足够，也未证明 2048 必然导致弃权。

`dispatchComplete=true`、`engineering=passed`（当前阶段）、`unknownUsageCalls=0`，服务 5xx 容错未使用。旧确认逻辑不套用到本轮：`confirmationPassed=false`、`selected=null`，不能将它写成原矩阵筛选/编译收益确认通过。开发方可见资料已见，按用户确认保留 `benefit=inconclusive`、semanticIndependence=unverified、inputHardBound=unverified。正式 Evaluation /adoption 均 not_run，activeGenome 不变。

历史 [512/256](./routing-fixed-output-v1.md)的 512 为 56/60、4 次 max_tokens 失败，仅作历史参考。本轮统一时间窗由原 30/28 秒改为 90/85 秒，不把跨轮差异全部归因于 cap；本次没有重跑 512。

## 成本、原始证据与复算

本轮 120 次生成、120 次同正文计数，已知 **37,752 input /31,730 output tokens**，约 15 分钟完成。O2 实际开发累计 **382 次**，包括原矩阵失败的 142 次与 R1 的 120 次；原 18 个未派发槽位没有补跑。含 O1/准备累计 **1175 次生成尝试**，已知 **452,731 input /262,373 output**，历史未知 **2 次**继续单列，未返还额度或补零。

[执行摘要](./routing-output-cap-v1/summary.json)、[冻结清单](./routing-output-cap-v1/manifest.json)、[完整报告](./routing-output-cap-v1/report.json)、[配对与失败分析](./routing-output-cap-v1/analysis.json)、[独立脚本核验](./routing-output-cap-v1/independent-audit.json)、[请求发送范围核对](./routing-output-cap-v1/preflight-egress.json)、[原始证据包](../archives.json)、[归档摘要](./routing-output-cap-v1/archive.json)均保存。

独立脚本核对 120 个唯一 Run /DecisionCall、原始请求/响应摘要、每臂实际额度、冻结输入/裁判、完整分母及累计成本；SQLite integrity /外键通过，**3983 个 blob** SHA-256 全部匹配，父轮 **842 条事件**逐条不变。清理重开和证据包解压后，报告及独立核验逐字段一致。这里的独立脚本核验不代表独立保管资料或独立效果验证。

代码验证：17 个定向用例、120 槽位 fixture 演练、lint /format /typecheck，及全量 **456 passed /5 skipped**。fixture 不作为真实效果证据。

报告 SHA-256：`9aeaae7ff5b769743c1e63207a9e165ef61532e55d885a8544d83a1d8b6e16b2`。

证据包 SHA-256：`f97c57a73c67271bb529abbee6cc983fe05a3c9c6e11f0f343b2329d5006f058`，4,358,574 bytes。包仅含封闭数据库、内容 blobs 和报告/核验文件，不含凭据、可变资料目录或工作区。

离线复算无需凭据、网络或新调用：解压到新目录后，用 Node >=26 执行 `tests/experiments/run-diagnostic.ts --report /absolute/replay-directory`；用 Python 执行包中 `audit.py /absolute/replay-directory /absolute/sealed-parent-directory` 可同时核对父轮成本和事件。

## 后续顺序

1. 将 1024 固定为下一开发轮基线，保持本轮、历史快照与 active 不变。先单独比较 v1/v2 当前任务布局，再在固定布局下检验示例增量；每段先登记新资料、预算、误差策略与全分母。
2. 把本轮弃权保存为回归诊断样本，核对公开特征词表和能力边界描述。词表/能力描述若修改，必须另建版本、独立验证，不与额度或布局改动混为一个效果结论。
3. 基础接口与示例增量达门后，再登记更新配置的完整三臂真实观测。原失败矩阵不追认通过，现阶段不扩展 M6b/M6c、不自动采用。
