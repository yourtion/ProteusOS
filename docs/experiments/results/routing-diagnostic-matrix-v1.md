# 八条件真实矩阵：服务过载停止

2026-10-28。从干净 `2e198f0` 执行。142/160 Run 已封闭，141 份服务结果；最后一次请求约 6 秒后返回 HTTP 500 overloaded_error，用量未知，不是 token 或时间截止。按原协议停止，18 个未开始槽位未执行，未知不重发。

| 条件 | 完成/计划 | 成功/完整计划 | 已完成的结束原因 |
| --- | --- | --- | --- |
| v1-t256-d0 | 18/20 | 12/20 | {'end_turn': 12, 'max_tokens': 6} |
| v1-t256-d2 | 18/20 | 0/20 | {'end_turn': 9, 'max_tokens': 8, 'unavailable': 1} |
| v2-t256-d0 | 17/20 | 14/20 | {'end_turn': 14, 'max_tokens': 3} |
| v2-t256-d2 | 17/20 | 17/20 | {'end_turn': 17} |
| v1-t512-d0 | 18/20 | 18/20 | {'end_turn': 18} |
| v1-t512-d2 | 18/20 | 1/20 | {'end_turn': 14, 'max_tokens': 4} |
| v2-t512-d0 | 18/20 | 18/20 | {'end_turn': 18} |
| v2-t512-d2 | 18/20 | 17/20 | {'end_turn': 17, 'max_tokens': 1} |

以上成功分母包括未完成槽位，不把部分完成率当最终成功率。`engineering=incomplete`、`selected=null`、`confirmationPassed=false`，没有合格筛选配置。当前已完成部分显示 512 无示例更少达到额度上限，新布局双示例也有改善，但原矩阵没有通过。

142 次生成尝试、142 次计数预检；已知输入 73,182 / 输出 27,182，未知 1 次。含 O1 历史累计 935 次生成尝试，未知 2 次；不推断服务过载是否收费。active 未改，正式 Evaluation / adoption 均未运行。

[执行摘要](./routing-diagnostic-matrix-v1/summary.json)、[完整报告](./routing-diagnostic-matrix-v1/report.json)、[冻结清单](./routing-diagnostic-matrix-v1/manifest.json)、[事后配对分析](./routing-diagnostic-matrix-v1/analysis.json)、[原始证据包](../archives.json)、[归档校验](./routing-diagnostic-matrix-v1/archive.json)均保留。新代码复算停止报告逐字段一致；证据包不包含凭据或工作区。

下一步单独登记 [O2-R1 固定 512/256 对照](../fixed-output-v1.md)，不冒充原 O2-03 通过。最多 120 次新调用，开发累计不超过 262/280；原矩阵和未知占用保留。
