import { z } from "zod";
import { canonicalJson, digestOf } from "../../src/storage/blobs.ts";
import { parseAdaptiveObservation, type FrozenAdaptivePlan } from "./adaptive.ts";
import type { AdaptiveRunSlots } from "./run-slots.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const judgmentsSchema = z.strictObject({
  version: z.literal("adaptive-judgments-v1"),
  manifestDigest: digest,
  sourceRef: z.string().min(1).max(2048),
  cases: z
    .array(
      z.strictObject({
        caseId: z.string().min(1),
        taskDigest: digest,
        evaluatorDigest: digest,
        expectedChoice: z.string().min(1).nullable(),
      }),
    )
    .min(1),
});
export type AdaptiveJudgments = z.infer<typeof judgmentsSchema>;

export function parseJudgments(frozen: FrozenAdaptivePlan, input: unknown): AdaptiveJudgments {
  const doc = judgmentsSchema.parse(input);
  if (doc.manifestDigest !== frozen.digest) throw new Error("标签清单摘要不匹配");
  const cases = frozen.plan.cases.filter((c) => c.split === "formal" || c.split === "regression");
  if (
    doc.cases.length !== cases.length ||
    new Set(doc.cases.map((c) => c.caseId)).size !== cases.length
  )
    throw new Error("标签必须完整覆盖正式/回归 case，不能重复或追加开发标签");
  for (const row of doc.cases) {
    const c = cases.find((c) => c.id === row.caseId);
    if (!c || row.taskDigest !== c.taskDigest || row.evaluatorDigest !== c.evaluatorDigest)
      throw new Error("标签任务或裁判摘要漂移");
  }
  doc.cases.sort(
    (a, b) => cases.findIndex((c) => c.id === a.caseId) - cases.findIndex((c) => c.id === b.caseId),
  );
  if (Buffer.byteLength(canonicalJson(doc), "utf8") > 1024 * 1024)
    throw new Error("标签正文超过 1 MiB");
  return doc;
}

/** 选择已由无标签算法完成；此处才使用冻结的独立路由标签和验收结论。 */
export function deriveRunReceipt(
  proof: ReturnType<AdaptiveRunSlots["readAudit"]>,
  labels: AdaptiveJudgments,
  judgmentsDigest: string,
  startedAt: number,
  endedAt: number,
) {
  const arm = proof.arm;
  if (!arm || arm.missing.length || arm.proofs.some((p) => !p))
    throw new Error("原始收据须覆盖全部已结案槽位");
  const row = labels.cases.find((c) => c.caseId === arm.unit.caseId)!;
  if (!row) throw new Error("收据缺少冻结路由标签");
  const selected = arm.proofs[arm.selectedIndex]!;
  const choice = arm.selectedChoice;
  const needsVerdict = choice !== null && choice === row.expectedChoice;
  const unavailable = needsVerdict && selected.task.status !== "verified";
  const usage = arm.resources;
  const total = (key: "modelCalls" | "inputTokens" | "outputTokens") =>
    usage[key].unknownItems ? null : usage[key].knownTotal;
  const completeCost =
    !usage.unknownCostItems && usage.knownCosts.length === 1 ? usage.knownCosts[0]! : null;
  const state = unavailable ? "unknown" : selected.task.verification.runtimeState;
  const observation = parseAdaptiveObservation({
    unitId: arm.unit.id,
    manifestDigest: arm.manifestDigest,
    source: "fixture",
    startedAt,
    endedAt,
    state,
    accepted: unavailable ? null : needsVerdict && selected.task.verifiedAcceptance,
    decision: unavailable ? "unknown" : selected.decisionOutcome,
    misrouted: choice !== null && choice !== row.expectedChoice,
    evidenceRefs: [
      ...arm.proofs.map((p) => `run:${p!.runId}`),
      ...usage.items.map((item) => item.ref),
    ],
    usage: {
      modelCalls: total("modelCalls"),
      inputTokens: total("inputTokens"),
      outputTokens: total("outputTokens"),
      costAmount: completeCost?.amount ?? null,
      costCurrency: completeCost?.currency ?? null,
      priceRef: completeCost ? completeCost.priceRefs.join(";") : null,
    },
  });
  return {
    version: "adaptive-run-receipt-v1" as const,
    scope: "fixture-persisted-runtime-records" as const,
    experimentId: proof.experimentId,
    reservationId: proof.reservationId,
    manifestDigest: proof.manifestDigest,
    planDigest: proof.planDigest,
    judgmentsDigest,
    slotAuditDigest: proof.digest,
    observation,
    resources: usage,
    labelIndependence: "not_verified" as const,
    sourceModeVerification: "unavailable" as const,
    formalEvaluation: "not_run" as const,
  };
}
export type AdaptiveRunReceipt = ReturnType<typeof deriveRunReceipt>;

/** 跨单元保留原始计量项的已知部分；unknown 不会抹掉其他调用的已知 tokens。 */
export function summarizeReceiptResources(receipts: AdaptiveRunReceipt[]) {
  return summarizeRuntimeItems(receipts.flatMap((r) => r.resources.items));
}

export function summarizeRuntimeItems(items: AdaptiveRunReceipt["resources"]["items"]) {
  if (new Set(items.map((item) => item.ref)).size !== items.length)
    throw new Error("原始收据重复计量同一调用/执行");
  const sum = (key: "modelCalls" | "inputTokens" | "outputTokens") => {
    const values = items.map((i) =>
      key === "modelCalls" ? i.modelCalls : (i.usage?.[key] ?? null),
    );
    return {
      knownTotal: values.some((v) => v !== null)
        ? values.reduce<number>((s, v) => s + (v ?? 0), 0)
        : null,
      unknownItems: values.filter((v) => v === null).length,
    };
  };
  return {
    items: items.length,
    modelCalls: sum("modelCalls"),
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    unknownCostItems: items.filter(
      (i) => i.usage?.costAmount == null || !i.usage.costCurrency || !i.usage.priceRef,
    ).length,
    digest: digestOf(canonicalJson(items)),
  };
}
