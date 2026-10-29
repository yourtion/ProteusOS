// Offline audit: node audit.mjs EXTRACTED_EVIDENCE_DIRECTORY (Node >= 26).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = realpathSync(process.argv[2]);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const digest = (text) => createHash("sha256").update(text).digest("hex");
const summaries = [];
function check(checks, source, expectedExit) {
  const result = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${checks}`, `--allow-fs-read=${source}`, checks, source], { encoding: "utf8", timeout: 15000, env: { LANG: "C.UTF-8" } });
  assert.equal(result.status, expectedExit, result.stderr);
  return JSON.parse(result.stdout);
}
for (const number of [1, 2]) {
  const base = join(root, `attempt-${number}`);
  const manifest = readJson(join(base, "manifest.json"));
  const report = readJson(join(base, "report.json"));
  const run = readJson(join(base, "run.json"));
  assert.equal(digest(canonical(manifest)), report.manifestDigest);
  assert.equal(hash(join(base, "frozen/source.ts")), manifest.sourceDigest);
  assert.equal(hash(join(base, "frozen/checks.mjs")), manifest.checksDigest);
  const before = check(join(base, "frozen/checks.mjs"), join(base, "frozen/source.ts"), 1);
  assert.equal(before.results.filter((r) => !r.passed).length, 8);
  assert.equal(before.results.filter((r) => r.passed).length, 4);
  const db = new DatabaseSync(join(base, "instance/metadata.sqlite"), { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attempts").get().n, 1);
    assert.equal(db.prepare("SELECT state FROM runs WHERE id=?").get(run.runId).state, number === 1 ? "failed" : "succeeded");
    assert.equal(db.prepare("SELECT active_genome_id FROM organisms").get().active_genome_id, run.activeSnapshotId);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM promotions").get().n, 0);
    let blobs = 0;
    const blobRoot = join(base, "instance/blobs");
    for (const shard of readdirSync(blobRoot)) {
      for (const file of readdirSync(join(blobRoot, shard))) {
        assert.equal(hash(join(blobRoot, shard, file)), file);
        blobs++;
      }
    }
    const workspace = join(base, "instance/workspaces", run.runId, "develop");
    const trace = readJson(join(workspace, ".proteus/acp-trace.json"));
    const evidence = report.summary.attempts[0].evidence;
    assert.equal(hash(join(blobRoot, evidence.traceRef)), evidence.traceDigest);
    const events = db.prepare("SELECT type,payload FROM events WHERE run_id=?").all(run.runId);
    const storedEvidence = events.filter((e) => e.type === "attempt.evidence.recorded").map((e) => JSON.parse(e.payload).evidence);
    assert.equal(storedEvidence.length, 1);
    assert.deepEqual(storedEvidence[0], evidence);
    let afterPassed = null;
    if (number === 1) {
      assert.equal(trace.permissions.length, 3);
      assert.ok(trace.permissions.every((p) => p.toolCall.name === "Write" && p.decision.outcome.outcome === "cancelled"));
      const proposals = trace.permissions.map((p) => p.toolCall.rawInput.content);
      assert.ok(proposals.every((p) => digest(p) === hash(join(root, "accepted-proposal.ts"))));
      const after = check(join(base, "frozen/checks.mjs"), join(root, "accepted-proposal.ts"), 0);
      assert.equal(after.results.length, 12);
      assert.ok(after.results.every((r) => r.passed));
      afterPassed = 12;
    } else {
      assert.equal(trace.stopReason, "end_turn");
      assert.equal(trace.permissions.length, 1);
      assert.equal(trace.permissions[0].decision.outcome.optionId, "allow-once");
      const candidate = join(workspace, "output", manifest.target);
      assert.equal(hash(candidate), report.verification.outputDigest);
      assert.equal(hash(join(workspace, "inputs/source.ts")), manifest.sourceDigest);
      assert.equal(hash(join(workspace, "inputs/checks.mjs")), manifest.checksDigest);
      const after = check(join(base, "frozen/checks.mjs"), candidate, 0);
      assert.equal(after.results.length, 12);
      assert.ok(after.results.every((r) => r.passed));
      assert.deepEqual(after, JSON.parse(report.verification.testOutput));
      const verified = events.filter((e) => e.type === "verify.completed").map((e) => JSON.parse(e.payload));
      assert.equal(verified.length, 1);
      assert.equal(verified[0].passed, true);
      assert.equal(verified[0].attestedOutputs[`output/${manifest.target}`], hash(candidate));
      assert.equal(verified[0].attestedOutputs[".proteus/pilot-verification.json"], hash(join(workspace, ".proteus/pilot-verification.json")));
      afterPassed = 12;
    }
    summaries.push({ attempt: number, runId: run.runId, runtimeState: report.summary.state, beforeFailed: 8, beforePassed: 4, afterPassed, blobsChecked: blobs, traceStatus: evidence.traceStatus, droppedEvents: evidence.droppedEvents, activeUnchanged: true });
  } finally { db.close(); }
}
console.log(JSON.stringify({ auditPassed: true, modelCallsDuringReplay: 0, attempts: summaries }, null, 2));
