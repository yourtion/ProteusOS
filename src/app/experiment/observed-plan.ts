import { z } from "zod";
import { canonicalJson, digestOf } from "../../storage/blobs.ts";
import { adaptiveTaskInputDigest } from "./task-input.ts";

export const OBSERVED_PROTOCOL = "adaptive-observed-v2";
export const OBSERVED_ARMS = ["single", "budget-matched", "compiled"] as const;
const id = z.string().min(1);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const observedCaseSchema = z.strictObject({
  id,
  familyId: id,
  split: z.enum(["train", "search", "formal", "regression"]),
  critical: z.boolean(),
  task: z.strictObject({
    goal: id,
    inputs: z.array(z.strictObject({ name: id, content: z.string() })).min(1),
  }),
  expectedChoice: z.enum(["local-process", "capability/changed-file-summary"]),
  schema: z.string().min(1),
  expected: z.string().min(1),
});
const observedPlanSchema = z.strictObject({
  protocol: z.enum(["adaptive-observed-v1", OBSERVED_PROTOCOL]),
  mode: z.enum(["real", "fixture"]),
  visibility: z.literal("developer-visible"),
  semanticIndependence: z.literal("unverified"),
  sourceCommit: id,
  seed: z.number().int().nonnegative(),
  repeats: z.literal(3),
  serviceId: id,
  model: id,
  adapter: id,
  environmentDigest: sha,
  setup: z.strictObject({
    modelCalls: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    unknownCostItems: z.number().int().nonnegative(),
    evidence: z.array(z.strictObject({ ref: id, digest: sha })),
  }),
  snapshots: z.strictObject({ base: id, source: id }),
  snapshotDigests: z.strictObject({ base: sha, source: sha }),
  // 参数仅取预登记 train 示例，且不能查看搜索/正式标签再替换 fallback。
  demoCaseIds: z.array(id).min(1).max(8),
  selection: z.literal("qualified-search-else-prespecified-demo-ablation"),
  cases: z.array(observedCaseSchema).min(4),
  limits: z.strictObject({
    calls: z.number().int().positive().max(800),
    inputPerCall: z.literal(2048),
    outputPerCall: z.literal(256),
    wallClockMs: z.number().int().positive().max(3600000),
    runMs: z.number().int().positive().max(30000),
    decisionMs: z.literal(28000),
  }),
});
export type ObservedCase = z.infer<typeof observedCaseSchema>;
export type ObservedPlan = z.infer<typeof observedPlanSchema>;
export interface ObservedSlot {
  ordinal: number;
  caseId: string;
  phase: "source" | "search" | "measurement";
  arm: (typeof OBSERVED_ARMS)[number];
  repeat: number;
  position: number;
  configuration: 0 | 1;
  unitId: string;
}
export function observedSlots(plan: ObservedPlan): ObservedSlot[] {
  const rows: Omit<ObservedSlot, "ordinal">[] = [];
  for (const c of plan.cases.filter((c) => c.split === "train" || c.split === "search"))
    rows.push({
      caseId: c.id,
      phase: "source",
      arm: "compiled",
      repeat: 0,
      position: 0,
      configuration: 0,
      unitId: `source:${c.id}`,
    });
  for (const configuration of [0, 1] as const)
    for (const c of plan.cases.filter((c) => c.split === "search"))
      rows.push({
        caseId: c.id,
        phase: "search",
        arm: "compiled",
        repeat: 0,
        position: 0,
        configuration,
        unitId: `search:${configuration}:${c.id}`,
      });
  for (const c of plan.cases.filter((c) => c.split === "formal" || c.split === "regression"))
    for (let repeat = 1; repeat <= 3; repeat++)
      for (let p = 0; p < 3; p++) {
        const arm = OBSERVED_ARMS[(p + repeat - 1 + plan.seed) % 3]!;
        for (let position = 0; position < (arm === "budget-matched" ? 3 : 1); position++)
          rows.push({
            caseId: c.id,
            phase: "measurement",
            arm,
            repeat,
            position,
            configuration: arm === "compiled" ? 1 : 0,
            unitId: canonicalJson([c.id, repeat, arm]),
          });
      }
  return rows.map((r, ordinal) => ({ ...r, ordinal }));
}
export function freezeObservedPlan(input: unknown) {
  const plan = observedPlanSchema.parse(input);
  if (new Set(plan.cases.map((c) => c.id)).size !== plan.cases.length)
    throw new Error("duplicate observed case");
  const groups = new Map<string, string>();
  const tasks = new Set<string>();
  for (const c of plan.cases) {
    if (groups.has(c.familyId) && groups.get(c.familyId) !== c.split)
      throw new Error("observed family crosses split");
    groups.set(c.familyId, c.split);
    adaptiveTaskInputDigest(c.task);
    if (
      c.task.inputs.some(
        (f) =>
          f.name.includes("/") || ["private-schema.json", "private-expected.json"].includes(f.name),
      )
    )
      throw new Error("first observed round requires flat input names");
    const digest = digestOf(canonicalJson(c.task));
    if (tasks.has(digest)) throw new Error("duplicate observed task content");
    tasks.add(digest);
    JSON.parse(c.schema);
    JSON.parse(c.expected);
  }
  for (const split of ["train", "search", "formal", "regression"])
    if (!plan.cases.some((c) => c.split === split)) throw new Error(`missing ${split}`);
  if (
    new Set(plan.demoCaseIds).size !== plan.demoCaseIds.length ||
    plan.demoCaseIds.some((id) => !plan.cases.some((c) => c.id === id && c.split === "train"))
  )
    throw new Error("demonstrations must be unique train cases");
  if (plan.mode === "real")
    for (const [split, n] of [
      ["train", 20],
      ["search", 20],
      ["formal", 40],
      ["regression", 10],
    ] as const)
      if (plan.cases.filter((c) => c.split === split).length !== n)
        throw new Error(`observed real round requires ${n} ${split} tasks`);
  const slots = observedSlots(plan);
  const calls = slots.filter((s) => s.phase !== "source").length;
  if (calls + plan.setup.modelCalls > plan.limits.calls)
    throw new Error("observed planned calls exceed limit");
  return { plan, digest: digestOf(canonicalJson(plan)), slots, plannedCalls: calls };
}
export type FrozenObservedPlan = ReturnType<typeof freezeObservedPlan>;
