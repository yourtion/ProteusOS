// Offline, post-hoc check of nullable SDK cache counters; no model or network calls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, cpSync, mkdtempSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const root = resolve(process.argv[2]),
  repository = resolve(process.argv[3]);
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const checks = join(dirname(fileURLToPath(import.meta.url)), "nullable-cache-checks.mjs");
const suite = json(join(root, "manifest.json"));
const task = suite.cases.find((c) => c.id === "adapter-cached-token-accounting");
const first = join(root, `${task.id}-1`);
const reference = join(root, "registered-fixtures", task.id, "reference.ts.txt");
assert.equal(hash(reference), task.referenceDigest);
const implementations = [
  {
    id: "historical-source",
    path: join(first, "frozen/source.ts"),
    expectedDigest: task.sourceDigest,
  },
  { id: "historical-reference", path: reference, expectedDigest: task.referenceDigest },
  ...[1, 2, 3].map((i) => {
    const id = `${task.id}-${i}`,
      base = join(root, id),
      run = json(join(base, "run.json")),
      report = json(join(base, "report.json"));
    return {
      id,
      path: join(base, "instance/workspaces", run.runId, "develop/output", task.target),
      expectedDigest: report.verification.outputDigest,
    };
  }),
];
const runs = [];
for (const implementation of implementations) {
  assert.equal(hash(implementation.path), implementation.expectedDigest);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "proteus-nullable-cache-review-")));
  try {
    cpSync(join(first, "frozen/repository"), scratch, { recursive: true });
    symlinkSync(join(repository, "node_modules"), join(scratch, "node_modules"), "dir");
    const target = join(scratch, task.target);
    cpSync(implementation.path, target);
    const result = spawnSync(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${scratch}`,
        `--allow-fs-read=${checks}`,
        `--allow-fs-read=${join(repository, "node_modules")}`,
        checks,
        target,
      ],
      {
        cwd: scratch,
        env: { LANG: "C.UTF-8" },
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.ok(result.status === 0 || result.status === 1, result.stderr);
    assert.ok(result.stdout.trim(), result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(result.status === 0, verdict.passed);
    assert.equal(verdict.results.length, 6);
    runs.push({ id: implementation.id, sourceDigest: implementation.expectedDigest, ...verdict });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
assert.equal(runs.find((r) => r.id === "historical-reference").passed, true);
console.log(
  JSON.stringify(
    {
      version: "development-suite-v2-nullable-cache-review",
      postHoc: true,
      changesRegisteredScore: false,
      modelCalls: 0,
      checksDigest: hash(checks),
      historicalReferenceDigest: task.referenceDigest,
      candidatePassed: runs.slice(2).filter((r) => r.passed).length,
      candidateCount: 3,
      runs,
    },
    null,
    2,
  ),
);
