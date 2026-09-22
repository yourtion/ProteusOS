/**
 * LLM 决策响应的严格解析（实验规范 §3.3）。
 * 整段响应必须通过严格 schema 校验；禁止从 Markdown、解释文本或近似名称中
 * 猜测/提取选项。网络错误、429、超时与非法响应不能映射为 abstain。
 */

export const ABSTAIN_REASON_LIMIT = 512;

export type ChoiceResponse =
  | { kind: "value"; value: string }
  | { kind: "abstain"; reason: string; origin: "model" | "service_refusal" }
  | { kind: "invalid"; detail: string };

/**
 * 解析整段模型响应。规则：
 * - 必须是单一 JSON 对象（不允许 Markdown 围栏、前后缀文本、多个 JSON）
 * - 只接受 {"kind":"value","value":...} 或 {"kind":"abstain","reason":...}，拒绝其他字段
 * - value 必须与候选 ID 完全相等（不做前缀/模糊/大小写匹配）
 * - abstain reason ≤ 512 字符
 * - 数字/布尔/嵌套值均为 invalid
 */
export function parseChoiceResponse(raw: string, options: string[]): ChoiceResponse {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { kind: "invalid", detail: "响应为空" };
  }
  // 允许服务端常规空白填充，但围栏与解释文本整体判 invalid（不从中提取）
  if (trimmed.startsWith("```")) {
    return { kind: "invalid", detail: "响应被 Markdown 围栏包裹，拒绝提取" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "invalid", detail: "响应不是合法 JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "invalid", detail: "响应不是 JSON 对象" };
  }
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (obj["kind"] === "value") {
    if (keys.join(",") !== "kind,value") {
      return { kind: "invalid", detail: `value 响应含非法字段：${keys.join(", ")}` };
    }
    const value = obj["value"];
    if (typeof value !== "string") {
      return { kind: "invalid", detail: "value 不是字符串" };
    }
    if (!options.includes(value)) {
      return {
        kind: "invalid",
        detail: `value ${JSON.stringify(value)} 不在候选 [${options.join(", ")}] 内（不做近似匹配）`,
      };
    }
    return { kind: "value", value };
  }
  if (obj["kind"] === "abstain") {
    if (keys.join(",") !== "kind,reason") {
      return { kind: "invalid", detail: `abstain 响应含非法字段：${keys.join(", ")}` };
    }
    const reason = obj["reason"];
    if (typeof reason !== "string") {
      return { kind: "invalid", detail: "abstain reason 不是字符串" };
    }
    if (reason.length > ABSTAIN_REASON_LIMIT) {
      return {
        kind: "invalid",
        detail: `abstain reason 超过 ${ABSTAIN_REASON_LIMIT} 字符（实际 ${reason.length}）`,
      };
    }
    if (reason.length === 0) {
      return { kind: "invalid", detail: "abstain reason 为空" };
    }
    return { kind: "abstain", reason, origin: "model" };
  }
  return {
    kind: "invalid",
    detail: `kind 必须是 value 或 abstain，实际 ${JSON.stringify(obj["kind"])}`,
  };
}
