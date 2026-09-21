# ProteusOS

承载长期、可适应智能的运行基质：让具有持续身份的个体执行任务、积累经验，并通过可验证、可继承、可回滚的产物变化改进行为。

## 当前状态（2026-09-21）

- **M0 已完成**：单 Organism 本地闭环——身份、不可变版本、GenomeSnapshot、有限 DAG（decision / execute / verify）、预算原子预留、崩溃恢复与对账、可重复 seed 安装。
- **M1 已完成**：外部委托——Claude Code 与 Codex 经 ACP（官方 agent 适配器）接入、pi 经官方 SDK 直连；委托编码 → 独立测试验收的完整闭环，真实 agent E2E 已验证。
- **M2 已完成**：最小自举——能力声明与缺口等待、能力经独立子进程加载、委托构建 → 不可变版本 → 候选快照、独立评估（任务/输入/裁判钉住）→ operator 批准 CAS 晋升 → 接替 Run 完成原任务 → 仅回滚到历史采用快照；ChangedFileSummary 七步自举故事 CLI 验收固化。132+ 项测试全绿。
- 下一步：[本体决策最小实验](./docs/experiments/organism-decision-v1.md)（设计已记录，待实现）——规则与单一 LLM 在固定任务上对照，分别验收工程正确性和决策收益，沉淀可追溯经验。
- 后续 M3：经验驱动演化（冻结经验集、Consolidation、多目标比较；前置：真隔离、裁判拆分独立晋升、评估独立预算池）；规则策略也可进入演化，LLM 收益不是硬前置。

## 快速开始

```bash
pnpm install
pnpm check                          # lint + format + typecheck + 全量测试
pnpm proteus init                   # 初始化实例（默认 ~/.proteus），安装 seed 并装载 G0
pnpm proteus submit <task.yaml>     # 提交任务并内联执行到终态
pnpm proteus runs [id]              # 列出 / 查看 Run
pnpm proteus recover / reconcile    # 崩溃恢复 / unknown Attempt 对账
pnpm proteus inspect <id>           # 按 ID 查看任意对象
```

真实外部 agent 的 E2E 测试默认跳过（消耗凭据）：`PROTEUS_E2E=claude|codex|pi|all pnpm test -- tests/e2e`。

## 文档

- 设计文档入口：[docs/README.md](./docs/README.md)
- 领域词汇：[docs/CONTEXT.md](./docs/CONTEXT.md)
- 自举路线、已决策事项与实现进度：[docs/roadmap.md](./docs/roadmap.md)

License：Apache-2.0
