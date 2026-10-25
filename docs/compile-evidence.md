# 编译开发证据的只读核验

M6a-03-02a，2026-10-25。入口为 [auditCompileEvidence](../src/app/experiment/compile-evidence.ts)。本切片先核验 [编译作业](./policy-compilation.md) 的开发侧证据，供后续适应实验收据桥接使用。

```ts
import { auditCompileEvidence } from "./src/app/experiment/compile-evidence.ts";

const evidence = auditCompileEvidence({
  kernel: app.kernel,
  runtime: app.runtime,
  evolution: app.evolution,
  storage: app.storage,
  blobs: app.blobs,
  organismId: "organism-default",
  actorId: "principal-local",
}, jobId);
```

函数只接受已封闭的作业，在一致的 SQLite 事务中核验记录和 blob，不持有 Provider，不调用模型、不读取正式标签、不补跑或重新选择候选。权限按当前操作者检查；输出为 `compile-evidence-audit-v1`，包含证据引用、重算报告、候选绑定状态和规范 JSON 摘要。工作区清理和实例重启不影响核验。

## 核验范围

- 清单、基线版本、冻结视图和成员记录的内容摘要，以及当前读取权限。
- 来源 normal Run 的个体、family、快照和决策归属；请求视图、响应正文、已冻结的 Adapter 用量、执行时间与 Attempt 证据。来源 Run 含额外决策调用时拒绝，防止漏掉未纳入原冻结预算的调用。
- 本地确定性执行器的持久化 Attempt 与轨迹摘要；Agent 内部开销不在这个核验合同中。未知执行费用仍保持未知。
- 每个 Trial 的配置序号、case/family、策略版本、示例参数、视图、完整请求正文、Adapter/服务/模型/采样与提示摘要。
- Trial 与学习调用账本一一对应，状态、终止时间、错误和 tokens 一致；孤立、遗漏或重复调用均拒绝。
- 从完整编译响应重算分类、correct、servedModel 和全部用量，不信任 Trial 中已有的评分和费用字段。结果与持久化报告再作比较。
- 有获胜配置时，Candidate 必须绑定原作业、清单、基线、裁判和正式计划元数据，快照只改变 routing-policy，内容等于实际获胜参数；零获胜不能绑定候选。

失败、取消、prepared 未发送、unknown 和零改善作业也可核验。核验只证明记录一致，负结果仍然是负结果，unknown 仍保留原额度和缺失用量。完成作业不能丢失计划调用。来源或正文漂移、账本不一致、轨迹损坏和权限不足均抛错，不返回“已核验”证据。

## 能证明与尚不能证明的事项

`verification=persisted-development-records` 表示本地开发记录相互一致。`declaredMode` 保留受信装配记录的 fixture/real 模式，`remoteExecution=not-independently-verified` 明确不把该模式当成独立远端账单证明。

用量核验细分为：编译侧 `response-and-learning-ledger`，来源侧 `frozen-adapter-ledger`，执行侧 `persisted-local-execution-evidence`。旧 Runtime 的 response blob 通常只有模型 choice 正文，没有服务响应头用量；不能据此声称从原始正文重新提取了来源 tokens 或价格。来源任务内容指纹沿用冻结成员摘要，不重新读取其外部输入文件。语义 family 独立性与材料权限仍须独立资料流程证明。

输出固定 `formalEvaluation=not_run`。本切片尚未把这些来源映射为 [持久化实验账本](./adaptive-journal.md) 的开发单元，也没有正式 Run 的任务/裁判证据桥接、正式集一次领用、受信 runner 或 Evaluation。下一步补齐这些连接后，才能运行独立真实轮；这个核验产物不能用于 Promotion。

## 真实轮的预算可行性

真实协议至少 20 train / 20 search family，40 formal / 10 regression family，各正式 case 三次重复，三臂 1/3/1 次执行。最小正式与回归部分已占 `50×3×5 = 750` 次模型调用，800 次上限只剩 50 次开发调用。

当前编译器至少两组参数，对 20 个 search 成员分别调用，需要 40 次搜索调用。若再把 40 个来源全用模型采集，则全轮至少 `40+40+750 = 830` 次，不能按原协议运行。核验保留这 40 次来源调用，不能删除成本以凑额度。

可行资料方案之一是采用满足现有视图、独立标注和完整验收合同的本地确定性来源：来源模型调用为零，搜索 40 次，加正式/回归 750 次，共 790 次。它仍需核验全部执行开销、数据独立性、token 上界与墙钟。若实际资料必须额外调用模型，须在运行前另行注册合适的新协议，不能就地放宽 `adaptive-behavior-v1`。

## 验证

[集成测试](../tests/integration/compile-evidence.test.ts) 覆盖工作区清理后的重启复算、错误评分/用量/费用、请求/响应/轨迹损坏、来源额外调用、孤立学习调用、unknown、取消、零改善与无权主体。适应协议同时接受 `abstain_origin_unavailable` 分类，避免把来源不明的弃权归为模型主动弃权。

```bash
env -u PROTEUS_E2E -u PROTEUS_SANDBOX PATH="/opt/homebrew/bin:$PATH" \
  /opt/homebrew/bin/node node_modules/vitest/vitest.mjs run \
  tests/integration/compile-evidence.test.ts tests/integration/policy-compiler.test.ts \
  tests/integration/adaptive-journal.test.ts tests/unit/adaptive-experiment.test.ts
```
