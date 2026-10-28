# 真实三臂观测协议 v2：模型身份核验修订

2026-10-28。继承 [v1](./adaptive-observed-v1.md) 的数据、两组策略、选择门、预注册消融回退、40/10 测量任务、三次重复、1/3/1、时限、资源与 inconclusive 资格。未改动原正式协议。

## 修订原因与历史保留

从干净提交 `8a19919` 开始的 v1 真实轮在完成 40 个本地来源和第 1 次搜索生成后停止。预计数/实际输入同为 320、输出 110；原始服务响应明确报告 `GLM-5.3-Flash`，但新增核验误用了 Runtime 尚未填充的 `DecisionCall.provenance.servedModel=null`。这是观测运行器的实现缺陷，没有发送正式/回归任务。

保留该轮[摘要](./results/adaptive-observed-v1-stopped/summary.json)、[完整报告](./results/adaptive-observed-v1-stopped/report.json)、[冻结清单](./results/adaptive-observed-v1-stopped/manifest.json)及原实例。v1 仍按原核验逻辑复算为 incomplete，新代码已证明报告逐字段一致；不修改旧 Run、收据、调用或终态，不将停止记录改成成功。

首次调用的[计数记录](./results/adaptive-observed-v1-stopped/first-count-event.json)与[原始服务结果](./results/adaptive-observed-v1-stopped/first-service-result.json)已保存并核对摘要。v1 报告的 30 个关键回归失败来自对全部未执行项的保守归类，不代表发生了 30 次实测回归失败；v2 将两者明确分列。

## v2 的变化

- 从已经持久化并核对 SHA-256 的原始服务结果读取模型身份，与冻结模型 ID 比较；缺失或不匹配仍停止。fixture 同样覆盖身份核验，不能因 fixture 模式绕过而遗漏真实缺陷。
- 报告将未执行关键回归列为 criticalMissing，criticalFailures 仅统计已经完成的失败；缺测仍占完整分母，工程 incomplete，数值门不通过。v1 历史口径保留。
- 创建新的实验 ID、目录和冻结清单。显式 `--carry-stopped-round` 只接收已封闭、用量完整且尚未测量的开发停止轮；已见正式/回归数据或未知调用不能通过此入口复用。
- 该次停止轮新增 1 次生成、320 input / 110 output，以及 40 个来源和 1 个搜索 worker 的全部开销加入 setup；原有 2 次兼容调用不重复计费。因而准备共 **3 次生成、878 input / 343 output**，新的 790 次生成计划连同准备为 **793 次**，仍在 800 次额度内。

这不是自动重发旧槽位。新轮开始前提交修复、补充反例、验证 v1 历史复算并冻结包含全部成本的 v2 清单。固定示例、搜索比较和 formal/regression 材料不根据停止轮结果改写。

```bash
env PATH="/opt/homebrew/bin:$PATH" /opt/homebrew/bin/node \
  tests/experiments/run-observed.ts --real --output NEW_DIRECTORY \
  --claude-settings /path/to/explicit/settings.json \
  --carry-stopped-round STOPPED_DEVELOPMENT_DIRECTORY
```

生成预算、真实调用、数值质量、独立收益与采用仍分别报告。即使完整运行且数值改善，独立收益仍为 inconclusive，不创建正式 Evaluation 或执行晋升。
