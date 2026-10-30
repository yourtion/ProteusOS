# 候选基线新资料可靠性真实观测

2026-10-29。按 [预登记协议](../reliability-observation-v1.md)，从干净提交 `69925748fddfa3690117ce6777a2262959aa1c32` 直接复用上轮封存的 v2 /1024 /零示例候选快照。20 个新合成任务 ×3 次重复，60/60 已完成、验收成功和合法 JSON 均 60/60，24 个关键槽位全部通过，误派、截断和新增未知均为 0；`reliabilityPassed=true`。

10 个场景家族各 6/6，两个目标能力各覆盖 30 次。场景涉及 UTF-8 字节与词法、空文件与换行、测试路径优先级、扩展名与目录冲突、重复/删除条目和字面路径等；完整资料和场景依据见 [冻结任务](../../../src/app/experiment/reliability-cases.json)与[设计记录](../reliability-case-design-v1.json)。这些标记表达不同测试场景，不声称独立语义分布：任务仍以两种能力、合成输入和开发方可见资料为范围，独立收益 `inconclusive`。

本轮 60 次生成与 60 次预检，实际已知 **32,136 input /16,134 output tokens**；中位 Run 延迟 5.635 秒，p95 15.695 秒，结束原因均 `end_turn`。全链累计 **1475 次生成尝试**、已知 **600,079 input /331,718 output**，历史未知用量 2 次继续保留。价格及执行成本未知，不换算金额；正式 Evaluation 和采用未执行，active 保持原状态。

[执行摘要](./routing-reliability-v1/summary.json)、[冻结清单](./routing-reliability-v1/manifest.json)、[完整报告](./routing-reliability-v1/report.json)、[只读审计](./routing-reliability-v1/independent-audit.json)、[原始证据包](../archives.json)及[归档摘要](./routing-reliability-v1/archive.json)已保存。审计核对 60 个唯一 Run/DecisionCall、请求/响应摘要、额度与候选快照、SQLite 完整性、外键、5248 个 blob 和父轮 842 条事件；解包后报告和审计结果逐字段一致。证据包 SHA-256：`9e15c6856fae743fc8e8521b83721250a5340e424d6f9b2d896eacdd26041420`。

工程验证：20 个冻结任务均通过真实本地 worker 与裁判的无网络 60 槽位演练；34 个定向测试、静态检查及全量 **460 passed /5 skipped**。fixture 不作为真实效果。
