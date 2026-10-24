import { z } from "zod";
import { canonicalJson, digestOf } from "../storage/blobs.ts";
import { FROZEN_LLM_POLICY } from "./llm-policy.ts";
import { ABSTAIN_REASON_LIMIT } from "./response.ts";
import { RESPONSE_SCHEMA_DIGEST_TARGET } from "./call.ts";
import { computeViewFeatures, DECISION_VIEW_LIMIT_BYTES } from "./view.ts";

export const LLM_DEMOS_POLICY_KIND = "llm-choice-demos-v1";
export const LLM_DEMO_POOL_LIMIT = 32;
export const LLM_SELECTED_DEMO_LIMIT = 8;
export const LLM_REQUEST_LIMIT_BYTES = 64 * 1024;
const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const viewSchema = z.strictObject({
  viewVersion: z.literal("decision-view-v1"),
  goal: z.string(),
  options: z.array(z.strictObject({ id, description: id })),
  inputs: z.array(z.strictObject({ name: id, type: id, bytes: z.number().int().nonnegative() })),
  features: z.record(id, z.boolean()),
});
const viewContentSchema = z.strictObject({
  schemaVersion: z.number().int().positive(),
  kind: z.literal("decision-view-v1"),
  optionDescriptions: z.record(id, id),
  features: z.record(id, z.strictObject({ terms: z.array(id) })),
  inputViewLimitBytes: z.number().int().positive().max(DECISION_VIEW_LIMIT_BYTES).optional(),
});
const baseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("llm-choice-v1"),
  service: z.literal("anthropic-messages"),
  model: id,
  sampling: z.strictObject({
    temperature: z.number().min(0).max(1),
    maxOutputTokens: z.number().int().positive(),
  }),
  promptTemplate: id,
  responseSchema: z.strictObject({ accept: z.array(id) }),
});
const responseSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("value"), value: id }),
  z.strictObject({ kind: z.literal("abstain"), reason: id.max(ABSTAIN_REASON_LIMIT) }),
]);
const demonstrationSchema = z.strictObject({
  id,
  view: viewSchema,
  response: responseSchema,
  /** 来源声明由后续 learner 读取原始证据核验，不能把模型自报当 verified。 */
  source: z.strictObject({
    purpose: z.literal("development"),
    split: z.literal("train"),
    permission: z.enum(["synthetic", "permitted"]),
    datasetId: id,
    caseId: id,
    familyId: id,
    runId: id,
    decisionId: id,
    verificationRef: id,
    viewDigest: digest,
    responseDigest: digest,
  }),
});
const policySchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal(LLM_DEMOS_POLICY_KIND),
  fixed: z.strictObject({
    basePolicy: z.strictObject({ versionId: id, contentDigest: digest, content: baseSchema }),
    decisionView: z.strictObject({
      versionId: id,
      contentDigest: digest,
      content: viewContentSchema,
    }),
    options: z.array(id).min(1),
    responseSchemaDigest: z.literal(digestOf(RESPONSE_SCHEMA_DIGEST_TARGET)),
  }),
  pool: z.strictObject({
    digest,
    demonstrations: z.array(demonstrationSchema).max(LLM_DEMO_POOL_LIMIT),
  }),
  parameters: z.strictObject({ demoIds: z.array(id).max(LLM_SELECTED_DEMO_LIMIT) }),
});
export type LlmDemonstration = z.infer<typeof demonstrationSchema>;
export type LlmDemosPolicyContent = z.infer<typeof policySchema>;

export class LlmDemosPolicyError extends Error {}

export function isLlmDemosPolicy(content: unknown): boolean {
  return (
    typeof content === "object" &&
    content !== null &&
    (content as { kind?: unknown }).kind === LLM_DEMOS_POLICY_KIND
  );
}

export function parseLlmDemosPolicy(input: unknown): LlmDemosPolicyContent {
  const result = policySchema.safeParse(input);
  if (!result.success) throw new LlmDemosPolicyError(`示例策略格式非法：${result.error.message}`);
  const policy = result.data;
  const { basePolicy, decisionView, options } = policy.fixed;
  for (const source of [basePolicy, decisionView]) {
    if (digestOf(canonicalJson(source.content)) !== source.contentDigest)
      throw new LlmDemosPolicyError("冻结组件内容摘要不匹配");
  }
  if (
    new Set(options).size !== options.length ||
    options.some((option) => !decisionView.content.optionDescriptions[option])
  )
    throw new LlmDemosPolicyError("冻结选项重复或缺少描述");
  if (
    !basePolicy.content.promptTemplate.includes("{{OPTIONS}}") ||
    !basePolicy.content.promptTemplate.includes("{{VIEW}}")
  )
    throw new LlmDemosPolicyError("冻结模板缺少 OPTIONS/VIEW 占位符");
  if (
    canonicalJson(basePolicy.content.responseSchema) !==
    canonicalJson(FROZEN_LLM_POLICY.responseSchema)
  )
    throw new LlmDemosPolicyError("响应 schema 不得改变");
  if (digestOf(canonicalJson(policy.pool.demonstrations)) !== policy.pool.digest)
    throw new LlmDemosPolicyError("示例池摘要不匹配");
  if (Buffer.byteLength(canonicalJson(policy), "utf8") > 1024 * 1024)
    throw new LlmDemosPolicyError("策略产物超过 1 MiB");
  const ids = new Set<string>();
  const views = new Set<string>();
  for (const demo of policy.pool.demonstrations) {
    if (ids.has(demo.id) || views.has(demo.source.viewDigest))
      throw new LlmDemosPolicyError("示例 ID 或视图重复");
    ids.add(demo.id);
    views.add(demo.source.viewDigest);
    assertLlmDemoView(policy, demo.view);
    if (
      demo.source.viewDigest !== digestOf(canonicalJson(demo.view)) ||
      demo.source.responseDigest !== digestOf(canonicalJson(demo.response))
    )
      throw new LlmDemosPolicyError("示例内容与来源摘要不匹配");
    if (demo.response.kind === "value" && !options.includes(demo.response.value))
      throw new LlmDemosPolicyError("示例选择不属于冻结选项");
  }
  if (
    new Set(policy.parameters.demoIds).size !== policy.parameters.demoIds.length ||
    policy.parameters.demoIds.some((selected) => !ids.has(selected))
  )
    throw new LlmDemosPolicyError("示例参数包含重复或未知 ID");
  return policy;
}

/** 校验实际任务与示例都遵循同一冻结视图合同。 */
export function assertLlmDemoView(policy: LlmDemosPolicyContent, input: unknown): void {
  const parsed = viewSchema.safeParse(input);
  if (!parsed.success) throw new LlmDemosPolicyError("视图包含非法字段或类型");
  const view = parsed.data;
  const content = policy.fixed.decisionView.content;
  const expected = policy.fixed.options.map((option) => ({
    id: option,
    description: content.optionDescriptions[option]!,
  }));
  if (
    canonicalJson(view.options) !== canonicalJson(expected) ||
    canonicalJson(view.features) !== canonicalJson(computeViewFeatures(content, view.goal))
  )
    throw new LlmDemosPolicyError("视图选项、描述或公开特征与冻结合同不一致");
  if (
    Buffer.byteLength(canonicalJson(view), "utf8") >
    (content.inputViewLimitBytes ?? DECISION_VIEW_LIMIT_BYTES)
  )
    throw new LlmDemosPolicyError("视图超过冻结大小上限");
}

export function createLlmDemosPolicy(input: {
  basePolicy: LlmDemosPolicyContent["fixed"]["basePolicy"];
  decisionView: LlmDemosPolicyContent["fixed"]["decisionView"];
  options: string[];
  demonstrations: LlmDemonstration[];
  demoIds: string[];
}): LlmDemosPolicyContent {
  return parseLlmDemosPolicy({
    schemaVersion: 1,
    kind: LLM_DEMOS_POLICY_KIND,
    fixed: {
      basePolicy: input.basePolicy,
      decisionView: input.decisionView,
      options: input.options,
      responseSchemaDigest: digestOf(RESPONSE_SCHEMA_DIGEST_TARGET),
    },
    pool: {
      digest: digestOf(canonicalJson(input.demonstrations)),
      demonstrations: input.demonstrations,
    },
    parameters: { demoIds: input.demoIds },
  });
}

/** 唯一优化入口：冻结基线/签名/池，只改变示例 ID 的子集及顺序。 */
export function withLlmDemoParameters(input: unknown, demoIds: string[]): LlmDemosPolicyContent {
  const base = parseLlmDemosPolicy(input);
  return parseLlmDemosPolicy({ ...base, parameters: { demoIds } });
}

export function assertLlmDemoParametersOnly(before: unknown, after: unknown): void {
  const a = parseLlmDemosPolicy(before);
  const b = parseLlmDemosPolicy(after);
  if (
    canonicalJson({ fixed: a.fixed, pool: a.pool }) !==
    canonicalJson({ fixed: b.fixed, pool: b.pool })
  )
    throw new LlmDemosPolicyError("优化只允许选择与重排冻结示例");
}
