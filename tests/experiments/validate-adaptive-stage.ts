import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { stageHarness, STAGE_SCENARIOS } from "../fixtures/adaptive-behavior/stage-harness.ts";
import { canonicalJson, digestOf } from "../../src/storage/blobs.ts";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--output"))
  throw new Error(
    "Usage: node tests/experiments/validate-adaptive-stage.ts [--output NEW_DIRECTORY]",
  );
const output = args.length
  ? resolve(args[1]!)
  : mkdtempSync(join(tmpdir(), "proteus-adaptive-stage-"));
if (args.length) mkdirSync(output);
const cwd = fileURLToPath(new URL("../../", import.meta.url));
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
const sourceTreeDirty = !!execFileSync("git", ["status", "--porcelain"], {
  cwd,
  encoding: "utf8",
}).trim();
const scenarios = [];
for (const scenario of STAGE_SCENARIOS) {
  process.stdout.write(`Validating ${scenario}...\n`);
  const root = join(output, scenario);
  const h = await stageHarness(root, scenario, sourceCommit);
  try {
    let failure: string | null = null;
    try {
      await h.run();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const report = h.app.adaptive.report(h.job.id);
    assert.equal(h.app.kernel.getOrganism("organism-default")!.activeGenomeId, h.activeBefore);
    assert.equal(h.app.evolution.validationSet(h.validationSetId).usageCount, 0);
    assert.equal(report.report.realModel, "not_run");
    assert.equal(report.report.benefit, "not_evaluated");
    assert.doesNotMatch(
      JSON.stringify(h.provider.bodies),
      /PUBLIC_FIXTURE_ROUTE_LABELS|expectedChoice|private-expected|familyId/,
    );
    assert.equal(report.evidence!.runtimeResources.modelCalls.knownTotal, h.provider.bodies.length);
    if (scenario === "interrupted") {
      assert.match(failure!, /interrupted/);
      assert.equal(report.job.state, "failed");
      assert.equal(report.report.engineering, "incomplete");
      assert.equal(report.observations.at(-1)!.state, "unknown");
    } else {
      assert.equal(failure, null);
      assert.equal(report.job.state, "completed");
      assert.equal(report.report.engineering, "passed");
      assert.equal(report.evidence!.receipts.length, 36);
      assert.equal(h.provider.bodies.length, 60);
      assert.equal(report.report.evidenceVerification, "persisted-development-and-runtime-records");
      assert.equal(report.report.qualityGate, scenario === "improvement");
    }
    const sent = h.provider.requests.length;
    await h.run();
    assert.equal(h.provider.requests.length, sent);
    const replay = h.cleanAndReplay();
    assert.deepEqual(replay.after, replay.before);
    const reportRaw = canonicalJson(report);
    writeFileSync(join(root, "manifest.json"), canonicalJson(h.frozen));
    writeFileSync(join(root, "report.json"), reportRaw);
    const arms = Object.fromEntries(
      Object.entries(report.report.arms).map(([arm, value]) => [
        arm,
        { formal: value.formal, regression: value.regression },
      ]),
    );
    const summary = {
      scenario,
      experimentId: h.job.id,
      instanceRoot: h.app.root,
      reportDigest: digestOf(reportRaw),
      manifestDigest: h.frozen.digest,
      engineering: report.report.engineering,
      evidenceVerification: report.report.evidenceVerification,
      realModel: report.report.realModel,
      benefit: report.report.benefit,
      numericalQualityGate: report.report.qualityGate,
      arms,
      knownFormalDecisionCalls: h.provider.bodies.length,
      runtimeResources: report.evidence!.runtimeResources,
      developmentResources: report.evidence!.developmentResources,
      unsettledResources: report.evidence!.unsettledResources,
      completedReceipts: report.evidence!.receipts.length,
      missingUnits: report.report.missing.length,
      criticalFailures: report.report.criticalFailures.length,
      failure,
      cleanReopenReplay: "passed",
      noAutomaticResend: "passed",
      activeUnchanged: true,
      formalValidationUsage: 0,
    };
    scenarios.push(summary);
    process.stdout.write(
      `${scenario}: ${summary.engineering}, calls=${summary.knownFormalDecisionCalls}, replay=passed\n`,
    );
  } finally {
    h.app.close();
  }
}
const summary = {
  version: "adaptive-stage-validation-v1",
  sourceCommit,
  sourceTreeDirty,
  recordedAt: new Date().toISOString(),
  scope: "scripted-fixture-with-real-local-workers",
  output,
  scenarios,
  realModelCompatibility: "not_run",
  realBenefit: "not_evaluated",
  adoption: "not_run",
};
writeFileSync(join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`Evidence saved to ${output}\n`);
