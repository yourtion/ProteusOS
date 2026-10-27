import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openInstance } from "../../../src/app/instance.ts";
import { freezeAdaptivePlan } from "../../../src/app/experiment/adaptive.ts";
import { prepareCompileDevelopment } from "../../../src/app/experiment/development.ts";
import {
  buildLlmChoiceBody,
  resolveLlmDemosRequest,
} from "../../../src/adapters/decision-llm/request.ts";
import {
  isLlmDemosPolicy,
  parseLlmDemosPolicy,
  parseLlmPolicy,
  type DecisionRequest,
  type DecisionResult,
} from "../../../src/decision/index.ts";
import { canonicalJson, digestOf } from "../../../src/storage/blobs.ts";
import { CompilerFake, compileHarness } from "../compilation/harness.ts";
import { DEV_DATASET } from "../decision/harness.ts";
import { rehearsalPlan } from "./rehearsal.ts";

export const STAGE_SCENARIOS = [
  "improvement",
  "no-improvement",
  "regression",
  "interrupted",
] as const;
export type StageScenario = (typeof STAGE_SCENARIOS)[number];

/** 场景行为是公开的测试脚本；不模拟真实模型泛化，不读取冻结 gold。 */
class StageProvider extends CompilerFake {
  formal = false;
  bodies: unknown[] = [];
  constructor(privateScenario: StageScenario) {
    super();
    this.scenario = privateScenario;
  }
  private readonly scenario: StageScenario;
  override async decide(request: DecisionRequest): Promise<DecisionResult> {
    if (!this.formal) return super.decide(request);
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    const demos = isLlmDemosPolicy(request.policy.content);
    this.bodies.push(
      demos
        ? resolveLlmDemosRequest(request)
        : buildLlmChoiceBody(
            parseLlmPolicy(request.policy.content)!,
            request.view!,
            request.options,
          ),
    );
    const candidate =
      demos && parseLlmDemosPolicy(request.policy.content).parameters.demoIds.length > 0;
    const stats = request.view!.features["hasStatsIntent"] === true;
    const correct = stats ? "local-process" : "capability/changed-file-summary";
    const value =
      this.scenario === "no-improvement"
        ? correct
        : this.scenario === "regression" && candidate && !stats
          ? "local-process"
          : stats && !candidate
            ? "capability/changed-file-summary"
            : correct;
    return {
      kind: "value",
      value,
      provenance: { provider: this.name, policyVersion: request.policy.versionId },
      raw: canonicalJson({ kind: "value", value }),
      evidence: { inputTokens: 20, outputTokens: 5 },
    };
  }
}

export async function stageHarness(
  root: string,
  scenario: StageScenario,
  sourceCommit = "fixture-stage-v1",
) {
  mkdirSync(root, { recursive: true });
  const dataset = join(root, "development-materials");
  cpSync(DEV_DATASET, dataset, { recursive: true });
  const h = await compileHarness(false, dataset, join(root, "instance"));
  const provider = new StageProvider(scenario);
  h.port.provider = provider;
  const { job: compilation } = h.app.evolution.compiler.submit(h.input);
  await h.app.evolution.compiler.run(compilation.id);
  const development = prepareCompileDevelopment(
    { ...h.app, organismId: "organism-default", actorId: "principal-local" },
    compilation.id,
  );
  if (!development.bundle.candidateId) throw new Error("stage fixture did not compile a candidate");
  const candidate = h.app.storage.getCandidate(development.bundle.candidateId)!;
  const compilePlan = JSON.parse(h.app.blobs.read(compilation.planRef)) as {
    baseSnapshotId: string;
  };
  const snapshots = { base: compilePlan.baseSnapshotId, compiled: candidate.proposedSnapshotId };
  const backend = h.app.storage.getCompileJob(compilation.id)!.backend!;
  const materials = join(root, "formal-materials");
  const original = rehearsalPlan().plan;
  const privateChoices = new Map<string, string>();
  const loadable = new Map<
    string,
    {
      task: { goal: string; inputs: Array<{ name: string; content: string }> };
      submission: {
        requestedBy: string;
        goal: string;
        familyId: string;
        inputs: string[];
        requires: string[];
        budget: { maxAttempts: number; maxWallClockSeconds: number };
        acceptance: { verifier: string; outputSchema: string; expectedOutput: string };
      };
    }
  >();
  const formalCases = original.cases
    .filter((c) => c.split === "formal" || c.split === "regression")
    .map((c, i) => {
      const dir = join(materials, c.id);
      mkdirSync(dir, { recursive: true });
      const stats = c.split === "formal";
      const text = `# Stage ${i + 1}\nfixture text ${i + 1}\n`;
      const changedPath = `src/stage-${i + 1}.ts`;
      const task = {
        goal: stats
          ? `Count words and lines in release text ${i + 1}.`
          : `按类型归类这一组改动文件 ${i + 1}。`,
        inputs: [
          { name: "sample.md", content: text },
          {
            name: "changed-files.json",
            content: canonicalJson({ changes: [{ path: changedPath, changeType: "modified" }] }),
          },
        ],
      };
      const schemaRaw = readFileSync(
        join(
          dataset,
          "schemas",
          stats ? "stats-summary.schema.json" : "changed-file-summary.schema.json",
        ),
        "utf8",
      );
      const values = { bytes: Buffer.byteLength(text), lines: 2, words: 6, headings: 1 };
      const expectedRaw = canonicalJson(
        stats
          ? { files: [{ path: "sample.md", ...values }], totals: { files: 1, ...values } }
          : { summary: { total: 1, files: [{ path: changedPath, category: "source" }] } },
      );
      for (const file of task.inputs) writeFileSync(join(dir, file.name), file.content);
      const schema = join(dir, "private-schema.json");
      const expected = join(dir, "private-expected.json");
      writeFileSync(schema, schemaRaw);
      writeFileSync(expected, expectedRaw);
      const familyId = `stage-${c.split}-family-${i + 1}`;
      loadable.set(c.id, {
        task,
        submission: {
          requestedBy: "principal-local",
          goal: task.goal,
          familyId,
          inputs: task.inputs.map((file) => join(dir, file.name)),
          requires: ["changed-file-summary"],
          budget: { maxAttempts: 1, maxWallClockSeconds: 30 },
          acceptance: {
            verifier: "experiment-acceptance",
            outputSchema: schema,
            expectedOutput: expected,
          },
        },
      });
      privateChoices.set(c.id, stats ? "local-process" : "capability/changed-file-summary");
      return {
        ...c,
        familyId,
        taskDigest: digestOf(canonicalJson(task)),
        evaluatorDigest: digestOf(
          canonicalJson({
            verifier: "experiment-acceptance",
            outputSchemaDigest: digestOf(schemaRaw),
            expectedOutputDigest: digestOf(expectedRaw),
          }),
        ),
      };
    });
  original.cases = [...development.bundle.cases, ...formalCases];
  original.development = development.bundle.development;
  original.policies = {
    baseDigest: development.bundle.policies.baseDigest,
    candidateDigest: development.bundle.policies.candidateDigest!,
  };
  Object.assign(original.fixed, development.bundle.fixed);
  original.source = development.bundle.source;
  original.sourceCommit = sourceCommit;
  original.sourceDigest = digestOf(
    canonicalJson({ development: development.record.digest, formalCases }),
  );
  original.developmentClosedAt = Math.max(Date.now(), development.record.createdAt);
  original.frozenAt = original.developmentClosedAt;
  original.budget.modelCalls = 128;
  original.budget.outputTokens = 20000;
  const frozen = freezeAdaptivePlan(original);
  h.app.close();
  const app = openInstance(h.root, {
    compileBackend: h.port,
    decisions: new Map([["decision-llm", provider]]),
  });
  provider.formal = true;
  const job = app.adaptive.registerCompiled(frozen, compilation.id);
  app.adaptiveRuns.registerJudgments(job.id, {
    version: "adaptive-judgments-v1",
    manifestDigest: frozen.digest,
    sourceRef: "PUBLIC_FIXTURE_ROUTE_LABELS_NOT_INDEPENDENT_HELD_OUT",
    cases: formalCases.map((c) => ({
      caseId: c.id,
      taskDigest: c.taskDigest,
      evaluatorDigest: c.evaluatorDigest,
      expectedChoice: privateChoices.get(c.id)!,
    })),
  });
  let executionCalls = 0;
  const execute = app.runtime.executeRun.bind(app.runtime);
  if (scenario === "interrupted")
    app.runtime.executeRun = async (id) => {
      if (++executionCalls === 8)
        throw new Error("fixture host interrupted before eighth dispatch");
      return execute(id);
    };
  const activeBefore = app.kernel.getOrganism("organism-default")!.activeGenomeId;
  const run = () =>
    app.adaptiveRuns.runAll(job.id, (id) => {
      const record = loadable.get(id);
      if (!record) throw new Error(`unknown formal fixture: ${id}`);
      return { ...record, snapshots, backend };
    });
  const cleanAndReplay = () => {
    const before = app.adaptive.report(job.id);
    rmSync(materials, { recursive: true });
    rmSync(dataset, { recursive: true });
    rmSync(join(app.root, "workspaces"), { recursive: true });
    const reopened = openInstance(app.root);
    try {
      return { before, after: reopened.adaptive.report(job.id) };
    } finally {
      reopened.close();
    }
  };
  return {
    app,
    provider,
    frozen,
    job,
    compilation,
    run,
    cleanAndReplay,
    activeBefore,
    validationSetId: h.input.validationSetId,
  };
}
