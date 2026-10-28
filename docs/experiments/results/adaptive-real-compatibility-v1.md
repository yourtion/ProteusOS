# 真实开发兼容探针 v1

2026-10-28（Asia/Shanghai）。本轮不是完整三臂正式实验，不消费正式验证集、不产生 Evaluation 或 Promotion。

## 真实服务探针

从干净提交 `9c02244c2ef9b8f3d65c0f3d0dcf840de689ba4c` 运行 `tests/experiments/probe-adaptive-service.ts`，显式选择本机模型配置；凭据仅在内存中使用。真实服务为 `https://open.bigmodel.cn/api/anthropic`，模型 `GLM-5.3-Flash`，SDK 重试为 0，最多一次生成。

结果：服务预计数 265 input tokens，实际输入 265、输出 82；返回合法 value，选择 `local-process`，符合开发题目预期。此探针只验证 API 请求/响应，不宣称执行了 worker。

原始[报告](./adaptive-service-v1/report.json)、[请求](./adaptive-service-v1/request.json)、[响应](./adaptive-service-v1/response.json)均已保存，正文 SHA-256 与报告核对一致。输出目录 `/private/tmp/proteus-adaptive-service-20261028-v1` 保留本机副本；代码拒绝复用输出目录，生成开始前落盘，中断不自动重发。

## Runtime 探针

从干净提交 `0b08bad00cf2a9a7096cddf123ceca333a15c363` 运行 `tests/experiments/probe-adaptive-runtime.ts`：真实决策通过既有调用账本派发，宿主累计额度为 1，显式装配禁网 worker 与能力后端；使用开发题目和私有期望 JSON 验收。

结果：Run succeeded、唯一 DecisionCall value、唯一 worker Attempt 成功。预计数/实际输入均为 **293 tokens**，输出 **151 tokens**；worker 的模型调用及 tokens 为 0，CPU/费用仍未知。原始 JSON 验收 verified；删除资料及工作区、重开实例，核验报告逐字段相同，activeGenome 不变。

保留[报告](./adaptive-runtime-v1/report.json)、[验收核验](./adaptive-runtime-v1/verification.json)、[原始调用请求](./adaptive-runtime-v1/request.json)和[原始响应](./adaptive-runtime-v1/response.json)，所有正文摘要核对一致。SQLite 与原始 trace/验收 blob 位于 `/private/tmp/proteus-adaptive-runtime-20261028-v1/instance`；临时目录可能被系统清理，使用下列命令生成新证据，不重用已运行目录。

```bash
env PATH="/opt/homebrew/bin:$PATH" /opt/homebrew/bin/node \
  tests/experiments/probe-adaptive-runtime.ts --output NEW_DIRECTORY \
  --claude-settings /path/to/explicit/settings.json
```

也可省略 `--claude-settings`，改用 `PROTEUS_LLM_API_KEY` / `PROTEUS_LLM_BASE_URL`。不得在命令、报告或版本库中粘贴凭据。

## 结论与限制

本次共有 **2 次真实开发生成**（独立服务探针 1 次，Runtime 探针 1 次），合计 558 input / 233 output tokens；不是正式三臂样本，不混入之后实验的收益分母。服务及 Runtime 兼容通过，不能把计数匹配当作输入硬上界，也不能外推模型收益。`inputHardBound=unverified`、`realExperimentAdmission=blocked`、`independentBenefit=not_evaluated`。完整真实轮尚未运行，后续执行路径见[准备方案](../real-run-readiness.md)。

代码验证为 lint、format、typecheck 通过，68 个文件 / 417 passed、5 skipped；跳过项仍为另外显式启用的 Agent/Microsandbox 场景。

另修复 Adapter 的缓存计量：Anthropic input_tokens 不包含缓存读/建输入，累计输入须加 cache_read_input_tokens 和 cache_creation_input_tokens；缺失/非法用量保留未知。依据已安装官方 SDK `Usage` 类型说明，不修改历史调用记录。
