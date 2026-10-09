# ProteusOS

承载长期、可适应智能的运行基质：让具有持续身份的个体执行任务、积累经验，并通过可验证、可继承、可回滚的产物变化改进行为。

## 当前状态（2026-10-10）

- **M0 已完成**：单 Organism 本地闭环——身份、不可变版本、GenomeSnapshot、有限 DAG（decision / execute / verify）、预算原子预留、崩溃恢复与对账、可重复 seed 安装。
- **M1 已完成**：外部委托——Claude Code 与 Codex 经 ACP（官方 agent 适配器）接入、pi 经官方 SDK 直连；委托编码 → 独立测试验收的完整闭环，真实 agent E2E 已验证。
- **M2 已完成**：最小自举——能力声明与缺口等待、能力经独立子进程加载、委托构建 → 不可变版本 → 候选快照、独立评估（任务/输入/裁判钉住）→ operator 批准 CAS 晋升 → 接替 Run 完成原任务 → 仅回滚到历史采用快照；ChangedFileSummary 七步自举故事 CLI 验收固化。自举故事经固定 fixture 验收。
- **M2 后决策实验工程已实现**：规则/LLM 接口、预算、恢复和决策证据闭环已验收；工程通过不等于真实 LLM 收益成立。
- **M3 已完成并补强**：冻结私有经验集、规则/LLM 提议、独立学习调用账本与取消、候选生成前冻结验证计划、双臂多目标评估、独立裁判和评估预算池。验证经历不能回流学习，证据不足可以不晋升。
- **M4 已完成本地验收**：多个体与权限隔离；团队发布、离线分享包、导入/fork/本地继承；不同个体可以独立采用或拒绝相同版本。签名来源信任与 HTTP registry 已继续落地，真正共进化尚未实现，见 [ADR 0009](./docs/adr/0009-m4-selective-local-sharing.md)。

## 快速开始

```bash
pnpm install
pnpm check                          # lint + format + typecheck + 全量测试
pnpm proteus init                   # 初始化实例（默认 ~/.proteus），安装 seed 并装载 G0
pnpm proteus submit <task.yaml>     # 提交任务并内联执行到终态
pnpm proteus runs [id]              # 列出 / 查看 Run
pnpm proteus recover / reconcile    # 崩溃恢复 / unknown Attempt 对账
pnpm proteus inspect <id>           # 查看当前个体有权读取的对象
```

真实外部 agent 的 E2E 测试默认跳过（消耗凭据）：`PROTEUS_E2E=claude|codex|pi|all pnpm test -- tests/e2e`。

## 多个体与团队版本

各命令支持 `--home`、`--organism` 和 `--actor`。例如在同一实例创建两个不同归属的个体：

```bash
pnpm proteus init --home ./instance --organism alice-organism --actor alice
pnpm proteus init --home ./instance --organism bob-organism --actor bob
pnpm proteus team-create contributors --home ./instance --organism alice-organism --actor alice
pnpm proteus team-grant contributors bob --permission read --home ./instance --organism alice-organism --actor alice
```

用 `share-fork --versions <版本ID...> --scope public` 或 `team:<团队ID>` 明确准备可共享版本；`publish --team <团队ID> --versions <版本ID...> --scope <范围>` 发布精确版本。`share-export <发布ID> --out <文件>` 与 `share-import <文件>` 交换包，默认不共享经历或评估明细，导入不切换默认行为。

接收方先 `validation-register --cases <验证计划JSON> --repeats <次数>`，随后 `inherit <导入ID> --validation-set <验证集ID>`、`evaluate-policy <候选ID>`，验证通过后由本地操作者 `promote <候选ID> --as <操作者>`。验证用例需要稳定 `id`/`familyId`、任务、期望路由，至少包含一个 `role: "regression"` 的健康基线回归任务。拒绝用 `share-reject <导入ID>`，不影响其他个体的选择；所有操作应带目标个体和操作者选项。

学习作业使用 `consolidate-submit` / `consolidate-run` / `consolidate-cancel`；`consolidate-run --learning-calls <上限>` 配置独立累计调用额度。停止其他学习进程后可用 `consolidate-recover` 结案崩溃遗留作业，未知调用不自动重发或退还额度。

## 签名来源与网络交换

已实现 Ed25519 发布签名、按个体登记公钥信任、永久撤信、团队权限撤销和 HTTP registry。`sharing-key-create/trust/revoke` 管理来源，`publication-sign` 导出签名离线包；`registry serve/token-create/token-revoke/publish/import` 提供精确版本交换。团队包读取和全部写入需要有效凭据，接收方仍须独立验签与本地评估。详见 [使用说明](./docs/sharing-registry.md) 与 [ADR 0010](./docs/adr/0010-signed-sharing-and-registry.md)。

CLI 服务仅监听 loopback；远端部署通过 HTTPS 反向代理接入。撤权会阻止新决策发送与 worker 派发，已采用行为不会自动回滚。工程验收使用实际本机 HTTP，未部署外网服务。

## 文档

- 设计文档入口：[docs/README.md](./docs/README.md)
- 领域词汇：[docs/CONTEXT.md](./docs/CONTEXT.md)
- 自举路线、已决策事项与实现进度：[docs/roadmap.md](./docs/roadmap.md)

License：Apache-2.0
