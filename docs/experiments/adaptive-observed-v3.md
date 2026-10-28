# 真实三臂观测协议 v3：冻结测量的时间延续

2026-10-28。用户要求继续直至完整三臂测量。[v2](./adaptive-observed-v2.md) 因真实服务吞吐慢于 fixture，在 60 分钟截止时封闭；此修订只为执行尚未开始的槽位，不重新搜索或改变已见结果。

## v2 的实际停止状态

从干净提交 `fced4ff` 运行，登记清单摘要 `51e8fd6b478dec787f61ad2548437022fcae5076dfb2af19bf30282112daba2b`。完成 **517/830 Run、477 次生成尝试**，截止时 1 次模型调用的用量未知；原始记录、占用和全部计划分母保留。所有 40 个来源和 40 次搜索都已完成，示例配置未通过开发改善门，冻结为 `prespecified-fixed-demo-ablation`。

保留[完整报告](./results/adaptive-observed-v2-stopped/report.json)、[摘要](./results/adaptive-observed-v2-stopped/summary.json)、[清单](./results/adaptive-observed-v2-stopped/manifest.json)。当前代码复算 v2 报告逐字段一致。后续安装的只读资料围栏发生在进程已结束后，没有影响这轮结果，停止原因仍是原 60 分钟截止。

## 延续合同

1. 新实验 ID、新目录和新登记，复制已关闭的父实例及内容寻址证据；不修改父账本。继承 517 张已封闭原始收据，包括那次未知调用，**只执行剩余 313 个未开始槽位**。
2. 父清单、报告、配置和选择分别以 SHA-256 固定。除了协议 ID、实现提交和明确的父记录引用，新清单必须与父清单完全一致；模型、请求模板、示例、任务、裁判、seed、顺序、重复次数、选择器及所有调用/token 上限都不得改变。父轮开发必须已完整核验，选择已经冻结。
3. 新段增加最多 **60 分钟**执行时间。该时限修订发生在看到部分观测之后，明确作为观测性时间修订记录；不冒充原轮在 60 分钟内完成或独立预注册收益。
4. 父轮 477 次预留计入后续额度，未知调用不退还、不重发。最终目标仍是 790 次本轮生成尝试，连同准备共 **793 次**，不增加 800 次调用上限。
5. 父记录仍按 v2 核验，后续同样从原始服务正文核验身份、计数和用量。新段发生未知或超限仍停止；不对已开始槽位自动重试。
6. 三次臂若跨越延续暂停，延迟报告使用原定义的 Run 主动执行时长之和，明确排除操作者暂停；分段和累计主动时间另列，不将其解释为连续端到端墙钟。

## 完成与证据资格

`dispatchComplete=true` 仅表示全部 830 个计划 Run 已尝试并有封闭记录；`engineering=passed` 还要求全部调用计量完整。父轮历史未知调用永久保留，因此它可能在调度完成后仍是 `engineering=incomplete`、`unknownUsageCalls=1`。所有质量分母完整，缺测/未知不算成功，不补考。

`benefit=inconclusive`、`originalProtocolEligible=false`、`formalEvaluation=not_run`、`adoption=not_run` 保持不变。既有 v1/v2 停止报告不能因延续而被改写；不领用原正式验证集、不修改 activeGenome、不执行晋升。

```bash
env PATH="/opt/homebrew/bin:$PATH" /opt/homebrew/bin/node \
  tests/experiments/run-observed.ts --real --output NEW_DIRECTORY \
  --claude-settings /path/to/explicit/settings.json \
  --continue-frozen-round SEALED_V2_DIRECTORY
```

入口只允许已封闭、选择已冻结的 v2 父轮；拒绝改变测量参数、重置开发或复用在途 Run。原始未知和全部开销跨段累计。九个定向测试覆盖完整延续、父报告不变、参数变更拒绝、历史未知保留、不重发及离线复算；全量 426 passed / 5 skipped。
