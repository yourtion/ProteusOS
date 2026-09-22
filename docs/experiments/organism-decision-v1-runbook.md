# 本体决策实验 v1：执行说明（E1–E4 交接记录）

状态：**E1–E4 已实现并通过工程验证（2026-09-22）**；真实模型调用未执行（缺少凭据，见下）。
本文是 [organism-decision-v1](./organism-decision-v1.md) 的执行说明与实现交接，
基准实现 commit 见仓库历史（`feat(experiment): organism-decision-v1 E1–E4`）。

## 1. 服务协议与依赖锁定（E4）

| 项 | 值 |
| --- | --- |
| 服务协议 | Anthropic Messages（官方协议，经 baseURL 指向兼容端点） |
| SDK | `@anthropic-ai/sdk@0.127.0`（锁定于 package.json；自动重试关闭 `maxRetries: 0`） |
| 默认端点 | `https://api.z.ai/api/anthropic`（操作者现有 Z.ai coding plan 配置的 GLM 入口） |
| 冻结模型 | `GLM-5.3-Flash`（`llm-choice-v1` 策略产物内容，快照槽位版本化） |
| 冻结采样 | `temperature=0`，`maxOutputTokens=256`（输出上限按协议 §4.2） |
| 复现限制 | `reproducibility=recorded-inputs-only`（模型权重无法钉住） |

提示模板、服务/模型标识与采样参数**全部**来自快照 `routing-policy` 槽位的
`llm-choice-v1` 产物（`src/decision/llm-policy.ts` 的 `FROZEN_LLM_POLICY`，
按内容摘要幂等注册）；env 只注入凭据与端点，配置漂移会被恢复路径的
`decision_policy_drift` / `decision_request_drift` 检查拒绝。

## 2. 配置变量与启动方法

```bash
# 必需：真实调用凭据（缺失时 --llm real 预检失败退出码 2，fake 路径不受影响）
export PROTEUS_LLM_API_KEY=<你的 Z.ai API key>
# 可选：覆盖端点（默认 https://api.z.ai/api/anthropic）
export PROTEUS_LLM_BASE_URL=https://api.z.ai/api/anthropic
# 可选：实现 commit 记录（写入决策调用 provenance）
export PROTEUS_COMMIT=$(git rev-parse HEAD)
# 代理（本机外网经 127.0.0.1:8090；Node ≥24 需显式开启 env 代理）
export NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:8090
```

### 命令序列（按实验规范 §6）

```bash
# 0) 日常 CI / 工程验证（无凭据，含 D01–D15 场景与 M0–M2 回归）
pnpm check

# 1) 工程预检 + 开发调试（只允许 dev 数据集；真实调用计入开发额度 ≤100 次）
proteus experiment run \
  --dataset tests/fixtures/decision/dev \
  --out <dev-out-dir> \
  --llm real --oracle \
  --experiment-id <dev-exp-id> \
  --experiment-calls 100 --organism-calls 1000 \
  --repeats 1 --json

# 2) 只读复算报告（不调用模型）
proteus experiment report <dev-out-dir> --dataset tests/fixtures/decision/dev --json

# 3) 正式比较（E5 验证负责人在冻结 commit 上执行；300 次真实调用上限内置为
#    experiment-calls 默认值，墙钟 60 分钟默认值）
proteus experiment run \
  --dataset <formal-dataset-dir> \
  --out <formal-out-dir> \
  --llm real --oracle \
  --experiment-id <formal-exp-id> --seed 20260921 --json
proteus experiment report <formal-out-dir> --dataset <formal-dataset-dir> --json

# 4) 未结决策调用的显式取消结案（保留 unknown 证据与未结算费用）
proteus settle-decision <decisionId> --note "operator 结案说明"
```

中断恢复：`experiment run` 使用原 `--experiment-id` 重新执行，只补未开始的
`(arm, caseId, repeat)` 单元，不覆盖旧结果；额度持久化于实例数据库，重启与
更换 experimentId 均不重置 organism 域计数。

## 3. 退出码

| 命令 | 码 | 含义 |
| --- | --- | --- |
| `experiment run` | 0 | 完成（收益结论可能是 not_demonstrated/inconclusive——实验完成不等于收益证明） |
| `experiment run` | 2 | 工程/预检失败（数据集校验、capability 模块、Oracle 预检、真实配置缺失） |
| `experiment run` | 3 | 不完整（墙钟/额度中止），收益结论 inconclusive，保留部分证据 |
| `experiment report` | 0 | 工程证据链完整（engineering=passed） |
| `experiment report` | 2 | 证据问题（manifest 摘要漂移直接抛错；重复/缺失/损坏行列出并判 failed） |

## 4. 已冻结的唯一配置（E1–E4 记录）

- **规则基线（R 组）**：`rule-choice-v1`——`hasStatsIntent`/`hasChangeIntent`
  单侧命中选择、双侧/零侧 abstain；词表版本化于 `decision-view` 槽位
  （`src/app/experiment/assets.ts` 的 `DECISION_VIEW_CONTENT`），初始词表即
  协议 §3.3 建议值。未做开发集调参（真实调用未发生），如 E5 前需要修订，
  修订后必须重走冻结流程并在 manifest 记录新版本。
- **LLM（L 组）**：`llm-choice-v1`——上表冻结值；提示模板
  `src/decision/llm-policy.ts` 的 `DEFAULT_LLM_PROMPT_TEMPLATE`。
- **共享**：`decision-view-v1`（16 KiB 上限）、固定裁判
  `hybrid-acceptance-v1`、能力 `capability/changed-file-summary`
  （`tests/fixtures/decision/capability/changed-file-summary.module.json`，
  内容与 M2 验收 fixture 同源）。

## 5. E4 未执行条件（真实验证缺什么）

1. `PROTEUS_LLM_API_KEY` 未配置（本机无可用明文凭据；ZCode 自有加密凭据
   不属于 ProteusOS 可用配置，未使用）。
2. 因此：**开发阶段真实调用 0 次**（协议 §4.2 的 100 次开发额度未消耗），
   词表/提示的"开发集调参"环节未发生——当前冻结值即初始值。
3. E5 交付时报告 `realModel=not_run`、`benefit=inconclusive`；补齐凭据后
   依本文命令序列执行，再由验证负责人复算。

## 6. 开发数据集与 E5 交接

- 开发集：`tests/fixtures/decision/dev/`（40 case / 36 family / 36 bundle，
  生成器 `tests/fixtures/decision/generate.mjs`，期望输出按能力规范独立计算）。
- 管道演练集：`tests/fixtures/decision/plumbing/`（同内容，`datasetPurpose=
  plumbing-test`，供全数量 fake 演练，不与独立验证混合）。
- **E5 验证负责人**须另备 100 个正式样本（80 可执行 + 20 弃权），family 与
  开发集完全不重叠（数据集装载器支持 `assertFamilyIsolation` 校验），
  gold 标签由 evaluator 单独加载；本仓不包含正式集内容。
- 实验 runner/reporter 入口即上文命令；证据聚合校验唯一键
  `(experimentId, arm, caseId, repeat)`，重复/缺失/损坏行显式列出。

## 7. 实现落点（对照规范 §2 差距表）

| 位置 | 内容 |
| --- | --- |
| `src/decision/view.ts` | decision-view-v1 构造/校验/词法特征/16KiB 上限 |
| `src/decision/response.ts` | 严格响应解析（围栏/额外字段/未知 ID 全拒） |
| `src/decision/call.ts`、`llm-policy.ts` | 调用记录合同、llm-choice-v1 冻结合同 |
| `src/adapters/decision-rule/` | rule-v1 语义保持 + rule-choice-v1 基线 |
| `src/adapters/decision-llm/` | 真实 Adapter（Anthropic Messages，取消/用量/refusal） |
| `src/runtime/index.ts` | 决策调用生命周期、同事务提交、deadline/取消/额度、恢复与 settle |
| `src/storage/migrations.ts` v5 | decision_calls 账本、decision_call_limits、runs.deadline_at/experiment_id |
| `src/app/experiment/` | 快照构造、数据集装载、runner（Oracle/trials）、reporter |
| `src/app/cli.ts`、`commands.ts` | `experiment run/report`、`settle-decision` |
| `tests/contract/decision-contract.test.ts` | D01/D03/D04/D10 合同层 |
| `tests/integration/decision-runtime.test.ts` | D05–D09/D12/D13（真实 SQLite） |
| `tests/acceptance/organism-decision.test.ts` | D02/D11/D14/D15 + Oracle 预检 + 240-trial fake 演练 |
