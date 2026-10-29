# 开发仓库验收与依赖上下文 v2

2026-10-29。承接 [v1 的 9/9 功能通过、6/9 类型复核通过](./results/development-suite-v1.md)。本轮先固定自动验收，再为 snapshotDigest 补充类型上下文并预置原文件，三次门槛全部通过后再运行两个不同模块的新任务。开发方可见历史重放，收益仍为 inconclusive。

## 自动验收

`DevelopmentPilotPlan.repository` 提供受信历史源码目录、公开接口符号列表和只读依赖文件列表。宿主在模型调用前冻结 `src/`、package.json、tsconfig.json、检查脚本、编译器版本/摘要及已安装依赖锁摘要。完整仓库只供本地验收，不发送给模型。

每个候选在新建的历史仓库副本中替换唯一目标文件，并独立记录三项结果：

1. 冻结行为测试：Node 只读权限，禁止网络、写文件和子进程；允许读取历史副本和现有依赖，以覆盖有运行时依赖的模块。必须返回完整且名称一致的检查结果，退出 0 本身不算通过。
2. 仓库类型检查：固定 TypeScript 7 编译器在历史 tsconfig 下执行 `--noEmit`，检查源文件及调用方。不给候选配置脚本/命令执行权限；没有安装依赖或运行仓库脚本的步骤。
3. 接口兼容检查：与冻结原始模块对照，列明的公开领域类型必须一致；函数/常量、类的公开成员与构造参数须向后兼容。函数接收更宽输入而不破坏旧调用方可以通过；新增类型检查抑制指令不接受。接口清单见冻结 manifest，不声称涵盖所有运行时行为或语义兼容。

三项全部通过才令 Runtime 的 verify 成功。原始仓库类型/API 基线必须通过，行为基线必须同时包含失败与健康回归，否则不启动模型。参考修复也要全部通过。对输入、依赖、冻结仓库、检查器、编译器和候选做摘要核对；模型不能写测试、依赖、配置或其他文件。类型检查是可信宿主工具，功能候选在受限 Node 子进程中运行；不把此试点声称为通用恶意代码隔离环境。

## 上下文与修改方式

模型可读取 source.ts、checks.mjs、context.json 与唯一输出文件。context.json 从同一个历史快照生成，逐项记录原始路径、内容和摘要；既不取当前已修复实现，也不提供参考答案。宿主在派发前将原文件放入 output/目标路径，指令要求最小编辑、保留原有类型导入和公开合同。

| 本轮真实任务 | 可修改目标 | 额外只读上下文（同一旧提交） |
| --- | --- | --- |
| snapshot-digest | src/kernel/index.ts | src/kernel/types.ts |
| evolution-capability-accumulation | src/evolution/assets.ts | src/kernel/index.ts、src/kernel/types.ts、src/runtime/capability.ts、src/storage/blobs.ts、src/storage/store.ts |
| adapter-cached-token-accounting | src/adapters/decision-llm/index.ts | src/decision/index.ts、src/adapters/decision-llm/request.ts |

`schema-own-properties`、`capability-name` 保留为本轮离线回归对照，不追加真实调用。总历史任务覆盖从 3 个扩至 5 个；本轮真实测量仍是上表 3 个任务，不能把重复运行当独立任务。

新 evolution 任务只修复累积能力路由丢失。其真实修复提交同时修改了 builder 接口，不能把整份迁移代码放进旧仓库当正对照。因此保存完整历史修复文件，同时将该提交中仅修复能力累积的原始 hunk 用作 scoped reference；两者摘要和区别在 manifest 中显式记录。没有合成新的 bug。

## 已完成的离线门槛

`validate-development-suite-v2.ts` 在真实 Runtime 的 execute→verify 图中重放上一轮 9 份候选，零模型调用：3 份 snapshot 坏补丁全部自动拒绝，其余 6 份通过；5 项历史任务全部具备红行为基线、绿类型/API 基线和绿参考修复。定向测试覆盖正常最小编辑、行为正常但类型错误、普通 tsc 通过但接口变宽、上下文或宿主仓库被修改、类型抑制、原始仓库无效与只读权限。

## 真实运行预注册

冻结资料在 `tests/fixtures/development-suite-v2/manifest.json`。最多 9 个全新会话：先 snapshot 1/2/3，全部通过三项验收和记录完整性后，再按 evolution→adapter 的顺序各运行 3 次。任何门槛失败立即停止扩样本；扩展任务的已知功能/类型失败原样记录，不用重试替换成绩；记录不完整立即停止。中断或已有目录不得自动重发。

固定 `GLM-5.3-Flash`、`https://open.bigmodel.cn/api/anthropic`、Read/Write/Edit、每次 1 Attempt / 最多 6 轮 / 300 秒 / 输出上限 8192 tokens，总上限 54 轮和 2700 秒。验收另有本地检查超时。只发送每项目标旧源码、任务说明、固定测试及表中依赖，不发送整个历史仓库。上一批 9 次授权已经消耗完，新增依赖和新会话按本表取得一次批量授权后执行。

入口：`run-development-suite-v2.ts --output NEW_DIRECTORY --claude-settings FILE`。先运行所有离线控制，落盘 manifest 和 summary，再逐次记录 Run/Attempt、进度、公开流式轨迹、缓存/输入/输出用量与三项验收。原始响应正文/隐藏推理和私有 Agent 配置不归档；费用仍仅可记录 SDK 估算，实际账单未知。

本轮同时改变依赖上下文和原文件预置/编辑方式，旨在验证工程可用性。与 v1 比较时，不把改善单独归因于某一个因素，不声称相对直接使用 Agent 的收益。候选仅保存供审查，不自动应用或晋升。

## 本轮派发前中断与续跑边界

前两个 snapshot 会话已完成且三项验收及记录完整性通过。共享工作区的并行开发随后改变执行接口，版本检查在第三次创建私有配置和派发之前停止；原始 summary 的中断原因与两次结果保留，不覆盖。原始目录中没有第三次 Run 或第三次私有配置。

续跑使用独立工作目录，恢复前两次记录的全部 13 个执行文件并逐字节核对摘要。`continue-development-suite-v2.ts` 仅接受这个已完成两次的中断形态；先离线重跑五项红绿控制，再只派发剩余 7 次，并记录前段 summary 摘要、Run ID、原中断原因和续跑脚本摘要。第三次 snapshot 仍必须全部通过，才开放后续六次。新段使用全新目录，旧段不重发、不复写，总计仍不超过已授权的 9 个会话。续跑编排脚本作为第 14 个文件另外冻结；其余执行文件与首段相同。

这是对明确尚未派发任务的一次受控续跑，并非失败会话自动重试机制。归档应保留两个分段 summary 和 continuation 记录，再单独生成聚合结果。

## 执行结果

本轮授权的 9 个会话均已完成，预注册三项验收 9/9、记录完整。事后补充的可空缓存字段检查发现两份候选语义不兼容，合并已检查要求为 7/9；原冻结检查与成绩不变。完整结果、额度消耗、中断续跑记录及离线复验见 [结果报告](./results/development-suite-v2.md)。下一轮须将该语义边界纳入新版本协议。
