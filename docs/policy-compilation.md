# 有界示例编译：作业、调用与唯一候选

更新：2026-10-24。对应 M6a-02，承接 [示例参数合同](./compiled-policy.md) 与 [实验冻结协议](./experiments/adaptive-behavior-v1.md)。当前交付是可运行的编译 API、持久化作业/调用、离线报告和 fixture 验收；真实模型兼容、正式三臂效果评价和采用仍未运行。

## 1. 接口与模块归属

入口为 `instance.evolution.compiler`，实现见 [PolicyCompiler](../src/evolution/policy-compiler.ts)。它使用现有 Kernel 版本/快照、冻结 ExperienceDataset、学习调用额度和 Candidate 表，新增编译作业与逐次记录，不复用生成规则的 Consolidation 参数。

| API | 行为 |
| --- | --- |
| `registerCase` | 把获许可 normal 经验明确标注为 train 或 search，核验原调用/任务/验收与摘要，记录 operator 和标签 |
| `submit` | 冻结数据、基线/视图/示例池、参数网格、正式计划、预算、指标和选择规则，返回 queued 作业；相同清单幂等 |
| `run(jobId)` | 原子领取 queued 作业，串行调用后端，在完整搜索结束后生成至多一个候选；重复调用终态作业只读回 |
| `job` / `report` | 读取状态、完整 CompileTrial 和离线重算的 CompileReport，不调用模型 |
| `cancel` | queued 直接结案，running 记录取消并传播 AbortSignal；阻止候选生成 |
| `recover` | operator 停止其他 worker 后恢复中断作业；当前进程仍活跃时拒绝恢复 |

策略/响应合同归 Decision，服务正文渲染归 Adapter，编译与候选治理归 Evolution，SQL 归 Storage，后端在 app 装配。编译只对受限视图调用一个 `choice` 模块，不生成代码、不执行搜索任务 worker、不修改图、工具或裁判；端到端任务收益另由正式阶段评价。

SQLite migration 15 新增 `policy_compile_cases/jobs/trials` 三表，保留已有表和记录格式。每次编译推断同时进入既有 `learning_calls`；与旧 LLM 归纳共用 Organism 的累计学习调用池，换作业 ID 不会获得新额度。

## 2. 来源准入与隔离

先用现有 `freezeExperienceWindow(purpose=development)` 固定 normal 经验，再调用 `registerCase`。需要 dataset/run/decision/case 引用、显式 family、train/search 用途、synthetic/permitted 许可、独立 expectedChoice 和 verifiedBy。

准入检查包括：

- 当前主体及标注者有个体操作权；经验属于当前个体、冻结成员仍完整且摘要一致。
- 原调用是可重放的 choice，保留完整请求/响应 blob 与摘要；视图、原任务及输入/期望结果内容均可核对。
- train 的 value 必须等于独立标注，原任务成功且有完整 expectedOutput 验收；不能仅以 schema 合法或 Run 最终成功猜测选择正确。train 的弃权必须明确来自模型，服务 refusal 不作正确示例。
- 训练/搜索输入的公开特征、选项与描述均匹配当前冻结视图。只接收本地 stats / changed-file-summary 的确定性执行来源；未知 Agent 内部调用不能隐去。
- 同一 experience 不能改标签/用途/许可重新包装，同一 family 或精确任务/视图内容不能跨 train/search；相同视图不能改名为独立 family，caseId 不重复。

示例由 train 的实际规范化响应构造，verificationRef 指向已核验 Case 记录。search 标签由宿主评分使用，不进入示例或模型正文。正式计划在搜索前注册，所有 formal/regression family 与开发经历隔离；它的任务、标签和反馈不传给后端。当前正式计划仅作隔离和后续候选绑定，搜索不领用 usageCount。

精确任务/请求摘要不能证明所有语义近似都已被分到同一 family，独立资料负责人仍须检查真实数据。仓库 fixture 是公开工程资料，不宣称真实 held-out 证据。

## 3. 搜索与选择

首轮基线是现有单一 `decision-llm` choice 图和 `llm-choice-v1` 策略；所有配置继承它的模型、提示、采样、视图和 schema。每个配置生成 M6a-01 的示例策略版本，只改 demoIds，保留基线/视图依赖及私有权限。只在最终获胜时组合候选快照，不修改 activeGenome。

提交时显式冻结 **2–8 组参数**，第一组必须为 `[]`（零示例基线）；其他组只能从冻结 train 池中选取至多 8 条示例并排序。train/search 各 1–32 个 Case，池与完整请求继续受 M6a-01 的字节界限约束。重复配置、未知示例 ID、把 search 当 demo 都在调用前拒绝。

搜索是冻结网格的顺序枚举，不调用额外的模型优化器：配置顺序 × search case 顺序，每个单元独立上下文、一次调用，无自动重试。每个 family 内先平均 case 正确率，再在 family 间等权平均；同族改写不会增加独立 family 数。

评分只把合法、匹配标注的 value 或明确模型弃权算正确；服务拒绝、非法输出、传输失败和 unknown 不算正确弃权。获胜规则固定为：完整搜索达到 minAccuracy，且相对零示例基线至少提高 minImprovement；同分优先示例更少，再按冻结配置顺序。未达门、基线最好、取消、失败或搜索不完整都不生成候选。零改善是 completed/零候选的正常结果。

## 4. 预算、后端与来源费用

`CompileBackend` 是 app 注入的受信宿主端口，包含 fixture/real 模式、version、DecisionProvider，以及针对实际完整请求返回 input/output tokens 硬上界的 `bounds`。上界须由宿主/服务可验证地约束，不能把字符数、平均 token 比率或估算当作保证；输出预留不能低于固定 maxOutputTokens。

**缺少后端或可核验上界时，作业在发送前失败。** 当前没有从 API key 自动构造这种保证，也没有把原生 LLM Adapter 包装成“已支持真实硬预算”。fixture 后端没有网络，使用固定用量和可控的边界验证工程路径；真实接入是下一阶段的前置。

编译清单固定 maxCalls、maxInputTokens、maxOutputTokens、wallClockMs、callTimeoutMs：

- 原始 train/search 收集调用的已知模型用量也分配到本轮，不摊薄为零；来源模型 tokens 未知时拒绝冻结硬预算。已有 local 规则来源不冒充远程模型调用。
- 计划来源调用数加网格调用数须在总调用额度内；每次新单元在同一事务检查/预留剩余调用、input/output tokens 和个体累计学习额度，并写入 learning_calls 与 prepared Trial。
- 每次预留完整硬上界，完成后也不退还差额；unknown、超时、取消不获得新额度。预算不足立即停止，保留未完成分母，不用部分配置选候选。
- 第一次启动时固定绝对 deadline，重启不延长；单次超时取 callTimeoutMs 与全作业剩余时间的较小值。
- 后端 version/provider/Adapter/端点从首次预留固定，切配置或恢复不能换服务。后端违反 token 上界时保留已知响应与超额用量，停止作业且不生成候选。

CompileReport 分列来源决策、编译调用预留/实际已知 tokens、未知用量、分币种且有价格依据的费用，以及来源本地执行时长和 Attempt 证据。未知执行费用单独计数，不把本地 worker 当作免费，也不把这个模块报告称作整个任务生命周期的精确总费用。

真正的 adaptive-behavior-v1 实验还须把编译报告与正式三臂的 Run/Attempt 资源合并，在首次真实调用前验证全轮 800 次等上限；不能给编译和正式阶段各自重置一份预算。使用已经有模型收集开销的来源时，同样必须扣除它；额度不足不能临时扩预算。

## 5. 持久化、取消、恢复与权限

报告明确列出后端的 fixture/real 配置模式；这不是对远端成功或计费的保证，实际状态仍查看逐次记录。CompileTrial 保存配置/case/family、策略版本、LearningCall ID、完整请求引用/摘要、prepared 正文、后端来源、硬预留、状态、响应引用/摘要、分类、正确性及用量/servedModel。模型凭据不落入正文。网络在数据库事务外执行。

| 中断位置 | 恢复行为 |
| --- | --- |
| prepared 与 learning 预留已提交，尚未 started | 沿原 Trial/Call ID、正文、预留和截止点首次发送，不重复预留 |
| started 已提交，结果保存前中断 | Trial 和 LearningCall 记 unknown，作业 failed，不自动重发 |
| 已有部分 completed Trial，当前无未知调用 | 重新排队，只补剩余未开始单元 |
| 全部搜索完成，候选事务尚未提交 | 不再调用模型，只补完整选择与候选事务 |
| 候选、正式计划绑定、completed 作业和报告已提交 | 重复 run 只读回同一候选 |

结果 Trial 与 learning_calls 同事务保存；候选、计划绑定、作业完成与最终报告也在同事务。任何取消标记在候选提交前重新检查。对未知调用不会因迟到值改变终态或生成候选。当前版本不将迟到正文重新纳入报告或搜索评分。

个体、基线/依赖和来源版本的权限在准入、每个单元及发送前重新检查；中途撤权阻止后续调用和候选生成。内部仍保存停止/用量证据；公开 report 另按读取者核对版本权限，不借报告绕过私有策略读取限制。

清单、Case、调用请求/响应和报告都有冻结内容或摘要引用；读取终态报告不依赖源工作区仍存在，也不发请求。恢复时必须保持冻结来源可核验，缺失、修改或端点漂移都会停止。

## 6. 候选与正式评价

至多一个获胜配置形成 `candidateType=compiled-policy`，关联 compileJobId/planDigest 和预注册正式计划。搜索报告不是 Evaluation，正式集 usageCount 保持 0，activeGenome 不变。

旧的 `evaluate-policy` / `m3-policy-eval-v1` 不接收这一新类型，防止搜索候选绕过新协议的独立 family、三臂与全成本门。没有正式 eligible Evaluation 时不能 promote。M6a-03 仍需接通 adaptive 协议正式评价与采用桥接；本切片不通过放宽旧门槛来填补这一空缺。

调用示意（具体 source IDs 来自受许可实例；backend 由宿主提供真实约束或使用工程 fixture）：

```ts
const app = openInstance(home, { compileBackend: backend });
const compiler = app.evolution.compiler;
const verified = compiler.registerCase({
  datasetId, runId, decisionId, caseId: "example-1", split: "train",
  permission: "synthetic", expectedChoice: "local-process", verifiedBy: actor,
});
const { job } = compiler.submit({
  trainCaseIds: [verified.id], searchCaseIds, validationSetId,
  parameterSets: [[], [verified.id]], budget,
  thresholds: { minAccuracy: 0.9, minImprovement: 0.05 }, requestedBy: actor,
});
await compiler.run(job.id);
const report = compiler.report(job.id);
app.close();
```

## 7. 验收与当前结论

```bash
env -u PROTEUS_E2E -u PROTEUS_SANDBOX PATH="/opt/homebrew/bin:$PATH" \
  /opt/homebrew/bin/node node_modules/vitest/vitest.mjs run \
  tests/unit/compile-report.test.ts tests/integration/policy-compiler.test.ts \
  tests/unit/llm-demos-policy.test.ts tests/integration/consolidation-recovery.test.ts
```

[集成验收](../tests/integration/policy-compiler.test.ts) 覆盖唯一候选/幂等、零改善、来源/用途隔离、预算耗尽、不可信上界零发送、后端违约、取消/迟到、超时、三处崩溃点、并发领取、版本撤权及后端漂移。[纯报告验收](../tests/unit/compile-report.test.ts) 覆盖 family 等权、同分选择、完整分母、未知用量和分币种费用。[fixture](../tests/fixtures/compilation/harness.ts) 的源执行使用真实 SQLite 与本地 worker，编译推断全部为无网络 fake。

工程通过不代表真实 LLM 路由收益。真实兼容、独立正式效果和采用均为 not_run；下一步 M6a-03 先满足后端预算保证、独立资料与全轮冻结，再执行真实效果验证，证据不足时保留原基线。
