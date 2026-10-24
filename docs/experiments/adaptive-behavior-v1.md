# 适应行为实验 v1：冻结与离线演练

协议 ID：`adaptive-behavior-v1`，报告合同同名，冻结日期：2026-10-24。与 [organism-decision-v1](./organism-decision-v1.md) 独立，不修改旧实验或 `m3-policy-eval-v1` 的判定。实现见 [冻结与复算合同](../../src/app/experiment/adaptive.ts)。

当前交付为 **P0-04 工程验收**：可冻结清单、隔离用途、预检预算并离线复算；fixture 和本地 worker 演练均不提供真实模型收益证据。编译器、任务内适应、经验库、真实实验 runner 及正式 Evaluation 桥接尚未实现。这个离线模块不会调用服务、创建 Candidate/Evaluation、消费正式验证集或晋升版本。

## 1. 问题、变量与阶段

第一轮只问：**在同一个 route-choice 合同上，只优化示例选择与顺序，能否在未见 family 上提高最终任务质量，并优于增加原配置执行次数？** 主目标固定为质量，不在结果出来后改成成本目标。

冻结模型 ID、Adapter、decision-view、指令、响应 schema、图、裁判、工具权限和环境内容摘要。基线/候选保存不同的策略内容摘要，编译参数仅允许 `demo-selection` 与 `demo-order`。禁止优化裁判、标签、工具权限、输入视图、模型、图或执行器内部提示；不采集隐藏推理。模型远端权重不能固定时仍声明 `recorded-inputs-only`。

| 阶段 | 比较 | 开始条件与边界 |
| --- | --- | --- |
| 编译（本版支持冻结） | 单次原配置、同预算原配置多次执行、编译后单次 | P0 完成；M6a 补齐参数/编译器、计量与真实预检后再执行 |
| 单步任务内适应（规划） | 已冻结有效方案的同预算多次执行，对比基线 → 一个提案 Probe → 组合后实测 | M6a 真实效果门通过；三个独立 Run/快照、相同初始输入、全会话预算，无不可重放副作用 |
| 冻结改进库（规划） | 同一个适应流程，有库与无库 | 前一效果门通过；冻结所读库版本、跨 family 评价，报告负迁移与检索/构库开销 |

后两阶段必须在首次正式调用前另行注册协议版本、数据、预算和主比较。当前解析器只接受 `stage=compile`，不把未实现的阶段或额外比较混进本版结果。

## 2. 数据、可见范围与截止点

首轮只接受合成或明确许可资料，记录 source 类型与材料摘要。每个成员固定 caseId、familyId、split、任务内容摘要、独立裁判资料摘要及 critical 标记。

| split | 真实轮最少独立 family | 用途 |
| --- | --- | --- |
| train | 20 | 许可示例、teacher 轨迹生成；不消费正式标签 |
| search | 20 | 开发选型与有界搜索，允许复用评分但所有调用计量 |
| formal | 40 | 候选及报告算法冻结后的唯一正式比较；首次公开后仅作回归 |
| regression | 10 | 既有能力回归；关键成员标 critical；不增加泛化样本量 |

四个 split 的 family 完全隔离；同模板、输入衍生、改写和成对目标归同一 family，不能换 ID 后跨 split。解析器拒绝 family 跨 split，以及不含 ID/split/标签的任务内容摘要跨 split 相同。摘要去重不能证明语义独立，真实轮仍需独立负责人核对来源与 family。一个 family 可以有多个 case，统计时 family 等权；重复与改写不算新独立样本。

开发截至 `developmentClosedAt`；最终候选、完整配置与全部单元表在 `frozenAt` 冻结，开发截止点不得晚于冻结时间。冻结清单包含代码 commit、seed、模型/组件摘要、数据/裁判摘要、两个策略摘要、比较臂、重复数、选择器、额度与阈值。规范 JSON 的 SHA-256 作为 manifestDigest，之后每张收据引用该摘要。改变任何内容都生成新实验，保留旧证据；不能在正式结果后追加搜索或重选候选。

开发 loader 只请求 train/search；`adaptiveTask` 显式投影为 `{goal, inputs:[{name,content}]}` 并核对摘要，去除根级与输入条目的额外字段。case/family/split、答案、期望输出、验收资料均不随投影进入 learner/worker。Runtime 的受限 decision-view 保持现有规则，标准答案仅交给可信 evaluator，保存在输入目录之外。

这些函数是应用层的数据边界。真实独立验证还需要资料保管权限：`visibility=independent-custodian`，开发方不能读取正式目标/标签；只有公开仓库 fixture 或同一开发方可读资料时使用 `developer-visible`，结果不得宣称独立 held-out 收益。当前公开演练全部属于这一类。

## 3. 三臂、顺序与无标签选择

每个 formal/regression case 每臂固定三次重复，三臂共享任务输入、模型、工具与裁判。

| arm | 计划 | 计费归属 |
| --- | --- | --- |
| `single` | 原配置执行 1 次 | 本次决策和完整执行 |
| `budget-matched` | 原配置执行 3 次，按固定选择器取一个结果 | 三次完整执行，失败也占次数；不得用 gold/验收分数选最好的一次 |
| `compiled` | 冻结候选执行 1 次 | 所有训练、搜索、编译及候选正式/回归执行总开销 |

选择器为 `plurality-first-tie-no-gold-v1`：按规范化选择投票，失败/弃权作为 null 一票；同票取最早出现的选择，再取该选择首次执行的产物。不能先查看正确答案或裁判成绩。样本顺序取冻结 case 数组，按 seed 和重复序号轮转臂顺序；三次重复中每臂各占一次首位，不并发执行。每次使用独立上下文与输入副本，不切换 activeGenome。

同预算比较指相同资源上限，允许某一臂未用满。候选的**全部**开发与评估预留在调用、输入/输出 tokens、累计执行时长上均不得超过 `budget-matched`。编译成本以整轮总额计入，不用假设未来无限复用来摊薄。任何新的模型生成、重试、裁判模型或执行器内调用都须计量；不能只算最后路由调用。

## 4. 预算与停止条件

真实轮冻结的硬上限为：800 次模型调用、1,638,400 input tokens、204,800 output tokens、全轮墙钟 60 分钟。三次/一次的臂调用额度固定；还受现有 Organism、Run、学习预算限制。每个任务执行单元包括完整 worker，时限由其 allowance 明确给定。

一个最小清单例子：20 train + 20 search 开发单元各最多 1 次；40 formal + 10 regression 各 3 次重复，三臂分别 1/3/1 次，共 `40 + 50×3×5 = 790` 次。假设每次最多 2,048 input / 256 output tokens，总预留为 1,617,920 / 202,240 tokens。开发与单次任务 allowance 30 秒、多次臂 90 秒时，累计时长预留为 23,700,000 ms。`budget.durationMs` 表示累计执行时长，`budget.wallClockMs` 表示全轮截止时限，二者独立；达到 60 分钟时停止并保留缺测，不能延时补齐。

在派发前保守预留完整单元上限；冻结时检查所有单元总预留及候选/对照总额。运行时必须持久化已开始的单元和预留，恢复不重置次数。未知调用、超时、取消、非法响应、服务异常不补考，不因缺用量退还额度。尚未开始的计划单元可恢复首次执行，已开始但结果不明的单元保留 unknown。原决策账本的“不自动重发”规则继续适用。

本切片只实现**预检与离线审计**；尚未把新额度装入真实 runner 的事务/调度流程。M6a 在真实运行前必须补齐这一连接，证明输入 token 上界、输出上限及所有执行调用能被宿主/服务约束；不能把离线报告当作在线预算控制器。

费用可冻结 `{currency,maxAmount}` 硬上限；此时需可验证的服务/宿主限额与完整价格依据。没有这些条件时预检拒绝货币硬上限模式。默认上限为 null；费用按币种、价格来源分别汇总，未知保持未知，不据此宣称节省费用。

以下任一情况停止新派发并保留报告：额度/墙钟耗尽、正式资料泄漏或漂移、Oracle/裁判装配失败、权限变化、不可恢复 unknown。出现关键回归时停止扩展，不增加搜索或放宽门槛挽救结论。

## 5. 收据与离线报告

每个计划单元保存 unitId、manifestDigest、fixture/real 来源、起止时间、终态、独立 evaluator 的 accepted/misrouted、决策分类、Run/DecisionCall/Attempt/学习调用引用及用量。开发单元的 accepted 必须为 null，不把 search 分数伪装成正式验收。模型主动弃权、服务拒绝、非法输出、网络错误、超时、取消、unknown 分列。

每项资源只归属一个单元，拒绝重复证据引用；同一多次执行单元内累计全部调用/执行，不能把相同 token 用量从 DecisionCall 与 Attempt 重复相加。tokens/调用缺失列为 unknownUnits，费用缺失列为 unknownCostUnits。已知部分照常求和，不因部分缺失把整个已知开销丢弃。

当前复算接口接受宿主收据，不独立访问原始数据库或验证远端事实。正式接入须从持久化账本生成收据、核对引用/摘要与策略/快照绑定，再调用复算器；不能直接导入模型自报 accepted、source 或费用。现有 [策略证据](../evolution.md#12-版本化策略观测证据) 与 [执行轨迹](../execution-evidence.md) 是其来源。

主指标：对每个 formal family，先对其 case×repeat 的端到端 accepted 取平均，再在 family 间等权平均。只有选择正确、执行完成且固定裁判通过的可执行任务 accepted=true；弃权/拒绝/异常不能成为端到端成功。回归单独报告。缺失与 unknown 保留在完整计划分母中为未成功；同时标工程 incomplete，不能以较低基线或完成子集支持收益。

真实轮效果门全部满足才报告 supported：

- 候选 formal family 等权成功率 ≥90%，且分别优于 single、budget-matched 至少 5 个百分点。
- 候选误派率 ≤5%、运行失败/取消率 ≤5%、任务 p95 ≤30 秒。
- 回归成功率不低于任一对照，所有 critical 回归 case×repeat 成功。
- 样本量满足第 2 节、三个重复完成、资源未超额且调用/tokens 完整可核验；资料由独立保管人隔离，实际有真实模型调用。

同时列出 per-family 改善/退化、各重复成功率及总体方差、各决策分类、每臂和全轮资源。p95 仅在计划单元都有完整时长时计算，否则 null。上述门槛是本项目预注册的工程效果门，不等于统计显著性或论文收益复现。

结果分列 engineering、realModel、benefit 与 adoption：fixture 永远是 realModel=not_run、benefit=not_evaluated，即使人为构造的数值过门；真实但缺测/计量不全/开发方可见时 inconclusive，完整但未过门为 not_demonstrated。未知真实调用计数时 realModel=unknown。报告不会晋升：采用仍需正式 Evaluation 的一次领用与候选绑定，之后 operator Promotion。

## 6. 复现实验与当前结果

无需凭据、网络或真实 Agent：

```bash
# 本机 Node 版本满足项目要求；其他环境可使用其 Node >=24 路径
env -u PROTEUS_E2E -u PROTEUS_SANDBOX PATH="/opt/homebrew/bin:$PATH" \
  /opt/homebrew/bin/node node_modules/vitest/vitest.mjs run \
  tests/unit/adaptive-experiment.test.ts tests/acceptance/adaptive-experiment.test.ts
```

- [公开协议 fixture](../../tests/fixtures/adaptive-behavior/rehearsal.ts)：2 train / 2 search / 2 formal / 2 regression family，3 次重复，40 张单元收据，最多 64 次 fake 模型调用额度。样本量仅适用于工程演练。
- [可复算示例报告](../../tests/fixtures/adaptive-behavior/report.json)：刻意构造候选过数值门，测试仍不宣称真实收益；所有费用为未知。
- [单元反例](../../tests/unit/adaptive-experiment.test.ts)：重叠 family/任务、摘要漂移、读入正式资料、重复引用、超额、缺测、unknown、币种/价格缺失、关键回归、无标签选择器。
- [完整管道演练](../../tests/acceptance/adaptive-experiment.test.ts)：60 次 fake 决策、60 次真实本地 worker，加 4 张开发收据。三臂使用现有策略，仅演练新合同；本地输出由独立计算的完整 JSON 验收。保存 manifest/observations/report 到临时目录后只读重算，断言无额外请求、标签不进入模型请求、activeGenome 不变。全部成功也不会产生编译改善结论。

当前真实模型兼容及收益均为 not_run。下一切片为 M6a-01：在已有通用 LLM choice 上定义受控的示例参数格式、可重建请求和旧快照兼容；Jev 仍是独立 M5 工作线。
