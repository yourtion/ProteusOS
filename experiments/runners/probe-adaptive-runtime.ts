import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { LlmDecisionProvider } from "../../src/adapters/decision-llm/index.ts";
import { experimentServiceConfig } from "../protocols/service-config.ts";
import {
  ModelFreeProcessExecutor,
  ModelFreeNodeSandbox,
  modelFreeUsage,
} from "../../src/runtime/model-free.ts";
import { openInstance } from "../../src/app/instance.ts";
import { installSeed } from "../../src/app/seed.ts";
import { ensureExperimentGenomes } from "../protocols/assets.ts";
import { parseCapabilityModule } from "../../src/runtime/capability.ts";
import { auditRunVerification } from "../protocols/run-verification.ts";
import { canonicalJson, digestOf } from "../../src/storage/blobs.ts";
import type { DecisionRequest } from "../../src/decision/index.ts";

const args = process.argv.slice(2);
if (
  (args.length !== 2 && args.length !== 4) ||
  args[0] !== "--output" ||
  (args.length === 4 && args[2] !== "--claude-settings")
)
  throw new Error(
    "Usage: probe-adaptive-runtime.ts --output NEW_DIRECTORY [--claude-settings FILE]",
  );
const output = resolve(args[1]!);
mkdirSync(output);
const { config, source } = experimentServiceConfig(args[3]);
const repo = fileURLToPath(new URL("../..", import.meta.url));
const record: Record<string, unknown> = {
  version: "adaptive-runtime-probe-v1",
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceTreeDirty: !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  configurationSource: source,
  serviceId: config.baseUrl,
  maximumGeneratedCalls: 1,
  retries: 0,
  formalEvaluation: "not_run",
  independentBenefit: "not_evaluated",
  realExperimentAdmission: "blocked",
  inputHardBound: "unverified",
};
const save = () =>
  writeFileSync(join(output, "report.json"), `${JSON.stringify(record, null, 2)}\n`);
class ProbeProvider extends LlmDecisionProvider {
  generated = 0;
  override async decide(request: DecisionRequest) {
    if (this.generated) throw new Error("probe_call_limit");
    const count = await this.countInputTokens(request);
    record.countedInputTokens = count;
    if (count > 2048) throw new Error("probe_input_threshold_exceeded");
    this.generated++;
    record.status = "generation-started";
    save();
    return super.decide(request);
  }
}
const provider = new ProbeProvider(config);
const instance = join(output, "instance");
const app = openInstance(instance, {
  decisions: new Map([[provider.name, provider]]),
  executors: new Map([
    [
      "local-process",
      new ModelFreeProcessExecutor(join(repo, "src/adapters/executor-process/stats-worker.mjs")),
    ],
  ]),
  capabilitySandbox: new ModelFreeNodeSandbox(),
  decisionCallTimeoutMs: 15_000,
});
try {
  installSeed({ ...app, clock: { now: Date.now } });
  const parsed = parseCapabilityModule(
    JSON.parse(
      readFileSync(
        join(repo, "tests/fixtures/decision/capability/changed-file-summary.module.json"),
        "utf8",
      ),
    ),
  );
  if (!parsed.ok) throw new Error("invalid_repository_capability");
  const genomes = ensureExperimentGenomes(
    { ...app, clock: { now: Date.now } },
    { createdBy: "principal-local", capabilityModule: parsed.module },
  );
  const active = app.kernel.getOrganism("organism-default")!.activeGenomeId;
  app.storage.setDecisionCallLimit({ organismId: "organism-default" }, 1, Date.now());
  app.storage.setDecisionCallLimit(
    { organismId: "organism-default", experimentId: "compatibility-only-v1" },
    1,
    Date.now(),
  );
  const materials = join(output, "materials");
  mkdirSync(materials);
  const text = "# Release\nhello world\n";
  const values = { bytes: Buffer.byteLength(text), lines: 2, words: 4, headings: 1 };
  writeFileSync(join(materials, "release.md"), text);
  writeFileSync(
    join(materials, "expected.json"),
    canonicalJson({ files: [{ path: "release.md", ...values }], totals: { files: 1, ...values } }),
  );
  cpSync(
    join(repo, "tests/fixtures/stats/schemas/stats-summary.schema.json"),
    join(materials, "schema.json"),
  );
  const result = await app.runtime.submitTask(
    {
      requestedBy: "principal-local",
      goal: "Count words and lines in release notes.",
      familyId: "development-compatibility-only",
      inputs: [join(materials, "release.md")],
      requires: ["changed-file-summary"],
      budget: { maxAttempts: 1, maxWallClockSeconds: 30 },
      acceptance: {
        verifier: "experiment-acceptance",
        outputSchema: join(materials, "schema.json"),
        expectedOutput: join(materials, "expected.json"),
      },
    },
    {
      snapshotId: genomes.llm.snapshot.id,
      purpose: "normal",
      experimentId: "compatibility-only-v1",
    },
  );
  record.runId = result.runId;
  record.status = result.state;
  const calls = app.storage.listDecisionCalls(result.runId);
  assert.equal(calls.length, 1);
  record.callState = calls[0]!.state;
  record.callId = calls[0]!.id;
  record.requestDigest = calls[0]!.requestDigest;
  record.responseDigest = calls[0]!.responseDigest;
  record.actualUsage = calls[0]!.usage;
  record.countMatchesUsage = record.countedInputTokens === calls[0]!.usage?.inputTokens;
  record.generatedCalls = provider.generated;
  assert.equal(result.state, "succeeded");
  assert.equal(result.attempts.length, 1);
  assert.equal(modelFreeUsage(result.attempts[0]!.evidence, app.blobs)?.modelCalls, 0);
  record.executionModelCalls = 0;
  const deps = { ...app, organismId: "organism-default", actorId: "principal-local" };
  const before = auditRunVerification(deps, result.runId);
  assert.equal(before.status, "verified");
  rmSync(materials, { recursive: true });
  rmSync(join(instance, "workspaces"), { recursive: true });
  const reopened = openInstance(instance);
  try {
    const after = auditRunVerification(
      { ...reopened, organismId: "organism-default", actorId: "principal-local" },
      result.runId,
    );
    assert.deepEqual(after, before);
    assert.equal(reopened.kernel.getOrganism("organism-default")!.activeGenomeId, active);
    writeFileSync(join(output, "verification.json"), canonicalJson(after));
    record.verificationDigest = digestOf(canonicalJson(after));
    record.cleanReopenReplay = "passed";
    record.activeUnchanged = true;
  } finally {
    reopened.close();
  }
} catch (error) {
  record.status = "incomplete";
  record.errorType = error instanceof Error ? error.name : "UnknownError";
} finally {
  app.close();
  record.generatedCalls = provider.generated;
  record.finishedAt = new Date().toISOString();
  save();
}
process.stdout.write(`${JSON.stringify(record, null, 2)}\nEvidence saved to ${output}\n`);
process.exitCode = record.status === "succeeded" ? 0 : 1;
