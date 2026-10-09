# ProteusOS 文档

当前实现覆盖 M0–M4，以及签名来源信任、撤权和 HTTP registry。阶段验收与剩余工作统一见 [路线图](./roadmap.md)；工程验收与真实模型收益分开记录。

## 阅读入口

| 文档 | 内容 |
| --- | --- |
| [项目 README](../README.md) | 安装、快速开始与常用命令 |
| [设计原则](./principles.md) | 约束、证据与用户控制 |
| [领域词汇](./CONTEXT.md) | 统一术语 |
| [总体架构](./architecture.md) | 模块职责、依赖和不变量 |
| [领域模型](./domain-model.md) | 当前记录、归属和关联 |
| [运行时合同](./runtime.md) | DAG、决策调用、派发、取消与恢复 |
| [进化与继承](./evolution.md) | 经验冻结、候选、评估、晋升与共享 |
| [签名共享与 registry](./sharing-registry.md) | 公钥、凭据、网络交换和撤销 |
| [仓库设计](./repository.md) | 源码、实例数据、检查和测试布局 |
| [路线图](./roadmap.md) | 里程碑验收与尚未验证事项 |
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
