import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LlmDecisionProvider } from "../../../src/adapters/decision-llm/index.ts";
import { buildExecutors, openInstance } from "../../../experiments/instance.ts";
import { adaptiveUnits, freezeAdaptivePlan } from "../../../experiments/protocols/adaptive.ts";
import {
  FROZEN_LLM_POLICY,
  RESPONSE_SCHEMA_DIGEST_TARGET,
  type DecisionRequest,
  type DecisionResult,
} from "../../../src/decision/index.ts";
import { canonicalJson, digestOf } from "../../../src/storage/blobs.ts";
import { rehearsalPlan } from "./rehearsal.ts";
import { bootExperimentHarness } from "../decision/harness.ts";
import { llmDemosFixture } from "../decision/llm-demos.ts";
import { fixturePath } from "../../helpers.ts";
type Script =
  | "local-process"
  | "capability/changed-file-summary"
  | "abstain"
  | "refusal"
  | "invalid"
  | "transport";
class FixtureProvider extends LlmDecisionProvider {
  scripts: Script[] = [];
  requests: DecisionRequest[] = [];
  override async decide(request: DecisionRequest): Promise<DecisionResult> {
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    const script = this.scripts.shift() ?? "local-process";
    const provenance = { provider: this.name, policyVersion: request.policy.versionId };
    const evidence = {
      inputTokens: 10,
      outputTokens: 2,
      costAmount: 0.01,
      costCurrency: "USD",
      priceRef: "fixture-price-v1",
    };
    if (script === "transport") throw new Error("fixture offline transport failure");
    if (script === "abstain" || script === "refusal")
      return {
        kind: "abstain",
        reason: "fixture abstention",
        provenance,
        evidence,
        origin: script === "refusal" ? "service_refusal" : "model",
        raw:
          script === "refusal"
            ? canonicalJson({ stopReason: "refusal", refusal: true })
            : canonicalJson({ kind: "abstain", reason: "fixture abstention" }),
      };
    if (script === "invalid")
      return {
        kind: "invalid_output",
        detail: "wrapped output",
        provenance,
        evidence,
        raw: '```json\n{"kind":"value","value":"local-process"}\n```',
      };
    return {
      kind: "value",
      value: script,
      provenance,
      evidence,
      raw: canonicalJson({ kind: "value", value: script }),
    };
  }
}

export function armHarness(firstBadOutput: boolean | "execution-failure" = false) {
  const seeded = bootExperimentHarness();
  seeded.inst.close();
  const provider = new FixtureProvider({ apiKey: "NEVER_PERSIST", baseUrl: "https://arm.invalid" });
  const executors = buildExecutors();
  if (firstBadOutput) {
    const delegate = executors.get("local-process")!;
    let calls = 0;
    executors.set("local-process", {
      ...delegate,
      name: delegate.name,
      recoveryPolicy: delegate.recoveryPolicy,
      async start(request) {
        if (firstBadOutput === "execution-failure")
          return {
            ok: false,
            exitCode: 1,
            stdout: "",
            stderr: "fixture worker failed",
            durationMs: 1,
            outputRef: null,
          };
        const result = await delegate.start(request);
        if (calls++ === 0 && result.outputRef) {
          const output = JSON.parse(readFileSync(result.outputRef, "utf8"));
          output.files[0].bytes++;
          output.totals.bytes++;
          writeFileSync(result.outputRef, canonicalJson(output));
        }
        return result;
      },
    });
  }
  const app = openInstance(seeded.root, {
    decisions: new Map([["decision-llm", provider]]),
    executors,
  });
  const base = seeded.genomes.llm.snapshot;
  const content = llmDemosFixture({
    base: seeded.genomes.llm.policyVersionId,
    view: seeded.genomes.decisionViewVersionId,
  });
  const candidate = app.storage.tx(() => {
    const blob = app.blobs.write(canonicalJson(content));
    const version = app.kernel.registerVersion({
      artifact: app.storage.getArtifact("experiment-policy")!,
      schemaVersion: 1,
      contentDigest: blob.digest,
      contentRef: blob.ref,
      parents: [seeded.genomes.llm.policyVersionId],
      dependencies: [seeded.genomes.llm.policyVersionId, seeded.genomes.decisionViewVersionId],
      createdBy: "principal-local",
    });
    return {
      version,
      snapshot: app.kernel.createSnapshot(
        { ...base.bindings, "routing-policy": version.id },
        "principal-local",
      ),
    };
  });
  const dir = join(app.root, "materials");
  mkdirSync(dir);
  const inputs = [
    { name: "sample.md", content: "# A\nhello world\n" },
    {
      name: "changed-files.json",
      content: canonicalJson({ changes: [{ path: "src/a.ts", changeType: "modified" }] }),
    },
  ];
  for (const file of inputs) writeFileSync(join(dir, file.name), file.content);
  const schemaRaw = readFileSync(fixturePath("schemas", "stats-summary.schema.json"), "utf8");
  const stats = { bytes: 16, lines: 2, words: 4, headings: 1 };
  const gold = canonicalJson({
    files: [{ path: "sample.md", ...stats }],
    totals: { files: 1, ...stats },
  });
  const schema = join(dir, "schema.json");
  const expected = join(dir, "expected.json");
  writeFileSync(schema, schemaRaw);
  writeFileSync(expected, gold);
  const task = { goal: "统计这些文本的词数和行数", inputs };
  const backend = {
    mode: "fixture" as const,
    version: "arm-fixture-v1",
    provider: "decision-llm",
    adapter: "anthropic-messages@sdk-0.127.0",
    serviceId: "https://arm.invalid",
  };
  const plan = rehearsalPlan().plan;
  const resolved = app.kernel.resolveSnapshot(base.id);
  Object.assign(plan.fixed, {
    model: FROZEN_LLM_POLICY.model,
    instructionDigest: digestOf(FROZEN_LLM_POLICY.promptTemplate),
    schemaDigest: digestOf(RESPONSE_SCHEMA_DIGEST_TARGET),
    adapterDigest: digestOf(canonicalJson(backend)),
    graphDigest: resolved.versions.get("task-graph")!.contentDigest,
    judgeDigest: resolved.versions.get("acceptance-evaluator")!.contentDigest,
    viewDigest: resolved.versions.get("decision-view")!.contentDigest,
  });
  plan.policies = {
    baseDigest: content.fixed.basePolicy.contentDigest,
    candidateDigest: candidate.version.contentDigest,
  };
  plan.developmentClosedAt = Date.now();
  plan.frozenAt = plan.developmentClosedAt;
  const c = plan.cases.find((c) => c.id === "formal-0")!;
  c.taskDigest = digestOf(canonicalJson(task));
  c.evaluatorDigest = digestOf(
    canonicalJson({
      verifier: "experiment-acceptance",
      outputSchemaDigest: digestOf(schemaRaw),
      expectedOutputDigest: digestOf(gold),
    }),
  );
  const frozen = freezeAdaptivePlan(plan);
  const snapshots = { base: base.id, compiled: candidate.snapshot.id };
  const submission = {
    requestedBy: "principal-local",
    ...task,
    inputs: inputs.map((f) => join(dir, f.name)),
    requires: ["changed-file-summary"],
    budget: { maxAttempts: 1, maxWallClockSeconds: 30 },
    acceptance: {
      verifier: "experiment-acceptance",
      outputSchema: schema,
      expectedOutput: expected,
    },
  };
  const submit = async (
    arm: "single" | "budget-matched" | "compiled" = "single",
    script: Script = "local-process",
  ) => {
    provider.scripts.push(script);
    return app.runtime.submitTask(submission, {
      purpose: "evaluation",
      snapshotId: arm === "compiled" ? snapshots.compiled : snapshots.base,
      experimentId: "fixture-arm",
    });
  };
  const input = (arm: "single" | "budget-matched" | "compiled", runIds: Array<string | null>) => ({
    frozen,
    task,
    snapshots,
    backend,
    runIds,
    unitId: adaptiveUnits(frozen.plan).find(
      (u) => u.caseId === c.id && u.repeat === 1 && u.arm === arm,
    )!.id,
  });
  const deps = { ...app, organismId: "organism-default", actorId: "principal-local" };
  return { app, provider, dir, candidate, deps, submit, input, submission };
}
