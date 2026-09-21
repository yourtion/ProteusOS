# M2 最小自举：Candidate / Evaluation / Promotion 实现计划

## 总体思路

M0/M1 已备好的机制全部直接复用，不重造：CAS active 指针（`Kernel.installAsActive` → `Storage.setActiveGenome` 的 `UPDATE ... WHERE revision=?`）、不可变版本与快照（`registerVersion`/`createSnapshot` digest 幂等、`resolveSnapshot` 闭包解析、`snapshotDigest` 内容寻址）、Run 创建时固定快照、M1 委托构建链路（AcpExecutor/pi + 受控工作区 + test-runner 裁判 + trace）、裁判按快照产物内容分发（`readEvaluatorKind`）、事件投影模式（`appendEvent`）、同事务组合模式（`installSeed` 的 `storage.tx(() => { 指针切换 + 事件 })`）。

M2 新增四块：**能力声明与缺口等待**（Runtime）、**评估 Run 入口与能力执行**（Runtime）、**Evolution 模块**（build → collect → evaluate → promote/rollback/supersede 编排）、**Kernel.promote**（一次验证 + CAS + Promotion 记录 + operationId 幂等，同事务）。

已确认的两个决策：**执行隔离采用进程级**（node 子进程 + 受控工作区 + 超时，满足"独立进程协议加载、不热加载进 kernel"；真沙箱挂账 M3，写入 roadmap 与 ADR）；**接替编排用显式 `proteus supersede` 命令**（promote 保持纯晋升）。

## 端到端故事与机制映射（7 步）

| roadmap 步骤 | 机制 |
|---|---|
| ① R1 检查发现缺 ChangedFileSummary → 记录缺口 → 带截止点等待 | task.yaml 新增 `requires` 能力声明；准入事务内检查快照 bindings 是否含 `capability/<name>` 槽位；缺 → Run 直接以 `waiting` 创建（记录 missingCapabilities + waitingUntil）；`proteus advance <runId>` 到期结案 `failed/missing_capability` |
| ② 固定 builder 图委托编码 worker | Evolution 预注册 builder 快照（builder 图 + test-runner 裁判，digest 幂等）；`proteus build` 提交 builder Run（purpose=evaluation 绑 builder 快照，执行器可指定），复用 M1 委托链路；产出验收走 capability 测试 fixture |
| ③ 产出注册 ArtifactVersion → 构造候选 G1 | `collectCandidate` 采集 builder 工作区产出 → `capability-module-v1` 内容 → blob → `registerVersion`（parents 指向 G0 各版本）→ 预注册的 graph v2/policy v2/evaluator v2 组合 → `createSnapshot` G1 → Candidate 记录 + `candidate.proposed` 事件 |
| ④ 旧/新组合独立评估 | `evaluateCandidate` 跑 3 个 evaluation Run：G1×summary 任务（新能力验收，必须过）、G1×stats 任务（回归，必须过）、G0×stats（基线健康对照，防评估环境本身故障误判）；裁判由评估计划固定（evaluatorVersionId 覆盖），候选换裁判放水无效 |
| ⑤ operator 批准 CAS Promotion | `proteus promote` → evolution.promote（eligible 门 + 同事务 kernel.promote + 事件）；失败保持 G0 |
| ⑥ R1 failed 结案 + R2 接替 | `proteus supersede <runId>`：R1 finalize `failed/superseded` → 创建同 Task 修订的 R2（supersedesRunId=R1，绑当前 active=G1）→ R2 用新能力完成摘要 |
| ⑦ 回滚到 G0，R3 再验证缺口 | `proteus rollback` → 对 G0 做一次 kind=rollback 的 Promotion（revision 续增）；R3 提交后 waiting → advance → `failed/missing_capability`；R2/G1 记录不受影响 |

## 关键设计

### 1. 能力槽位与派发（不动 kernel 校验逻辑）

- 能力 = 快照槽位，槽位名 = `capability/<name>`（如 `capability/changed-file-summary`）。`createSnapshot` 已要求 artifact.kind === 槽位名，能力产物的 artifact kind 即为该全名，无需改 kernel。
- 能力产物内容（`capability-module-v1`）：`{ kind, name, entry: "index.mjs", files: [{path, content}] }`，执行合同与 stats-worker 一致：cwd=工作区，读 `inputs/`，写 `output.json`。
- 图骨架不变（route → execute → check）：G1 的 task-graph v2 只是 decision 节点 options 追加 `"capability/changed-file-summary"`；routing-policy v2 追加规则 `when: {"capability:changed-file-summary": true} choose: "capability/changed-file-summary"`（兜底 `{nodeType:"execute"}→local-process` 保留）。`runDecision` 构造 context 时把 task.requires 展开为布尔键（`capability:<name>: true`），rule-v1 的严格匹配零改动。
- `runExecute` 遇 `capability/` 前缀执行器名 → 新建 `src/runtime/capability.ts`（CapabilityRunner）：从 run 固定快照解析槽位版本 → 校验内容 schema → 落盘 `workspace/capability/<name>/` → `spawnSync(process.execPath, [entry])`（cwd=工作区、超时）→ 读 output.json。这是"独立进程协议加载"的隔离边界（进程级，真隔离挂账）。
- 回归语义：G1 下 stats 任务 requires 为空 → 无能力布尔键 → 路由到 local-process，走原路径原规则。

### 2. 评估 Run 入口（`submitTask` 扩展，不新增第二套 API）

```ts
interface TaskSubmission { /* 既有字段 */ requires?: string[] }
interface SubmitOptions {
  purpose?: RunPurpose;            // "evaluation" 时记录但不改 active（本来就不写）
  snapshotId?: string;             // 显式绑定候选/基线/builder 快照
  supersedesRunId?: string;        // R2 接替 R1
  evaluatorVersionId?: string;     // 仅 purpose=evaluation 允许：评估计划固定裁判，覆盖快照槽位
}
```
准入流程改造：固定快照（active 或显式指定）→ verifier binding 校验（按生效 evaluator 版本）→ **能力检查**：requires 中每个 `c` 要求 bindings 含 `capability/<c>`；缺 → 仍创建 Task/Run，Run 直接 `waiting`（runs 新列 missing_capabilities JSON、waiting_until），不执行图，返回 RunSummary。评估预算暂与 normal 共享 organism 池（purpose 标记区分），独立预算池 M3（注记记录）。

### 3. waiting 语义与截止

- `waiting(missing_capability)` 的 Run 固定自身快照，能力永远不会在自身快照中出现——出路只有两条：被 `supersede` 结案、或 `advance` 到期结案 `failed/missing_capability`。
- `advanceRun(runId)`：`now >= waitingUntil` → finalize failed；未到期 no-op。waiting(unknown_attempts) 仍归 recover/reconcile，不混。
- task.yaml `constraints.missingCapabilityWaitSeconds`（默认 3600，fixture 用短值测截止）。

### 4. 裁判：hybrid-acceptance-v1（预注册，非 builder 产物）

- 同一 `stats-acceptance` artifact 注册新版本，内容 kind 升为 `hybrid-acceptance-v1`：输出含 `files`+`totals` 结构时走既有 stats 校验（判定与 v1 等价），否则走纯 JSON Schema 校验（task 自带 schema）。artifactId 不变 → task.verifier 不变，stats 任务验收强度不降。
- **让步记录（ADR 0006）**：裁判版本与能力变化同处 G1 快照，严格派应拆两个候选；M2 折衷为"固定其中一方"——裁判 v2 由基质预注册，其与 v1 在 stats 上的判定等价性由独立 fixture（`tests/evals/`）验证后才允许进入候选组合；M3 拆分为裁判独立晋升。
- **防放水**：评估 Run 以 `evaluatorVersionId` 钉住预注册裁判，候选快照槽位放什么都影响不了评估裁判；normal Run（R2）仍用快照槽位裁判（放水候选在晋升前已被评估拦截）。

### 5. Kernel.promote（repository.md L61：一次验证，原子提交）

```ts
promote(input: {
  organismId; kind: "adopt" | "rollback"; toSnapshotId;
  expectedRevision; operationId; authorizedBy; evaluationRef?; note?;
}):
  | { result: "promoted"; promotionId; revision }
  | { result: "already"; promotionId; revision }   // operationId 幂等读回
  | { result: "stale"; currentRevision }
```
同一事务内：operationId 查重 → `resolveSnapshot(toSnapshotId)`（回滚目标依赖缺失被拒）→ principal 存在性 → CAS `setActiveGenome`（conflict → stale，不插记录）→ insertPromotion。KernelStore 扩展 `insertPromotion`/`getPromotionByOperationId`。事件仍由调用方（evolution）在同事务追加，与 installSeed 模式一致。

### 6. Evolution 模块（`src/evolution/`，依赖 kernel + runtime 提交合同，不被 runtime 反向导入）

- `assets.ts`：预注册资产模板（graph v2 / policy v2 按能力名生成、evaluator v2、builder genome、评估协议 blob `m2-bootstrap-eval-v1`），全部走 digest 幂等注册——同内容跨实例同摘要，保持 seed 可重复精神。
- `build`：提交 builder Run（绑 builder 快照，prompt=实现规范，规范明示仅可写工作区、不涉 seed 裁判与 kernel）。
- `collectCandidate(builderRunId, {name, hypothesis, proposedBy})`：builder Run 必须 succeeded（测试失败不能构造候选）→ 采集约定产出路径 → capability-module → registerVersion（parents=G0 对应版本）→ createSnapshot G1 → Candidate 记录（按 proposed_snapshot 去重）+ `candidate.proposed` 事件。状态（proposed/evaluating/eligible/rejected/stale/adopted）由 `candidate-<id>` 事件投影，不物化 status 列（domain-model L98）。
- `evaluateCandidate`：3 个 evaluation Run（§总体思路表④），evaluations 记录 verdict=eligible/rejected/**inconclusive**（基线对照失败=评估环境不可信，不判 rejected，可重评；"证据不足不能记通过"）；metrics 按成功/回归/时延分列，不合成总分，成本记 null。
- `promote(candidateId, {authorizedBy, operationId})`：投影必须 eligible → 同事务（证据校验 + kernel.promote(kind=adopt, expectedRevision=candidate.baseRevision) + `candidate.adopted`/`organism.genome.promoted` 事件）；CAS conflict → `candidate.stale` 事件，旧记录保留。
- `rollback({toSnapshotId, authorizedBy, operationId, note})`：kind=rollback 的 promotion，revision 只增不减。
- `supersedeRun(runId, note)`：R1 finalize `failed/superseded` → `submitTask(同 task 字段, { supersedesRunId })` 创建 R2（绑当前 active），taskRevision+1。

### 7. 数据模型（migration v3，一次加齐）

```sql
ALTER TABLE tasks ADD COLUMN requires TEXT NOT NULL DEFAULT '[]';
ALTER TABLE runs  ADD COLUMN missing_capabilities TEXT;
ALTER TABLE runs  ADD COLUMN waiting_until INTEGER;
CREATE TABLE candidates (id PK, organism_id, base_snapshot_id, base_revision,
  proposed_snapshot_id, hypothesis, proposed_by, source_refs/*JSON:builder run等*/, dataset_ref, created_at);
CREATE TABLE evaluations (id PK, candidate_id, protocol_digest, baseline_snapshot_id,
  runs/*JSON 逐Run结果*/, verdict/*eligible|rejected|inconclusive*/, metrics/*JSON 分列*/, created_at);
CREATE TABLE promotions (id PK, operation_id UNIQUE, kind/*adopt|rollback*/, organism_id,
  from_snapshot_id, to_snapshot_id, expected_revision, result_revision,
  evaluation_ref, authorization_ref, actor, note, created_at);
```

### 8. CLI 新命令 + inspect 扩展

`proteus build --capability <name> --spec <file> [--executor <name>]`（默认 claude-code-acp，测试传 fake-acp）、`candidates [id]`、`evaluate <candidateId>`、`promote <candidateId> --as <principal> [--operation-id]`、`rollback --to <snapshotId|digest> --as`、`supersede <runId>`、`advance <runId>`；inspect 支持 candidate/evaluation/promotion。

## 实施切片（每片实现+测试+独立提交，`pnpm check` 全绿后收官）

1. **切片①：能力声明、缺口等待与截止结案**——task-file（requires/waitSeconds）、migration v3、Runtime 准入检查→waiting、advanceRun、CLI advance。测试：waiting 创建、advance 未到期 no-op、到期 `failed/missing_capability`、无 requires 任务不受影响。
2. **切片②：评估 Run 入口与能力执行**——SubmitOptions、CapabilityRunner、decision context 能力布尔键、evolution/assets.ts 雏形（graph/policy v2、evaluator v2 预注册）。测试：绑指定快照不改 active、purpose=evaluation、capability Run 产出、G1 下 stats 回归路由、evaluatorOverride 生效。
3. **切片③：委托构建与候选构造**——builder genome、build 编排、collectCandidate、Candidate 记录与状态投影。测试：fake builder 成功→候选（digest 去重）；BUGGY builder→Run failed→collect 拒绝；投影 proposed。
4. **切片④：独立评估与晋升、接替**——evaluateCandidate、kernel.promote、evolution.promote、supersedeRun、CLI。测试：unit（kernel.promote 幂等/stale/principal/快照缺失）+ integration（三 Run 评估、rejected 保留证据、inconclusive、放水候选被固定裁判拦截、评估门禁晋升、双候选一胜一 stale、operationId 幂等读回 revision 不增、supersede R1→R2 绑 G1）。
5. **切片⑤：回滚、端到端验收与文档收官**——rollback 命令、`tests/acceptance/m2.test.ts` CLI 驱动完整 7 步故事（含回滚后 revision 续增、旧并发晋升请求仍 stale、R2 记录不被回滚抹去）、`tests/evals/` 裁判等价性、PROTEUS_E2E 门控的真实 builder 自举用例、文档全套（ADR 0006、roadmap 进度与待验证项三行更新——隔离/晋升权限/评价指标、runtime.md 与 evolution.md 实现注记、repository.md 目录）。

## 失败场景覆盖（roadmap §4 M2 各行 → 测试落点）

候选测试失败/输出不合法/依赖缺失→禁止晋升旧默认有效（切片③④）；双候选同 revision→一胜一 stale（④）；Promotion 成功响应丢失→operationId 读回 revision 不增（④）；Run 执行期间默认版本变化→原 Run 原快照（①②既有+waiting R1 固定 G0）；候选换 evaluator 降门槛→固定裁判拦截（④）。

## 已记录的让步（ADR 0006 + roadmap 待验证项更新）

进程级隔离（真沙箱 M3）；hybrid 裁判与能力同快照（等价性 fixture 验证 + M3 拆分）；评估预算共享池（purpose 标记，独立池 M3）；评估指标 M2 固定为 m2-bootstrap-eval-v1 协议（成功/回归硬约束 + 时延分列，成本记 null 待真实数据）。
