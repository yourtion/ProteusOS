import { z } from "zod";
import { canonicalJson, digestOf } from "../storage/blobs.ts";
import type { ShareEnvelope } from "./types.ts";

const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const parentSchema = z.strictObject({ id, contentDigest: digest, lineageId: id });
export const envelopeSchema = z.strictObject({
  digest,
  bundle: z.strictObject({
    format: z.literal("proteus-share-v1"),
    publicationId: id,
    teamId: id,
    scope: id,
    publisher: id,
    createdAt: z.number().int().nonnegative(),
    roots: z.array(id).min(1).max(256),
    versions: z
      .array(
        z.strictObject({
          id,
          artifactId: id,
          kind: id,
          lineageId: id,
          scope: id,
          schemaVersion: z.number().int().positive(),
          content: z.string().max(8_000_000),
          contentDigest: digest,
          dependencies: z.array(id).max(256),
          parents: z.array(parentSchema).max(256),
          withheldParentCount: z.number().int().nonnegative(),
        }),
      )
      .min(1)
      .max(256),
    evidence: z
      .array(
        z.strictObject({
          protocolDigest: digest,
          verdict: z.literal("eligible"),
          samples: z.number().int().min(4),
          baseSuccessRate: z.number().min(0).max(1).nullable(),
          candidateSuccessRate: z.number().min(0).max(1).nullable(),
        }),
      )
      .max(64),
  }),
});

export function validateShareEnvelope(input: unknown): ShareEnvelope {
  const envelope = envelopeSchema.parse(input);
  if (Buffer.byteLength(canonicalJson(envelope), "utf8") > 16_000_000)
    throw new Error("分享包超出导入预算");
  const bundle = envelope.bundle;
  if (digestOf(canonicalJson(bundle)) !== envelope.digest) throw new Error("分享包摘要不符");
  if (bundle.scope !== "public" && bundle.scope !== `team:${bundle.teamId}`)
    throw new Error("分享包 scope 与团队不一致");
  const versions = new Map(bundle.versions.map((v) => [v.id, v]));
  if (
    versions.size !== bundle.versions.length ||
    new Set(bundle.roots).size !== bundle.roots.length ||
    bundle.roots.some((v) => !versions.has(v))
  )
    throw new Error("重复版本或根版本缺失");
  for (const v of versions.values()) {
    if (!heritableKind(v.kind) || (v.scope !== "public" && v.scope !== bundle.scope))
      throw new Error("外部版本类型或 scope 不允许分享");
    if (digestOf(v.content) !== v.contentDigest || v.dependencies.some((d) => !versions.has(d)))
      throw new Error("内容摘要不符或依赖闭包缺失");
  }
  const pending = [...versions.values()];
  const complete = new Set<string>();
  while (pending.length) {
    const index = pending.findIndex((v) => v.dependencies.every((d) => complete.has(d)));
    if (index < 0) throw new Error("外部依赖形成环");
    complete.add(pending.splice(index, 1)[0]!.id);
  }
  return envelope;
}

export function heritableKind(kind: string): boolean {
  return (
    ["task-graph", "routing-policy", "acceptance-evaluator", "decision-view"].includes(kind) ||
    /^capability\/[a-z][a-z0-9-]*$/.test(kind)
  );
}
