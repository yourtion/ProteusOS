---
status: accepted
date: 2026-10-09
---

# M3 经验驱动演化：冻结经验集、规则归纳与策略候选

M3 落地 roadmap「从历史失败提出改进，在独立任务上比较基线，保留可复验结果；证据不足可以不晋升」。三项 M2 挂账前置先兑现，主体是经验→候选→评估的离线闭环。实现决策：

**真隔离用现成开源沙箱，port 即替换边界。** `SandboxBackend`（available/run/isolated）抽象执行环境；首个后端 microsandbox（Apache-2.0，libkrun microVM，macOS Apple Silicon / Linux KVM），CLI 受控接口：挂载 realpath 工作区、`--no-net`、CPU/内存/超时限制，microVM 亚秒启动、前台退出自动回收。bare-process 后端显式命名"非真隔离"（M2 行为保留）。选 sandbox 模式而后端不可用时**拒绝执行不静默降级**。docker 后端预留接入（CI ubuntu lane 无 KVM 跑不了 microsandbox，届时互补）。真实验证：本机 microsandbox 0.7.7 全链路通过（禁网/挂载写回/资源限制）；CI macos lane 安装 msb 跑真实沙箱用例。

**评估独立预算池。** OrganismBudget 拆 normal/evaluation 双池，准入按 Run purpose 取池；学习与评估不挤占在线任务预算。统一点数抽象继续推迟（真实计费数据仍未出现）。

**裁判拆分为两阶段晋升。** `ensureJudgeGenome` 构造只升 acceptance-evaluator 的候选；能力组合函数不再升裁判（继承基准槽位，基准非 hybrid 即拒绝）——裁判与能力变化永不同处一个候选（evolution.md §6 正式兑现）。裁判候选的评估协议 m3-judge-eval-v1：候选臂钉新裁判跑能力不变回归集 + 基线臂对照。自举链：G0 →（judge 候选）→ G_eval →（capability 候选）→ G_cap。

**冻结经验集固定成员而非查询语句。** `experience_datasets`（migration v6）：显式成员 experience 清单 + 内容摘要 + 截止点 + 过滤规则版本 + 用途许可（development/validation/regression——同一集不得跨用途复用，防 held-out 泄漏为开发反馈）。学习投影（experience × run/task × decision_calls × 预算）是 Consolidation 的唯一输入；决策视图特征经请求 blob 重放，不可回放如实标注。

**Consolidation 首版为纯规则确定性归纳（不调 LLM）。** 正例两来源：成功 Run 的实际选择（expectedOutput 验收即正确性）与失败/弃权成员经开发集 gold join（实验文档允许：开发经验可作学习来源；验证 family 不得参与）。对每个视图特征统计支持数/精度，达门槛提议 (feature→choose)；门槛、候选数、扫描预算为显式参数预限制；**零提议是正常结果**。策略候选只改 routing-policy（实验文档 §11"首个候选只改路由 Policy，执行能力与裁判固定"），策略内容 rule-hybrid-v1：归纳的 featureRoutes 优先、基准兜底 routes 继承（回归约束——无特征任务行为不变）。

**策略评估协议 m3-policy-eval-v1（构造候选前固定门槛）。** 双臂（基准快照 vs 候选快照）× 验证集 cases × repeats，指标分列不合成总分：成功率、路由准确率（有期望的 case）、弃权率、时延 p50/p95、成功率跨重复方差（domain-model 的 uncertainty 落地）；样本不足或门槛未达分别 inconclusive/rejected，证据不足不判通过。评估记录携带 datasetRef/datasetSplitRefs（held-out 使用计数可审计，migration v7）。M3 验收故事（tests/acceptance/experience-evolution-story.test.ts）：两阶段装配 → 未声明能力的语义任务历史失败 ×2 → 冻结 → gold 归纳出 hasChangeIntent 特征路由 → 新 family 验证集双臂评估（候选臂 4/4、基线臂 1/4）→ operator 晋升 → 同类新表述任务被特征路由修复。

**让步与挂账（M4+）**：Consolidation 独立队列/取消策略首版为同步函数+显式预算参数（evolution.md §57 全量语义挂账）；验证 family 目前为仓内 fixture（家族与 dev 隔离经装载器断言），正式集移交验证负责人机制沿用实验规范；LLM 归纳与 E5 均不在本轮（已确认），M3 复用实验证据接口不继承其结论；docker 沙箱后端待接入（ubuntu CI 届时补真实沙箱用例）。
