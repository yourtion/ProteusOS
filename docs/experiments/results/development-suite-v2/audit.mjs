// Offline verification and replay: node audit.mjs EXTRACTED_SUITE REPOSITORY_WITH_NODE_MODULES
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
const root = realpathSync(process.argv[2]),
  repository = realpathSync(process.argv[3]);
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const hash = (path) => digest(readFileSync(path));
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const suite = json(join(root, "manifest.json")),
  summary = json(join(root, "summary.json"));
assert.equal(hash(join(root, "manifest.json")), summary.manifestDigest);
assert.equal(summary.halted, null);
assert.equal(summary.runs.length, 9);
assert.deepEqual(
  summary.runs.map((r) => r.id),
  [
    "snapshot-digest-1",
    "snapshot-digest-2",
    "snapshot-digest-3",
    "evolution-capability-accumulation-1",
    "adapter-cached-token-accounting-1",
    "evolution-capability-accumulation-2",
    "adapter-cached-token-accounting-2",
    "evolution-capability-accumulation-3",
    "adapter-cached-token-accounting-3",
  ],
);
assert.ok(summary.runs.slice(0, 3).every((r) => r.passed));
// Preserve the interrupted segment; the aggregate never replaces its original history.
assert.deepEqual(
  summary.segments.map((s) => s.name),
  ["initial", "continuation"],
);
const [initial, continued] = summary.segments.map((s) => {
  assert.equal(hash(join(root, s.file)), s.digest);
  return json(join(root, s.file));
});
assert.equal(initial.plannedRuns, 9);
assert.equal(initial.runs.length, 2);
assert.equal(
  initial.halted,
  "interrupted at snapshot-digest-3: harness changed during suite: src/runtime/types.ts",
);
assert.equal(continued.plannedRuns, 7);
assert.equal(continued.runs.length, 7);
assert.equal(continued.halted, null);
assert.equal(initial.manifestDigest, summary.manifestDigest);
assert.equal(continued.manifestDigest, summary.manifestDigest);
assert.deepEqual([...initial.runs, ...continued.runs], summary.runs);
const continuation = json(join(root, "segments/continuation.json"));
assert.deepEqual(continued.continuation, continuation);
assert.equal(continuation.previousSummaryDigest, summary.segments[0].digest);
assert.equal(continuation.previousHalt, initial.halted);
assert.deepEqual(
  continuation.previousRunIds,
  initial.runs.map(({ id, runId }) => ({ id, runId })),
);
assert.deepEqual(
  continuation.sequence,
  continued.runs.map((r) => r.id),
);
assert.equal(continuation.authorizedSessions, 9);
assert.equal(continuation.consumedSessions, 2);
assert.equal(continuation.remainingSessions, 7);
assert.equal(Object.keys(continuation.originalHarnessDigests).length, 13);
assert.equal(
  hash(join(root, "harness/tests/experiments/continue-development-suite-v2.ts")),
  continuation.continuationDigest,
);
assert.equal(new Set(summary.runs.map((r) => r.runId)).size, 9);
const nodeModules = realpathSync(join(repository, "node_modules"));
const require = createRequire(join(repository, "package.json"));
const compiler = join(
  dirname(
    createRequire(require.resolve("typescript/package.json")).resolve(
      `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
    ),
  ),
  "lib",
  process.platform === "win32" ? "tsc.exe" : "tsc",
);
function files(dir, prefix = "") {
  return readdirSync(dir).flatMap((name) => {
    const file = join(dir, name),
      relative = prefix + name,
      stat = lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false, relative);
    return stat.isDirectory() ? files(file, relative + "/") : [relative];
  });
}
assert.equal(hash(join(root, "registered-fixtures/manifest.json")), summary.manifestDigest);
for (const task of suite.cases) {
  const fixture = join(root, "registered-fixtures", task.id);
  for (const [name, expected] of [
    ["source.ts.txt", task.sourceDigest],
    ["reference.ts.txt", task.referenceDigest],
    ["checks.mjs", task.checksDigest],
  ])
    assert.equal(hash(join(fixture, name)), expected);
  if (task.historicalReferenceDigest)
    assert.equal(
      hash(join(fixture, "historical-reference.ts.txt")),
      task.historicalReferenceDigest,
    );
  for (const folder of ["controls", "continuation-controls"]) {
    const controls = json(join(root, folder, task.id, "controls.json"));
    assert.equal(controls.red.functional.passed, false);
    assert.equal(controls.red.repositoryTypes.passed, true);
    assert.equal(controls.red.apiCompatibility.passed, true);
    assert.equal(controls.green.passed, true);
  }
}
const verifier = readFileSync(join(root, "harness/src/app/development-pilot.ts"), "utf8").match(
  /export const DEVELOPMENT_VERIFIER = String\.raw`([\s\S]*?)`;\n/,
)?.[1];
assert.ok(verifier);
const audited = [];
for (const row of summary.runs) {
  const base = join(root, row.id),
    manifest = json(join(base, "manifest.json")),
    run = json(join(base, "run.json")),
    report = json(join(base, "report.json"));
  const task = suite.cases.find((t) => t.id === row.task);
  const expectedHarness = { ...continuation.originalHarnessDigests };
  if (!initial.runs.some((r) => r.id === row.id))
    expectedHarness["tests/experiments/continue-development-suite-v2.ts"] =
      continuation.continuationDigest;
  assert.deepEqual(manifest.harnessDigests, expectedHarness);
  assert.equal(manifest.requestedModel, suite.model);
  assert.equal(manifest.executionProfile.endpoint, suite.endpoint);
  assert.equal(manifest.executionProfile.maxTurns, suite.maxTurns);
  assert.equal(manifest.executionProfile.outputMaxTokens, suite.outputMaxTokens);
  assert.deepEqual(manifest.executionProfile.tools, ["Read", "Write", "Edit"]);
  assert.equal(manifest.maxAttempts, 1);
  assert.equal(manifest.maxWallClockSeconds, suite.maxWallClockSeconds);
  assert.equal(row.evidenceComplete, true);
  assert.equal(manifest.version, "development-pilot-v2");
  assert.equal(digest(canonical(manifest)), report.manifestDigest);
  assert.equal(manifest.sourceDigest, task.sourceDigest);
  assert.equal(manifest.checksDigest, task.checksDigest);
  assert.equal(manifest.verifierDigest, digest(verifier));
  assert.equal(hash(join(base, "frozen/source.ts")), manifest.sourceDigest);
  assert.equal(hash(join(base, "frozen/checks.mjs")), manifest.checksDigest);
  assert.equal(manifest.outputSeedDigest, manifest.sourceDigest);
  assert.deepEqual(manifest.repository.api, task.api);
  assert.deepEqual(manifest.repository.contextFiles, task.contextFiles);
  assert.equal(digest(canonical(manifest.repository.files)), manifest.repository.digest);
  const frozenRepo = join(base, "frozen/repository");
  assert.deepEqual(files(frozenRepo).sort(), Object.keys(manifest.repository.files).sort());
  for (const [file, expected] of Object.entries(manifest.repository.files))
    assert.equal(hash(join(frozenRepo, file)), expected);
  for (const [file, expected] of Object.entries(manifest.harnessDigests))
    assert.equal(hash(join(root, "harness", file)), expected);
  const context = json(join(base, "frozen/context.json"));
  assert.equal(hash(join(base, "frozen/context.json")), manifest.repository.contextDigest);
  assert.deepEqual(
    context.files.map((f) => f.path),
    task.contextFiles,
  );
  for (const f of context.files) {
    assert.equal(f.digest, manifest.repository.files[f.path]);
    assert.equal(digest(f.content), f.digest);
  }
  const workspace = join(base, "instance/workspaces", run.runId, "develop");
  const candidate = join(workspace, "output", task.target);
  assert.equal(hash(candidate), report.verification.outputDigest);
  for (const file of ["source.ts", "checks.mjs", "context.json"])
    assert.equal(hash(join(workspace, "inputs", file)), hash(join(base, "frozen", file)));
  const allowed = new Set([
    "inputs/source.ts",
    "inputs/checks.mjs",
    "inputs/context.json",
    `output/${task.target}`,
  ]);
  for (const file of files(workspace))
    assert.ok(file.startsWith(".proteus/") || allowed.has(file), file);
  const evidence = report.summary.attempts[0].evidence,
    blobRoot = join(base, "instance/blobs");
  for (const file of files(blobRoot))
    assert.equal(hash(join(blobRoot, file)), file.split("/").at(-1));
  assert.equal(hash(join(blobRoot, evidence.traceRef)), evidence.traceDigest);
  assert.equal(hash(join(blobRoot, evidence.accountingRef)), evidence.accountingDigest);
  const accounting = json(join(blobRoot, evidence.accountingRef));
  assert.deepEqual(accounting, evidence.accounting);
  assert.deepEqual(accounting, row.usage);
  assert.deepEqual(accounting, report.modelUsage);
  assert.equal(accounting.tokenStatus, "complete");
  assert.deepEqual(accounting.issues, []);
  assert.equal(accounting.transportAttempts, null);
  assert.equal(report.modelCallCount, null);
  assert.equal(report.cost, null);
  if (accounting.reportedCost) assert.equal(accounting.reportedCost.verified, false);
  const ids = accounting.receipts.filter((r) => r.kind === "assistant").map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, accounting.observedModelResponses);
  const sdkResult = accounting.receipts.find((r) => r.kind === "sdk-result");
  assert.ok(sdkResult.numTurns <= suite.maxTurns);
  for (const key of Object.keys(accounting.totals)) {
    assert.ok(Number.isSafeInteger(accounting.totals[key]) && accounting.totals[key] >= 0);
    assert.equal(
      accounting.totals[key],
      sdkResult.modelUsage.reduce((sum, m) => sum + m[key], 0),
    );
  }
  const totals = accounting.totals;
  assert.equal(
    totals.inputTokens,
    totals.uncachedInputTokens + totals.cachedReadTokens + totals.cachedWriteTokens,
  );
  assert.equal(totals.totalTokens, totals.inputTokens + totals.outputTokens);
  const trace = json(join(workspace, ".proteus/acp-trace.json"));
  assert.equal(trace.journal.failed, false);
  assert.equal(trace.journal.droppedEvents, 0);
  assert.equal(trace.projectionDropped, 0);
  assert.equal(trace.progressFailures, 0);
  const journal = readFileSync(join(workspace, ".proteus/acp-events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    journal.map((e) => e.seq),
    journal.map((_, i) => i + 1),
  );
  assert.equal(journal.at(-1).kind, "session.completed");
  const immutableTrace = json(join(blobRoot, evidence.traceRef));
  assert.equal(immutableTrace.status, "complete");
  assert.equal(immutableTrace.droppedEvents, 0);
  assert.equal(immutableTrace.events.at(-1).kind, "session.completed");
  assert.equal(
    immutableTrace.events
      .filter((e) => e.kind === "message")
      .map((e) => e.data.text)
      .join(""),
    journal
      .filter((e) => e.kind === "message")
      .map((e) => e.data.text)
      .join(""),
  );
  const db = new DatabaseSync(join(base, "instance/metadata.sqlite"), { readOnly: true });
  let progressRecords;
  try {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attempts").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM promotions").get().n, 0);
    assert.equal(
      db.prepare("SELECT active_genome_id FROM organisms").get().active_genome_id,
      run.activeSnapshotId,
    );
    assert.equal(
      db.prepare("SELECT state FROM runs WHERE id=?").get(run.runId).state,
      report.summary.state,
    );
    const events = db
      .prepare(
        "SELECT type,payload,occurred_at,seq FROM events WHERE run_id=? ORDER BY occurred_at,seq",
      )
      .all(run.runId);
    const stored = events.find((e) => e.type === "attempt.evidence.recorded");
    assert.deepEqual(JSON.parse(stored.payload).evidence, evidence);
    const progress = events.filter((e) => e.type === "attempt.progress");
    progressRecords = progress.length;
    assert.ok(progress.length > 1 && progress[0].occurred_at < stored.occurred_at);
    assert.deepEqual(
      JSON.parse(progress.at(-1).payload).progress,
      report.summary.attempts[0].progress,
    );
    const verified = JSON.parse(events.find((e) => e.type === "verify.completed").payload);
    assert.equal(verified.passed, report.passed);
    assert.equal(verified.attestedOutputs[`output/${task.target}`], hash(candidate));
    assert.equal(
      verified.attestedOutputs[".proteus/pilot-verification.json"],
      hash(join(workspace, ".proteus/pilot-verification.json")),
    );
  } finally {
    db.close();
  }
  const checker = join(base, "frozen/repository-review.mjs");
  assert.equal(hash(checker), manifest.repository.checkerDigest);
  assert.equal(hash(compiler), manifest.repository.compiler.digest);
  const lock = join(nodeModules, ".pnpm/lock.yaml");
  if (manifest.repository.dependencyLock)
    assert.equal(hash(lock), manifest.repository.dependencyLock.digest);
  const baseline = json(join(base, "baseline.json"));
  const expectedChecks = JSON.parse(baseline.stdout).results.map((r) => r.name);
  const config = {
    root: frozenRepo,
    files: manifest.repository.files,
    target: task.target,
    api: task.api,
    compiler: { ...manifest.repository.compiler, path: compiler },
    nodeModules,
    checksPath: join(base, "frozen/checks.mjs"),
    checksDigest: manifest.checksDigest,
    dependencyLock: manifest.repository.dependencyLock
      ? { path: lock, digest: manifest.repository.dependencyLock.digest }
      : null,
    expectedChecks,
  };
  function replay(source) {
    const result = spawnSync(process.execPath, [checker, JSON.stringify(config), source], {
      env: { LANG: "C.UTF-8" },
      encoding: "utf8",
      timeout: 85000,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.ok(result.status === 0 || result.status === 1, result.stderr);
    return JSON.parse(result.stdout);
  }
  const red = replay(join(base, "frozen/source.ts")),
    after = replay(candidate);
  assert.deepEqual(red, json(join(base, "repository-baseline.json")));
  assert.equal(red.functional.passed, false);
  assert.equal(red.repositoryTypes.passed, true);
  assert.equal(red.apiCompatibility.passed, true);
  assert.equal(after.passed, report.passed);
  assert.deepEqual(after, report.verification.repository);
  assert.equal(row.functional, after.functional.passed);
  assert.equal(row.repositoryTypes, after.repositoryTypes.passed);
  assert.equal(row.apiCompatibility, after.apiCompatibility.passed);
  audited.push({
    id: row.id,
    task: row.task,
    elapsedMs: row.elapsedMs,
    sdkTurns: sdkResult.numTurns,
    functional: after.functional.passed,
    repositoryTypes: after.repositoryTypes.passed,
    apiCompatibility: after.apiCompatibility.passed,
    passed: after.passed,
    progressRecords,
    journalRecords: journal.length,
    observedModelResponses: accounting.observedModelResponses,
    tokens: totals.totalTokens,
    droppedEvents: 0,
    activeUnchanged: true,
  });
}
const sum = (values) => values.reduce((total, value) => total + value, 0);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const metrics = {
  sessions: audited.length,
  independentTasks: new Set(audited.map((r) => r.task)).size,
  passed: audited.filter((r) => r.passed).length,
  elapsedMs: sum(audited.map((r) => r.elapsedMs)),
  sdkTurns: sum(audited.map((r) => r.sdkTurns)),
  observedModelResponses: sum(audited.map((r) => r.observedModelResponses)),
  progressRecords: sum(audited.map((r) => r.progressRecords)),
  journalRecords: sum(audited.map((r) => r.journalRecords)),
  tokenTotals: Object.fromEntries(
    Object.keys(summary.runs[0].usage.totals).map((key) => [
      key,
      sum(summary.runs.map((r) => r.usage.totals[key])),
    ]),
  ),
  actualCost: null,
  benefit: "inconclusive",
  tasks: [...new Set(audited.map((r) => r.task))].map((task) => {
    const rows = audited.filter((r) => r.task === task);
    return {
      task,
      sessions: rows.length,
      functional: rows.filter((r) => r.functional).length,
      repositoryTypes: rows.filter((r) => r.repositoryTypes).length,
      apiCompatibility: rows.filter((r) => r.apiCompatibility).length,
      passed: rows.filter((r) => r.passed).length,
      medianElapsedMs: median(rows.map((r) => r.elapsedMs)),
      medianTotalTokens: median(rows.map((r) => r.tokens)),
    };
  }),
};
assert.ok(metrics.sdkTurns <= suite.maxTurns * 9);
console.log(
  JSON.stringify(
    {
      version: "development-suite-v2-audit",
      auditPassed: true,
      modelCallsDuringReplay: 0,
      metrics,
      runs: audited,
    },
    null,
    2,
  ),
);
