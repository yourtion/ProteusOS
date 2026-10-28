/**
 * Decision：结构化选择合同（docs/runtime.md §3）。
 * 只回答类型化问题；不持有执行副作用，也不原地修改策略。
 * M0 切片② 实现 choice；gate/rank 类型保留在合同中。
 * 本体决策实验（ADR 0007）扩展：view-based 请求、严格响应解析与调用记录合同。
 */

import type { DecisionCallProvenance } from "./call.ts";
import type { DecisionView } from "./view.ts";

export type DecisionProblem = "choice" | "gate" | "rank";

export interface DecisionProvenance {
  provider: string;
  policyVersion: string;
}

export interface PreparedDecisionRequest {
  /** 不含认证头/凭据的版本化请求正文，由受信 Provider 渲染。 */
  format: string;
  body: Record<string, unknown>;
}

export interface DecisionRequest {
  problem: DecisionProblem;
  /** choice / gate / rank 的候选选项 */
  options: string[];
  /** 图节点声明的静态决策上下文 */
  context: Record<string, unknown>;
  /** 快照解析出的策略内容与精确版本 */
  policy: { versionId: string; content: unknown };
  deadlineMs: number;
  remainingAttempts: number;
  /**
   * decision-view-v1 受限任务视图（实验规范 §3.2）。
   * 声明 view 的决策节点由 Runtime 装配；Provider 只能接收这个视图，
   * 不接收整个 Task、存储对象或工作区访问能力。旧图（无 view）不携带。
   */
  view?: DecisionView;
  /** 精确快照视图来源，供带冻结签名的策略核对。 */
  viewSource?: { versionId: string; contentDigest: string };
  /** prepared 之前保存的实际请求；恢复不能改用新渲染结果。 */
  prepared?: PreparedDecisionRequest;
  /** 底层请求取消信号：Runtime 在 deadline/取消时触发；Provider 应尽力传播 */
  signal?: AbortSignal;
}

/**
 * 调用级证据提示：由受信 Adapter 从服务响应提取（模型自报的不作门槛）。
 * 缺失字段最终落 null，不按零费用/零 token 计入比较。
 */
export interface DecisionServiceResponseEvidence {
  version: "llm-service-response-v1";
  stopReason: string | null;
  contentBlockTypes: Array<string | null> | null;
  textBytes: number;
}

export interface DecisionEvidenceHint {
  inputTokens?: number | null;
  outputTokens?: number | null;
  costAmount?: number | null;
  costCurrency?: string | null;
  priceRef?: string | null;
  /** 服务报告的模型版本（缺省 null） */
  servedModel?: string | null;
  /** 受信服务元数据；不包含隐藏推理正文，旧结果缺失时不推断。 */
  serviceResponse?: DecisionServiceResponseEvidence;
}

export type DecisionResult =
  | {
      kind: "value";
      value: unknown;
      provenance: DecisionProvenance;
      /** 原始响应文本（写入受控 blob 作为证据；凭据永不落盘） */
      raw?: string;
      evidence?: DecisionEvidenceHint;
    }
  | {
      kind: "abstain";
      reason: string;
      provenance: DecisionProvenance;
      /** 弃权来源：模型自身弃权或服务 refusal（原始类型单独保存） */
      origin?: "model" | "service_refusal";
      raw?: string;
      evidence?: DecisionEvidenceHint;
    }
  | {
      /** 整段响应未通过严格 schema：不做截断修复或猜测（实验规范 §3.3） */
      kind: "invalid_output";
      detail: string;
      provenance: DecisionProvenance;
      raw: string;
      evidence?: DecisionEvidenceHint;
    };

export interface DecisionProvider {
  readonly name: string;
  /** 远端调用（消耗决策调用额度并承担计费/unknown 风险）；缺省 false=本地计算 */
  readonly remote?: boolean;
  capabilities(): { problems: DecisionProblem[] };
  decide(request: DecisionRequest): Promise<DecisionResult>;
  /** 同步、无副作用的请求渲染；旧 Provider 可不实现。 */
  prepareRequest?(request: DecisionRequest): PreparedDecisionRequest | undefined;
  /** 受信 Adapter 填充的调用来源（服务/模型/采样/提示摘要）；不信模型自报 */
  callProvenance?(request: DecisionRequest): {
    adapter: string;
    serviceId?: string | null;
    requestedModel?: string | null;
    sampling?: DecisionCallProvenance["sampling"];
    promptDigest?: string | null;
    reproducibility?: DecisionCallProvenance["reproducibility"];
  };
}

export type ChoiceValidation =
  | { ok: true; value: string }
  | { ok: false; reason: "abstain" | "invalid_output"; detail: string };

/**
 * Runtime 必须独立校验决策结果（选项成员关系），不能信 provider 自述。
 * abstain 与非法输出分开：前者是"无法可靠作答"，后者按 invalid_output 处理。
 */
export function validateChoice(result: DecisionResult, options: string[]): ChoiceValidation {
  if (result.kind === "abstain") {
    return { ok: false, reason: "abstain", detail: result.reason };
  }
  if (result.kind === "invalid_output") {
    return { ok: false, reason: "invalid_output", detail: result.detail };
  }
  if (typeof result.value !== "string" || !options.includes(result.value)) {
    return {
      ok: false,
      reason: "invalid_output",
      detail: `choice 结果 ${JSON.stringify(result.value)} 不在候选 [${options.join(", ")}] 内`,
    };
  }
  return { ok: true, value: result.value };
}

export * from "./view.ts";
export * from "./response.ts";
export * from "./call.ts";
export * from "./llm-policy.ts";

export * from "./llm-demos-policy.ts";
