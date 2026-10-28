# 1024 / v2 下的示例增量真实对照

按 [O2-R4 协议](../layout-and-demo-v1.md)，从干净提交 42450cd 完成 120/120 次：固定 v2 请求布局与 1024 输出上限，同一 20 个开发任务 × 3 repeats，对照零示例与两个固定来源示例。两臂当前计量完整，无新增未知；资料为开发方可见，独立收益仍 inconclusive。

| 条件 | 验收成功 | 合法 JSON | 关键失败 | input /output tokens | 中位 /p95 Run 延迟 |
| --- | --- | --- | --- | --- | --- |
| 零示例 | 60/60，100% | 60/60，100% | 0/12 | 26,292 /11,436 | 5.073 /10.050 s |
| 两示例 | 55/60，91.67% | 58/60，96.67% | 0/12 | 43,752 /13,506 | 5.329 /21.786 s |

两示例臂的 5 次失败包括 2 次 max_tokens 无效输出、3 次合法 JSON 弃权。两臂的误派均为 0，均满足各自的预登记质量门；但示例臂成功率低 8.33 个百分点，未达到相对零示例提高至少 5 个百分点的增量门，因此推荐零示例。60 个配对中两者成功 55、仅零示例成功 5、仅两示例成功 0、两者均失败 0。

两个示例使本轮 input 增加 17,460 tokens（约 66.4%）、output 增加 2,070 tokens（约 18.1%），p95 高 11.736 秒。费用及币种未知，不能直接换算金额；结果仅限当前固定示例和开发资料，不推断所有示例均无效。零示例的两个重复阶段均为 60/60，但不将重复视作独立 family。

本阶段 120 次生成、120 次计数预检，已知 70,044 input /24,942 output。含历史累计 1415 次生成尝试，已知 567,943 input /315,584 output，历史未知 2 次继续保留。正式 Evaluation /adoption 未运行，active 不变；这是开发配置建议，不是独立收益确认。

[摘要](./routing-demo-increment-v1/summary.json)、[清单](./routing-demo-increment-v1/manifest.json)、[原始报告](./routing-demo-increment-v1/report.json)、[配对与核验](./routing-demo-increment-v1/analysis.json)、[证据包](./routing-demo-increment-v1/evidence.tar.gz)和[归档摘要](./routing-demo-increment-v1/archive.json)已保存。脚本核对 SQLite、4947 个 blob、120 条收据及父轮 842 条事件；解包后报告逐字段复算一致。完整代码定向 18 个测试及全量 457 passed /5 skipped。
