# 开发闭环观测与历史任务扩样本 v1

2026-10-29。先补齐进度、公开轨迹和用量，再增加真实历史缺陷。此轮是开发方可见、已定位根因的历史重放，不是独立留出集，也没有直接 Agent 对照臂；收益结论固定为 `inconclusive`。

## 先验证记录

每次执行报告连接、工作、工具、权限、结束阶段，以及耗时、已观察文字数、工具数和最后活动时间，不提供推算百分比。Runtime 把进度存为 `attempt.progress`，摘要读取最后一条；实验入口实时输出到 stderr。等待期间每秒心跳，仍能区分“进程等待”和“收到新活动”。

连续公开文字按最多 2000 字符聚合，完整保留分段文字。权限、工具状态和最终结束事件单独记录；终态在缓冲溢出时仍保留，被丢弃的事件数明确计入 partial。工作区 `.proteus/acp-events.jsonl` 在执行期间追加，最多 2048 条或 2 MiB，结束事件另行保留；`.proteus/acp-trace.json` 是有界公开投影。不可变轨迹由 Runtime 另存为带摘要的 blob。写盘/显示失败不触发重新执行。

只订阅 Claude SDK 的 assistant/result 扩展，并立即投影为响应 ID、模型和数值用量，丢弃消息正文和隐藏推理。相同响应 ID 去重，累计 modelUsage 快照替换而非相加。标准 usage_update 的 used 是上下文占用，不计作收费 tokens。归一化输入 = 未缓存输入 + 缓存读 + 缓存写；总量再加输出。缺项、无效值、未结束或累计倒退保留 partial/unknown。仅标准 prompt 用量时注明 top-agent 范围不足，不能冒充完整会话。

保存计量原始数值投影及其 blob 摘要，可重开实例校验。`observedModelResponses` 是观察到的去重响应数；传输重试次数仍未知，`modelCallCount` 不填造。`reportedCost` 只是 SDK 按自身价表算出的估算，未经本端点账单核实，实际 `cost` 仍为 null。旧归档不回填。

## 固定任务和顺序

冻结清单：`tests/fixtures/development-suite-v1/manifest.json`。源码原样来自真实 Git 提交，`.ts.txt` 防止它们参与项目编译；运行时复制为冻结 `.ts`。reference 仅用于宿主离线正对照，绝不发送给模型。

| 任务 | 来源文件 | 旧版通过/总数 | 历史修复通过/总数 |
| --- | --- | --- | --- |
| schema-own-properties | src/runtime/schema-validator.ts | 4/12 | 12/12 |
| snapshot-digest | src/kernel/index.ts | 4/5 | 5/5 |
| capability-name | src/runtime/capability.ts | 3/6 | 6/6 |

共 3 个不同缺陷任务，每个 3 次独立新会话，共最多 9 次。按第 1 次的 schema → snapshot → capability，再第 2、3 次同顺序运行。先用 schema 第 1 次做记录门槛：功能通过、进度到达结束、trace complete 且 dropped=0、用量 complete 且有存储摘要，才执行新样本。其后任何记录不完整立即停止；功能失败原样记录，不用替换任务或临时改提示补齐成绩。既有目录拒绝运行；中断后先检查已有 Run，不自动续发。

每次仍使用固定 execute→verify、1 Attempt、最多 6 轮、300 秒；单次输出上限 8192 tokens，以容纳最长约 9 KB 的完整模块。此为编码输出上限，与之前固定 1024 的路由实验无关。本轮不比较不同输出上限。总执行预算最多 54 轮、2700 秒，不含本地验收。

固定 GLM-5.3-Flash、端点 `https://open.bigmodel.cn/api/anthropic`，凭据只由用户指定设置文件读取到内存。每次只发送相应历史源码、固定测试和任务说明；Read/Write/Edit 仅可访问这两个输入与单个指定输出，不能读取仓库、历史参考答案或其他任务目录。配置目录保持在证据目录之外，不归档原始 SDK 会话文件。

新任务继续用原只读固定验收器，验证原始检查完整执行、输入不变、目标及目录没有链接/多余产物。候选补丁仅保存供审查，不重复应用已修复的历史代码。

## 执行与复验

本地先执行 `tests/experiments/run-development-suite.ts --preflight`：验证全部冻结摘要，并用只读进程确认每项红/绿对照。真实入口为同脚本 `--output NEW_DIR --claude-settings FILE`，先落盘注册清单，再逐次写 summary、manifest、baseline、Run/Attempt、公开轨迹、数值计量凭据、固定验收和候选补丁。

完成后按任务报告成功率、墙钟耗时、token 总量、响应数、轨迹完整性；重复运行不能冒充更多独立任务。归档后在没有凭据和网络的条件下重放固定测试，并复核输入、输出、轨迹及计量摘要。不能据此声称相对人工或直接 Agent 的收益。
