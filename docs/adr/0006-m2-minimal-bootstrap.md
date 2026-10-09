---
status: accepted
date: 2026-09-21
---

# M2 最小自举：能力槽位、进程级隔离与预注册裁判

M2 落地 Candidate / Evaluation / Promotion，端到端完成 ChangedFileSummary 自举故事（见自举验收故事）。三个实现决策：

**能力即快照槽位，经独立子进程加载。** 能力以 `capability/<name>` 为槽位名（artifact kind 与槽位一致），复用 Kernel 既有的槽位校验与闭包解析，不新增版本概念。产物内容合同 `capability-module-v1`（`{ kind, name, entry, files[] }`），执行合同与 M0 本地 worker 相同：独立 node 子进程、cwd=工作区、读 `inputs/` 写 `output.json`——满足"代码候选不热加载进 kernel"（roadmap），但不构成安全沙箱。**隔离决策：M2 采用进程级隔离（子进程 + 超时 + 工作区 + 路径越界拒绝），真隔离（容器/独立宿主）挂账 M3**；工作区不算安全沙箱的立场不变，此为显式接受的让步而非默认。任务经 `requires` 声明能力，准入检查发现缺口即进入带截止点的 `waiting`（出路只有被接替或到期 `failed/missing_capability`——Run 固定自身快照，能力永远不会在其中出现）；决策上下文把声明展开为 `capability:<name>: true` 布尔键，rule-v1 严格匹配零扩展。

**裁判按内容寻址钉住，不取候选快照槽位。** 评估协议 `m2-bootstrap-eval-v1`（构造候选前固定）以三个 evaluation Run 覆盖：候选×新能力验收、候选×既有能力回归、基准×回归（健康对照——基线失败即评估环境不可信，记 `inconclusive` 而非 `rejected`，可重评；证据不足不能记通过）。评估 Run 的裁判版本持久化于 `runs.evaluator_version_id`（恢复/续跑不漂移），且按 digest 内容寻址取预注册的 `hybrid-acceptance-v1`——候选把快照槽位换成放水裁判对评估无效，这是"候选更换 evaluator 降低门槛被既有独立基线阻止"（roadmap §4）的实现。**让步：hybrid 裁判与能力变化同处候选快照**，严格做法是拆成两个晋升（evolution.md §6"裁判与被评估行为同时变化时，固定其中一方进行对照"）；M2 选择固定裁判一方——hybrid 版本由基质预注册，其与 stats-acceptance-v1 的判定等价性由 tests/evals 固定用例证明后才允许进入候选组合。M3 拆分为裁判独立晋升。

**晋升一次验证、同事务提交、幂等读回。** `Kernel.promote` 在一个事务内完成快照可解析校验（不能晋升/回滚到依赖缺失的组合）、授权者存在、CAS 条件更新与成功记录（repository.md"调用者不手动串起可漏掉的步骤"）。`operationId` 幂等：提交成功但响应丢失时按它读回同一结果，revision 不重复增加；CAS 冲突返回 stale 并由 Evolution 记 `candidate.stale`（须基于新基准重构重评），不落 promotion 记录。回滚是 `kind=rollback` 的一次 Promotion：revision 只增不减，回滚到相同快照引用后旧的并发晋升请求仍然 stale。评估门（最新评估必须 eligible）与 operator 批准在 Evolution 层，同一事务内先于 CAS 检查。接替为显式命令：`supersede` 把缺口等待的 R1 以 `failed/superseded` 结案并创建同 Task 修订（revision+1）的 R2 绑定当前 active——promote 保持纯晋升，单一职责。

**M2 收官审查后的补强。** builder Run 成功时立即记录约定产出的内容摘要，采集只接受与该证明一致的内容，避免验收后修改工作区再借用旧证据。候选构造必须同时固定评估计划摘要；摘要覆盖目标、输入文件树、schema、可选期望输出、预算、能力声明和回归任务，执行评估时重新计算并拒绝漂移。新能力任务必须声明候选能力；基准快照已有的其他能力必须分别出现在回归任务中。能力候选的图与策略从基准已有能力槽位和本次新增能力的并集生成，持续积累不会丢失旧路由。ChangedFileSummary 以固定完整输出做语义比对，不再只验证 JSON schema。rollback 目标必须出现在该 Organism 的历史 Promotion 路径中，未评估、被拒或从未采用的候选快照不能借 rollback 激活。外部执行器通过 `recoveryPolicy` 显式声明缺失产物是否可安全重试；ACP、pi 与动态能力执行器默认人工对账，未知副作用不会被误判失败后重派。能力名统一限制为单段 slug，并在最终工作区路径上再次校验边界，阻断名称级目录逃逸。最新 Evaluation 的 eligible 门移入晋升事务，与 CAS 使用同一提交单元，消除事务外读取造成的竞态窗口。

其余已确认事项：评估预算与普通 Run 共享 organism 池（purpose 标记区分，独立预算池 M3）；评估指标按成功/回归/时延分列、成本显式 null（真实计费数据出现前不臆造）；canonicalJson 下沉至 storage/blobs.ts（evolution 不依赖 app 层）。验证布局新增 tests/evals/（Evaluation 层）。

M2 的阶段性让步已经由 M3 补齐：裁判独立晋升、normal/evaluation 分池和可配置隔离后端见 [ADR 0008](./0008-m3-experience-driven-evolution.md)；当前授权检查包含实际操作权限及版本闭包，见 [运行时合同](../runtime.md)。
