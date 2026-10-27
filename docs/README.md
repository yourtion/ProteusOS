# ProteusOS 文档

当前实现覆盖 M0–M4，以及签名来源信任、撤权和 HTTP registry。阶段验收与剩余工作统一见 [路线图](./roadmap.md)；工程验收与真实模型收益分开记录。

## 阅读入口

| 文档 | 内容 |
| --- | --- |
| [项目 README](../README.md) | 安装、快速开始与常用命令 |
| [设计原则](./principles.md) | 约束、证据与用户控制 |
| [领域词汇](./CONTEXT.md) | 统一术语 |
| [总体架构](./architecture.md) | 模块职责、依赖和不变量 |
| [Web 与应用 Interface](./interaction.md) | Web 优先、CLI/TUI 复用、Host、操作/查询/订阅与交付切片 |
| [领域模型](./domain-model.md) | 当前记录、归属和关联 |
| [运行时合同](./runtime.md) | DAG、决策调用、派发、取消与恢复 |
| [进化与继承](./evolution.md) | 经验冻结、候选、评估、晋升与共享 |
| [签名共享与 registry](./sharing-registry.md) | 公钥、凭据、网络交换和撤销 |
| [仓库设计](./repository.md) | 源码、实例数据、检查和测试布局 |
| [路线图](./roadmap.md) | 里程碑验收与尚未验证事项 |
| [原始架构差距](./architecture-gaps.md) | Jev/决策层、预测、记忆、归因与当前实现的逐项核对 |
| [后续迭代规划](./iteration-plan.md) | 决策层优先的 P0/M5–M8 方向、DSPy 适用范围与效果门 |
| [适应能力执行计划](./execution-plan.md) | P0、M6a/b/c 的交付顺序、依赖、验收门和逐步执行记录 |
| [DSPy 论文研究](./research/dspy-paper.md) | 论文概念、当前官方实现与项目适用边界 |
| [DSPy 与 Harness² 联合分析](./research/dspy-harness2.md) | 可编译策略、任务内试探和改进经验库的代码映射 |
| [Jev 决策层研究](./research/jev-decision-plane.md) | 官方接口、问题类型、概率证据与接入边界 |
| [编译作业与报告](./policy-compilation.md) | 来源标注与隔离、有界示例搜索、累计预算、恢复和唯一候选 |
| [可编译策略](./compiled-policy.md) | 冻结示例池、选择/顺序参数、模型请求持久化与旧策略兼容 |
| [适应行为实验](./experiments/adaptive-behavior-v1.md) | 新版实验冻结、四类数据隔离、同预算比较与无真实调用演练 |
| [实验派发账本](./adaptive-journal.md) | 冻结收据、单次派发、累计预留、绝对期限与崩溃恢复 |
| [编译开发证据核验](./compile-evidence.md) | 原始正文、学习账本、来源执行证据和获胜候选的只读一致性检查 |
| [编译开发单元映射](./compile-development.md) | 冻结任务内容、绑定清单、完整计量与未知执行开销 |
| [JSON 验收证据与 Run 核验](./verification-evidence.md) | 当次验收正文、冻结任务输入、实际执行绑定及旧记录缺项 |
| [策略臂与选择器核验](./adaptive-arm-evidence.md) | 固定快照、原始决策、无标签选择及全部已知/未知开销 |
| [Journal Run 槽位绑定](./adaptive-run-slots.md) | 预派发槽位、原子准入、单次启动、顺序与崩溃恢复 |
| [原始收据与完整三臂运行](./adaptive-receipts.md) | 冻结路由标签、证据结案、串行运行与清理后复算 |
| [本体决策实验](./experiments/organism-decision-v1.md) | 规则/LLM 对照协议、指标和运行命令 |

## 架构决策

ADR 保存选择理由；后续变化在相关记录中注明，当前行为以运行时、进化与使用文档为准。

- [0001：基质与行为分离](./adr/0001-substrate-and-behavior.md)
- [0002：快照与原子晋升](./adr/0002-snapshots-and-promotion.md)
- [0003：个体主权与继承](./adr/0003-organism-and-federation.md)
- [0004：技术栈](./adr/0004-m0-engineering-baseline.md)
- [0005：外部执行器](./adr/0005-external-executors.md)
- [0006：能力自举](./adr/0006-m2-minimal-bootstrap.md)
- [0007：本体决策实验](./adr/0007-organism-decision-experiment.md)
- [0008：经验驱动演化](./adr/0008-m3-experience-driven-evolution.md)
- [0009：独立个体与共享](./adr/0009-m4-selective-local-sharing.md)
- [0010：签名信任与 registry](./adr/0010-signed-sharing-and-registry.md)
