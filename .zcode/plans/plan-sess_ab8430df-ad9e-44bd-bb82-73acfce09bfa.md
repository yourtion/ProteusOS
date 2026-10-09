# M3 经验驱动演化：实现计划

## 依据与已确认决策

文档约定（roadmap:32、evolution.md §3/§6/§9、experiments/organism-decision-v1.md §11、ADR 0007）：M3 = 冻结经验集 + Consolidation + 规则/Skill/Graph 候选 + 固定验证集 + 多目标比较；完成判据 = 「从历史失败提出改进，在独立任务上比较基线，保留可复验结果；证据不足可以不晋升」。三项前置：真隔离、裁判拆分独立晋升、评估独立预算池。实验文档 §11 预设：**首个候选只改路由 Policy，执行能力与裁判固定**。

已确认：**真隔离用现成开源沙箱（首个后端 microsandbox，SandboxBackend port 可替换，docker 后端后续接入）**；**首个学习场景 = 路由策略归纳**（决策实验 R 组在 dev fixture 上的弃权/失败经验为学习材料）；**Consolidation 首版纯规则确定性归纳、不调 LLM；E5 继续留给验证负责人，M3 只复用证据接口不继承结论**。

环境事实：本机 macOS arm64 + Docker Desktop（daemon 未运行）；CI ubuntu+macos 双矩阵——ubuntu 无 KVM（microsandbox 不可用，docker 可用）、macos runner 可跑 microsandbox。沙箱真实用例按环境门控（`PROTEUS_SANDBOX=microsandbox`），CI macos lane 增设该 env；合同正确性用可注入 fake backend 全环境覆盖。

## 架构设计

### 1. Sandbox 层（切片①）

```ts
// src/runtime/sandbox.ts
export interface SandboxProfile { network: "none"; timeoutMs: number; }
export interface SandboxRunRequest { command: string[]; hostWorkspace: string; profile: SandboxProfile; }
export interface SandboxBackend {
  readonly name: string;                      // "microsandbox" | "docker" | "bare-process"
  available(): Promise<{ ok: boolean; reason?: string }>;
  run(req: SandboxRunRequest): Promise<{ exitCode: number | null; stdout: string; stderr: string; durationMs: number }>;
}
```

- **MicrosandboxBackend**：官方 `@microsandbox/msb-sdk`（实现时以 context7 文档核对 API），每次能力执行一次性 VM：同步工作区入 → `network: none`、资源限制下执行 `node capability/<name>/<entry>`（cwd=工作区）→ 回收 output.json。文件交换细节若 SDK 不满足则回退 `msb` CLI；两者都不行则本切片直接改做 docker 后端（本机启动 Docker Desktop），port 不变。
- **bare-process 后端**：现 CapabilityRunner 行为，显式命名“非真隔离”；实例配置 `capabilityExecution: "sandbox" | "bare-process"`。选 sandbox 而后端不可用 → 执行前拒绝（错误明确），**不静默降级**。
- 集成点：`RuntimeDeps.sandbox`；CapabilityRunner 按配置分流。评估 Run 与 M3 策略评估走 sandbox（真隔离进入“候选进入默认行为前”的链路）。
- 测试：合同测试（fake backend：调用约定/超时/输出回收/拒绝语义）全环境；真实 microsandbox 用例门控（本机 + CI macos lane）。

### 2. 前置②：评估独立预算池（切片②）

- `OrganismBudget` 拆双池：现有字段语义化为 normal 池，新增 evaluation 池配置（独立并发/Attempt/墙钟上限）；`countActiveRuns`/`inFlightBudget` 增 scope（SQL 按 runs.purpose 过滤），`assertOrganismBudget` 按 Run purpose 取池。决策调用额度（v5 已有）不动。

### 3. 前置③：裁判拆分独立晋升（切片②）

- 新 `ensureJudgeGenome(deps, { baseSnapshotId, evaluatorContent, createdBy })`：只升 acceptance-evaluator 的候选快照（G0→G_eval），其余槽位继承。
- `ensureCapabilityGenome` 改造：**不再注册 evaluator 新版本**，继承 base 的 evaluator；组合前校验 base evaluator 为 hybrid-acceptance-v1（否则报错“先晋升裁判候选”）——裁判与能力变化拆为两次独立 Candidate→Evaluation→Promotion（evolution.md:101 的正式兑现）。
- 自举链变为 G0 --(judge 候选)--> G_eval --(capability 候选)--> G_cap；M2 七步验收故事与 m2 文档同步更新（两阶段），tests/evals 等价性证明继续作为裁判候选的评估证据。

### 4. 冻结经验集（切片③）

- migration v6：`experience_datasets` 表（id、digest UNIQUE、purpose: development|validation|regression、cutoff_at、member_experience_ids JSON、member_digest、filter_version、permission_scope、created_by、created_at）。
- `Evolution.freezeExperienceWindow({ purpose, cutoffAt?, runIds? })`：显式成员清单（默认 cutoff 前全部终态 Run 的 experience，排除 plumbing-test）+ 内容摘要（成员 canonical 摘要的摘要）→ 不可变记录 + `dataset.frozen` 事件。**固定成员而非查询语句**（domain-model:86）。
- 学习投影视图 `experienceDatasetView(datasetId)`：experience × decision_calls（请求/响应/features/abstain 原因）× budget（预留/结算）× run/task join——Consolidation 的唯一输入。CLI `proteus dataset freeze|list|inspect`。

### 5. Consolidation 与策略候选（切片④）

- `src/evolution/consolidation.ts`：`consolidateRoutes(view, params)` 纯函数确定性归纳——对决策弃权/路由失败的 case，按 decision-view features（词表命中集合）统计「特征子集 S → 应选选项 O」的支持数与精度（support ≥ minSupport 且 precision ≥ minPrecision 才提议），输出候选提议 [{ featureRoutes, hypothesis, evidenceRefs, supportStats }]；候选数、扫描预算、停止条件全部为显式参数（预限制，evolution.md:97）。
- `Evolution.proposePolicyCandidate({ datasetId, params, createdBy })`：跑归纳 → 新 routing-policy 版本（rule-choice-v1 featureRoutes，parents 指向当前版本）→ 候选快照**只改 routing-policy 槽位**（执行能力与裁判固定）→ Candidate（sourceRefs: datasetId + datasetDigest + params digest + 规则摘要；hypothesis 记录「从 N 个弃权样本归纳，支持度/精度」）。

### 6. 策略评估与 M3 收官（切片⑤）

- **新验证 family**：复用 `tests/fixtures/decision/generate.mjs` 生成 `tests/fixtures/decision/validation/`（family 与 dev 完全隔离，装载时 `assertFamilyIsolation` 断言；purpose=validation 固定入库）。
- **评估协议 m3-policy-eval-v1**（复核升级 m2 协议，构造候选前固定）：双臂（base policy vs candidate policy 快照，各自 purpose=evaluation 绑定 + sandbox 执行 + 独立预算池）× 验证集 cases × repeats（固定种子）→ 指标**分列**：成功率、弃权率、弃权正确率、invalid_output 数、时延 p50/p95、跨 repeat 方差；门槛参数显式（最小改善幅度、每臂最低有效样本数）；证据不足（样本不足/方差不收敛）→ inconclusive。held-out 使用计数经 evaluations.dataset_ref 查询跟踪。
- `EvaluationRecord` 扩展：`datasetSplitRefs`、`uncertainty`（domain-model:94-95 对齐）。
- **M3 端到端验收故事**（tests/acceptance/m3.test.ts）：① R 组跑 dev 子集产生弃权/失败经验 → ② 冻结经验集（成员+摘要+截止点）→ ③ Consolidation 归纳 featureRoutes → 只改 routing-policy 的候选 → ④ 新验证 family 双臂×repeats 评估 → eligible（改善达标）→ ⑤ operator promote → 新 Run 用新策略正确路由历史失败类输入 → ⑥ 反向故事：证据不足（门槛未达/样本不足）→ 不晋升，旧默认继续有效。
- **ADR 0008**（收口文档）：冻结经验成员与摘要规则、开发数据与独立验证 family、可修改策略字段（仅 routing-policy featureRoutes）、Consolidation 候选数/预算/停止条件、收益与回归门槛、Candidate→Evaluation→operator Promotion 关系、sandbox 后端选型与替换边界；roadmap/evolution/experiments 文档对齐。

## 实施切片（每片实现+测试+独立提交，check 全绿）

1. **切片①**：SandboxBackend port + MicrosandboxBackend（SDK/CLI，回退 docker）+ bare-process 显式化 + 配置拒绝语义 + 合同测试 + 门控真实用例 + CI macos lane 加 env
2. **切片②**：评估独立预算池 + 裁判拆分两阶段晋升（ensureJudgeGenome / 组合函数改造 / M2 故事更新为两阶段）
3. **切片③**：冻结经验集（migration v6 + freeze + 学习投影 + CLI dataset）
4. **切片④**：Consolidation 确定性归纳器 + proposePolicyCandidate（只改路由策略的候选）
5. **切片⑤**：验证 family 生成 + m3-policy-eval-v1 双臂多目标评估 + M3 端到端验收故事 + ADR 0008 + 文档收官

## 失败场景覆盖（roadmap §4 对应 + 新增）

- sandbox 不可用时拒绝执行不静默降级；评估 Run 全程真隔离可审计
- 双候选同基准竞态（M2 既有 CAS 继续覆盖，策略候选同样适用）
- 评估预算耗尽/样本不足 → inconclusive 不判通过；held-out 复用计数可见
- Consolidation 无达标准则 → 零候选提议是正常结果（“不晋升成为正常结果”）
- 回归：既有能力与裁判在两阶段晋升中每步都有独立评估兜底

## 风险与让步记录

- microsandbox 为 beta：以 port 隔离替换成本；SDK 文件交换不满足则回退 CLI，再不满足本切片改做 docker 后端（用户已确认后续接 docker，port 不变）
- CI ubuntu lane 在 docker 后端接入前无真实沙箱用例（合同测试由 fake backend 覆盖）
- Consolidation 独立队列/取消策略（evolution.md:57 全量语义）首版为同步函数+显式预算参数，异步队列挂账
- E5 与 LLM 归纳均不在本轮（已确认）
