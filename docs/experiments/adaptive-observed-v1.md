# 真实三臂观测协议 v1

协议 ID：`adaptive-observed-v1`。2026-10-28，用户明确选择“另注册真实观测轮，先取得完整三臂测量”。此协议独立于 `adaptive-behavior-v1`，不解除原协议的输入预算、独立资料、正式 Evaluation 或采用门。

## 问题与资格

固定同一个 GLM-5.3-Flash 模型、原路由提示、视图、JSON 响应合同、执行图、工具与裁判，仅改变示例选择。测量单次原策略、三次原策略的无标签投票，以及示例策略的质量、回归、延迟和完整开销。

无论数值是否改善，真实轮的独立收益均为 `inconclusive`、`originalProtocolEligible=false`：资料由开发方可见，语义独立性未证明，输入计数为观测性预检。该轮不创建可晋升的 Evaluation/Candidate，不领用原正式验证集，不修改 activeGenome，不执行 Promotion。

## 冻结的数据与家族

资料均为合成文本与改动路径清单，公开生成器是 [observed-data.ts](../../experiments/protocols/observed-data.ts)。固定 20 train / 20 search / 40 formal / 10 regression **任务**；formal/regression 在开发选择冻结前不会发送给模型。生成器及整份任务/裁判清单在首次来源运行前持久化并计算 SHA-256。

同一模板的材料变体归入同一家族，实际为 **5 train / 5 search / 10 formal / 5 regression 模板家族**；不将 40 formal 任务包装成原协议要求的 40 个独立 family，也不将模板 ID 隔离当作语义独立性证明。正式/回归指标先在 case×repeat 内汇总，再在家族间等权平均，全部计划分母保留。每个角色包含文本统计与文件类别任务；输入同时包含真实文本与改动路径，期望输出和裁判文件保存在模型/worker 输入之外。

## 开发选择及预注册回退

1. 先运行 40 个本地确定性标注来源 Run。teacher 只用于 train/search，worker 仍实际执行并由独立 JSON 期望输出验收；模型调用为 0，CPU 成本未知。
2. 从已验收的 `train-0-0`、`train-1-0` 生成固定示例池，示例仅带白名单视图及响应；源 Run/DecisionCall/收据引用不进入模型正文。
3. 对 20 search 任务逐一比较空示例与固定的两个示例，共 **40 次真实搜索生成**；不新增参数组合、不修改示例、不追加搜索。
4. 如果示例配置 search 家族等权准确率 ≥90%，且优于空示例至少 5 个百分点，记录 `development-qualified-demo-selection`。否则记录开发未显示改善，并使用首次调用前已指定的两个示例，明确标为 `prespecified-fixed-demo-ablation`。这个回退仅用于完成三臂观测，不冒充编译器产出改进，不改变原编译器的无候选停止合同。
5. 两种情况下都先将策略快照、完整搜索成绩及选择类别写入持久化事件，再开始测量。

## 三臂与完整资源

50 个 formal/regression 任务各 3 次重复；每次执行 single=1、budget-matched=3、compiled=1 个独立 Run。compiled 在报告中表示示例策略；它是否通过开发选择由上述 selection 字段决定。

共 **450 个三臂单元、750 次测量生成**，加 40 次搜索为 **790 次生成**；另有 40 个零模型来源 Run，共 **830 个 Run**。开发来源与全部搜索资源归入 compiled；未选中的执行、失败、弃权也完整计量。输入/输出 tokens 包含服务报告的缓存读/建输入；计数 API 请求另外报告，价格与 CPU 费用未知，不按免费处理。

前置兼容探针的 **2 次真实生成、558 input / 233 output tokens** 也冻结为 setup 证据并计入全流程资源；该端点本轮及准备合计计划 **792 次生成**，仍受 800 次上限约束。报告区分本轮与包含 setup 的总额，不把这两次混入三臂质量样本；setup 的生成、计数请求和一次 worker 的价格/时长缺项继续保留未知。

固定选择器 `plurality-first-tie-no-gold-v1`：按实际成功执行的选择投票，执行失败或弃权为 null；同票取首次出现者，并使用该选择首次执行的产物。选择器不读取 gold 或验收成绩，首次产物验收失败也不换用后一次成功产物。

按 seed=20261028 和重复序号轮转臂顺序，串行执行、不共享模型上下文。每个 Run 最多一次 worker Attempt；只装配 [受约束本地执行](../model-free-execution.md)，不使用未知内部调用的 Agent。

## 计量、时限与停止

- 宿主生成预留累计最多 800 次；每次预留 2,048 input / 256 output，总上限对应 1,638,400 / 204,800。已预留的失败/unknown 不退还、不补考。
- 每次生成前调用同一服务的 `count_tokens`，检查同一冻结正文 ≤2,048；生成参数 `max_tokens=256`，SDK 自动重试为 0。计数不是输入硬上界证明，响应后逐次核对实际输入与计数一致、输入/输出未超预留。
- 计数和生成共享 Runtime 的 28 秒决策期限；每 Run 最多 30 秒，全轮自登记起最多 60 分钟。截止后不派发新任务。
- 漂移、未知/缺失用量、服务异常、计数超限、权限变化、中断或不可核验执行证据停止新派发，保留已知部分、占用与所有计划分母，不自动重发。
- 迟到响应用量单独留证，不能改写取消/超时终态、释放预留或补跑。

## 验收及报告

每个 Run 在准入事务中绑定唯一顺序槽位，在启动事务中消费单次许可；重新打开实例仍受默认守卫约束。来源/搜索/测量快照、实际受限视图、服务请求摘要、全部 DecisionCall/Attempt、裁判正文与原始收据可复算。结束后删除资料和工作区、重开实例，报告须逐字段相同。

报告包含每臂 formal/regression 家族等权成功率、误派率、失败率、p95；每个 case×repeat 的选择与结果；关键回归失败；开发及每臂资源；全部生成/计数请求、已知用量、未知用量和未知费用。缺测保留在完整分母中，p95 样本不全时为 null。

数值质量门沿用 ≥90% 成功、分别改善 ≥5 个百分点、误派/失败 ≤5%、候选 p95 ≤30 秒、回归不劣于对照且关键回归全通过。它只描述本观测样本，不能升级独立收益结论。工程完整性、真实调用、数值门、独立收益、正式采用分别报告。

## 执行与复算

```bash
# 无模型请求，完整规模工程演练
env PATH="/opt/homebrew/bin:$PATH" /opt/homebrew/bin/node \
  experiments/runners/run-observed.ts --fixture --output NEW_DIRECTORY

# 必须从干净提交启动，输出目录不可复用；凭据只在内存中使用
env PATH="/opt/homebrew/bin:$PATH" /opt/homebrew/bin/node \
  experiments/runners/run-observed.ts --real --output NEW_DIRECTORY \
  --claude-settings /path/to/explicit/settings.json

# 不需要凭据或原资料，读取保存实例重新核验
env PATH="/opt/homebrew/bin:$PATH" /opt/homebrew/bin/node \
  experiments/runners/run-observed.ts --report EXISTING_DIRECTORY
```

保存 manifest.json、run.json、report.json、summary.json、SQLite 和内容寻址 blob。所有真实执行必须在本协议和运行器提交后开始。
