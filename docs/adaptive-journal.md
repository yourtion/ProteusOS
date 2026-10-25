# 适应实验的持久化派发账本

M6a-03-01，2026-10-25。实现见 [AdaptiveJournal](../src/app/experiment/journal.ts)，通过 `openInstance(...).adaptive` 使用。协议仍为 [adaptive-behavior-v1](./experiments/adaptive-behavior-v1.md)，不改变其预算、数据或效果门槛。

本切片实现冻结清单、派发许可、预留和恢复的持久化。它不发送模型请求或任务，不读取正式资料，不核验原始 Runtime 证据，也不创建 Evaluation 或 Promotion。真实 runner、受信预算后端与独立资料仍是后续前置；不能以此切片的通过替代真实效果验证。

## 冻结与注册

`register(frozen, developmentObservations)` 对清单及全部开发收据做严格校验，将两者写入内容寻址 blob。开发收据必须完整、闭合，符合 train/search 用途及截止点，不能预填 formal/regression 成绩。重复注册同一清单返回原实验，不能替换开发收据、重置期限或重新领取额度。收据数组顺序不影响幂等。

编译实验可使用 `registerCompiled(frozen, jobId)`：先调用 [开发单元绑定](./compile-development.md)，再在同一事务中写入实验、开发收据引用、`compilationEvidence={jobId,bundleDigest,auditDigest}` 和注册事件。记录插入后故障会整体回滚；幂等重试不重置期限或额度。旧记录没有此可选字段，仍按普通宿主收据读取；普通实验不能原地升级或替换为编译来源合同，已绑定实验的普通幂等调用也不会丢掉其来源。

每个 Organism 独立保存实验。所有公开操作检查当前主体的个体权限，撤权后不能继续派发或读取报告。清单和收据每次使用前复核 blob 摘要；单元必须匹配冻结的顺序与额度。migration 16 只新增实验与预留两张表，旧 Run、Candidate 和协议不变。

全轮 `startedAt` 取开发最早开始时间与冻结点的最小值，`deadlineAt = startedAt + budget.wallClockMs`。注册、恢复和等待均不延长期限。开发开销不会因为正式阶段尚未启动而从墙钟中消失。货币硬上限模式暂时拒绝注册，因为尚无可验证的限额后端。

## 派发与结果

| 操作 | 合同 |
| --- | --- |
| `prepare(id)` | 按清单预留下一个完整单元；重复调用返回原预留；在途单元未封闭时不能领取下一个 |
| `start(id, reservationId)` | 事务内将 prepared 改为 started；只有一次能成功；返回单元和绝对截止点 |
| `complete(id, reservationId, observation)` | 绑定原单元、开始时间和清单；收据 blob、单元终态、实验状态与事件同事务提交 |
| `report(id)` | 在一致的数据库事务中读取清单、预留及收据，只读复算；不补跑缺失单元 |
| `cancel(id)` | 封闭账本；started 保留 unknown，prepared 保留预留；调用者负责停止实际执行器 |
| `recover(id)` | 仅在旧 Host/执行器已停止后显式调用；prepared 保留原 ID，started 封为 unknown 并停止本轮 |

宿主只有在 `start` 成功返回后才能执行外部调用。两个连接可以读取同一个 prepared，但只有一个连接能取得 start 许可。单元截止点是自身时限与全轮截止点的较早者；宿主需将该截止点传给实际执行器，并在结束或取消时停止它。

已绑定编译来源的实验在 `prepare`、`start` 和 `report` 前重新核验来源、任务包和开发收据，且在提交事务内再次检查个体及所读版本权限。核验与提交之间撤权也不能取得派发许可。未装配核验入口或来源发生漂移时拒绝；不能退回普通收据模式继续。`complete` 保留在途结果，`cancel/recover` 封闭未知状态，不依赖来源仍可访问，避免撤权或损坏后无法留存已经发生的执行证据。原始来源恢复后仍可复算。

`prepare` 持久化完整 allowance，不因实际少用、失败、取消或 unknown 退款。开发 allowance 和所有已预留单元共同构成 `report.reserved`，它不同于纯报告中整个计划的总预留。清单冻结时已验证全部单元总额，以及编译臂含开发开销不超过多次执行对照；单元只能领取一次，因此累计已领取额度不会超出清单。这个上界约束派发账本，实际模型输入、输出及内部 worker 调用仍须由受信后端约束。

完整、相同的结果可幂等提交；不同结果不能覆盖。合法但超额的收据仍保存，随后停止新派发，防止丢弃坏结果掩盖超额。unknown、取消和截止点同样停止本轮。结构非法的收据被拒绝，原 started 状态不重发；恢复时保留 unknown。封闭后不接纳迟到回包。已提交结果不依赖可变工作区，重启只读复算得到相同报告。

## 证据边界与后续工作

报告以 `developmentVerification` 区分 `persisted-development-records` 与普通 `unverified-host-receipts`。前者仅表示开发来源已绑定并核验；正式结果仍为宿主提供的收据，整体固定带有 `evidenceVerification=unverified-host-receipts`、`formalEvaluation=not_run`。fixture 为 `realModel=not_run / benefit=not_evaluated`；real 清单为 `realModel=unknown / benefit=inconclusive`，即使收据自报的数字通过质量门，也不能升级结论。`engineering=passed` 只表示收据完整且符合离线合同。

后续 [编译开发证据核验](./compile-evidence.md) 和 [开发单元映射](./compile-development.md) 已接入开发侧原始记录。仍需从正式 Run、DecisionCall 和 Attempt 构造收据，绑定策略、快照、任务和独立裁判。不能把宿主提供的 accepted、source 或用量直接当成事实。随后才接入受信 runner、正式验证集的一次领用与新版 Evaluation。独立真实轮通过后，仍由 operator 显式 Promotion。

[冻结任务与 JSON 核验](./verification-evidence.md)、[策略臂与选择器核验](./adaptive-arm-evidence.md) 已可独立读取原始记录。后者尚不证明调用者提供的 Run 槽位在派发前已登记，不能直接接纳为 Journal 正式收据。下一步须持久化槽位、Run 身份和派发顺序，并补齐误派标签及真实来源/预算合同。

## 验证

[SQLite 集成测试](../tests/integration/adaptive-journal.test.ts) 覆盖完整三臂复算、两个连接竞争、prepared/started/结果提交处的崩溃、事务回滚、绝对期限、取消、超额、迟到、摘要漂移、主体隔离和撤权。[开发绑定测试](../tests/integration/compile-development.test.ts) 另覆盖原子注册回滚、旧合同不升级、来源漂移、缺少核验入口、提交前团队撤权和私有裁判硬链接。测试不调用真实服务。

```bash
env -u PROTEUS_E2E -u PROTEUS_SANDBOX PATH="/opt/homebrew/bin:$PATH" \
  /opt/homebrew/bin/node node_modules/vitest/vitest.mjs run \
  tests/integration/adaptive-journal.test.ts tests/unit/adaptive-experiment.test.ts
```
