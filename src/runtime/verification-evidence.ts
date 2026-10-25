import { z } from "zod";
import { canonicalJson, digestOf, type BlobStore } from "../storage/blobs.ts";
import {
  evaluateExpectedOutput,
  evaluateHybridOutput,
  evaluateStatsOutput,
  readEvaluatorKind,
} from "./acceptance.ts";
import type { OutcomeCheck } from "./types.ts";

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const documentSchema = z.strictObject({ ref: id, digest });
const recordSchema = z.strictObject({
  version: z.literal("json-verification-evidence-v1"),
  runId: id,
  taskId: id,
  snapshotId: id,
  nodeId: id,
  inputFrom: id,
  evaluator: z.strictObject({ versionId: id, contentRef: id, contentDigest: digest }),
  algorithm: z.enum(["stats-acceptance-v1", "hybrid-acceptance-v1"]),
  documents: z.strictObject({
    output: documentSchema,
    schema: documentSchema,
    expected: documentSchema.nullable(),
  }),
  passed: z.boolean(),
  checks: z.array(z.strictObject({ name: id, passed: z.boolean(), detail: z.string().optional() })),
  recordedAt: z.number().int().nonnegative(),
});
export type JsonVerificationRecord = z.infer<typeof recordSchema>;
export type StoredVerificationEvidence =
  | { version: "verification-evidence-v1"; status: "available"; ref: string; digest: string }
  | { version: "verification-evidence-v1"; status: "failed" | "unavailable"; reason: string };

/** 原始判定正文只进入受控 blob，不进入 worker 输入或模型请求。 */
export function persistJsonVerification(
  blobs: BlobStore,
  record: Omit<JsonVerificationRecord, "version" | "documents">,
  raw: { output: string; schema: string; expected: string | null },
): StoredVerificationEvidence {
  if (
    Object.values(raw).reduce((sum, value) => sum + Buffer.byteLength(value ?? "", "utf8"), 0) >
    4 * 1024 * 1024
  )
    return {
      version: "verification-evidence-v1",
      status: "unavailable",
      reason: "json_documents_exceed_4_mib",
    };
  try {
    const payload = recordSchema.parse({
      ...record,
      version: "json-verification-evidence-v1",
      documents: {
        output: blobs.write(raw.output),
        schema: blobs.write(raw.schema),
        expected: raw.expected === null ? null : blobs.write(raw.expected),
      },
    });
    const blob = blobs.write(canonicalJson(payload));
    return { version: "verification-evidence-v1", status: "available", ...blob };
  } catch {
    return {
      version: "verification-evidence-v1",
      status: "failed",
      reason: "verification_evidence_persistence_failed",
    };
  }
}

/** 验证摘要并以原始正文复算；不读取可变工作区，不运行 test-runner 或外部服务。 */
export function readJsonVerification(
  evidence: StoredVerificationEvidence,
  blobs: Pick<BlobStore, "read">,
) {
  if (evidence.version !== "verification-evidence-v1" || evidence.status !== "available")
    throw new Error("json_verification_evidence_unavailable");
  const read = (ref: string, expectedDigest: string) => {
    const raw = blobs.read(ref);
    if (digestOf(raw) !== expectedDigest) throw new Error("verification_evidence_digest_mismatch");
    return raw;
  };
  const record = recordSchema.parse(JSON.parse(read(evidence.ref, evidence.digest)));
  const evaluator = JSON.parse(read(record.evaluator.contentRef, record.evaluator.contentDigest));
  if (record.algorithm !== readEvaluatorKind(evaluator))
    throw new Error("verification_evaluator_algorithm_mismatch");
  const outputRaw = read(record.documents.output.ref, record.documents.output.digest);
  const schemaRaw = read(record.documents.schema.ref, record.documents.schema.digest);
  const expectedRaw = record.documents.expected
    ? read(record.documents.expected.ref, record.documents.expected.digest)
    : null;
  const output: unknown = JSON.parse(outputRaw);
  const schema: unknown = JSON.parse(schemaRaw);
  const evaluation =
    record.algorithm === "hybrid-acceptance-v1"
      ? evaluateHybridOutput(output, schema)
      : evaluateStatsOutput(output, schema);
  if (expectedRaw !== null) {
    const check = evaluateExpectedOutput(output, JSON.parse(expectedRaw));
    evaluation.checks.push(check);
    evaluation.passed &&= check.passed;
  }
  if (
    evaluation.passed !== record.passed ||
    canonicalJson(evaluation.checks) !== canonicalJson(record.checks)
  )
    throw new Error("verification_verdict_mismatch");
  return { record, evaluation: evaluation as { passed: boolean; checks: OutcomeCheck[] } };
}
