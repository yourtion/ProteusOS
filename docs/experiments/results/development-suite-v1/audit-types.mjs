// Post-hoc compatibility review, separate from the frozen functional score.
// node audit-types.mjs EXTRACTED_SUITE_DIRECTORY REPOSITORY_WITH_NODE_MODULES
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
const root = realpathSync(process.argv[2]), repository = realpathSync(process.argv[3]);
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const summary = JSON.parse(readFileSync(join(root, "summary.json"), "utf8"));
const tsc = join(repository, "node_modules/typescript/bin/tsc");
const run = (cwd, args) => {
  const result = spawnSync(process.execPath, [tsc, ...args], { cwd, encoding: "utf8", timeout: 30000, env: { LANG: "C.UTF-8" } });
  if (result.error) throw result.error;
  return { exitCode: result.status, output: result.stdout + result.stderr };
};
const version = run(repository, ["--version"]).output.trim();
const baselines = [], candidates = [];
for (const task of manifest.cases) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "proteus-type-review-")));
  try {
    cpSync(join(root, "compatibility", task.id), temp, { recursive: true, filter: (path) => basename(path) !== "node_modules" });
    symlinkSync(join(repository, "node_modules"), join(temp, "node_modules"), "dir");
    const target = join(temp, task.target), original = readFileSync(target);
    assert.equal(createHash("sha256").update(original).digest("hex"), task.sourceDigest);
    const baseline = run(temp, ["--noEmit"]);
    assert.equal(baseline.exitCode, 0, baseline.output);
    baselines.push({ task: task.id, ...baseline });
    for (const entry of summary.runs.filter((r) => r.task === task.id)) {
      const candidate = join(root, entry.id, "instance/workspaces", entry.runId, "develop/output", task.target);
      writeFileSync(target, readFileSync(candidate));
      candidates.push({ id: entry.id, ...run(temp, ["--noEmit"]) });
      writeFileSync(target, original);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ kind: "post-hoc-repository-type-review", version, modelCalls: 0, baselines, candidates }, null, 2));
