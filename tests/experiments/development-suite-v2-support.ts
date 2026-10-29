import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareDevelopmentRepository,
  reviewDevelopmentRepository,
  safeDevelopmentPath,
  type DevelopmentRepositoryPlan,
} from "../../src/app/development-repository.ts";
import { digestOf } from "../../src/storage/blobs.ts";

export const repository = fileURLToPath(new URL("../..", import.meta.url));
export const fixtures = join(repository, "tests/fixtures/development-suite-v2");
export const rawManifest = readFileSync(join(fixtures, "manifest.json"), "utf8");
export interface SuiteCase {
  id: string;
  target: string;
  sourceCommit: string;
  fixCommit: string;
  goal: string;
  stage: "offline-regression" | "gate" | "expansion";
  sourceDigest: string;
  referenceDigest: string;
  checksDigest: string;
  contextFiles: string[];
  api: DevelopmentRepositoryPlan["api"];
}
export const manifest = JSON.parse(rawManifest) as {
  version: string;
  endpoint: string;
  model: string;
  repetitions: number;
  maxTurns: number;
  maxWallClockSeconds: number;
  outputMaxTokens: number;
  cases: SuiteCase[];
};

/** Export only recorded history. Never read a solution from the current working tree. */
export function exportHistoricalRepository(task: SuiteCase, destination: string): void {
  if (!/^[0-9a-f]{40}$/.test(task.sourceCommit)) throw new Error("invalid historical revision");
  const files = execFileSync(
    "git",
    [
      "ls-tree",
      "-r",
      "--name-only",
      task.sourceCommit,
      "--",
      "src",
      "package.json",
      "tsconfig.json",
    ],
    { cwd: repository, encoding: "utf8" },
  )
    .trim()
    .split("\n");
  mkdirSync(destination);
  for (const file of files) {
    if (!safeDevelopmentPath(file)) throw new Error("unexpected historical path");
    const data = execFileSync("git", ["show", `${task.sourceCommit}:${file}`], {
      cwd: repository,
      maxBuffer: 8 * 1024 * 1024,
    });
    mkdirSync(dirname(join(destination, file)), { recursive: true });
    writeFileSync(join(destination, file), data);
  }
  if (digestOf(readFileSync(join(destination, task.target), "utf8")) !== task.sourceDigest)
    throw new Error("historical target digest mismatch");
}

export function prepareCase(task: SuiteCase, output: string) {
  for (const [file, expected] of [
    ["source.ts.txt", task.sourceDigest],
    ["reference.ts.txt", task.referenceDigest],
    ["checks.mjs", task.checksDigest],
  ]) {
    if (digestOf(readFileSync(join(fixtures, task.id, file!), "utf8")) !== expected)
      throw new Error(`fixture drift: ${task.id}/${file}`);
  }
  mkdirSync(output);
  const history = join(output, "history"),
    frozen = join(output, "frozen");
  exportHistoricalRepository(task, history);
  mkdirSync(frozen);
  const checksPath = join(frozen, "checks.mjs");
  writeFileSync(checksPath, readFileSync(join(fixtures, task.id, "checks.mjs")));
  const plan = { root: history, contextFiles: task.contextFiles, api: task.api };
  const prepared = prepareDevelopmentRepository(
    plan,
    frozen,
    task.target,
    task.sourceDigest,
    checksPath,
  );
  const old = join(output, "source.ts"),
    reference = join(output, "reference.ts");
  writeFileSync(old, readFileSync(join(fixtures, task.id, "source.ts.txt")));
  writeFileSync(reference, readFileSync(join(fixtures, task.id, "reference.ts.txt")));
  const red = reviewDevelopmentRepository(prepared, old);
  if (
    red.functional?.exitCode !== 1 ||
    red.functional.verdict?.passed !== false ||
    !red.functional.verdict.results.some((r) => r.passed) ||
    !red.functional.verdict.results.some((r) => !r.passed) ||
    !red.repositoryTypes?.passed ||
    !red.apiCompatibility?.passed
  )
    throw new Error(`invalid red control: ${task.id}: ${JSON.stringify(red)}`);
  prepared.config.expectedChecks = red.functional.verdict.results.map((r) => r.name);
  const green = reviewDevelopmentRepository(prepared, reference);
  writeFileSync(join(output, "controls.json"), JSON.stringify({ red, green }, null, 2));
  if (!green.passed) throw new Error(`invalid green control: ${task.id}: ${JSON.stringify(green)}`);
  return { history, plan, prepared, red, green };
}
