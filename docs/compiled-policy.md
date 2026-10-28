# 可编译 LLM 策略：示例参数合同

更新：2026-10-24。对应 [执行计划](./execution-plan.md) 的 M6a-01，实验边界见 [adaptive-behavior-v1](./experiments/adaptive-behavior-v1.md)。已实现可版本化内容、有限参数、确定性请求渲染与恢复兼容。M6a-02 的作业、来源核验、有界搜索和 CompileReport 见 [编译执行合同](./policy-compilation.md)；真实模型效果尚未验证。

## 1. 新内容格式与固定部分

`llm-choice-demos-v1` 是 routing-policy 的新内容格式，`schemaVersion=1`。旧 `llm-choice-v1` 保留原内容、解析及网络消息布局；既有快照不升级、不重写。

新内容由 [Decision 合同](../src/decision/llm-demos-policy.ts) 定义，经现有 ArtifactVersion/GenomeSnapshot 保存。它包含：

| 字段 | 含义 |
| --- | --- |
| `fixed.basePolicy` | 基线精确 versionId、contentDigest 及完整 `llm-choice-v1` 内容；本轮只支持现有 Anthropic Messages 服务协议 |
| `fixed.decisionView` | 精确 versionId、contentDigest 及完整视图规则、选项描述、特征词表与大小上限 |
| `fixed.options` | 有限、唯一、有序的选项 ID，必须有冻结描述 |
| `fixed.responseSchemaDigest` | 现有严格 choice/abstain 响应合同摘要，不能另加输出字段 |
| `pool` | 冻结的示例池及规范 JSON 摘要，包括示例内容与受控来源记录 |
| `parameters.demoIds` | 从池中选择的示例 ID，数组顺序就是实际提示顺序 |

基线内容与视图内容必须匹配各自摘要，池也必须匹配摘要。新格式严格拒绝额外字段；模型、指令模板、采样、视图、选项/描述、schema、池与来源记录都不属于本轮优化参数。未来工具、执行图、裁判和环境仍由实验清单与快照固定。

`createLlmDemosPolicy` 从已选定基线、视图与池构造初始产物；`withLlmDemoParameters` 只接收新的示例 ID 数组。`assertLlmDemoParametersOnly` 对两个完整策略复核，拒绝任何固定部分或池变更。后续 learner 在产生候选前必须调用这一复核，不能只检查两个自洽但不同的策略都能解析。

构造器校验内容自洽，不授予修改/采用权限，也不证明来源声明真实。生产者须从获授权的 ArtifactVersion 读取精确内容，并把基线及视图版本纳入新版本 dependencies；父版本保留原基线/候选谱系。已有版本闭包、读取权限、撤权、评估和 operator Promotion 规则继续生效。当前集成验收实际注册了这组依赖与评估快照，不改变 activeGenome。

## 2. 示例及来源

每条示例只有 `id`、严格的 `decision-view-v1`、规范化 choice/abstain 响应和 `source`。view 只含 goal、公开选项描述、输入清单及词法特征；features 必须由同一冻结词表对 goal 重算得到，描述与选项顺序也必须一致。输入清单不含文件正文。

来源必须声明 `purpose=development`、`split=train`、`permission=synthetic|permitted`，以及 dataset/case/family、Run/DecisionCall、verificationRef 和 view/response 摘要。search/formal/regression 均不能直接作为示例来源。响应 value 必须属于冻结选项；弃权理由非空且不超过 512 字符，不允许 confidence 或解释等额外字段。

来源中的 `verificationRef` 指向后续 learner 要读取的独立验收证据。这个切片只验证字段/用途和内容摘要，不从存储提取或核验 teacher 成绩；M6a-02 的 `registerCase` 已核对原始 Run、调用、许可、family 与独立标注及完整验收；具体边界见编译执行合同。不能把 `split=train` 的自报或任务最终成功当作每个中间选择正确的证明。

来源记录保留在受控策略产物里，遵循其版本权限。渲染只取被选示例的 view 和规范化 response，不发送示例 ID、dataset/case/family、split、Run/DecisionCall、verificationRef、digest 或未选示例。正式标签与验收资料也不进入模型正文。

边界固定为：池最多 32 条、选中最多 8 条；重复 ID、同一视图换 ID 重复入池、未知选择 ID 都被拒绝。每个视图不超过冻结上限（最高 16 KiB），产物最多 1 MiB，完整模型请求正文最多 64 KiB。空示例参数合法，用于相同基线的零示例对照。所有限制按 UTF-8 字节校验，超限失败，不截断；字节上限不代表 token 硬上限。

## 3. 渲染与调用证据

[请求渲染器](../src/adapters/decision-llm/request.ts) 归 Adapter，不使用 SDK、凭据、时钟或额外存储读取；Decision 只定义策略与通用 prepared 请求合同，Runtime 不依赖服务字段。模型、temperature、max_tokens 和 system 模板来自固定基线。system 保持旧模板的 OPTIONS/VIEW 替换规则；消息数组先按选择顺序添加 `(user=示例 view JSON, assistant=规范响应 JSON)`，最后是原来的 user 消息。空示例时正文与旧基线的相同输入渲染一致。

新请求格式为 `anthropic-choice-demos-request-v1`。它保存完整的 `{model,max_tokens,temperature,system,messages}` 正文；认证头、API key 和代理环境不进入该对象。端点由受信 Adapter 的 call provenance 单独记录，凭据仍由 app 注入。默认端点同时用于 SDK 配置与 provenance，Adapter 保留配置副本，避免来源记录与实际 SDK 端点不同。

DecisionProvider 增加可选同步 `prepareRequest`，返回 `{format,body}`。Runtime 在额度预留和 started 之前调用它，新格式的 request blob 在原字段外增加 `prepared` 和 `viewSource`。requestDigest 覆盖整个 blob，因此包括实际模型正文；viewSource 绑定快照中的视图 versionId/contentDigest。准备失败为 `decision_request_invalid`，不生成调用预留或发送请求。

[LLM Adapter](../src/adapters/decision-llm/index.ts) 发送保存的正文，并将其与固定策略/视图确定性重建的结果比较，发现漂移时失败。新格式的 promptDigest 覆盖规范 JSON `{system,messages}`，包括示例及其顺序；旧格式仍只对原 system 求摘要，保持历史口径。响应解析、服务 refusal 分类、用量缺失、关闭 SDK 重试与取消信号传播保持原规则。

## 4. 恢复与兼容

| 状态 | 行为 |
| --- | --- |
| 新格式 prepared，确认未发送 | 校验 request blob 摘要、策略版本、完整正文、视图来源及 Adapter/端点；沿原 decisionId 和预留首次发送 |
| 正文缺项、另一份自洽 blob 替换原正文、渲染/视图或端点变化 | `decision_request_drift`；拒绝静默重渲染后补发 |
| request blob 丢失或其摘要不匹配 | 保留原有 `decision_request_lost` / `decision_request_drift` 路径 |
| started/unknown 远端调用 | 保留 unknown/waiting，不自动重发、不派发 worker |
| 合法选择或节点/Attempt 已完成 | 使用原记录恢复；不重调模型、不重复 worker |
| 旧 v1 prepared、无新字段 | 原视图与请求恢复，prepareRequest 返回 undefined，继续旧模型请求布局 |

新字段仅在原请求 JSON blob 内，无数据库 schema 迁移。API key 轮换不改变正文或端点，可沿原预留恢复；更换端点/Adapter 不能把旧预留静默迁移到另一服务。

## 5. 验证与后续

定向验收：

```bash
env -u PROTEUS_E2E -u PROTEUS_SANDBOX PATH="/opt/homebrew/bin:$PATH" \
  /opt/homebrew/bin/node node_modules/vitest/vitest.mjs run \
  tests/unit/llm-demos-policy.test.ts tests/contract/llm-demos-adapter.test.ts \
  tests/integration/llm-demos-runtime.test.ts tests/integration/decision-runtime.test.ts
```

- [内容与请求合同](../tests/unit/llm-demos-policy.test.ts)：有限参数、来源隔离、未知/重复示例、schema/特征/摘要漂移、正文界限、零示例与旧请求一致。
- [Adapter 合同](../tests/contract/llm-demos-adapter.test.ts)：以 SDK 替身核对实际提交参数、signal、无重试及来源摘要，非法正文零调用，服务 refusal 与传输失败分离。
- [Runtime 集成](../tests/integration/llm-demos-runtime.test.ts)：真实 SQLite、ArtifactVersion 依赖、快照、本地 worker、完整请求持久化；重启时 prepared 原 ID/额度/正文恢复、unknown 不重发、完成证据不重复执行；旧 v1 快照和缺少新字段可用；正文与端点漂移被拒绝。

这些是工程验证；远端 SDK/服务兼容与真实收益均未运行。M6a-02 已接入受许可经验、有限搜索、持久化累计预算、CompileTrial/CompileReport、唯一候选，以及取消/unknown/零候选路径。正式采用继续要求独立 Evaluation 与 operator Promotion。


## 显式当前任务请求 v2

O2 新增 `llm-choice-demos-v2`（schemaVersion 2）和 `anthropic-choice-demos-request-v2`。仅显式构造时启用，最后 user 消息包含当前 decision-view 和决策 JSON 指令；system 与示例顺序沿旧合同。格式身份属于固定策略，不能作为示例选择参数优化。旧 v1 默认构造、正文、摘要和 prepared 回放不升级。当前尚无 v2 真实效果结论，后续按 [O2 开发对照](./experiments/observed-iteration-plan.md)验证。
