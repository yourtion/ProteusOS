/**
 * 决策调用记录合同（实验规范 §4.3/§4.4）。
 * 每次决策生成持久化 decisionId；调用记录独立于 Executor Attempt，
 * 状态覆盖 prepared → started → 终态（value/abstain/invalid_output/
 * transport_error/timeout/cancelled/unknown）。
 */

export const DECISION_CALL_STATES = [
  "prepared",
  "started",
  "value",
  "abstain",
  "invalid_output",
  "transport_error",
  "timeout",
  "cancelled",
  "unknown",
] as const;

export type DecisionCallState = (typeof DECISION_CALL_STATES)[number];

/** 终态集合；prepared/started 只是内部生命周期，不作为模型回答 */
export const TERMINAL_DECISION_CALL_STATES: ReadonlySet<DecisionCallState> = new Set([
  "value",
  "abstain",
  "invalid_output",
  "transport_error",
  "timeout",
  "cancelled",
  "unknown",
]);

/** 决策调用类别：local（规则本地计算，不消耗远端额度）| model（真实远端调用） */
export type DecisionCallKind = "local" | "model";

/**
 * 全部策略与调用来源（实验规范 §4.1）。
 * Provider 返回的 provenance 由受信 Adapter 和请求配置填充；
 * 不相信模型自报的策略/模型版本。
 */
export interface DecisionCallProvenance {
  /** 决策 provider 注册名（受信装配） */
  provider: string;
  /** adapter 实现标识与版本（受信代码内嵌） */
  adapter: string;
  /** routing-policy 精确版本 ID */
  policyVersionId: string;
  /** decision-view 槽位精确版本 ID */
  viewVersionId: string | null;
  /** 服务协议与端点标识（可变 endpoint 不能在恢复时静默映射到另一服务） */
  serviceId: string | null;
  /** 请求的 model ID */
  requestedModel: string | null;
  /** 服务报告的模型版本（缺省 null） */
  servedModel: string | null;
  sampling: {
    temperature: number | null;
    maxOutputTokens: number | null;
    [key: string]: unknown;
  } | null;
  /** prompt/template 内容摘要 */
  promptDigest: string | null;
  /** 响应 schema 内容摘要 */
  responseSchemaDigest: string | null;
  /** 实现代码 commit */
  commit: string | null;
  /** 复现限制声明（模型权重无法钉住时 recorded-inputs-only） */
  reproducibility: "recorded-inputs-only" | "pinned" | null;
}

/** 用量与费用：缺失字段为 null，不能按零费用计入策略比较（实验规范 §4.2） */
export interface DecisionCallUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costAmount: number | null;
  costCurrency: string | null;
  priceRef: string | null;
}

export interface DecisionCallRecord {
  id: string;
  experimentId: string | null;
  runId: string;
  nodeId: string;
  snapshotId: string;
  kind: DecisionCallKind;
  state: DecisionCallState;
  /** 是否已真正进入网络发送（started 之后为 true；prepared 崩溃保守判 unknown 的判据） */
  sent: boolean;
  provider: string;
  policyVersionId: string;
  viewVersionId: string | null;
  requestRef: string | null;
  requestDigest: string | null;
  responseRef: string | null;
  responseDigest: string | null;
  provenance: DecisionCallProvenance;
  usage: DecisionCallUsage | null;
  errorClass: string | null;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  /** 迟到证据：timeout/cancel 后到达的响应不改终态，仅追加标记 */
  lateArrival: boolean;
  createdAt: number;
  updatedAt: number;
}

export const RESPONSE_SCHEMA_DIGEST_TARGET =
  '{"kind":"abstain","reason":"string(<=512)"}|{"kind":"value","value":"option-id"}';

/**
 * 预算检查的计数规则（D06）：消耗/预留 = 已发送（sent）的远端调用 +
 * 仍处于 prepared 预留的远端调用。prepared 未发送即取消的不计数。
 */
export function countsAgainstQuota(
  call: Pick<DecisionCallRecord, "kind" | "state" | "sent">,
): boolean {
  if (call.kind !== "model") return false;
  return call.sent || call.state === "prepared";
}
