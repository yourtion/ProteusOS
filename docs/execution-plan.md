# ProteusOS 适应能力执行计划

更新：2026-10-28。设计依据见 [演化合同](./evolution.md)、[DSPy 论文](https://arxiv.org/pdf/2310.03714) 和 [Harness² 论文](https://arxiv.org/pdf/2610.14224)。本文件记录交付顺序、验收门与执行状态；研究笔记保留事实依据，路线图保留阶段概览。

先完成可复现的工程基线和证据合同，再实现可编译策略、任务内试探与跨任务经验复用。Jev 决策层和 Web 工作线继续保留。每次交付一个可独立验证的切片，完成后把命令、结果及下一项写回本文件。

P0-01/02/03/04、M6a-01/02 均已完成工程验收。M6a-03 分解为持久化派发账本、原始证据桥接、受信 runner 与正式验证、独立真实轮四步；先补工程前置，再执行真实效果验证。Jev 与 Web 工作线仍按独立依赖推进。

## 执行规则

- 工程通过、真实服务兼容、真实任务收益分别记录；fixture/fake 通过不能替代后两者。
- 每个切片先明确合同和可观察验收，再实现最小改动，运行针对性检查，最后运行仓库统一检查。失败时保留证据并定位，不通过放宽断言或增加隐式重试绕过。
- 已冻结的 `organism-decision-v1` 和既有正式验证方案保持原语义。新指标或适应实验使用明确的新版本，旧记录缺项标记 unavailable。
- Candidate、正式 Evaluation、operator Promotion 继续分开。搜索与任务内试跑不产生可直接晋升的证据，不修改运行中的快照。
- 所有模型调用纳入累计预算；unknown 不自动重发或退还额度。真实实验在数据、配置、额度及停止条件固定后启动。
- 阶段之间按证据推进。没有收益时保留有效基线，记录负结果；不自动扩展图、权限、学习算法或联邦规模。

## 交付顺序与状态

状态含义：已完成表示实现与验收均通过；进行中表示当前执行；待执行表示合同足以开始；待前置表示须先满足表内依赖；待效果门表示须有真实实验依据。

| ID | 切片 | 前置 | 状态 | 完成标准 |
| --- | --- | --- | --- | --- |
| P0-01 | 恢复与取消测试的确定性基线 | 无 | 已完成 | 当前恢复失败定位并修复，崩溃点由明确事件控制，针对性与全量检查通过 |
| P0-02 | 版本化评估证据与指标口径 | P0-01 | 已完成 | 独立 family、重复稳定性、明确弃权/异常及用量缺失可区分，旧协议兼容 |
| P0-03 | [执行轨迹与用量合同](./execution-evidence.md) | P0-01，复用 P0-02 的口径 | 已完成 | ACP/pi/本地执行均能返回明确的轨迹可用性和用量状态，证据持久化且可复算 |
| P0-04 | [新实验协议及数据隔离合同](./experiments/adaptive-behavior-v1.md) | P0-02/03 | 已完成 | 固定预算、数据 split、对照、指标和停止条件，形成无真实调用的完整演练 |
| M5-01 | Jev choice 最小接入 | P0-02，官方接口核验 | 待前置 | 同一 Decision 合同下版本、概率、调用账本及恢复通过；真实兼容单独验证 |
| U0/U1 | 应用 Interface、Host 与任务 Web | P0-01；按交互设计切片 | 待执行 | 页面与 CLI 使用同一用例，异步任务可观察、取消和恢复 |
| M6a-01 | [可编译策略内容与参数合同](./compiled-policy.md) | P0-04，已有通用 LLM choice | 已完成 | 只开放许可参数；请求可重建；旧策略/快照/Run 兼容 |
| M6a-02 | [有界搜索、报告与唯一候选](./policy-compilation.md) | M6a-01 | 已完成 | train/search/formal 隔离；每次调用记账；零候选、取消和 unknown 路径通过 |
| M6a-03 | 单模块真实效果验证 | M6a-02、受信预算后端、独立数据、全轮冻结 | 待前置 | 未见 family 上满足预注册质量或成本门；不足则停止扩展 |
| M6a-03-01 | [持久化实验派发账本](./adaptive-journal.md) | P0-04，M6a-02 | 已完成 | 冻结开发收据，原子预留/开始/结果，顺序派发、取消、期限与崩溃恢复 |
| M6a-03-02 | 原始证据与编译来源桥接 | M6a-03-01 | 进行中 | 核验 CompileJob/Run/DecisionCall/Attempt、策略/快照/裁判绑定及全部开销；不接受自报成绩 |
| M6a-03-02a | [编译开发证据核验](./compile-evidence.md) | M6a-03-01 | 已完成 | 原始正文、来源账本、Attempt、报告与获胜候选一致性；负结果和 unknown 原样保留 |
| M6a-03-02b | 开发单元映射与正式 Run 收据 | M6a-03-02a | 进行中 | 编译全开销映射冻结单元；正式任务、策略、快照、独立裁判和多次臂选择可核验 |
| M6a-03-02b1 | [开发单元内容与计量映射](./compile-development.md) | M6a-03-02a | 已完成 | 持久化源任务投影、全部开销和候选绑定；未知执行用量不抹零，不允许冒充真实证据 |
| M6a-03-02b2 | 开发包与 Journal 原子绑定 | M6a-03-02b1 | 已完成 | 固定开发来源，派发前重核来源与权限；取消/恢复仍可留存未知证据 |
| M6a-03-02b3 | 正式 Run 收据 | M6a-03-02b2 | 进行中 | 正式任务、策略、快照、独立裁判及多次臂选择可核验，覆盖缺测和全部开销 |
| M6a-03-02b3a | [JSON 验收正文与只读 Run 核验](./verification-evidence.md) | M6a-03-02b2 | 已完成 | 保存当次实际正文并复算；绑定 Run、裁判及成功 Attempt 输出；旧项和采集失败不冒充证明 |
| M6a-03-02b3b | 冻结任务与三臂 Run 收据 | M6a-03-02b3a | 进行中 | 核对输入投影、策略和快照，绑定重复执行选择器、缺测及全部调用成本，接入 Journal |
| M6a-03-02b3b1 | [冻结任务输入与裁判资料绑定](./verification-evidence.md) | M6a-03-02b3a | 已完成 | 同一读事务内核对实际输入、目标/修订与独立裁判摘要；清理后可复算，所有 Attempt 与缺测不遗漏 |
| M6a-03-02b3b2 | [策略臂、选择与 Journal 收据](./adaptive-arm-evidence.md) | M6a-03-02b3b1 | 进行中 | 策略选择及 [预派发 Run 绑定](./adaptive-run-slots.md) 已可核验；继续补独立误派资料、原始收据结案和完整成本 |
| M6a-03-03 | 受信 runner 与正式 Evaluation | M6a-03-02，预算后端 | 待前置 | 实际调用受约束，正式集一次领用，三臂完整执行与新版 Evaluation；采用仍显式授权 |
| M6a-03-04 | 独立真实轮 | M6a-03-03，独立数据 | 待前置 | 全轮冻结后真实执行，按原协议记录 supported / not_demonstrated / inconclusive |
| M6b-01 | 单步任务内适应会话 | M6a-03 通过，P0-03 | 待效果门 | 独立快照试跑、会话累计预算、组合后实测、不改变 active、不重复副作用 |
| M6b-02 | 同预算适应实验 | M6b-01 | 待效果门 | 与原方案多次执行对照，证明额外编排的质量或成本价值 |
| M6c-01 | 改进经验资产与冻结检索 | M6b-02 通过 | 待效果门 | 来源/反例/用途可追溯；任务固定所读库版本；采用受治理 |
| M6c-02 | 未见 family 的库迁移实验 | M6c-01 | 待效果门 | 有库优于无库，报告负迁移和总成本；通过后再设计持续更新实验 |
| M7/M8 | 固定多模块组合与团队本地适配 | M6 的收益与治理门 | 待效果门 | 每个新增变量独立评价，接收方本地验证与采用 |

P0 完成后，按实际开发容量安排 M5 与 U0/U1；不把两条工作线的工期简单重叠。M6a 需要一个可固定、可追溯的 Provider，不要求提前完成 M5 的第二类决策或级联。当前不承诺整个 M6 的日历工期，完成各切片后依据验证结果估算下一项。

M6a-03 的预算预检已发现：40 个模型来源 + 40 次最低搜索 + 750 次正式/回归 = 830 次，超过原协议 800 次。按现合同可采用满足视图、标注与验收要求的本地确定性来源，使模型调用为 790 次；若资料必须另耗模型调用，则先另注册新协议。完整开销映射是 M6a-03-02b 的验收项，不允许通过漏记来源调用满足上限。

## P0 的具体工作

### P0-01 恢复基线

范围：`tests/integration/recovery.test.ts`，仅在证据指向运行逻辑缺陷时修改 `src/runtime/` 或执行 Adapter。

1. 单独运行“有完整产物时按原 Attempt 成功续跑”，捕获 `succeeded → unknown` 的失败。
2. 区分执行尚未完成、产物路径/内容不符、恢复状态投影错误三个假设；一次只改变一个变量。
3. 测试按明确的“开始执行”“产物已写入”“进入第二节点”等事件注入崩溃与取消，替换固定 sleep 推测状态的装配。
4. 保留负例：无完成证据且执行器为 manual 时必须保持 unknown；完整产物时沿原 Attempt 续跑且不重派；retry-safe 的缺失产物允许有界重试。
5. 验证取消在执行中发生、保留已完成 Attempt，并且终态不被迟到事件覆盖。

验收：目标复现从红变绿；覆盖延迟完成的明确时序；整个恢复文件通过；仓库 lint、格式、类型与全量测试通过。若问题只在测试装配，不放宽 Runtime 的 unknown 规则。

### P0-02 评估证据

范围：Evolution 的类型/投影、实验报告以及相应单元与集成测试。

交付版本化的明细投影，包含 caseId/familyId/role/repeat/arm、Run/DecisionCall 引用、明确结果分类和资源记录。报告独立 case/family 数、重复次数与配对改善/退化；回归集不计作新的泛化样本。明确区分模型主动弃权、服务拒绝、invalid_output、transport_error、timeout、cancelled、unknown 和未执行。

旧评估协议的 eligible 门槛不就地更改。先增加可复算的新版证据；新的统计门槛由 P0-04 预注册。测试覆盖“一项任务重复多次不能充当多个独立 family”、异常不能计作正确弃权、缺失费用不能计零、旧记录缺项可读。

### P0-03 执行轨迹

范围：`ExecutionResult`、执行 Adapter、Runtime/Storage 的证据保存与读取。

合同区分没有轨迹能力、采集失败、部分轨迹和完整可用轨迹。保存宿主可观察的工具/交付事件、来源版本、输入输出摘要与必要的权限决定；不要求模型隐藏推理。费用、tokens 和价格依据允许 unavailable，不能根据进程完成推断免费。

验收包括 trace 保存失败、输出截断、迟到事件、崩溃恢复、Adapter 不支持用量、历史数据缺项。证据通过内容寻址引用持久化，不依赖临时工作区永久存在。第一轮只实现支持实际对照所需的字段，避免复制整个供应商事件协议。

### P0-04 实验冻结

在 `docs/experiments/adaptive-behavior-v1.md` 定义新协议，至少固定：

- train/search/formal/regression 的 family 隔离、用途与截止点；首轮使用合成或明确许可资料。
- 编译期与任务内试探的修改白名单；模型、视图、裁判、工具权限和环境摘要。
- 固定基线单次、同总预算原配置多次执行、编译方案、单步适应、冻结经验库的分阶段对照。开发侧选定方案后，正式阶段只执行预注册比较。
- 调用、tokens、时间与已知费用的累计额度；缺失/unknown 计入报告，预算耗尽不补考。
- 一个主目标及约束：任务质量或总成本；独立 family 样本量、关键回归、误派/弃权、失败率、p95 和停止条件。

验收：fixture 演练可重复，报告可离线复算，正式标签不进入 learner/worker，只有正式证据能用于采用。真实调用阶段单独记录 `not_run / ran` 与收益结论。

## M6 的实施边界

M6a 先在现有 `route-choice` 上开放示例选择与顺序，以 ArtifactVersion 保存新内容格式。PolicyLearner 只返回候选与证据；CompileTrial 保存开发搜索，CompileReport 汇总全部成本和选择理由。模型、指令、视图、schema、图、裁判冻结。规则若已接近满分，改选成本目标或有实际需求的任务。

M6b 的首轮采用一个提案的简化单步：基线 Run、提案 Probe Run、组合后最终 Run。明确这是项目实验变体。各 Run 固定快照、工作区从相同输入状态初始化；适应会话承担总预算、停止/恢复和结果关联。只在可重置本地任务上执行，不重放消息发送或部署。组合生成新版本后须实际执行，不能沿用父版本成绩。

M6c 将任务结果 Experience 与 ImprovementExperience 分开，记录适用条件、修改、对照、反例及成本。先检验冻结库的跨 family 迁移；持续适应另设按时间顺序的协议，只允许使用此前经验。库草稿不直接影响未来请求，实际可检索版本需要独立评价与采用。

最小 Prediction/Outcome 先落在 Trial 的可检验假设及实际差异；通用预测、自我投影与普通任务记忆继续保留独立目标。完整世界模型、算法自修改、动态图和自动晋升不作为本批次前置。

## 验证环境与执行记录

项目要求 Node >=24，`.node-version` 为 24。当前 shell 默认 Node 20，已安装的 `/opt/homebrew/bin/node` 为 26.11.1。执行时使用满足版本要求的 Node；不为通过检查改变项目依赖或统一检查内容。

标准检查为 `pnpm check`。若本机 pnpm 的自动依赖检查受网络限制，可直接执行等价本地工具：

```bash
env -u PROTEUS_E2E -u PROTEUS_SANDBOX PATH="/opt/homebrew/bin:$PATH" \
  sh -c 'node_modules/.bin/oxlint . && node_modules/.bin/oxfmt --check src tests bin && node_modules/.bin/tsc --noEmit && node_modules/.bin/vitest run'
```

该替代命令仅描述当前 macOS 环境。真实模型和真实 Microsandbox 测试保持显式启用；本地 HTTP 验收需要允许 loopback 监听。

| 日期 | 切片 | 改动与证据 | 结果 |
| --- | --- | --- | --- |
| 2026-10-23 | 计划落地 | 分离设计依据与执行状态，细化 P0 与 M6a/b/c 的合同和验收 | 已完成 |
| 2026-10-23 | P0-01 初始基线 | 单用例通过；恢复文件与 registry-cli 并发时复现 `succeeded → unknown` | 已复现 |
| 2026-10-23 | P0-01 原因确认 | 对账时缺产物；worker 实际 113 ms 后成功退出；等待完成后同一 Attempt 对账成功 | 固定等待 100 ms 的测试装配竞态，Runtime 行为符合合同 |
| 2026-10-23 | P0-01 修复 | [恢复测试](../tests/integration/recovery.test.ts) 以派发、真实完成、第二节点进入和取消释放检查点替代所有固定 sleep；提前结束/抛错立即反馈 | 未修改运行逻辑、权限或 unknown 语义 |
| 2026-10-23 | P0-01 验证 | 恢复文件 6/6；原并发复现 7/7；lint、format、typecheck 通过；全量 47 个测试文件通过，242 passed / 5 skipped | 已完成，提交 `5d58182`；跳过项为显式启用的真实 Agent / Microsandbox E2E |
| 2026-10-23 | P0-02 实现与验证 | `m3-policy-evidence-v1` 冻结逐次观测，分列 family/角色、决策分类、部分已知用量和币种；新旧评估 JSON 可读；针对性 11/11，全量 248 passed / 5 skipped，静态检查通过 | 已完成，提交 `c8ccad5` |
| 2026-10-23 | P0-03 恢复边界 | 崩溃注入证明“Attempt 已成功、节点完成未提交”时会执行两次；成功结果、节点完成和轨迹引用改为同事务提交 | 回归已通过，执行次数保持 1 |
| 2026-10-23 | P0-03 观测与持久化 | 有界公开事件、Adapter 用量/缺失、输入输出指纹、blob 摘要与回放、失败/截断/迟到事件、工作区清理和旧记录；评估明细冻结 Attempt 引用 | 已完成，完整合同见执行轨迹文档 |
| 2026-10-23 | 本轮最终验证 | lint、format、typecheck 通过；51 个测试文件全过，260 passed / 5 skipped；真实 Agent 与 Microsandbox 未启用 | P0-01/02/03 工程验收通过；未产生真实模型收益结论 |
| 2026-10-24 | P0-04 冻结合同 | 新协议固定四类 split、三臂、示例修改白名单、累计额度/截止点与效果门；拒绝跨 split family/内容、摘要漂移与重复计量 | 已完成；离线审计不替代运行时持久化预算与正式 Evaluation |
| 2026-10-24 | P0-04 演练 | 40 张公开收据可重复复算；60 次 fake 决策与真实本地 worker 完整验收；模型请求无标签/验收资料、activeGenome 不变 | 12 个单元用例及 1 个完整管道用例通过；fixture 永不产生真实收益结论 |
| 2026-10-24 | P0-04 边界与最终验证 | 恰好 5 个百分点的浮点门槛、unknown/缺测、币种与价格缺失、关键回归、无标签选择器均覆盖；lint、format、typecheck 与文档检查通过 | 53 个测试文件全过，273 passed / 5 skipped；真实 Agent / Microsandbox 未启用，真实模型兼容与收益均 not_run |
| 2026-10-24 | M6a-01 策略与参数 | 新 `llm-choice-demos-v1` 冻结基线/视图/池与来源，只开放示例选择和顺序；严格响应、特征、train 用途、摘要与大小界限 | 已完成，合同见可编译策略文档；未实现搜索器或自动采用 |
| 2026-10-24 | M6a-01 请求与恢复 | 请求渲染归 Adapter，完整正文及视图来源进入 request blob；prepared 原 ID/额度恢复、unknown 不重发、完成证据不重复执行、端点/正文漂移拒绝 | 旧 v1 请求布局、promptDigest、快照与 prepared Run 兼容，无数据库迁移；SDK 默认端点与来源记录统一 |
| 2026-10-24 | M6a-01 验证 | 新增 17 个用例；含旧决策运行的定向验收 35/35，扩展的旧 v1 prepared 恢复通过；lint、format、typecheck、文档检查通过 | 56 个测试文件全过，290 passed / 5 skipped；真实模型兼容与收益均 not_run |
| 2026-10-24 | M6a-02 来源与搜索 | operator 独立标注并核验冻结 normal 经验、原调用/视图/验收及许可；train/search/formal 隔离；冻结参数网格、family 等权评分和同分规则 | 已完成；只输出至多一个 compiled-policy 候选，搜索不创建 Evaluation、不领用正式次数、不切 active |
| 2026-10-24 | M6a-02 调用与恢复 | migration 15 增加编译 Case/Job/Trial，复用累计 learning_calls；来源费用/执行证据、硬 token 预留、绝对截止点、fixture/real 配置和完整报告持久化 | prepared 沿原预留恢复；started/unknown 不重发；结果、候选/绑定/报告原子提交；取消、并发领取、后端漂移与真实团队撤权通过 |
| 2026-10-24 | M6a-02 验证 | 新增 13 个 SQLite/本地 worker 集成用例和 3 个纯报告用例；包含三个崩溃点、零候选、源漂移、预算耗尽、未知费用、旧归纳回归；静态与文档检查通过 | 58 个测试文件全过，306 passed / 5 skipped；真实模型兼容/效果及正式采用均 not_run；原生 Adapter 尚无可核验 token 上界，不自动启用真实编译 |
| 2026-10-25 | M6a-03-01 派发账本 | migration 16 固定清单/开发收据、完整额度与单次 start 许可；结果/实验状态原子提交；绝对期限含开发与等待；prepared 原预留恢复，started 封为 unknown | 新增 13 个 SQLite 集成用例；双连接竞争、三个崩溃点、撤权/个体隔离、取消、超额及迟到路径均通过 |
| 2026-10-25 | M6a-03-01 验证 | 定向 25/25；lint、format、typecheck、文档链接与全量检查通过 | 59 个测试文件全过，319 passed / 5 skipped；收据尚未核验原始账本，不装配真实 runner、不创建正式 Evaluation，真实效果仍未运行 |
| 2026-10-25 | M6a-03-02a 编译证据 | 只读核对来源许可/成员摘要、Run/DecisionCall/Attempt、请求重建、完整响应、学习账本、评分/费用、报告及获胜候选；来源 raw choice 与 Adapter 用量分别核验 | 新增 6 个集成用例；工作区清理后可复算，篡改、遗漏、孤立调用、unknown、取消和零改善均保留明确结果；适应协议补齐弃权来源缺失分类 |
| 2026-10-25 | M6a-03-02a 验证与下一项 | 定向 44/44；静态、格式、类型、文档链接与全量检查通过；发现直接扩大模型来源将达 830 次而超过 800 次协议预算 | 60 个测试文件全过，325 passed / 5 skipped；下一项 M6a-03-02b 开发单元映射与正式 Run 收据；真实兼容、独立效果及正式采用仍未运行 |
| 2026-10-25 | M6a-03-02b1 开发映射 | migration 17 固定每个编译作业唯一任务内容包，核对旧任务指纹与新输入投影，全部来源决策/Attempt/Trial 各映射一次；固定策略、组件、family 与完整额度 | 新增 7 个集成用例；删除资料后可复算，遗漏/降额、漂移、链接、零候选及伪 real 声明均拒绝；已知部分与未知执行开销分列 |
| 2026-10-25 | M6a-03-02b1 验证 | 定向 51/51；lint、format、typecheck、文档链接及全量检查通过 | 61 个测试文件全过，332 passed / 5 skipped；真实来源模式与执行器模型调用上界仍不可用，真实绑定拒绝；继续开发包与 Journal 原子关联 |
| 2026-10-25 | M6a-03-02b2 来源关联 | `registerCompiled` 原子固定实验、开发收据及编译/包/核验摘要；预留/开始/报告重核来源，提交内再查版本权限；来源失效仍能取消/恢复封存 unknown | 新增 6 个集成用例，包含注册回滚、旧合同不升级、跨连接幂等、缺失端口、提交前团队撤权与裁判硬链接隔离 |
| 2026-10-25 | M6a-03-02b2 验证 | 定向 57/57；lint、format、typecheck、文档链接和最终全量检查通过 | 61 个测试文件全过，338 passed / 5 skipped；开发来源可核验，整体正式收据仍为 unverified-host-receipts；下一项 M6a-03-02b3 正式 Run 收据，无真实效果或正式采用结论 |
| 2026-10-25 | M6a-03-02b3a JSON 验收 | 保存当次 JSON 输出/schema/期望输出及生效裁判；只读核验 Run/Attempt 输出、原始判定与最终结案；缺项、超限和写入失败不升级为证明 | 新增 11 个集成用例；定向 22/22，覆盖清理重开、负结果、篡改、跨 Run、重复事件、旧路径及裁判钉住；任务输入与三臂正式绑定留待下一切片 |
| 2026-10-25 | M6a-03-02b3a 验证 | lint、format、typecheck、文档链接及全量检查通过；历史 pipeline/test-runner 判定保持不变，重复验收证据拒绝歧义 | 62 个测试文件全过，349 passed / 5 skipped；JSON 验收范围可核验，Journal 正式收据仍为 unverified-host-receipts；下一项 M6a-03-02b3b，真实模型兼容/效果与正式采用仍未运行 |
| 2026-10-25 | M6a-03-02b3b1 冻结任务 | 纯文件投影复算派发前目录摘要；同一读事务核对全部 Attempt 输入、目标/修订、formal/regression 用途及冻结裁判正文 | 新增 20 个用例；定向 56/56，覆盖同统计不同输入、清理重开、嵌套 UTF-8、额外空目录、负验收与零执行缺测；预登记、策略臂及成本明确未核验 |
| 2026-10-25 | M6a-03-02b3b1 验证 | lint、format、typecheck、文档链接及全量检查通过；旧 JSON 核验合同保留，新入口只读且不修改 active | 63 个测试文件全过，369 passed / 5 skipped；下一项 M6a-03-02b3b2 策略臂、选择与 Journal 收据；真实模型兼容/效果和正式采用均未运行 |
| 2026-10-25 | M6a-03-02b3b2 策略臂与选择 | 同一读事务核对仅策略不同的快照、固定组件、原始 DecisionCall 请求/响应/事件及实际执行器；固定 1/3/1 槽位按无标签规则复算，汇总全部调用及未知开销 | 新增 14 个集成用例；定向 49/49，包含首次负验收不可跳过、null 票、worker 失败、缺测、倒排、来源漂移、额外调用和清理重开；预派发槽位及正式 Run 顺序仍未核验 |
| 2026-10-25 | M6a-03-02b3b2 本轮验证 | lint、format、typecheck、文档链接及全量检查通过；旧请求与任务核验保持兼容，不派发新调用、不修改 active、不产生正式 Evaluation | 64 个测试文件全过，383 passed / 5 skipped；Journal 仍为 unverified-host-receipts；下一项绑定预派发槽位、Run 身份及实际顺序，真实模型兼容/效果与采用未运行 |
| 2026-10-25 | M6a-03-02b3b2 Run 槽位 | migration 18 固定 1/3/1 槽位与任务包；Runtime 准入时同事务绑定 Run/Task/预算，调用前单次启动，按 Journal 事件序号核验实际顺序；绝对截止只截短，unknown 禁止继续 | 新增 14 个集成用例；定向 47/47，覆盖三臂、两个连接竞争、两处崩溃回滚、重复启动、同毫秒顺序、终态仍含 unknown、取消/权限/期限/文件漂移及清理重开 |
| 2026-10-25 | M6a-03-02b3b2 槽位验证 | lint、format、typecheck、文档链接及最终全量检查通过；旧宿主账本可读，不把宿主成功收据或未知开销升级为事实 | 65 个测试文件全过，397 passed / 5 skipped；下一项独立误派资料及原始收据结案；仅 fixture 可绑定，真实预算上界、模型兼容/效果和正式采用仍未运行 |
| 2026-10-28 | 原始收据闭环 | 派发前冻结路由标签；同事务从 Run/DecisionCall/Attempt 与选择器推导观察和收据，报告重核已提交证据并保留全部已知/未知开销；新增串行 runNext/runAll | 新增 12 个集成用例，定向 39/39；66 个测试文件全过，409 passed / 5 skipped；继续完整编译来源与三臂场景验收，不在此处结束大阶段 |

P0-01 的最小复现与回归命令：

```bash
env -u PROTEUS_E2E -u PROTEUS_SANDBOX PATH="/opt/homebrew/bin:$PATH" \
  /opt/homebrew/bin/node node_modules/vitest/vitest.mjs run \
  tests/integration/recovery.test.ts tests/acceptance/registry-cli.test.ts
```

P0-04 的新版协议与完整资源汇总规则见 [适应行为实验 v1](./experiments/adaptive-behavior-v1.md)。本切片只做离线冻结/审计，不装配真实 runner；M6a 在真实运行前补齐持久化预留、调用/token 上界与正式 Evaluation 桥接。现有正式判定与冻结门槛保持原语义。


P0-04 的定向验收命令：

```bash
env -u PROTEUS_E2E -u PROTEUS_SANDBOX PATH="/opt/homebrew/bin:$PATH" \
  /opt/homebrew/bin/node node_modules/vitest/vitest.mjs run \
  tests/unit/adaptive-experiment.test.ts tests/acceptance/adaptive-experiment.test.ts
```


M6a-01 的定向验收命令：

```bash
env -u PROTEUS_E2E -u PROTEUS_SANDBOX PATH="/opt/homebrew/bin:$PATH" \
  /opt/homebrew/bin/node node_modules/vitest/vitest.mjs run \
  tests/unit/llm-demos-policy.test.ts tests/contract/llm-demos-adapter.test.ts \
  tests/integration/llm-demos-runtime.test.ts tests/integration/decision-runtime.test.ts
```


M6a-02 的定向验收命令：

```bash
env -u PROTEUS_E2E -u PROTEUS_SANDBOX PATH="/opt/homebrew/bin:$PATH" \
  /opt/homebrew/bin/node node_modules/vitest/vitest.mjs run \
  tests/unit/compile-report.test.ts tests/integration/policy-compiler.test.ts \
  tests/unit/llm-demos-policy.test.ts tests/integration/consolidation-recovery.test.ts
```
