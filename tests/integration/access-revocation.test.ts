import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionProvider } from "../../src/decision/index.ts";
import { openInstance } from "../../src/app/instance.ts";
import { bootSeededInstance, fixturePath } from "../helpers.ts";
import type { ExecutorProvider } from "../../src/runtime/types.ts";

const instances: Array<ReturnType<typeof openInstance>> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const instance of instances.splice(0)) instance.close();
});

function deferredRevoker(revoke: () => void): DecisionProvider {
  return {
    name: "decision-rule",
    remote: false,
    capabilities: () => ({ problems: ["choice"] }),
    async decide(request) {
      revoke();
      return {
        kind: "value",
        value: "local-process",
        provenance: { provider: "decision-rule", policyVersion: request.policy.versionId },
        raw: '{"kind":"value","value":"local-process"}',
      };
    },
  };
}

function inertExecutor(starts: { count: number }): ExecutorProvider {
  return {
    name: "local-process",
    recoveryPolicy: "retry-safe",
    async start() {
      starts.count++;
      return {
        ok: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 0,
        outputRef: null,
      };
    },
  };
}

function submission(requestedBy: string, snapshotId?: string) {
  return {
    input: {
      requestedBy,
      goal: "produce a summary",
      inputs: [fixturePath("input-a")],
      budget: { maxAttempts: 1, maxWallClockSeconds: 10 },
      acceptance: {
        outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
        verifier: "stats-acceptance",
      },
    },
    options: snapshotId ? { snapshotId } : {},
  };
}

describe("live access revocation", () => {
  it("commits unsent cancellation and releases quota when stop arrives after preparation", async () => {
    const app = bootSeededInstance();
    instances.push(app);
    let calls = 0;
    const provider: DecisionProvider = {
      name: "decision-rule",
      remote: true,
      capabilities: () => ({ problems: ["choice"] }),
      async decide(request) {
        calls++;
        return {
          kind: "value",
          value: "local-process",
          provenance: { provider: "decision-rule", policyVersion: request.policy.versionId },
        };
      },
    };
    const runtime = openInstance(app.root, { decisions: new Map([["decision-rule", provider]]) });
    instances.push(runtime);
    runtime.storage.setDecisionCallLimit({ organismId: "organism-default" }, 1, Date.now());
    const insert = runtime.storage.insertDecisionCall.bind(runtime.storage);
    vi.spyOn(runtime.storage, "insertDecisionCall").mockImplementation((call) => {
      insert(call);
      // Inject the persisted stop intent at the preparation seam, before first send.
      runtime.storage.appendEvent({
        streamId: `run-${call.runId}`,
        type: "run.cancel_requested",
        payload: { note: "pre-send stop" },
        runId: call.runId,
        organismId: "organism-default",
        occurredAt: Date.now(),
      });
    });
    const { input, options } = submission("principal-local");
    const result = await runtime.runtime.submitTask(input, options);
    expect(result.state).toBe("cancelled");
    expect(calls).toBe(0);
    expect(runtime.storage.listDecisionCalls(result.runId)[0]).toMatchObject({
      state: "cancelled",
      sent: false,
      errorClass: "cancel_before_send",
    });
    expect(runtime.storage.countDecisionQuotaCalls({ organismId: "organism-default" })).toBe(0);
  });
  it("fails a delegated run when organism operate is revoked during a decision", async () => {
    const root = mkdtempSync(join(tmpdir(), "proteos-revoke-"));
    const owner = bootSeededInstance(root);
    const delegate = "principal-delegate";
    owner.kernel.createPrincipal(delegate, "user");
    owner.kernel.grantAccess("organism:organism-default", delegate, "operate", "principal-local");
    const snapshotId = owner.kernel.getOrganism("organism-default")!.activeGenomeId!;
    owner.close();

    const starts = { count: 0 };
    let inst!: ReturnType<typeof openInstance>;
    const provider = deferredRevoker(() => {
      inst.kernel.revokeAccess("organism:organism-default", delegate, "operate", "principal-local");
    });
    inst = openInstance(root, {
      actorId: delegate,
      decisions: new Map([["decision-rule", provider]]),
      executors: new Map([["local-process", inertExecutor(starts)]]),
    });
    instances.push(inst);

    const { input, options } = submission(delegate, snapshotId);
    const result = await inst.runtime.submitTask(input, options);
    expect(result).toMatchObject({ state: "failed", failureReason: "access_revoked" });
    expect(starts.count).toBe(0);
  });

  it("fails before worker dispatch when team read on a pinned version is revoked", async () => {
    const root = mkdtempSync(join(tmpdir(), "proteos-revoke-team-"));
    const owner = bootSeededInstance(root);
    const delegate = "principal-delegate";
    const team = "team-reviewers";
    owner.kernel.createPrincipal(delegate, "user");
    owner.kernel.createPrincipal(team, "team");
    owner.kernel.grantAccess("organism:organism-default", delegate, "operate", "principal-local");

    const organism = owner.kernel.getOrganism("organism-default")!;
    const { snapshot, versions } = owner.kernel.resolveSnapshot(organism.activeGenomeId!);
    const policy = versions.get("routing-policy")!;
    const artifact = owner.storage.getArtifact(policy.artifactId)!;
    const version = owner.kernel.registerVersion({
      artifact,
      schemaVersion: policy.schemaVersion,
      contentDigest: policy.contentDigest,
      contentRef: policy.contentRef,
      parents: [policy.id],
      dependencies: [...policy.dependencies],
      createdBy: "principal-local",
      scope: `team:${team}`,
    });
    const bindings = { ...snapshot.bindings, "routing-policy": version.id };
    const candidate = owner.kernel.createSnapshot(bindings, "principal-local");
    owner.storage.insertAccessGrant(
      `team:${team}`,
      "principal-local",
      "manage",
      "principal-local",
      Date.now(),
    );
    owner.kernel.grantAccess(`team:${team}`, delegate, "read", "principal-local");
    owner.close();

    const starts = { count: 0 };
    let inst!: ReturnType<typeof openInstance>;
    const provider = deferredRevoker(() => {
      inst.kernel.revokeAccess(`team:${team}`, delegate, "read", "principal-local");
    });
    inst = openInstance(root, {
      actorId: delegate,
      decisions: new Map([["decision-rule", provider]]),
      executors: new Map([["local-process", inertExecutor(starts)]]),
    });
    instances.push(inst);

    const { input, options } = submission(delegate, candidate.id);
    const result = await inst.runtime.submitTask(input, options);
    expect(result).toMatchObject({ state: "failed", failureReason: "access_revoked" });
    expect(starts.count).toBe(0);
  });

  it("commits a prepared decision as cancelled and releases quota after access is revoked", async () => {
    const root = mkdtempSync(join(tmpdir(), "proteos-revoke-prepared-"));
    const owner = bootSeededInstance(root);
    const delegate = "principal-delegate";
    owner.kernel.createPrincipal(delegate, "user");
    owner.kernel.grantAccess("organism:organism-default", delegate, "operate", "principal-local");
    owner.close();

    const starts = { count: 0 };
    let calls = 0;
    const provider: DecisionProvider = {
      name: "decision-rule",
      remote: true,
      capabilities: () => ({ problems: ["choice"] }),
      async decide(request) {
        calls++;
        return {
          kind: "value",
          value: "local-process",
          provenance: { provider: "decision-rule", policyVersion: request.policy.versionId },
          raw: '{"kind":"value","value":"local-process"}',
        };
      },
    };
    const inst = openInstance(root, {
      actorId: delegate,
      decisions: new Map([["decision-rule", provider]]),
      executors: new Map([["local-process", inertExecutor(starts)]]),
    });
    instances.push(inst);
    inst.storage.setDecisionCallLimit({ organismId: "organism-default" }, 1, Date.now());

    const { input, options } = submission(delegate);
    const first = await inst.runtime.submitTask(input, options);
    const call = inst.storage.listDecisionCalls(first.runId)[0]!;
    expect(call.state).toBe("value");
    expect(inst.storage.countDecisionQuotaCalls({ organismId: "organism-default" })).toBe(1);

    const db = new DatabaseSync(join(root, "metadata.sqlite"));
    db.prepare(
      "UPDATE decision_calls SET state = 'prepared', sent = 0, started_at = NULL, response_ref = NULL, response_digest = NULL, ended_at = NULL, duration_ms = NULL WHERE id = ?",
    ).run(call.id);
    db.prepare(
      "DELETE FROM events WHERE run_id = ? AND type IN ('node.completed', 'decision.recorded', 'decision.started', 'decision.prepared', 'verify.completed')",
    ).run(first.runId);
    db.prepare("UPDATE runs SET state = 'running', failure_reason = NULL WHERE id = ?").run(
      first.runId,
    );
    db.close();

    inst.kernel.revokeAccess("organism:organism-default", delegate, "operate", "principal-local");
    const recovered = await inst.runtime.executeRun(first.runId);
    expect(recovered).toMatchObject({ state: "failed", failureReason: "access_revoked" });
    expect(calls).toBe(1);
    expect(starts.count).toBe(1); // only the first execution, before revocation
    expect(inst.storage.getDecisionCall(call.id)).toMatchObject({
      state: "cancelled",
      sent: false,
      errorClass: "access_revoked",
    });
    expect(inst.storage.countDecisionQuotaCalls({ organismId: "organism-default" })).toBe(0);
  });
});
