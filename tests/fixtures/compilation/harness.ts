import { join } from "node:path";
import { LlmDecisionProvider } from "../../../src/adapters/decision-llm/index.ts";
import { resolveLlmDemosRequest } from "../../../src/adapters/decision-llm/request.ts";
import type { CompileBackend } from "../../../src/evolution/compile-types.ts";
import { openInstance } from "../../../src/app/instance.ts";
import {
  parseLlmDemosPolicy,
  type DecisionRequest,
  type DecisionResult,
} from "../../../src/decision/index.ts";
import { bootExperimentHarness, DEV_DATASET, experimentSubmission } from "../decision/harness.ts";
import { registerPolicyValidationSet } from "../../helpers.ts";

export class CompilerFake extends LlmDecisionProvider {
  requests: DecisionRequest[] = [];
  handler?: (request: DecisionRequest) => Promise<DecisionResult>;
  constructor() {
    super({ apiKey: "fake-no-network", baseUrl: "https://compiler.invalid" });
  }
  override async decide(request: DecisionRequest): Promise<DecisionResult> {
    resolveLlmDemosRequest(request);
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    if (this.handler) return this.handler(request);
    const policy = parseLlmDemosPolicy(request.policy.content);
    return {
      kind: "value",
      value: policy.parameters.demoIds.length ? "local-process" : "capability/changed-file-summary",
      provenance: { provider: this.name, policyVersion: request.policy.versionId },
      evidence: { inputTokens: 20, outputTokens: 5 },
    };
  }
}
export async function compileHarness(
  shared = false,
  datasetRoot = DEV_DATASET,
  instanceRoot?: string,
) {
  const seeded = bootExperimentHarness(instanceRoot);
  if (shared) {
    seeded.inst.federation.createTeam("compiler-sources", { createdBy: "principal-local" });
    const bindings: Record<string, string> = {};
    for (const [slot, id] of Object.entries(seeded.genomes.llm.snapshot.bindings)) {
      const version = seeded.inst.storage.getArtifactVersion(id)!;
      bindings[slot] = seeded.inst.kernel.registerVersion({
        artifact: seeded.inst.storage.getArtifact(version.artifactId)!,
        schemaVersion: version.schemaVersion,
        contentDigest: version.contentDigest,
        contentRef: version.contentRef,
        parents: [version.id],
        dependencies: version.dependencies,
        scope: "team:compiler-sources",
        createdBy: "principal-local",
      }).id;
    }
    seeded.genomes.llm.snapshot = seeded.inst.kernel.createSnapshot(bindings, "principal-local");
    seeded.genomes.llm.policyVersionId = bindings["routing-policy"]!;
    seeded.genomes.decisionViewVersionId = bindings["decision-view"]!;
  }
  const old = seeded.fake.decide.bind(seeded.fake);
  seeded.fake.decide = async (request) => ({
    ...(await old(request)),
    evidence: { inputTokens: 10, outputTokens: 2 },
  });
  seeded.fake.resetQueue({ type: "value", value: "local-process" });
  const organism = seeded.inst.kernel.getOrganism("organism-default")!;
  seeded.inst.kernel.installAsActive(
    organism.id,
    seeded.genomes.llm.snapshot.id,
    organism.revision,
  );
  const sourceRuns: string[] = [];
  for (const [i, goal] of [
    "统计培训文本的词数和标题数",
    "Count words in the project overview",
    "Count lines in the release notes",
  ].entries()) {
    const submission = experimentSubmission({
      goal,
      inputs: [
        join(datasetRoot, "bundles", "b01"),
        join(datasetRoot, "changed-files", "b01", "changed-files.json"),
      ],
      genomes: seeded.genomes,
      schema: join(datasetRoot, "schemas", "stats-summary.schema.json"),
      expected: join(datasetRoot, "expected", "dev-expl-01.json"),
    });
    const run = await seeded.inst.runtime.submitTask(
      { ...submission.input, familyId: `source-family-${i}` },
      { ...submission.options, purpose: "normal" },
    );
    if (run.state !== "succeeded") throw new Error(`fixture source failed: ${run.failureReason}`);
    sourceRuns.push(run.runId);
  }
  const dataset = seeded.inst.evolution.freezeExperienceWindow({
    purpose: "development",
    runIds: sourceRuns,
    createdBy: "principal-local",
  }).dataset;
  seeded.inst.close();
  const backend = new CompilerFake();
  const port: CompileBackend = {
    mode: "fixture",
    version: "fixture-enforced-bounds-v1",
    provider: backend,
    bounds: () => ({ inputTokens: 1000, outputTokens: 256 }),
  };
  const app = openInstance(seeded.root, { compileBackend: port });
  const cases = sourceRuns.map((runId, i) =>
    app.evolution.compiler.registerCase({
      datasetId: dataset.id,
      runId,
      decisionId: app.storage.listDecisionCalls(runId)[0]!.id,
      caseId: `source-${i}`,
      split: i === 0 ? "train" : "search",
      permission: "synthetic",
      expectedChoice: "local-process",
      verifiedBy: "principal-local",
    }),
  );
  const validationSetId = registerPolicyValidationSet(app, {
    cases: ["formal", "regression"].map((role, i) => ({
      id: `reserved-${role}`,
      familyId: `reserved-${role}-family`,
      role: i ? "regression" : "validation",
      expectedChoice: "local-process",
      task: {
        goal: `reserved-${role} 统计独立输入`,
        inputs: [join(datasetRoot, "bundles", "b01")],
        budget: { maxAttempts: 1, maxWallClockSeconds: 30 },
        acceptance: {
          verifier: "experiment-acceptance",
          outputSchema: join(datasetRoot, "schemas", "stats-summary.schema.json"),
        },
      },
    })),
    repeats: 1,
    thresholds: { minSamples: 1, minSuccessRate: 0.8, minImprovement: 0.1 },
    requestedBy: "principal-local",
  });
  const input = {
    trainCaseIds: [cases[0]!.id],
    searchCaseIds: cases.slice(1).map((c) => c.id),
    validationSetId,
    parameterSets: [[], [cases[0]!.id]],
    budget: {
      maxCalls: 7,
      maxInputTokens: 4030,
      maxOutputTokens: 1030,
      wallClockMs: 30_000,
      callTimeoutMs: 2000,
    },
    thresholds: { minAccuracy: 0.9, minImprovement: 0.1 },
    requestedBy: "principal-local",
  };
  return { app, backend, port, cases, input, root: seeded.root, dataset, sourceRuns };
}
