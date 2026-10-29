import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runDevelopmentPilot } from "../../src/app/development-pilot.ts";
import { digestOf } from "../../src/storage/blobs.ts";
import {
  fixtures,
  manifest,
  prepareCase,
  rawManifest,
  repository,
} from "./development-suite-v2-support.ts";
const { values } = parseArgs({ options: { output: { type: "string" } } });
if (!values.output) throw new Error("--output NEW_DIRECTORY required (offline only)");
const requested = resolve(values.output);
if (existsSync(requested)) throw new Error("output already exists");
mkdirSync(requested);
const root = realpathSync(requested);
const prepared = new Map<string, ReturnType<typeof prepareCase>>();
const controls = [];
for (const task of manifest.cases) {
  const value = prepareCase(task, join(root, task.id));
  prepared.set(task.id, value);
  controls.push({
    id: task.id,
    baselineChecks: value.red.functional!.verdict!.results,
    baselineTypes: value.red.repositoryTypes!.passed,
    baselineApi: value.red.apiCompatibility!.passed,
    referencePassed: value.green.passed,
  });
}
const prior = join(root, "prior-evidence");
mkdirSync(prior);
const archive = join(repository, "docs/experiments/results/development-suite-v1/evidence.tar.gz");
execFileSync("tar", ["-xzf", archive, "-C", prior]);
const old = JSON.parse(readFileSync(join(prior, "summary.json"), "utf8")) as {
  runs: Array<{ id: string; task: string; runId: string }>;
};
const replay = [];
for (const entry of old.runs) {
  const task = manifest.cases.find((t) => t.id === entry.task)!;
  const candidate = join(
    prior,
    entry.id,
    "instance/workspaces",
    entry.runId,
    "develop/output",
    task.target,
  );
  const report = await runDevelopmentPilot({
    output: join(root, `replay-${entry.id}`),
    sourceFile: join(fixtures, task.id, "source.ts.txt"),
    checksFile: join(fixtures, task.id, "checks.mjs"),
    target: task.target,
    goal: task.goal,
    maxWallClockSeconds: 30,
    repository: prepared.get(task.id)!.plan,
    provenance: { mode: "fixture", sourceCommit: task.sourceCommit, requestedModel: null },
    executor: {
      name: "archived-candidate-replay",
      recoveryPolicy: "manual",
      async start(request) {
        writeFileSync(join(request.workspaceDir, "output", task.target), readFileSync(candidate));
        return {
          ok: true,
          exitCode: 0,
          stdout: "Archived candidate, zero model calls",
          stderr: "",
          durationMs: 0,
          outputRef: null,
        };
      },
    },
  });
  assert.equal(report.passed, task.id !== "snapshot-digest", entry.id);
  replay.push({
    id: entry.id,
    expected: task.id !== "snapshot-digest",
    passed: report.passed,
    runId: report.summary.runId,
    state: report.summary.state,
    verification: report.verification,
  });
}
const summary = {
  version: "development-suite-v2-offline",
  manifestDigest: digestOf(rawManifest),
  modelCalls: 0,
  controls,
  replay,
  allExpected: true,
};
writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2));
console.log(
  JSON.stringify({
    output: root,
    controlTasks: controls.length,
    priorCandidates: replay.length,
    badCandidatesRejected: replay.filter((r) => !r.passed).length,
    modelCalls: 0,
  }),
);
