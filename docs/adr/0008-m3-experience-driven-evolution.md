---
status: accepted
date: 2026-10-09
---

# M3 经验驱动演化：冻结经验集、规则归纳与策略候选

M3 落地 roadmap「从历史失败提出改进，在独立任务上比较基线，保留可复验结果；证据不足可以不晋升」。三项 M2 挂账前置先兑现，主体是经验→候选→评估的离线闭环。实现决策：

**真隔离用现成开源沙箱，port 即替换边界。** `SandboxBackend`（available/run/isolated）抽象执行环境；首个后端 microsandbox（Apache-2.0，libkrun microVM，macOS Apple Silicon / Linux KVM），CLI 受控接口挂载 realpath 工作区，限制网络、CPU、内存与超时。bare-process 后端显式命名"非真隔离"（M2 行为保留）。选 sandbox 模式而后端不可用时**拒绝执行不静默降级**。Docker 后端未实现且不在当前范围；真实后端验收通过 `tests/e2e/sandbox-real.test.ts` 显式启用，不能由合同替身结果代替。

**评估独立预算池。** OrganismBudget 拆 normal/evaluation 双池，准入按 Run purpose 取池；学习与评估不挤占在线任务预算。统一点数抽象继续推迟（真实计费数据仍未出现）。

**裁判拆分为两阶段晋升。** `ensureJudgeGenome` 构造只升 acceptance-evaluator 的候选；能力组合函数不再升裁判（继承基准槽位，基准非 hybrid 即拒绝）——裁判与能力变化永不同处一个候选（裁判与受测行为分离）。裁判候选的评估协议 m3-judge-eval-v1：候选臂钉新裁判跑能力不变回归集 + 基线臂对照。自举链：G0 →（judge 候选）→ G_eval →（capability 候选）→ G_cap。

**冻结经验集固定成员而非查询语句。** `experience_datasets`（migration v6）：显式成员 experience 清单 + 内容摘要 + 截止点 + 过滤规则版本 + 用途许可（development/validation/regression——同一集不得跨用途复用，防 held-out 泄漏为开发反馈）。学习投影（experience × run/task × decision_calls × 预算）是 Consolidation 的唯一输入；决策视图特征经请求 blob 重放，不可回放如实标注。

**Consolidation 以确定性规则归纳为基线，支持 LLM 提议后重算证据门槛。** 正例两来源：成功 Run 的实际选择（expectedOutput 验收即正确性）与失败/弃权成员经开发集 gold join（实验文档允许：开发经验可作学习来源；验证 family 不得参与）。对每个视图特征统计支持数/精度，达门槛提议 (feature→choose)；门槛、候选数、扫描预算为显式参数预限制；**零提议是正常结果**。策略候选只改 routing-policy（执行能力与裁判固定），策略内容 rule-hybrid-v1：归纳的 featureRoutes 优先、基准兜底 routes 继承（回归约束——无特征任务行为不变）。

**策略评估协议 m3-policy-eval-v1（构造候选前固定门槛）。** 双臂（基准快照 vs 候选快照）× 验证集 cases × repeats，指标分列不合成总分：成功率、路由准确率（有期望的 case）、弃权率、时延 p50/p95、成功率跨重复方差（domain-model 的 uncertainty 落地）；样本不足或门槛未达分别 inconclusive/rejected，证据不足不判通过。评估记录携带 datasetRef/datasetSplitRefs（held-out 使用计数可审计，migration v7）。M3 验收故事（tests/acceptance/experience-evolution-story.test.ts）：两阶段装配 → 未声明能力的语义任务历史失败 ×2 → 冻结 → gold 归纳出 hasChangeIntent 特征路由 → 新 family 验证集双臂评估（候选臂 4/4、基线臂 1/4）→ operator 晋升 → 同类新表述任务被特征路由修复。

**M3 验收补强（2026-10-09）。** 策略候选构造前必须注册完整验证计划（稳定 case/family ID、回归角色、输入内容、schema、期望输出、裁判、预算、重复数与门槛）；候选绑定计划摘要与验证集，正式领用一次，同一候选重试只读回已有评估。更换用例、输入内容或门槛拒绝执行；基线回归失败为 inconclusive，候选回归或标注路由不符为 rejected。独立双臂数组按 case×repeat 索引计算方差。旧候选未绑定完整计划不能依靠旧证据晋升。

开发窗口仅包含本个体 normal Run；评估经历不能重新包装为开发数据，同一成员用途不可任意改写。读取冻结投影检查成员完整性及摘要，缺失/漂移明确拒绝。验证 family 注册时和领用时复核当前开发经历，已使用 family 不能换一个注册号继续充当未见数据；family 的语义分类由实验负责人负责，系统不会推断不同措辞的语义独立性。

Consolidation 作业已加入独立学习调用账本：默认每个体最多 100 次模型调用（可显式调整），派发前事务预留，成功记录 token usage（可缺省）、费用仍为 null；超时、取消和不确定结果保留 unknown 且不返还已用额度。运行中取消传播 AbortSignal，跨进程读取持久化取消请求，迟到结果不得形成候选。CLI 从受控环境装配 proposer，不将凭据写入数据集或分享内容。以上工程验证不代表真实模型已证明学习收益。

学习作业队列支持提交、运行、取消与显式崩溃恢复；未知外部调用不自动重发。当前操作方式见 [进化与继承](../evolution.md#11-当前学习与验证规则)。
