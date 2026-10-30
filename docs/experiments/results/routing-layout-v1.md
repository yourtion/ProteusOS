# 1024 下请求布局真实对照

按 [O2-R3 协议](../layout-and-demo-v1.md)，从干净提交 c1df834 运行 120 次，20 个开发任务 × 3 repeats，旧 v1 与 v2 均为零示例、1024 输出上限。资料为开发方可见，独立收益仍 inconclusive。

| 布局 | 验收 /合法 JSON | 关键失败 | 达输出上限 | input /output tokens | 中位 /p95 Run 延迟 |
| --- | --- | --- | --- | --- | --- |
| v1 | 59/60，98.33% | 0/12 | 1 | 18,876 /15,999 | 5.862 /17.074 s |
| v2 | 60/60，100% | 0/12 | 0 | 26,292 /12,270 | 5.154 /12.789 s |

两臂均达预登记质量门，按预先固定的规则推荐 v2 用于示例增量开发对照。60 个配对中两者成功 59、仅 v2 成功 1；这一例差异不构成独立泛化或因果收益证明。v2 的输入比 v1 增加 7416 tokens，但输出少 3729 tokens；价格未知。

本阶段完成 120/120、当前计量完整，无新增未知，保留历史未知 2 次。累计 1295 次生成尝试、已知 497899 input /290642 output；`benefit=inconclusive`，active 未变，正式 Evaluation /adoption 未运行。

[摘要](./routing-layout-v1/summary.json)、[清单](./routing-layout-v1/manifest.json)、[原始报告](./routing-layout-v1/report.json)、[配对与核验](./routing-layout-v1/analysis.json)、[证据包](../archives.json)和[归档摘要](./routing-layout-v1/archive.json)已保存。独立脚本核对 SQLite、4468 个 blob、120 条收据及父轮 842 条事件，解包后报告逐字段复算一致。完整代码定向 18 个测试及全量 457 passed /5 skipped。
