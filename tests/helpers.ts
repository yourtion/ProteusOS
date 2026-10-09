import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openInstance, type AppInstance } from "../src/app/instance.ts";
import { ensureJudgeGenome, HYBRID_EVALUATOR_CONTENT } from "../src/evolution/assets.ts";
import type { ExecutorProvider } from "../src/runtime/types.ts";
import { installSeed, canonicalJson } from "../src/app/seed.ts";
import type { PolicyEvaluationPlan } from "../src/evolution/index.ts";

export const FIXTURES = fileURLToPath(new URL("./fixtures/stats", import.meta.url));
export const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function fixturePath(...parts: string[]): string {
  return join(FIXTURES, ...parts);
}

/** Register an isolated, immutable policy validation plan for integration tests. */
export function registerPolicyValidationSet(
  inst: AppInstance,
  plan: PolicyEvaluationPlan,
  sourceRef = "tests/integration/policy-evidence.test.ts",
): string {
  const familyIds = [...new Set(plan.cases.map((c) => c.familyId))];
  return inst.evolution.registerValidationSet({
    familyIds,
    devFamilyIds: [],
    sourceRef,
    preparedBy: "principal-local",
    plan,
  }).id;
}

export function policyValidationPlan(repeats = 1): PolicyEvaluationPlan {
  const fixture = fileURLToPath(
    new URL("./fixtures/policy-evolution/validation-cases.json", import.meta.url),
  );
  const cases = JSON.parse(readFileSync(fixture, "utf8")) as Array<{
    id: string;
    familyId: string;
    role?: "validation" | "regression";
    task: PolicyEvaluationPlan["cases"][number]["task"];
    expectedChoice: string | null;
  }>;
  return {
    cases: cases.map((c) => ({
      ...c,
      task: {
        ...c.task,
        inputs: c.task.inputs.map((p) => resolve(REPO_ROOT, p)),
        acceptance: {
          ...c.task.acceptance,
          outputSchema: resolve(REPO_ROOT, c.task.acceptance.outputSchema),
        },
      },
    })),
    repeats,
    thresholds: { minSuccessRate: 0.75, minImprovement: 0, minSamples: 1 },
    requestedBy: "principal-local",
  };
}

export function tempInstanceRoot(): string {
  return mkdtempSync(join(tmpdir(), "proteos-test-"));
}

/** 建临时实例并安装 seed（每次调用都是干净实例）；executors 可注入测试替身 */
export function bootSeededInstance(
  root: string = tempInstanceRoot(),
  executors?: Map<string, ExecutorProvider>,
): AppInstance {
  const inst = openInstance(root, executors ? { executors } : {});
  installSeed({
    kernel: inst.kernel,
    storage: inst.storage,
    blobs: inst.blobs,
    clock: { now: Date.now },
  });
  return inst;
}

/**
 * 裁判升级快捷装配（M3 裁判拆分后 M2 场景的前置）：把 active 的裁判
 * 经 ensureJudgeGenome 升级为 hybrid 并 CAS 安装（测试捷径；正式流程走
 * judge-upgrade → evaluate → operator promote）。
 */
export function upgradeJudgeToActive(inst: AppInstance): string {
  const base = inst.kernel.getOrganism("organism-default")!.activeGenomeId!;
  const genome = ensureJudgeGenome(
    { kernel: inst.kernel, storage: inst.storage, blobs: inst.blobs, clock: { now: Date.now } },
    {
      baseSnapshotId: base,
      evaluatorContent: HYBRID_EVALUATOR_CONTENT,
      createdBy: "principal-local",
    },
  );
  inst.storage.tx(() => {
    const fresh = inst.kernel.getOrganism("organism-default")!;
    const result = inst.kernel.installAsActive(
      "organism-default",
      genome.snapshot.id,
      fresh.revision,
    );
    if (!result.ok) throw new Error("测试装配：裁判升级 CAS 冲突");
  });
  return genome.snapshot.id;
}

/** 以当前快照为基准注册新版本并 CAS 安装为默认（测试用自定义图/策略/验收器） */
export function installCustomGenome(
  inst: AppInstance,
  overrides: { graph?: object; policy?: object; evaluator?: object },
): void {
  const organism = inst.kernel.getOrganism("organism-default")!;
  const { snapshot, versions } = inst.kernel.resolveSnapshot(organism.activeGenomeId!);
  inst.storage.tx(() => {
    const bindings = { ...snapshot.bindings };
    const slots: Array<["task-graph" | "routing-policy", object | undefined]> = [
      ["task-graph", overrides.graph],
      ["routing-policy", overrides.policy],
    ];
    for (const [slot, content] of slots) {
      if (!content) continue;
      const current = versions.get(slot)!;
      const artifact = inst.storage.getArtifact(current.artifactId)!;
      const { digest, ref } = inst.blobs.write(canonicalJson(content));
      const version = inst.kernel.registerVersion({
        artifact,
        schemaVersion: 2,
        contentDigest: digest,
        contentRef: ref,
        parents: [current.id],
        dependencies: [],
        createdBy: "test",
      });
      bindings[slot] = version.id;
    }
    if (overrides.evaluator) {
      // 新验收器 artifact（kind = acceptance-evaluator 槽位）
      inst.storage.insertArtifact({
        id: "coding-acceptance",
        kind: "acceptance-evaluator",
        lineageId: "lineage-seed",
        ownerId: "principal-local",
        createdAt: Date.now(),
      });
      const artifact = inst.storage.getArtifact("coding-acceptance")!;
      const { digest, ref } = inst.blobs.write(canonicalJson(overrides.evaluator));
      const version = inst.kernel.registerVersion({
        artifact,
        schemaVersion: 2,
        contentDigest: digest,
        contentRef: ref,
        parents: [],
        dependencies: [],
        createdBy: "test",
      });
      bindings["acceptance-evaluator"] = version.id;
    }
    const next = inst.kernel.createSnapshot(bindings, "test");
    const fresh = inst.kernel.getOrganism("organism-default")!;
    const result = inst.kernel.installAsActive("organism-default", next.id, fresh.revision);
    if (!result.ok) throw new Error("测试装配 CAS 冲突");
  });
}
