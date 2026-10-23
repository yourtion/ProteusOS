# Jev 与可替换 typed decision plane

核验日期：2026-10-10。只采用 TypeSafe 官方文档、官方 API 与其文档直接链接的源码；未把第三方 Jev gateway 的接口视为厂商合同。

**迭代前置应是补全已有 DecisionProvider 替换缝的 Jev 接入与类型化证据，再开始 DSPy 式离线优化。** 当前已存在按名称装配的 provider 注册表与调用账本，缺口是 Jev Adapter、完整概率结果及其受控消费，不需要重建 Kernel。[现有接口](../../src/decision/index.ts)、[装配](../../src/app/instance.ts)、[调用账本](../../src/decision/call.ts)

## 已确认的官方接口

`POST https://api.typesafe.ai/v1/systemone` 使用 Bearer API key。请求包含 `state`、`model`、按名字索引的 `questions`；响应是对应 `answers`、实际 `model` 和 token `usage`。`GET /v1/models` 列出账号可用名称。[API](https://docs.typesafe.ai/api)、[OpenAPI 0.2.0](https://api.typesafe.ai/openapi.json)

| 原语 | 请求与结果 |
| --- | --- |
| Choice | `criteria` 为选项→描述映射，最多 255 项；返回 `choice`、各选项 `probabilities`、`confidence`。[官方说明](https://docs.typesafe.ai/primitives/choice) |
| Score | 有序描述等级；文档要求至少 2、最多 10 级，编号从 0 开始；返回概率加权平均 `score`、`legend`、分布和 confidence，并非任意数值回归。[官方说明](https://docs.typesafe.ai/primitives/score) |
| Noul | yes/no 问题，可附 `true/false` 描述；返回 `noul=P(true)`，没有独立 confidence，也不是已阈值化的 boolean。[官方说明](https://docs.typesafe.ai/primitives/noul) |

Choice/Score 的 confidence 是从分布计算的统计量。Choice 为 `(p_max−1/n)/(1−1/n)`；Noul 可由 host 派生 `|2p−1|`，必须标为 derived。confidence 不能当成另一个独立证据或本地准确率保证，阈值要用自己的任务验证。[计算与使用规则](https://docs.typesafe.ai/confidence)

官方 JavaScript/TypeScript 包为 `@typesafe-ai/sdk`，Node.js 20+；文档链接的源码版本是 **v0.6.0**。支持 `AbortSignal`，默认重试 2 次、单次 timeout 10 秒，没有总重试预算。[SDK](https://docs.typesafe.ai/sdk/javascript)、[版本](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/package.json)、[RetryPolicy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy)、[RequestOptions](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RequestOptions)

## 可固定的部分与学习边界

官方当前版本为 **`jev-1.13.0`**；latest/preview 是会移动的别名，应显式使用版本 ID，保存响应 model。官方明确不提供客户数据 fine-tune/LoRA，所有账号使用相同权重；可在 state、instructions、criteria 中表达领域规则，或用输出训练下游传统模型。[Models](https://docs.typesafe.ai/models)

本项目可冻结 SDK、HTTP/schema 合同、端点、模型 ID、问题、选项顺序、视图、阈值和摘要；凭据只在 host 环境注入。所读资料尚未确认远端权重摘要、历史版本永久可用或逐次确定性承诺，因此仍按 `recorded-inputs-only` 记录。版本 ID 可固定不等于整个服务可重放。[版本说明](https://docs.typesafe.ai/models)、[项目来源合同](../../src/decision/call.ts)

Jev 提供**在线原子推断**；DSPy 优化**程序的调用参数**。Jev 的模型训练与 ProteusOS 离线学习是不同责任：后者可以提出新问题/criteria/阈值与示例候选，但没有依据宣称可训练 Jev 权重或直接接入 DSPy finetune。[DSPy 优化器](https://github.com/stanfordnlp/dspy/blob/main/docs/docs/learn/optimization/optimizers.md)

## 落地顺序（项目建议）

1. **Choice 先端到端**：版本化 Jev policy；接入 provider 注册、受限 decision-view、远端预算、严格校验、账本、取消/恢复与真实双臂评估。保留完整分布、confidence、request/response 摘要和服务模型；静态 SDK 类型不替代响应校验。
2. **分别补 Score / binary / gate 合同**：Score 保留等级语义；binary 保留 Noul 原值，由版本化上下阈值产生 true/false/abstain。gate 在 host 组合预测与确定性条件，不能赋予权限。rank 只能作为 host 派生排序另立合同，不宣称 Jev 原生 rank。
3. **固定执行边界**：首期 `retry.maxRetries=0`，重试由 host 单独记账。低置信度弃权与传输错误/timeout/unknown 分开；服务取消只尽力传播，已发送未知请求不自动重发，迟到证据不覆盖终态。调用权限、累计预算、executor 派发、Evaluation 与 Promotion 仍由 host 控制。[现有运行合同](../runtime.md)

阈值弃权须记录 host-policy 来源，不能标成模型原生弃权；新增类型必须同时覆盖持久化、恢复、验收与报告，不能只增加接口声明。

先用相同视图与固定任务比较规则、LLM、Jev 的误派/弃权、任务成功、延迟和总成本，再决定哪些调用值得离线优化。官方已披露字面理解、数字精度、选项顺序与无关长状态等弱点，不能用类型正确替代任务正确。[已知限制](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

## 尚未确认

本次未使用凭据调用服务，尚未确认当前账号访问、实际返回与限流/成本、中文任务校准收益、版本保留期、服务端取消/幂等与未知请求计费。公开 OpenAPI 的 Score 最少等级为 1，文档/SDK 则为 2；实施前冻结合同并用真实服务核对这一差异，不据此扩张可支持范围。[OpenAPI](https://api.typesafe.ai/openapi.json)、[SDK 类型](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts)
