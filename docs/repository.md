# 仓库架构与实现约束

状态：**proposed**。当前仅沉淀文档，以下目录和工程配置尚未创建。首版建议 TypeScript + Bun、本地 CLI、SQLite 事务记录与文件内容存储；先验证持久化和执行边界，再锁定具体依赖版本。

## 1. 从单包模块化起步

领域模块先放在一个包中，保持明确导入方向；不因为概念图里有多个框就建立多个发布包或网络服务。当模块出现第二个独立消费者、不同部署需要或稳定发布节奏时，再提取到 `packages/`。

```text
ProteusOS/
├── docs/                       # 已有：设计、词汇、ADR、路线图
├── src/                        # 后续实现时创建
│   ├── kernel/                 # 身份/授权/版本/快照/晋升不变量
│   ├── runtime/                # Task/Run/Process、DAG、调度与恢复
│   ├── decision/               # 结构化决策合同与结果校验
│   ├── evolution/              # M2 起：候选、评估、巩固编排
│   ├── adapters/
│   │   ├── decision-rule/      # 确定性规则
│   │   ├── executor-process/   # 本地受控进程
│   │   └── executor-acp/       # M1 起：外部协议映射
│   ├── storage/                # SQLite、blob、outbox、迁移
│   └── app/                    # 组装依赖、CLI 命令与配置
├── tests/
│   ├── unit/                   # 纯不变量与状态迁移
│   ├── contract/               # Provider/持久化合同
│   ├── integration/            # 事务、恢复、晋升与执行组合
│   ├── acceptance/             # 自举闭环与失败路径
│   └── fixtures/               # 无凭据、可重复的测试产物与 worker
├── evals/                      # 固定评估协议、任务、切分清单
├── examples/                   # seed 图、规则、实例配置样例
├── package.json                # 私有根包、明确脚本
├── tsconfig.json               # 严格类型检查
└── bun.lock                    # 依赖版本固定
```

只在需要时创建目录：M0 不创建空的 evolution/ACP/模型训练包。Skill、Memory、World Model 先作为具体需求下的产物或内部实现，出现稳定消费者后再提取模块。

## 2. 依赖方向

箭头表示“导入/依赖”：

```text
app ───────────→ runtime / evolution / storage / adapters
evolution ─────→ runtime 的任务提交合同 / kernel
runtime ───────→ decision / kernel
decision ──────→ kernel 的基础引用类型
adapters ──────→ 它们实现的 Provider 合同
storage ───────→ 拥有持久化合同的模块类型
kernel ────────→ 纯类型与基础标准库
```

Runtime 不导入 Evolution：运行产生记录，Evolution 主动读取固定窗口并提交评估任务，避免双向依赖。Kernel 不导入 Runtime、数据库驱动或 SDK；算法只返回领域结果或待提交事实，I/O 通过由接口所有者定义的 port 注入。

Executor 合同属于 Runtime，DecisionProvider 合同属于 Decision，PolicyLearner 与评估编排合同属于 Evolution。Storage 可以实现不同模块的内部存储 port，但实际事务由同一个应用提交单元协调；跨模块不变量不得拆成各自提交的多个数据库事务。

模块对外通过自身 `index.ts` 暴露小接口；调用方不导入别人的 `internal/`。先不创建一个囊括所有对象的 `shared` 或 `types` 包；类型归属定义其不变量的模块。

## 3. 模块深度与可测试性

Runtime 的调用者只需提交、观察、取消或恢复工作；就绪判断、重试、对账和 checkpoint 留在实现中。Kernel 的晋升接口一次验证快照、证据引用、授权和 revision，再交由事务实现原子提交，调用者不手动串起多个可漏掉的步骤。

Clock、ID 生成、外部调用和持久化作为内部 seam 注入。公开 Provider seam 对应确实会变化的规则/模型或进程/协议实现；不提前为每一个未来研究词汇建立空接口。

不要将模型生成的字符串直接作为内部命令。Provider 响应、配置文件和持久化记录在边界做运行时 schema 校验；静态 TypeScript 类型不能验证外部输入。

## 4. 实例数据与源码分开

实例根目录由操作者显式配置，例如 `<instance-root>/`：

```text
<instance-root>/
├── metadata.sqlite             # 状态、事件、outbox、版本引用与晋升
├── blobs/                      # 按内容摘要保存的不可变内容
├── workspaces/                 # Run/Process 的可变工作区
└── tmp/                        # 构建和导入的临时区
```

路径示意不约束最终配置格式。凭据由受控的凭据来源注入，不进入实例快照或导出的经验。实现时增加 `.gitignore` 排除实例数据、工作区、测试输出和秘密文件；fixture 必须使用合成数据。

Seed 图、确定性策略和固定验收规范可以作为源码内的版本化资源，但首次安装需导入为不可变版本并生成初始 GenomeSnapshot。实例不能直接将仓库里一份持续变化的 Markdown 当作已固定的 skill 版本。

## 5. 验证布局

| 层次 | 需要证明的行为 | 代表场景 |
| --- | --- | --- |
| Unit | 不变量和状态迁移 | parents 无环、快照依赖完整、取消与终态合法 |
| Contract | Adapter 满足共同合同 | 事件关联、abstain、非法输出、幂等和不支持能力 |
| Integration | 真实持久化与运行协调 | 崩溃恢复、重复事件、资源预留、CAS 冲突、blob 缺失 |
| Acceptance | 使用者可观察的闭环 | 候选实现、独立评估、晋升、新 Run 完成原任务、回滚 |
| Evaluation | 变化的效果及局限 | 固定基线、独立任务切分、重复评估、成本与回归 |

合同测试复用调用者的接口，不穿透内部私有结构。测试替身必须包含未知副作用、取消延迟和重复事件等现实失败行为；不能只写立即成功的 fake。

日常 CI 使用固定 fixture 和本地可信 worker，默认无需外网、模型或用户凭据。真实 ACP 集成另设显式启用的测试任务；其缺失必须显示为未验证，不能用 mock 通过替代真实兼容性结论。

实际创建工程时设置类型检查、格式检查、测试脚本并记录标准命令；本文不提供尚不存在的可运行命令。质量门槛随阶段交付，见[路线图](./roadmap.md)。

## 6. 拆包和分布式的触发条件

只有当证据表明需要独立部署、隔离依赖、外部插件 SDK 或多个消费端时才拆包。跨机器调度还需要租约、故障接管、远端身份认证与多写入一致性；本地 outbox 不等于已经获得这些能力。

团队联邦增加独立的导入/发布 Adapter 与治理流程，不要求个人 Runtime 改为共享可写状态。协议扩展沿用精确版本与本地选择权；引入前补充对应威胁边界和迁移方案。
