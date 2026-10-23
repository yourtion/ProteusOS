# DSPy 论文与 ProteusOS 迭代依据

核验日期：2026-10-10。论文为 arXiv:2310.03714 **v1，2023-10-05**；指定链接没有后续 arXiv 版本。本笔记区分原论文证据、当前官方接口与本项目设计推断。[版本记录](https://arxiv.org/abs/2310.03714)

## 论文核实

- **Signatures** 声明输入/输出语义，**modules** 组合模型调用，**teleprompters** 优化调用参数。Bootstrap 让 teacher 执行训练输入，以 metric 筛选完整轨迹，再提取各调用的示例；通常不需中间步骤人工标签。[论文 §3–4](https://arxiv.org/pdf/2310.03714#page=4)
- GSM8K：200 训练、300 开发、约 1,300 测试。GPT-3.5 CoT 测试准确率：人工示例 72.4%，bootstrap 72.9%，加集成 81.6%；收益取决于程序和编译策略。较贵编译需数千次执行。[论文 §6 / Table 1](https://arxiv.org/pdf/2310.03714#page=8)
- HotPotQA：官方训练集再切分，抽 200/300 个训练/开发样本；抽官方验证集 1,000 个作测试，部分集成结果因成本仅测一半。[论文 §7 / Table 2](https://arxiv.org/pdf/2310.03714#page=10)

**外推边界（本项目判断）**：这些结果支持特定任务上的离线优化，不能证明 ProteusOS 的路由、外部编码、长期自主学习或共进化有效。最终成功也不能证明每个中间选择正确；示例准入仍需来源、独立验收和局部约束。集成和长示例增加未来调用成本，应同时比较质量、延迟与总资源，而非引用论文摘要涨幅作为目标。

## 当前 DSPy 可用接口

官方入口是 Python 包 `pip install dspy`；核验时 `main` 标识为 **3.4.0**、Python 要求 `>=3.10,<3.15`，这里没有把它认定为已发布稳定版。落地前应选择并锁定发布版本、依赖和源码提交。[安装说明](https://github.com/stanfordnlp/dspy/blob/main/README.md#installation)、[包配置](https://github.com/stanfordnlp/dspy/blob/main/pyproject.toml)

当前仍有 `Signature`、`InputField`、`OutputField`、`Module.forward`、`Predict`、`ChainOfThought`、`ReAct`；字段支持类型，模型通过 `LM` 与 `configure` 配置。[Signatures](https://github.com/stanfordnlp/dspy/blob/main/docs/docs/learn/programming/signatures.md)、[Modules](https://github.com/stanfordnlp/dspy/blob/main/docs/docs/learn/programming/modules.md)、[LM](https://github.com/stanfordnlp/dspy/blob/main/docs/docs/learn/programming/language_models.md)

Teleprompters 现称 **optimizers**。`BootstrapFewShot` / `BootstrapFewShotWithRandomSearch` 仍可用，另有 `MIPROv2`、`GEPA` 等后续算法，不能把这些归入 2023 论文成果。RandomSearch 未显式提供 `valset` 时会使用 `trainset`；此默认不满足本项目的独立评估要求。[优化器说明](https://github.com/stanfordnlp/dspy/blob/main/docs/docs/learn/optimization/optimizers.md)、[RandomSearch 源码](https://github.com/stanfordnlp/dspy/blob/main/dspy/teleprompt/random_search.py#L52)

## 对 ProteusOS 的建议（设计推断）

本笔记描述离线编译方法。原始架构中的 Jev/可替换在线决策层尚未完整落地，应先推进 M5，再将这里的方法用于 M6 的策略学习；预测、记忆、Skill 与自我事实投影也有独立职责，不能全部收敛为提示优化。核对见 [架构差距](../architecture-gaps.md)、[Jev 研究](./jev-decision-plane.md) 和 [迭代规划](../iteration-plan.md)。

现有 `llm-choice-v1` 固定提示模板；LLM 巩固只提出 `feature→choose`，随后重算统计门槛。正式验证已具备单次领用、候选绑定与 family 隔离。因此差距是**可编译调用参数、示例资产和多候选搜索合同**，并非缺少 held-out。[策略合同](../../src/decision/llm-policy.ts)、[巩固实现](../../src/evolution/consolidation.ts)、[验证实现](../../src/evolution/index.ts#L1247)

1. **先收敛到 routing-choice**：固定 decision-view、有限选项、弃权和响应 schema，首期只搜索 demos；指令搜索留作后续对照，保留规则与冻结提示基线。外部 executor 继续接受现有执行合同，首期不编译其内部 agent 循环。阶段选择见[迭代规划](../iteration-plan.md)。
2. **补三份用途分离的数据**：train 生成示例，search 多次评分选参数，formal 一次评估冻结的获胜候选。按 family 去重；search 反馈不能包装成 formal 证据。仍走 Candidate → Evaluation → operator Promotion。
3. **将示例做成不可变资产**：关联模块/接口版本、输入输出摘要、Run / decisionCall、快照、裁判、筛选标准与私有归属。保留失败轨迹用于诊断，只允许合格开发示例进入提示；分享必须检查私有依赖。
4. **优化器只产候选**：冻结搜索空间、候选数、随机种子、调用/Token/时间额度和停止条件；记录全部试验。先做有界示例选择，再按真实收益考虑指令搜索、跨模型重编译或教师蒸馏。

指标应覆盖误派、合适弃权、非法响应、最终任务成功及未知成本。开发反馈评分与正式裁判可以分离，但准入约束须预注册；证据不足保留零提议。

首选 TypeScript host 内实现最小机制；如需 DSPy 对照，将锁定版本的 Python worker 放在离线 evolution 边界，按窄 JSON 合同返回 instructions / demos 与 provenance。模型调用应经 host 授权与累计预算，明确缓存、重试、取消及 unknown 语义；DSPy 内存历史不能代替账本。官方支持自定义 `BaseLM`，也有默认缓存，桥接需专门验证。[LM 扩展与缓存](https://github.com/stanfordnlp/dspy/blob/main/docs/docs/learn/programming/language_models.md)

不建议首期移植完整 Python 框架、扩大 Kernel 可塑性、开放任意图搜索或立即微调。先证明同等总预算下，编译后的单一决策模块比已有基线可靠，并无回归；只有这一步成立，才扩展到多阶段文本模块。[项目现有边界](../evolution.md)、[未验证事项](../roadmap.md#2-尚未完成或验证)
