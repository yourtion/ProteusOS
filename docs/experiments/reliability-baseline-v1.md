# 开发候选基线与失败回归

2026-10-29。候选基线为上一轮已封存的 `v2-t1024-d0`，模型 GLM-5.3-Flash、输出上限 1024、v2 请求格式、零示例；直接使用父轮原快照，摘要 `5b481483aeffbf265e1262cc8267b7d62222d4d0818411a8995c0c9996e7c142`。配置标识见 `experiments/protocols/reliability-baseline.ts`；注册为候选和实验快照，不更改 active，不触发正式采用。真实运行统一 Run 90 秒、决策 85 秒。

## 失败回归证据

- [布局 v1](./results/routing-layout-v1/report.json)：`diagnostic-confirmation-5-1`、第 1 次，达到 1024 上限后空文本，decision=invalid_output；不能当成有效选择。
- [两示例 v2](./results/routing-demo-increment-v1/report.json)：`diagnostic-confirmation-5-1`、第 1 次和 `diagnostic-confirmation-7-1`、第 1 次达到 1024 上限、空文本，均为 invalid_output；另有 `5-0` 第 1/3 次及 `5-1` 第 2 次合法 JSON 弃权，均算验收失败。
- 前轮能力边界例要求按类别列出变更路径并汇总数量，该能力输出本身包含总数；模型把数量误解为另一项统计工作而弃权。合法 JSON 不意味着任务成功；弃权不会自动变成误派或成功。
- 以上实际收据按 case、repeat 和 condition 可从链接报告重算；空响应 SHA-256 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。保持失败原值，分别在空输出、合法弃权和真实 JSON 验收合同中回归验证；不按输出自述推断根因。

旧的 v1 和 v2 请求、词表及能力描述保持版本化。若需要更改词表或能力边界，另建版本并单独验证，不能将事后修改混入本轮可靠性结论。
