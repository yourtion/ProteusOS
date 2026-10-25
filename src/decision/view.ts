import { readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { canonicalJson } from "../storage/blobs.ts";

/**
 * decision-view-v1：模型与规则可见的受限任务视图（实验规范 §3.2）。
 * 只包含 goal、固定选项描述、输入清单（相对名/类型/字节数）与公开词法特征；
 * 答案、期望 JSON、schema 内容、caseId/familyId、split 与验收信息一律不进入。
 */

export const DECISION_VIEW_KIND = "decision-view-v1";

/** 输入视图总大小上限（UTF-8 字节）；超限在网络调用前失败，禁止无记录截断 */
export const DECISION_VIEW_LIMIT_BYTES = 16 * 1024;

/** decision-view 槽位产物内容（版本化：视图规则、选项描述、词表与输入限制） */
export interface DecisionViewContent {
  schemaVersion: number;
  kind: typeof DECISION_VIEW_KIND;
  /** 选项 ID → 对模型与规则公开的描述；必须覆盖图的全部 options */
  optionDescriptions: Record<string, string>;
  /** 公开词法特征：特征名 → 词表（开发集确定并版本化） */
  features: Record<string, { terms: string[] }>;
  inputViewLimitBytes?: number;
}

/** 发送给 Provider 的视图对象（唯一任务信息载体） */
export interface DecisionView {
  viewVersion: typeof DECISION_VIEW_KIND;
  goal: string;
  options: Array<{ id: string; description: string }>;
  inputs: Array<{ name: string; type: string; bytes: number }>;
  features: Record<string, boolean>;
}

export class DecisionViewError extends Error {
  readonly code: "invalid_view_content" | "unknown_option" | "input_too_large" | "input_unreadable";

  constructor(code: DecisionViewError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export function parseDecisionViewContent(content: unknown): DecisionViewContent {
  if (typeof content !== "object" || content === null) {
    throw new DecisionViewError("invalid_view_content", "decision-view 内容不是对象");
  }
  const c = content as Record<string, unknown>;
  if (c["kind"] !== DECISION_VIEW_KIND) {
    throw new DecisionViewError(
      "invalid_view_content",
      `decision-view kind 应为 ${DECISION_VIEW_KIND}，实际 ${String(c["kind"])}`,
    );
  }
  const descriptions = c["optionDescriptions"];
  if (typeof descriptions !== "object" || descriptions === null) {
    throw new DecisionViewError("invalid_view_content", "decision-view 缺少 optionDescriptions");
  }
  for (const [id, description] of Object.entries(descriptions)) {
    if (typeof description !== "string" || description.length === 0) {
      throw new DecisionViewError("invalid_view_content", `选项 ${id} 的描述不合法`);
    }
  }
  const features = c["features"];
  if (typeof features !== "object" || features === null) {
    throw new DecisionViewError("invalid_view_content", "decision-view 缺少 features 词表");
  }
  for (const [name, spec] of Object.entries(features)) {
    if (
      typeof spec !== "object" ||
      spec === null ||
      !Array.isArray((spec as { terms?: unknown }).terms) ||
      !(spec as { terms: unknown[] }).terms.every((t) => typeof t === "string" && t.length > 0)
    ) {
      throw new DecisionViewError("invalid_view_content", `特征 ${name} 的词表不合法`);
    }
  }
  return content as DecisionViewContent;
}

/** 大小写/Unicode 归一化（固定规则）：NFKC + 小写，用于 goal 与词表项匹配 */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/**
 * 由固定词法规则计算公开特征：goal 归一化后包含词表任一项即命中。
 * 特征只依赖 goal 与版本化词表——成对样本除 goal 及其派生特征外视图一致。
 */
export function computeViewFeatures(
  content: DecisionViewContent,
  goal: string,
): Record<string, boolean> {
  const normalizedGoal = normalizeText(goal);
  const features: Record<string, boolean> = {};
  for (const [name, spec] of Object.entries(content.features)) {
    // 词表项同样归一化，匹配规则与优先级固定（任一命中即 true）
    features[name] = spec.terms.some((term) => normalizedGoal.includes(normalizeText(term)));
  }
  return features;
}

/** 输入类型：按扩展名的固定映射；未知扩展归 other（不泄露正文） */
function inputTypeOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  return "other";
}

/** 遍历任务输入：目录展开为相对路径条目，文件取 basename；只暴露名称/类型/字节数 */
function listInputEntries(inputs: string[]): Array<{ name: string; type: string; bytes: number }> {
  const entries: Array<{ name: string; type: string; bytes: number }> = [];
  for (const input of inputs) {
    let stat;
    try {
      stat = statSync(input);
    } catch {
      throw new DecisionViewError("input_unreadable", `输入不可读：${input}`);
    }
    if (stat.isFile()) {
      entries.push({ name: basename(input), type: inputTypeOf(input), bytes: stat.size });
      continue;
    }
    if (!stat.isDirectory()) {
      throw new DecisionViewError("input_unreadable", `输入不是文件或目录：${input}`);
    }
    // 输入根 basename 对应工作区 inputs/ 下的同名目录
    const root = basename(input);
    for (const rel of walk(input, input)) {
      entries.push({
        name: `${root}/${rel}`,
        type: inputTypeOf(rel),
        bytes: statSync(join(input, rel)).size,
      });
    }
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

function walk(root: string, dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(root, full));
    else out.push(relative(root, full));
  }
  return out;
}

/**
 * 构造 decision-view-v1（Runtime 装配并校验）。
 * - options 必须全部有版本化描述（unknown_option 拒绝）
 * - 视图序列化大小超限 → input_too_large，调用方须在网络调用前失败
 */
export function buildDecisionView(input: {
  content: DecisionViewContent;
  goal: string;
  options: string[];
  taskInputs: string[];
}): DecisionView {
  return buildDecisionViewFromInputs({ ...input, inputs: listInputEntries(input.taskInputs) });
}

/** 对已冻结的文件清单构造同一受限视图；不读取工作区或验收资料。 */
export function buildDecisionViewFromInputs(input: {
  content: DecisionViewContent;
  goal: string;
  options: string[];
  inputs: Array<{ name: string; bytes: number }>;
}): DecisionView {
  const { content, goal, options } = input;
  for (const id of options) {
    if (!content.optionDescriptions[id]) {
      throw new DecisionViewError("unknown_option", `decision-view 缺少选项 ${id} 的描述`);
    }
  }
  const view: DecisionView = {
    viewVersion: DECISION_VIEW_KIND,
    goal,
    options: options.map((id) => ({ id, description: content.optionDescriptions[id]! })),
    inputs: input.inputs
      .map(({ name, bytes }) => ({ name, type: inputTypeOf(name), bytes }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    features: computeViewFeatures(content, goal),
  };
  const limit = content.inputViewLimitBytes ?? DECISION_VIEW_LIMIT_BYTES;
  const size = Buffer.byteLength(canonicalJson(view), "utf8");
  if (size > limit) {
    throw new DecisionViewError(
      "input_too_large",
      `decision-view 序列化后 ${size} 字节超过上限 ${limit}，拒绝在网络调用前发送`,
    );
  }
  return view;
}
