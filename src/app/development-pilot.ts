import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExecutorProvider } from "../runtime/types.ts";
import { canonicalJson, digestOf } from "../storage/blobs.ts";
import { openInstance } from "./instance.ts";
import type { RuntimeDeps } from "../runtime/index.ts";
import { installSeed, LINEAGE_ID, ORGANISM_ID, PRINCIPAL_ID } from "./seed.ts";

/** Fixed host verifier, embedded in the immutable evaluator version. It never runs worker tests. */
export const DEVELOPMENT_VERIFIER = String.raw`
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const config = JSON.parse(process.argv[1]);
const workspace = process.cwd();
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const record = { passed: false, checksIntact: false, inputsIntact: false, outputDigest: null, testExitCode: null, testOutput: null, error: null };
try {
  assert.equal(hash(config.checksPath), config.checksDigest, "frozen checks changed");
  record.checksIntact = true;
  for (const [name, digest] of Object.entries(config.inputs)) {
    const path = join(workspace, "inputs", name);
    assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), "input must be a regular file");
    assert.equal(hash(path), digest, "input changed: " + name);
  }
  record.inputsIntact = true;
  const allowed = new Set([...Object.keys(config.inputs).map((name) => "inputs/" + name), "output/" + config.target]);
  function scan(dir, prefix = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      assert.ok(!entry.isSymbolicLink(), "symlink is not allowed: " + relative);
      if (relative === ".proteus" && entry.isDirectory()) continue;
      if (entry.isDirectory()) scan(join(dir, entry.name), relative + "/");
      else assert.ok(entry.isFile() && allowed.has(relative), "unexpected output: " + relative);
    }
  }
  scan(workspace);
  const candidate = resolve(workspace, "output", config.target);
  assert.ok(existsSync(candidate) && lstatSync(candidate).isFile(), "missing implementation");
  record.outputDigest = hash(candidate);
  const result = spawnSync(process.execPath, ["--permission", "--allow-fs-read=" + config.checksPath, "--allow-fs-read=" + candidate, config.checksPath, candidate], {
    cwd: workspace, encoding: "utf8", timeout: 15000, maxBuffer: 256 * 1024, env: { LANG: "C.UTF-8" }
  });
  record.testExitCode = result.status;
  record.testOutput = result.stdout;
  if (result.error) throw result.error;
  assert.equal(result.status, 0, "fixed tests failed: " + result.stderr);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.passed, true, "fixed tests did not confirm success");
  assert.deepEqual(verdict.results.map((item) => item.name), config.expectedChecks, "fixed check set changed");
  assert.ok(verdict.results.every((item) => item.passed === true), "some fixed checks failed");
  assert.equal(hash(candidate), record.outputDigest, "implementation changed during verification");
  record.passed = true;
} catch (error) { record.error = String(error); }
mkdirSync(join(workspace, ".proteus"), { recursive: true });
writeFileSync(join(workspace, ".proteus", "pilot-verification.json"), JSON.stringify(record, null, 2));
console.log(JSON.stringify(record));
process.exitCode = record.passed ? 0 : 1;
`;

export interface DevelopmentPilotPlan {
  /** New directory only: reusing it never implicitly retries an unknown execution. */
  output: string;
  sourceFile: string;
  checksFile: string;
  target: string;
  goal: string;
  executor: ExecutorProvider;
  maxWallClockSeconds: number;
  onProgress?: RuntimeDeps["onExecutionProgress"];
  /** Public, non-secret description only; secrets belong in the executor's environment. */
  provenance: {
    mode: "real" | "fixture";
    sourceCommit: string;
    requestedModel: string | null;
    sourceTreeDirty?: boolean;
    harnessDigests?: Record<string, string>;
    executionProfile?: {
      endpoint: string;
      maxTurns: number;
      outputMaxTokens: number;
      tools: string[];
    };
  };
}

/** First development pilot: one self-contained Node module, external fixed checks, no auto-apply. */
export async function runDevelopmentPilot(plan: DevelopmentPilotPlan) {
  if (
    !/^[a-zA-Z0-9_./-]+\.(?:ts|mjs|js)$/.test(plan.target) ||
    plan.target.startsWith("/") ||
    plan.target.split("/").some((part) => part === ".." || part === "." || part === "")
  )
    throw new Error("target must be a safe relative module path");
  if (
    !Number.isInteger(plan.maxWallClockSeconds) ||
    plan.maxWallClockSeconds < 1 ||
    plan.maxWallClockSeconds > 600
  )
    throw new Error("pilot wall-clock budget must be 1..600 seconds");
  const requestedRoot = resolve(plan.output);
  if (existsSync(requestedRoot))
    throw new Error("pilot output already exists; inspect the original run instead of retrying");
  const source = readFileSync(plan.sourceFile, "utf8");
  const checks = readFileSync(plan.checksFile, "utf8");
  mkdirSync(requestedRoot);
  const root = realpathSync(requestedRoot);
  const frozen = join(root, "frozen");
  mkdirSync(frozen);
  const sourcePath = join(frozen, "source.ts");
  const checksPath = join(frozen, "checks.mjs");
  writeFileSync(sourcePath, source);
  writeFileSync(checksPath, checks);
  const baseline = spawnSync(
    process.execPath,
    ["--permission", `--allow-fs-read=${frozen}`, checksPath, sourcePath],
    {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 256 * 1024,
      env: { LANG: "C.UTF-8" },
    },
  );
  writeFileSync(
    join(root, "baseline.json"),
    JSON.stringify(
      { exitCode: baseline.status, stdout: baseline.stdout, stderr: baseline.stderr },
      null,
      2,
    ),
  );
  if (baseline.error || baseline.status !== 1)
    throw new Error("a reproducible failing baseline (exit 1) is required before delegation");
  // The fixed checker must report actual passing and failing cases, not a loader/parse error.
  const red = JSON.parse(baseline.stdout) as {
    passed: boolean;
    results: Array<{ name: string; passed: boolean }>;
  };
  if (
    red.passed !== false ||
    !Array.isArray(red.results) ||
    red.results.some((r) => typeof r.name !== "string" || typeof r.passed !== "boolean") ||
    new Set(red.results.map((r) => r.name)).size !== red.results.length ||
    !red.results.some((r) => r.passed) ||
    !red.results.some((r) => !r.passed)
  )
    throw new Error(
      "baseline must include both a reproduced failure and healthy regression checks",
    );
  const goal = [
    plan.goal,
    `Read inputs/source.ts and inputs/checks.mjs. Write the complete corrected implementation to output/${plan.target}.`,
    "Only that output file may be created or changed. Do not modify inputs, tests, configuration or files outside this workspace.",
    "The host runs the frozen tests after your response. No shell, network or additional agent tools are provided. Explain the minimal change briefly and finish.",
  ].join("\n");
  const verifierConfig = {
    checksPath,
    checksDigest: digestOf(checks),
    target: plan.target,
    expectedChecks: red.results.map((r) => r.name),
    inputs: { "source.ts": digestOf(source), "checks.mjs": digestOf(checks) },
  };
  const manifest = {
    version: "development-pilot-v1",
    ...plan.provenance,
    target: plan.target,
    goal,
    executor: plan.executor.name,
    maxAttempts: 1,
    maxWallClockSeconds: plan.maxWallClockSeconds,
    sourceDigest: digestOf(source),
    checksDigest: digestOf(checks),
    verifierDigest: digestOf(DEVELOPMENT_VERIFIER),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  const app = openInstance(join(root, "instance"), {
    executors: new Map([[plan.executor.name, plan.executor]]),
    onExecutionProgress: plan.onProgress,
  });
  try {
    const seed = installSeed({ ...app, clock: { now: Date.now } });
    const snapshot = app.storage.tx(() => {
      const bindings = { ...app.kernel.resolveSnapshot(seed.snapshotId).snapshot.bindings };
      for (const [slot, content] of Object.entries({
        "task-graph": {
          schemaVersion: 2,
          kind: "dag-v1",
          nodes: [
            { id: "develop", type: "execute", executor: plan.executor.name, dependsOn: [] },
            {
              id: "verify",
              type: "verify",
              verifier: "development-pilot-acceptance",
              inputFrom: "develop",
              dependsOn: ["develop"],
            },
          ],
        },
        "acceptance-evaluator": {
          kind: "test-runner-v1",
          command: [
            process.execPath,
            "--input-type=module",
            "--eval",
            DEVELOPMENT_VERIFIER,
            JSON.stringify(verifierConfig),
          ],
          attestPaths: [`output/${plan.target}`, ".proteus/pilot-verification.json"],
        },
      })) {
        const artifactId =
          slot === "acceptance-evaluator"
            ? "development-pilot-acceptance"
            : "development-pilot-graph";
        app.storage.insertArtifact({
          id: artifactId,
          kind: slot,
          lineageId: LINEAGE_ID,
          ownerId: PRINCIPAL_ID,
          createdAt: Date.now(),
        });
        const blob = app.blobs.write(canonicalJson(content));
        const version = app.kernel.registerVersion({
          artifact: app.storage.getArtifact(artifactId)!,
          schemaVersion: 1,
          contentDigest: blob.digest,
          contentRef: blob.ref,
          parents: [],
          dependencies: [],
          createdBy: PRINCIPAL_ID,
        });
        bindings[slot] = version.id;
      }
      return app.kernel.createSnapshot(bindings, PRINCIPAL_ID);
    });
    const schemaPath = join(frozen, "unused-schema.json");
    writeFileSync(schemaPath, "{}");
    // Commit the Run ID to the pilot receipt before dispatch; a lost response is inspectable.
    const admitted = app.runtime.admitTask(
      {
        requestedBy: PRINCIPAL_ID,
        goal,
        inputs: [sourcePath, checksPath],
        budget: { maxAttempts: 1, maxWallClockSeconds: plan.maxWallClockSeconds },
        acceptance: { verifier: "development-pilot-acceptance", outputSchema: schemaPath },
      },
      { purpose: "evaluation", snapshotId: snapshot.id },
    );
    const startedAt = Date.now();
    writeFileSync(
      join(root, "run.json"),
      JSON.stringify(
        {
          runId: admitted.runId,
          snapshotId: snapshot.id,
          activeSnapshotId: seed.snapshotId,
          startedAt,
        },
        null,
        2,
      ),
    );
    const summary = await app.runtime.executeRun(admitted.runId);
    const workspace = join(root, "instance", "workspaces", summary.runId, "develop");
    const candidate = join(workspace, "output", plan.target);
    const verificationPath = join(workspace, ".proteus", "pilot-verification.json");
    const verification = existsSync(verificationPath)
      ? (JSON.parse(readFileSync(verificationPath, "utf8")) as {
          passed: boolean;
          outputDigest: string | null;
        })
      : null;
    let patch: string | null = null;
    if (existsSync(candidate)) {
      const diff = spawnSync("git", ["diff", "--no-index", "--", sourcePath, candidate], {
        encoding: "utf8",
      });
      if (diff.status !== 0 && diff.status !== 1) throw new Error("cannot produce review patch");
      patch = diff.stdout
        .replaceAll(`a${sourcePath}`, `a/${plan.target}`)
        .replaceAll(`b${candidate}`, `b/${plan.target}`);
      writeFileSync(join(root, "candidate.patch"), patch);
    }
    const activeUnchanged = app.kernel.getOrganism(ORGANISM_ID)!.activeGenomeId === seed.snapshotId;
    const report = {
      version: "development-pilot-v1",
      manifestDigest: digestOf(canonicalJson(manifest)),
      summary,
      elapsedMs: Date.now() - startedAt,
      verification,
      activeUnchanged,
      hasPatch: patch !== null && patch.length > 0,
      passed: summary.state === "succeeded" && verification?.passed === true && activeUnchanged,
      benefit: "inconclusive",
      modelCallCount: null,
      modelUsage: summary.attempts[0]?.evidence?.accounting ?? null,
      cost: null,
    };
    writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
    return report;
  } finally {
    app.close();
  }
}
