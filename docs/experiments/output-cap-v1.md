# 输出上限 1024 / 2048 开发对照（O2-R2）

2026-10-28。用户要求直接比较 1024 / 2048，512 仅保留历史参考；并确认先使用开发方可见资料完成真实运行，独立收益结论标为 inconclusive。本协议在看到 [R1 结果](./results/routing-fixed-output-v1.md)后登记，不修改任何历史清单、失败或未知。

## 首次派发前固定

- 新协议 `routing-output-cap-v1`，新目录与 ID，从干净提交运行；父轮必须为已完整封闭且计量通过的 `routing-fixed-output-v1`，父报告重算一致、清单摘要相符。
- 直接复用父清单全部 20 个任务、输入、裁判和标签：10 个模板 family ×2 变体，4 个关键任务；每条件 3 repeats，共 **120 次生成**。这是见过的开发资料，不宣称独立测试或泛化。标签与裁判不进入模型输入。
- 固定 GLM-5.3-Flash、同一 Anthropic 兼容端点、旧 v1 请求布局、零示例、相同组件/采样参数；唯一请求因素是输出上限 **1024 / 2048**，按 seed=20261028 交错派发。不重跑 512，不混入 v2 布局因素。
- 两臂统一 Run **90 秒**、决策及 SDK **85 秒**，SDK 重试 0。时间窗高于历史 R1 的 30/28 秒，因此历史 512 仅作描述性参考，不能把跨轮差异全部归因于额度。
- 输入对完整冻结正文计数预检 ≤2048，再核对实际响应；输入硬上界仍 unverified。新段预留上限：120 次生成、245760 input、184320 output tokens；这不是实际账单。全段派发截止为注册时间加 **185 分钟**（120×90 秒加 300 秒），不足完整窗口不派发。

## 错误处理与判定

沿用 R1 明示规则：最多两个已经发送的 HTTP 500/502/503/504 槽位可封为失败/用量未知，并继续其他既定槽位；不重发、不返还占用、不增加 repeats。第三次停止。计数错误、超时/取消、身份漂移、成功响应缺失用量或结束证据、超限等仍立即停止。已经 started 的未知绝不续发。

每条件以完整 **60 单元**、family 等权报告合法 JSON、真实 worker 验收、误派、关键失败、结束原因、实际 tokens、中位数与 p95 Run 延迟；未完成/服务错误不删除。分别判断 JSON ≥95%、验收 ≥90%、误派 ≤5%、关键任务失败为 0，且当前阶段计量全部完整。存在未知时不推荐配置。

两臂均达门时，预登记推荐满足门槛的较小上限 1024；只有 2048 达门则推荐 2048；均未达门则不推荐。实际 tokens 与延迟仍单列，较高的额度不等于必然消费更多。该规则是开发校准，不以“相对另一臂必须增加 5pp”为前提，不冒充原 O2-03 的确认；`confirmationPassed=false`、`selected=null`，新增 `qualityGates` / `developmentRecommendation` 表达本协议结果。

真实模式 `benefit=inconclusive`、semanticIndependence=unverified；不生成正式 Evaluation、Candidate/Promotion、不切 activeGenome。下一步布局与示例增量另行登记，不因本轮通过就追认旧矩阵或自动进入完整三臂。

## 累计预算与执行

历史含准备 **1055 次生成尝试**、已知 414979 input /230643 output tokens、未知用量 2 次继续保留；本轮最多新增 120 次，累计 **1175 次**。O2 开发实际累计由 262 增至最多 **382 次**，是独立新增预算，不把原 280 次上限暗中放宽，也不消费原矩阵未派发的 18 个槽位。费用/币种和执行成本未知继续单列。

```bash
env PATH="/opt/homebrew/bin:$PATH" /opt/homebrew/bin/node \
  tests/experiments/run-diagnostic.ts --real --output NEW_DIRECTORY \
  --parent SEALED_FIXED_OUTPUT_DIRECTORY --stage output-cap \
  --claude-settings /path/to/explicit/settings.json
```

运行结束封存原始请求、服务结束证据、Run/worker/裁判及累计账本，清理重开与证据包解压后离线复算报告一致。中途只读观察，不修改冻结代码/配置，不对失败补考。
