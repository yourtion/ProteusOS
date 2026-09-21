# 自举路线与待验证项

当前可以开始架构文档和 seed 原型，无需先解决完整记忆系统、模型微调或团队共进化。以下阶段按验收能力推进，不对应既定发布日期；与历史讨论中的 V0–V4 不建立产品版本号映射。

## 0. 实现进度（2026-09-21）

- **M0 完成**：五个纵切片全部落地并各自以验收测试收口（单节点闭环 → DAG + 规则决策 + verify → 并发与预算原子预留 → 崩溃恢复与对账 → seed 可重复固化）。
- **M1 完成**：执行器注册表（local-process / claude-code-acp / codex-acp / pi）；委托编码 → 独立测试验收闭环；能力协商、权限请求、断连与取消合同由 fake agent（真实 ACP 协议实现）覆盖；真实凭据 E2E：Claude Code（50s）与 Codex（28s，经代理）通过，pi 链路验证至模型调用（当时凭据的默认模型返回 403，属账户配额，处理凭据后 `PROTEUS_E2E=pi` 即可复跑）。接入决策见 [ADR 0005](./adr/0005-external-executors.md)。
- **M2 完成**：最小自举（Candidate / Evaluation / Promotion）五片落地。能力即快照槽位（`capability/<name>`）+ 独立子进程加载；Task 声明 `requires`，缺口进入带截止点的 waiting；委托构建 → test-runner 独立验收 → 产出摘要证明 → 采集注册不可变版本 → 候选快照（digest 幂等去重）；评估协议 m2-bootstrap-eval-v1 在候选构造前固定任务、输入、预算和裁判，候选×新能力 + 候选×回归 + 基线对照，新能力同时校验 schema 与固定期望结果；`Kernel.promote` 一次验证 + CAS + operationId 幂等读回；接替为显式 `supersede`（R1 failed/superseded → R2 绑新快照）；回滚只允许历史采用快照且 revision 只增不减。七步自举故事经 CLI 验收固化（tests/acceptance/m2.test.ts），真实 builder 版挂 `PROTEUS_E2E=bootstrap`。实现决策与让步见 [ADR 0006](./adr/0006-m2-minimal-bootstrap.md)。
- **下一步 M3**：经验驱动演化——冻结经验集、Consolidation、多目标比较；前置：真隔离方案落地、裁判拆分独立晋升、评估独立预算池。

## 1. 本次澄清结果

讨论已经给出足够稳定的方向：独立基质、可替换决策与执行、长期个体、可继承产物、独立评估和协作继承。剩余事项属于可验证的实现选择，可写成 proposed 默认值后推进。

本次收敛了四处含糊之处：

- Kernel 管变化规则和不变量，Runtime 管图与调度，Evolution 管学习与比较。
- Genotype 的具体组合用 GenomeSnapshot 表达；运行时的 Phenotype 不直接整体继承。
- Task 内调整称为 adaptation；跨 Run 保留的新结构才进入 evolution 流程。
- Generation barrier 固定本轮经验、候选和比较基线，通过原子晋升切换后续运行，不采用全局停机。

## 2. 分阶段交付

| 阶段 | 实现范围 | 完成判据 | 尚未证明什么 |
| --- | --- | --- | --- |
| M0：可运行 seed | 单 Organism；身份/版本/快照；有限 DAG；规则 Decision；本地可信 process；事务记录、预算与恢复 | 不调用模型完成固定任务；两个并发 Run 可追溯；重启恢复；未知副作用不重复派发；人工安装 seed 快照可重复 | 外部 Agent 兼容性、学习收益 |
| M1：外部委托 | 一个真实 ACP coding worker；协议映射；权限/取消；受控工作区与执行环境；结果验收 | 委托实现一个固定测试功能，产出可定位代码和 trace；测试失败不能标为任务成功；断连和取消可对账 | 自举闭环、自动进化 |
| M2：最小自举 | Candidate/Evaluation/Promotion；独立验收；快照 CAS；显式晋升与回滚 | 完成下述端到端故事；新能力实际参与原任务，能恢复旧行为 | 长期经验驱动改进、统计优越性 |
| M3：经验驱动演化 | 冻结经验集；Consolidation；规则/Skill/Graph 候选；固定验证集；多目标比较 | 从历史失败提出改进，在独立任务上比较基线，并保留可复验结果；证据不足可以不晋升 | 任意模型微调有效、持续自主学习稳定 |
| M4：独立个体与共享 | 多 Organism 隔离；版本导入/fork/inherit；团队发布与证据筛选 | 两个个体可独立采用/拒绝同一团队版本，私有经历不泄露 | 联邦规模化、真正共进化 |
| 研究阶段 | 局部模型微调、学习式世界/自我模型、元可塑性、语义重组与共进化 | 为每项假设设计独立实验、对照和停止条件 | 不作为前述阶段的隐含前置依赖 |

M0 的 seed 必须含基本执行合同、固定图、确定性选择规则、验收和初始快照，不能只是空 registry。M2 的代码候选先采用独立进程协议加载，不把生成代码直接热加载到 kernel。M3 前可以人工提出候选，流程仍完整记录其来源。

## 3. 第一个自举验收故事

示例目标：让 ProteusOS 使用新增的 `ChangedFileSummary` 能力，对一份固定的代码变更生成可验证的文件分类摘要。Seed 已有读取测试输入、委托构建、执行测试与提交候选的基础能力；缺少的是这项派生能力。

1. 用户提交 Task T，包含输入 fixture、输出 schema 和验收规范。Run R1 使用 G0 中已有的能力检查图，对 Task 声明的需求做检查；发现缺少该能力，记录缺口后进入带截止点的等待状态。R1 的可执行图不引用尚不存在的实现，因此仍满足快照依赖完整性。
2. 固定 builder 图创建关联的构建任务，在独立工作区将实现规范交给已配置编码 worker。规范不授予修改 seed 裁判或 kernel 的权力。
3. 产出代码、能力声明和构建来源，注册为不可变 ArtifactVersion；构造基于 G0/revision 0 的候选 G1，增加新能力 binding 与使用它的图版本，并解析完整依赖闭包。
4. 使用构造候选前按内容摘要固定的验收与回归 fixture，在受控环境运行旧/新组合。G0 的缺失能力是已知基线，G1 必须通过输出 schema 与固定期望结果的语义验收；新增能力保留既有能力路由，评估计划须为基准中每项既有能力提供回归任务。候选提交的测试只是补充证据。
5. 展示差异、评估结果、权限需求与资源消耗；由 operator 批准（proposed 首版默认），执行一次 CAS Promotion。失败则保持 G0。
6. 将 R1 以 `failed` 结案，原因记录为能力缺失且被新运行接替；创建同一 Task 修订的 R2，以 supersedesRunId 关联 R1 并固定 G1。R2 使用新能力完成摘要，由独立验收器确认结果。
7. 回滚默认指针到 G0，revision 继续增长。新建 R3 再次确认能力缺失路径，等待截止后以 `failed/missing_capability` 结案；这是预期回滚行为的验收通过，不是 Task T 成功。G1 与 R2 记录仍可查看，R2 的外部结果不会被回滚抹去。

这证明系统能够使用已有执行能力构建、选择和采用派生能力。不能据此声称已经能修改自身基质或自主发现所有改进。

## 4. 各阶段必须保留的失败场景

| 场景 | 预期结果 |
| --- | --- |
| 候选测试失败、输出不合法或依赖缺失 | 保留证据，禁止晋升，旧默认行为继续有效 |
| 两个候选基于同一 revision 同时晋升 | 一个成功，另一个 stale；后者重新构造组合并评估 |
| Promotion 提交成功但响应丢失 | 通过 operationId 读回同一结果，不能再次增加 revision |
| 外部调用发出后本地崩溃 | 对账或等待；不能假定未执行并重发写操作 |
| Run 执行期间默认版本变化 | 原 Run 和重试仍使用原快照；撤权可独立阻止继续执行 |
| 预算不足或操作权限被撤回 | 停止新派发，记录状态并处理已在执行的工作 |
| 取消与结束报告竞态 | 记录请求与实际结果，终态不被迟到消息无条件覆盖 |
| 候选更换 evaluator 并降低门槛 | 既有独立基线阻止自我放行 |
| 删除源经验或缺失内容 blob | 明确标注不可回放/不可运行，不能悄悄填充替代内容 |
| 团队版本声明 public，但带私有依赖 | 发布/导入校验阻止泄露与越权使用 |

## 待验证项

以下问题不阻塞文档，按“需要作出决定的时点”推进；若默认方案不适用，再就具体约束讨论。

| 事项 | Proposed 默认方案 | 需要验证或决策的时点 |
| --- | --- | --- |
| 开发语言与运行时 | 已决策（2026-09-20），完整清单见 [ADR 0004](./adr/0004-m0-engineering-baseline.md)：TypeScript + Node 24 + node:sqlite + pnpm（@techs/proteus）+ commander / zod v4 / pino + vitest + oxlint/oxfmt + GitHub Actions（Linux 矩阵）+ Apache-2.0 | Node 26 转 LTS（2026-10-28）时复核 node:sqlite API 与 engines 基线 |
| 本地存储 | 已决策并验证（M0）：内置 node:sqlite 单 writer + 按摘要寻址的 blob 文件；迁移、事务、崩溃恢复与并发准入经 84 项测试覆盖 | 驱动位于 Persistence port 后，可平移；Node 26 LTS 时复核 API（ADR 0004） |
| M0 预算维度 | Attempt 数上限 + 墙钟秒数，Run 与 Organism 两级；按预留/结算/unknown 语义记账 | M3 出现真实成本数据后再决定是否抽象为统一点数 |
| CLI 与首次引导 | `proteus init/submit/runs/cancel/inspect`；实例根默认 `~/.proteus`；init 创建 local Principal 与默认 Organism，导入 seed 并安装 G0，幂等可重复 | task.yaml 四要素 schema（goal/inputs/constraints/acceptance，验收走槽位引用）与 G0 三槽位（task-graph / routing-policy / acceptance-evaluator）已确认；实现中细化参数与输出格式 |
| 首个外部 worker | 已决策（2026-09-20）：双执行器——Claude Code 经 `@zed-industries/claude-code-acp`（ACP 合同验证主路径，本机 claude 2.1.278 已就绪）+ pi 经 `@earendil-works/pi-coding-agent` SDK 直连（Provider 可替换性验证；pi 无原生 ACP，其自有 RPC/SDK 即受控进程接口） | M1 实现时锁定 `@agentclientprotocol/sdk` 1.4.x 与 pi SDK 0.86.x；真实集成测试需本机凭据显式启用，CI 用 fake ACP agent 覆盖合同 |
| 执行环境 | M0 只运行可信 fixture（已落地）；M1 E2E 在操作者本机运行（工作区隔离 + ACP 权限策略）；**M2 已决策（2026-09-21，ADR 0006）：能力代码以独立 node 子进程 + 工作区 + 超时 + 路径越界拒绝执行（进程级隔离），真隔离（容器/独立宿主）显式挂账 M3**——工作区不算安全沙箱的立场不变 | M3 构造第一批进入默认行为的候选前，容器或独立宿主方案必须就位 |
| 晋升权限 | **M2 已落地 proposed 首版默认**：评估自动执行（协议 m2-bootstrap-eval-v1），晋升由 operator 显式批准（`proteus promote --as`）；评估完成不等于授权；CAS 冲突候选标 stale 须重构重评 | M3 出现稳定评估基线后，再决定允许自主晋升的类型、scope、预算与证据要求 |
| 首个自举案例 | ChangedFileSummary 固定任务——**M2 已完成**（CLI 七步验收 + PROTEUS_E2E=bootstrap 真实 builder 版） | — |
| 评价指标 | **M2 已固定协议 m2-bootstrap-eval-v1**：候选构造前固定任务/输入/schema/期望输出/预算摘要；成功与全部既有能力回归为硬约束，时延分列记录，成本显式 null（真实计费数据出现前不臆造）；基线对照失败记 inconclusive 可重评 | M3 扩展多目标比较与重复运行方差前，复核该协议是否需要升级版本 |
| 用户数据保留 | 最小采集、禁止默认共享、来源可追溯 | 接入真实经历前确定保留期、删除和可训练用途 |
| 本地决策模型与微调 | 先 RuleProvider；真实需求和基线出现后比较模型 | M3 后选择数据、指标和训练路线，不提前绑定 Jev 或某一开源模型 |
| 团队治理 | 先保留归属与精确引用，后实现发布和本地继承 | M4 前明确组织身份、分享策略、团队发布授权及迁移方式 |

后续真正需要与用户讨论的是这些选择的具体约束，而不是重新开放已经收敛的架构主轴。实现过程中如果发现基质规则必须改变，应先记录原因与兼容影响，再更新设计。

仓库组织见[仓库设计](./repository.md)，完整文档入口见[README](./README.md)。
