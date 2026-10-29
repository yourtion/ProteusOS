// Offline: node audit.mjs EXTRACTED_SUITE_DIRECTORY (Node >= 26). No credentials/network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const root = realpathSync(process.argv[2]);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const digest = (text) => createHash("sha256").update(text).digest("hex");
const suite = readJson(join(root, "manifest.json"));
const summary = readJson(join(root, "summary.json"));
assert.equal(hash(join(root, "manifest.json")), summary.manifestDigest);
assert.equal(summary.halted, null);
assert.equal(summary.runs.length, suite.cases.length * suite.repetitions);
const expectedOrder = Array.from({ length: suite.repetitions }, (_, i) => suite.cases.map((task) => `${task.id}-${i + 1}`)).flat();
assert.deepEqual(summary.runs.map((run) => run.id), expectedOrder);
const audits = [];
function check(checks, source, expectedExit) {
  const result = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${checks}`, `--allow-fs-read=${source}`, checks, source], { encoding: "utf8", timeout: 15000, env: { LANG: "C.UTF-8" } });
  assert.equal(result.status, expectedExit, result.stderr);
  return JSON.parse(result.stdout);
}
function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const file = join(dir, name), stat = lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false, file);
    return stat.isDirectory() ? files(file) : [file];
  });
}
for (const entry of summary.runs) {
  const base = join(root, entry.id);
  const manifest = readJson(join(base, "manifest.json"));
  const report = readJson(join(base, "report.json"));
  const run = readJson(join(base, "run.json"));
  const task = suite.cases.find((t) => t.id === entry.task);
  assert.equal(entry.runId, run.runId);
  assert.equal(digest(canonical(manifest)), report.manifestDigest);
  assert.equal(manifest.sourceDigest, task.sourceDigest);
  assert.equal(manifest.checksDigest, task.checksDigest);
  assert.equal(manifest.target, task.target);
  for (const [file, expected] of Object.entries(manifest.harnessDigests)) {
    assert.equal(hash(join(root, "harness", file)), expected);
  }
  assert.equal(hash(join(base, "frozen/source.ts")), task.sourceDigest);
  assert.equal(hash(join(base, "frozen/checks.mjs")), task.checksDigest);
  const before = check(join(base, "frozen/checks.mjs"), join(base, "frozen/source.ts"), 1);
  assert.ok(before.results.some((r) => r.passed) && before.results.some((r) => !r.passed));
  const db = new DatabaseSync(join(base, "instance/metadata.sqlite"), { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attempts").get().n, 1);
    assert.equal(db.prepare("SELECT state FROM runs WHERE id=?").get(run.runId).state, report.summary.state);
    assert.equal(db.prepare("SELECT active_genome_id FROM organisms").get().active_genome_id, run.activeSnapshotId);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM promotions").get().n, 0);
    const blobRoot = join(base, "instance/blobs");
    const blobs = files(blobRoot);
    for (const blob of blobs) assert.equal(hash(blob), blob.split("/").at(-1));
    const workspace = join(base, "instance/workspaces", run.runId, "develop");
    const trace = readJson(join(workspace, ".proteus/acp-trace.json"));
    assert.equal(trace.version, "acp-public-trace-v2");
    assert.equal(trace.journal.failed, false);
    assert.equal(trace.journal.droppedEvents, 0);
    assert.equal(trace.projectionDropped, 0);
    assert.equal(trace.progressFailures, 0);
    const journal = readFileSync(join(workspace, ".proteus/acp-events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(journal.length, trace.journal.records);
    assert.deepEqual(journal.map((e) => e.seq), journal.map((_, i) => i + 1));
    assert.equal(journal[0].kind, "session.started");
    assert.equal(journal.at(-1).kind, "session.completed");
    assert.ok(journal.every((e) => ["session.started", "message", "tool", "permission", "session.completed"].includes(e.kind)));
    const evidence = report.summary.attempts[0].evidence;
    assert.equal(hash(join(blobRoot, evidence.traceRef)), evidence.traceDigest);
    assert.equal(hash(join(blobRoot, evidence.accountingRef)), evidence.accountingDigest);
    const accounting = readJson(join(blobRoot, evidence.accountingRef));
    assert.deepEqual(accounting, evidence.accounting);
    assert.deepEqual(accounting, report.modelUsage);
    assert.deepEqual(accounting, entry.usage);
    assert.equal(accounting.tokenStatus, "complete");
    assert.equal(accounting.source, "claude-sdk-model-usage");
    assert.deepEqual(accounting.issues, []);
    assert.equal(accounting.transportAttempts, null);
    assert.equal(report.cost, null);
    assert.equal(report.modelCallCount, null);
    if (accounting.reportedCost) assert.equal(accounting.reportedCost.verified, false);
    const responseIds = accounting.receipts.filter((r) => r.kind === "assistant").map((r) => r.id);
    assert.equal(new Set(responseIds).size, responseIds.length);
    assert.equal(accounting.observedModelResponses, responseIds.length);
    assert.ok(accounting.receipts.every((r) => !Object.keys(r).some((k) => ["content", "thinking", "reasoning", "message"].includes(k))));
    const receipt = accounting.receipts.find((r) => r.kind === "sdk-result");
    for (const key of Object.keys(accounting.totals)) {
      assert.ok(Number.isSafeInteger(accounting.totals[key]) && accounting.totals[key] >= 0);
      assert.equal(accounting.totals[key], receipt.modelUsage.reduce((sum, model) => sum + model[key], 0));
    }
    assert.equal(accounting.totals.inputTokens, accounting.totals.uncachedInputTokens + accounting.totals.cachedReadTokens + accounting.totals.cachedWriteTokens);
    assert.equal(accounting.totals.totalTokens, accounting.totals.inputTokens + accounting.totals.outputTokens);
    const immutableTrace = readJson(join(blobRoot, evidence.traceRef));
    assert.equal(immutableTrace.status, "complete");
    assert.equal(immutableTrace.droppedEvents, 0);
    assert.equal(immutableTrace.events.at(-1).kind, "session.completed");
    assert.equal(immutableTrace.events.filter((e) => e.kind === "message").map((e) => e.data.text).join(""), journal.filter((e) => e.kind === "message").map((e) => e.data.text).join(""));
    const events = db.prepare("SELECT type,payload,occurred_at FROM events WHERE run_id=? ORDER BY occurred_at,seq").all(run.runId);
    const storedEvidence = events.filter((e) => e.type === "attempt.evidence.recorded");
    assert.equal(storedEvidence.length, 1);
    assert.deepEqual(JSON.parse(storedEvidence[0].payload).evidence, evidence);
    const progress = events.filter((e) => e.type === "attempt.progress");
    assert.ok(progress.length > 1 && progress[0].occurred_at < storedEvidence[0].occurred_at);
    assert.equal(JSON.parse(progress.at(-1).payload).progress.phase, "completed");
    assert.deepEqual(JSON.parse(progress.at(-1).payload).progress, report.summary.attempts[0].progress);
    const candidate = join(workspace, "output", manifest.target);
    assert.equal(hash(candidate), report.verification.outputDigest);
    assert.equal(hash(join(workspace, "inputs/source.ts")), manifest.sourceDigest);
    assert.equal(hash(join(workspace, "inputs/checks.mjs")), manifest.checksDigest);
    const allowed = new Set([candidate, join(workspace, "inputs/source.ts"), join(workspace, "inputs/checks.mjs")]);
    for (const file of files(workspace)) assert.ok(file.startsWith(join(workspace, ".proteus") + "/") || allowed.has(file), `unexpected output: ${file}`);
    const after = check(join(base, "frozen/checks.mjs"), candidate, report.passed ? 0 : 1);
    assert.deepEqual(after.results.map((r) => r.name), before.results.map((r) => r.name));
    assert.deepEqual(after, JSON.parse(report.verification.testOutput));
    assert.equal(entry.passed, report.passed);
    const verified = events.filter((e) => e.type === "verify.completed").map((e) => JSON.parse(e.payload));
    assert.equal(verified.length, 1);
    assert.equal(verified[0].passed, report.passed);
    assert.equal(verified[0].attestedOutputs[`output/${manifest.target}`], hash(candidate));
    assert.equal(verified[0].attestedOutputs[".proteus/pilot-verification.json"], hash(join(workspace, ".proteus/pilot-verification.json")));
    audits.push({ id: entry.id, passed: report.passed, beforePassed: before.results.filter((r) => r.passed).length, afterPassed: after.results.filter((r) => r.passed).length, checks: before.results.length, traceStatus: evidence.traceStatus, droppedEvents: evidence.droppedEvents, progressRecords: progress.length, journalRecords: journal.length, observedModelResponses: accounting.observedModelResponses, tokens: accounting.totals.totalTokens, blobsChecked: blobs.length, activeUnchanged: true });
  } finally { db.close(); }
}
console.log(JSON.stringify({ auditPassed: true, modelCallsDuringReplay: 0, runs: audits }, null, 2));
