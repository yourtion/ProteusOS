# 真实开发兼容探针 v1

2026-10-28（Asia/Shanghai）。本轮不是完整三臂正式实验，不消费正式验证集、不产生 Evaluation 或 Promotion。

## 真实服务探针

从干净提交 `9c02244c2ef9b8f3d65c0f3d0dcf840de689ba4c` 运行 `tests/experiments/probe-adaptive-service.ts`，显式选择本机模型配置；凭据仅在内存中使用。真实服务为 `https://open.bigmodel.cn/api/anthropic`，模型 `GLM-5.3-Flash`，SDK 重试为 0，最多一次生成。

结果：服务预计数 265 input tokens，实际输入 265、输出 82；返回合法 value，选择 `local-process`，符合开发题目预期。此探针只验证 API 请求/响应，不宣称执行了 worker。

原始[报告](./adaptive-service-v1/report.json)、[请求](./adaptive-service-v1/request.json)、[响应](./adaptive-service-v1/response.json)均已保存，正文 SHA-256 与报告核对一致。输出目录 `/private/tmp/proteus-adaptive-service-20261028-v1` 保留本机副本；代码拒绝复用输出目录，生成开始前落盘，中断不自动重发。

## Runtime 探针

已实现 `tests/experiments/probe-adaptive-runtime.ts`：真实决策通过既有调用账本派发，宿主累计额度为 1，显式装配禁网 worker 与能力后端；使用开发题目和私有期望 JSON 验收。完成后删除资料及工作区、重开实例复算原始验收，检查 activeGenome 不变。等待从干净提交执行并记录结果。

## 结论与限制

服务一次兼容通过，不能把一次计数匹配当作输入硬上界，也不能外推模型收益。`inputHardBound=unverified`、`realExperimentAdmission=blocked`、`independentBenefit=not_evaluated`。完整真实轮尚未运行，后续执行路径见[准备方案](../real-run-readiness.md)。

另修复 Adapter 的缓存计量：Anthropic input_tokens 不包含缓存读/建输入，累计输入须加 cache_read_input_tokens 和 cache_creation_input_tokens；缺失/非法用量保留未知。依据已安装官方 SDK `Usage` 类型说明，不修改历史调用记录。
