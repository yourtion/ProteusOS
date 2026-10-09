import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openInstance, type AppInstance } from "../../src/app/instance.ts";
import { installSeed } from "../../src/app/seed.ts";
import {
  federationHeldoutPlan,
  federationOwnerInstance,
  installFederationCapability,
  CHANGED_FILES_DIR,
} from "../federation-helpers.ts";
import { tempInstanceRoot } from "../helpers.ts";
import type { SandboxBackend, SandboxExecution, SandboxResult } from "../../src/runtime/sandbox.ts";

const apps: AppInstance[] = [];
afterAll(() => apps.forEach((app) => app.close()));

function localReceiver(org: string, actor: string, sandbox?: SandboxBackend): AppInstance {
  const app = openInstance(tempInstanceRoot(), {
    organismId: org,
    actorId: actor,
    capabilitySandbox: sandbox,
  });
  installSeed(
    { kernel: app.kernel, storage: app.storage, blobs: app.blobs, clock: { now: Date.now } },
    { organismId: org, ownerId: actor },
  );
  installFederationCapability(app, org, actor);
  apps.push(app);
  return app;
}

function recordingTrustedFixtureBackend(): SandboxBackend & { calls: SandboxExecution[] } {
  const calls: SandboxExecution[] = [];
  return {
    name: "test-fixture-runner",
    isolated: true,
    calls,
    available: () => ({ ok: true }),
    run(exec): SandboxResult {
      calls.push(exec);
      // This executes a trusted repository fixture through the sandbox port contract.
      // It verifies routing and output handling, not real OS or VM isolation.
      const started = Date.now();
      const result = spawnSync(exec.command[0]!, exec.command.slice(1), {
        cwd: exec.hostWorkspace,
        encoding: "utf8",
        timeout: exec.profile.timeoutMs,
      });
      return {
        exitCode: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        durationMs: Date.now() - started,
      };
    },
  };
}

function fixedPlan(owner: string) {
  const plan = federationHeldoutPlan(owner);
  plan.cases[0]!.task.goal = `为${owner}整理这批改动文件的类别和用途`;
  plan.cases[0]!.familyId = `${owner}-imported-cap-validation-family`;
  plan.cases[0]!.id = `${owner}-imported-cap-validation`;
  plan.cases[0]!.task.requires = ["changed-file-summary"];
  plan.cases[1]!.familyId = `${owner}-imported-cap-regression-family`;
  plan.cases[1]!.id = `${owner}-imported-cap-regression`;
  plan.thresholds = { minSuccessRate: 1, minImprovement: 0, minSamples: 2 };
  return plan;
}

describe("imported capability sandbox gate", () => {
  it("requires sandbox for an imported capability while a local baseline capability still runs", async () => {
    const publisher = federationOwnerInstance("sandbox-publisher-org", "sandbox-publisher");
    apps.push(publisher);
    installFederationCapability(publisher, "sandbox-publisher-org", "sandbox-publisher");
    const source = publisher.kernel
      .resolveSnapshot(publisher.kernel.getOrganism("sandbox-publisher-org")!.activeGenomeId!)
      .versions.get("capability/changed-file-summary")!;
    publisher.federation.createTeam("sandbox-team", { createdBy: "sandbox-publisher" });
    publisher.federation.grantTeam("sandbox-team", "sandbox-publisher", "publish", {
      authorizedBy: "sandbox-publisher",
    });
    const fork = publisher.federation.fork({
      versionIds: [source.id],
      scope: "public",
      createdBy: "sandbox-publisher",
    });
    const publication = publisher.federation.publish({
      teamId: "sandbox-team",
      versionIds: [fork.versions[source.id]!],
      scope: "public",
      createdBy: "sandbox-publisher",
    });
    const envelope = publisher.federation.exportPublication(publication.id, "sandbox-publisher");

    const noSandbox = localReceiver("sandbox-no-backend-org", "sandbox-no-backend");
    const imported = noSandbox.federation.importBundle(envelope, {
      createdBy: "sandbox-no-backend",
    });
    const baseline = await noSandbox.runtime.submitTask({
      requestedBy: "sandbox-no-backend",
      goal: "请按类别整理这次改动文件并说明用途",
      inputs: [join(CHANGED_FILES_DIR, "inputs", "changed-files.json")],
      requires: ["changed-file-summary"],
      budget: { maxAttempts: 1, maxWallClockSeconds: 60 },
      acceptance: {
        outputSchema: join(CHANGED_FILES_DIR, "schema.json"),
        verifier: "stats-acceptance",
      },
    });
    expect(baseline.state, JSON.stringify(baseline)).toBe("succeeded");

    const plan = fixedPlan("sandbox-no-backend");
    const set = noSandbox.evolution.registerValidationSet({
      familyIds: plan.cases.map((c) => c.familyId),
      devFamilyIds: [],
      sourceRef: "imported-capability-no-sandbox",
      preparedBy: "sandbox-no-backend",
      plan,
    });
    const candidate = noSandbox.federation.inherit(imported.id, {
      validationSetId: set.id,
      versionIds: [imported.rootVersionIds[0]!],
      createdBy: "sandbox-no-backend",
    });
    const before = noSandbox.kernel.getOrganism("sandbox-no-backend-org")!.activeGenomeId;
    const evaluation = await noSandbox.evolution.evaluatePolicyCandidate(candidate.id);
    expect(evaluation.evaluation.verdict).not.toBe("eligible");
    expect(
      evaluation.evaluation.runs.some(
        (outcome) =>
          outcome.role === "policy-candidate" &&
          outcome.failureReason?.includes("sandbox_required"),
      ),
    ).toBe(true);
    expect(noSandbox.kernel.getOrganism("sandbox-no-backend-org")!.activeGenomeId).toBe(before);
  });

  it("runs the same imported capability through an explicitly injected isolated test backend", async () => {
    const publisher = federationOwnerInstance("sandbox-publisher-two-org", "sandbox-publisher-two");
    apps.push(publisher);
    installFederationCapability(publisher, "sandbox-publisher-two-org", "sandbox-publisher-two");
    const source = publisher.kernel
      .resolveSnapshot(publisher.kernel.getOrganism("sandbox-publisher-two-org")!.activeGenomeId!)
      .versions.get("capability/changed-file-summary")!;
    publisher.federation.createTeam("sandbox-team-two", { createdBy: "sandbox-publisher-two" });
    publisher.federation.grantTeam("sandbox-team-two", "sandbox-publisher-two", "publish", {
      authorizedBy: "sandbox-publisher-two",
    });
    const fork = publisher.federation.fork({
      versionIds: [source.id],
      scope: "public",
      createdBy: "sandbox-publisher-two",
    });
    const publication = publisher.federation.publish({
      teamId: "sandbox-team-two",
      versionIds: [fork.versions[source.id]!],
      scope: "public",
      createdBy: "sandbox-publisher-two",
    });
    const envelope = publisher.federation.exportPublication(
      publication.id,
      "sandbox-publisher-two",
    );

    const backend = recordingTrustedFixtureBackend();
    const receiver = localReceiver("sandbox-fake-backend-org", "sandbox-fake-backend", backend);
    const imported = receiver.federation.importBundle(envelope, {
      createdBy: "sandbox-fake-backend",
    });
    const plan = fixedPlan("sandbox-fake-backend");
    const set = receiver.evolution.registerValidationSet({
      familyIds: plan.cases.map((c) => c.familyId),
      devFamilyIds: [],
      sourceRef: "imported-capability-fake-backend",
      preparedBy: "sandbox-fake-backend",
      plan,
    });
    const candidate = receiver.federation.inherit(imported.id, {
      validationSetId: set.id,
      versionIds: [imported.rootVersionIds[0]!],
      createdBy: "sandbox-fake-backend",
    });
    const evaluation = await receiver.evolution.evaluatePolicyCandidate(candidate.id);
    expect(evaluation.evaluation.verdict, JSON.stringify(evaluation.evaluation)).toBe("eligible");
    expect(
      evaluation.evaluation.runs
        .filter((outcome) => outcome.role === "policy-candidate")
        .every((outcome) => outcome.state === "succeeded"),
    ).toBe(true);
    expect(backend.calls.length).toBeGreaterThan(0);
    expect(receiver.storage.listEvaluationsByCandidate(candidate.id, 1)[0]?.verdict).toBe(
      "eligible",
    );
  });
});
