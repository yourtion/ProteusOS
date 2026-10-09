import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AppInstance } from "../../src/app/instance.ts";
import { canonicalJson } from "../../src/app/seed.ts";
import { digestOf } from "../../src/storage/blobs.ts";
import { registerDerivedVersion } from "../../src/evolution/assets.ts";
import { fixturePath } from "../helpers.ts";
import {
  CHANGED_FILES_DIR as CFS,
  createChangedFilePolicyVersion,
  federationHeldoutPlan,
  federationOwnerInstance,
  installFederationCapability,
} from "../federation-helpers.ts";

const privateGoalSentinel = "PRIVATE_GOAL_SENTINEL_7bde7e";

function expectNoPrivateFields(value: unknown): void {
  const forbidden = new Set([
    "experience",
    "experiences",
    "task",
    "tasks",
    "prompt",
    "prompts",
    "credential",
    "credentials",
  ]);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      expect(forbidden.has(key.toLowerCase())).toBe(false);
      visit(child);
    }
  };
  visit(value);
}

function resealBundle<T extends { digest: string; bundle: unknown }>(envelope: T): T {
  return { ...envelope, digest: digestOf(canonicalJson(envelope.bundle)) };
}

describe("federation package lifecycle", () => {
  const apps: AppInstance[] = [];
  afterAll(() => apps.forEach((app) => app.close()));

  it("different owners import the same public team package; only local eligible evaluation and promotion changes active behavior", async () => {
    const ownerA = "owner-a";
    const ownerB = "owner-b";
    const organismA = "organism-a";
    const organismB = "organism-b";
    const a = federationOwnerInstance(organismA, ownerA);
    const b = federationOwnerInstance(organismB, ownerB);
    apps.push(a, b);
    installFederationCapability(a, organismA, ownerA);
    installFederationCapability(b, organismB, ownerB);

    const beforeA = a.kernel.getOrganism(organismA)!.activeGenomeId;
    const beforeB = b.kernel.getOrganism(organismB)!.activeGenomeId;
    const privateRun = await a.runtime.submitTask({
      requestedBy: ownerA,
      goal: privateGoalSentinel,
      inputs: [fixturePath("input-a")],
      budget: { maxAttempts: 1, maxWallClockSeconds: 60 },
      acceptance: {
        outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
        verifier: "stats-acceptance",
      },
    });
    expect(privateRun.state).toBe("succeeded");
    const privateDataset = a.evolution.freezeExperienceWindow({
      purpose: "development",
      runIds: [privateRun.runId],
      createdBy: ownerA,
    });
    expect(() =>
      b.evolution.freezeExperienceWindow({
        purpose: "development",
        runIds: [privateRun.runId],
        createdBy: ownerB,
      }),
    ).toThrow();
    expect(() => b.evolution.experienceDatasetView(privateDataset.dataset.id)).toThrow();
    const privateJob = a.evolution.submitConsolidationJob({
      datasetId: privateDataset.dataset.id,
      createdBy: ownerA,
    }).job;
    expect(() => b.evolution.consolidationJob(privateJob.id)).toThrow();

    a.kernel.createPrincipal(ownerB, "user");
    a.federation.createTeam("team-shared", { createdBy: ownerA });
    a.federation.grantTeam("team-shared", ownerB, "read", { authorizedBy: ownerA });
    a.federation.grantTeam("team-shared", ownerB, "publish", { authorizedBy: ownerA });

    const privatePolicy = createChangedFilePolicyVersion(a, organismA, ownerA);
    const sourceBasePolicy = a.kernel.resolveSnapshot(beforeA!).versions.get("routing-policy")!;
    const publicParentFork = a.federation.fork({
      versionIds: [sourceBasePolicy.id],
      scope: "public",
      createdBy: ownerA,
    });
    const publicParentId = publicParentFork.versions[sourceBasePolicy.id]!;
    const fork = a.federation.fork({
      versionIds: [privatePolicy.id, publicParentId],
      scope: "team:team-shared",
      createdBy: ownerA,
    });
    expect(a.kernel.getOrganism(organismA)!.activeGenomeId).toBe(beforeA);
    const publicPolicyId = fork.versions[privatePolicy.id]!;
    const forkedParentId = fork.versions[publicParentId]!;
    const forkedParentVersion = a.storage.getArtifactVersion(forkedParentId)!;
    expect(forkedParentVersion.lineageId).toBe(fork.lineageId);
    expect(forkedParentVersion.lineageId).not.toBe(publicParentFork.lineageId);
    a.kernel.createPrincipal("ungranted-publisher", "user");
    expect(() =>
      a.federation.publish({
        teamId: "team-shared",
        versionIds: [publicPolicyId],
        scope: "public",
        createdBy: "ungranted-publisher",
      }),
    ).toThrow(/publish|permission|权限|forbidden|无权操作/i);
    const publication = a.federation.publish({
      teamId: "team-shared",
      versionIds: [publicPolicyId, forkedParentId],
      scope: "team:team-shared",
      createdBy: ownerA,
    });
    const envelope = a.federation.exportPublication(publication.id, ownerA);
    expect(envelope.digest).toBe(publication.bundleDigest);
    expect(JSON.stringify(envelope)).not.toContain(privateGoalSentinel);
    expectNoPrivateFields(envelope);
    expect(envelope.bundle.evidence).toEqual([]);

    // The same team ID has no local trust record in B yet, so the team bundle is unreadable.
    expect(() => b.federation.importBundle(envelope, { createdBy: ownerB })).toThrow(
      /权限|forbidden/i,
    );
    b.kernel.createPrincipal("local-team-admin", "user");
    b.kernel.grantAccess(`organism:${organismB}`, "local-team-admin", "operate", ownerB);
    b.federation.createTeam("team-shared", { createdBy: "local-team-admin" });
    b.federation.grantTeam("team-shared", ownerB, "read", { authorizedBy: "local-team-admin" });
    expect(() =>
      b.federation.grantTeam("team-shared", ownerA, "publish", { authorizedBy: ownerB }),
    ).toThrow();

    const tampered = structuredClone(envelope);
    tampered.bundle.versions[0]!.content += "tampered";
    expect(() => b.federation.importBundle(tampered, { createdBy: ownerB })).toThrow(
      /摘要|digest/i,
    );
    expect(b.storage.findSharedImport(organismB, tampered.digest)).toBeUndefined();

    const missingDependency = structuredClone(envelope);
    missingDependency.bundle.versions[0]!.dependencies = ["missing-version"];
    const missingSealed = resealBundle(missingDependency);
    expect(() => b.federation.importBundle(missingSealed, { createdBy: ownerB })).toThrow(
      /依赖|bundle/i,
    );
    expect(b.storage.findSharedImport(organismB, missingSealed.digest)).toBeUndefined();

    const duplicateVersion = structuredClone(envelope);
    duplicateVersion.bundle.versions.push(structuredClone(duplicateVersion.bundle.versions[0]!));
    const duplicateSealed = resealBundle(duplicateVersion);
    expect(() => b.federation.importBundle(duplicateSealed, { createdBy: ownerB })).toThrow(
      /重复|bundle/i,
    );
    expect(b.storage.findSharedImport(organismB, duplicateSealed.digest)).toBeUndefined();

    const cyclicDependencies = structuredClone(envelope);
    const [cycleA, cycleB] = cyclicDependencies.bundle.versions;
    expect(cycleA).toBeTruthy();
    expect(cycleB).toBeTruthy();
    cycleA!.dependencies = [cycleB!.id];
    cycleB!.dependencies = [cycleA!.id];
    const cyclicSealed = resealBundle(cyclicDependencies);
    expect(() => b.federation.importBundle(cyclicSealed, { createdBy: ownerB })).toThrow(
      /环|cycle/i,
    );
    expect(b.storage.findSharedImport(organismB, cyclicSealed.digest)).toBeUndefined();
    expect(b.kernel.getOrganism(organismB)!.activeGenomeId).toBe(beforeB);

    const importedA = a.federation.importBundle(envelope, { createdBy: ownerA });
    const importedB = b.federation.importBundle(envelope, { createdBy: ownerB });
    expect(importedA.organismId).toBe(organismA);
    expect(importedB.organismId).toBe(organismB);
    expect(importedA.bundleDigest).toBe(importedB.bundleDigest);
    const parentEntry = envelope.bundle.versions.find((version) => version.id === forkedParentId)!;
    expect(parentEntry.parents.map((parent) => parent.id)).toEqual([publicParentId]);
    const sourceExternal = b.storage.getExternalVersionRef(forkedParentId)!;
    expect(sourceExternal).toMatchObject({
      id: forkedParentId,
      contentDigest: parentEntry.contentDigest,
      lineageId: parentEntry.lineageId,
      publicationDigest: envelope.digest,
    });
    expect(b.storage.getExternalVersionRef(publicParentId)).toMatchObject({
      id: publicParentId,
      contentDigest: parentEntry.parents[0]!.contentDigest,
      lineageId: parentEntry.parents[0]!.lineageId,
      publicationDigest: envelope.digest,
    });
    const importedParentVersion = b.storage.getArtifactVersion(
      importedB.versions[forkedParentId]!,
    )!;
    expect(importedParentVersion.parents).toEqual([forkedParentId]);
    expect(importedParentVersion.lineageId).not.toBe(parentEntry.lineageId);
    expect(a.kernel.getOrganism(organismA)!.activeGenomeId).toBe(beforeA);
    expect(b.kernel.getOrganism(organismB)!.activeGenomeId).toBe(beforeB);

    const planA = federationHeldoutPlan(ownerA);
    const validationA = a.evolution.registerValidationSet({
      familyIds: planA.cases.map((c) => c.familyId),
      devFamilyIds: [],
      sourceRef: "m4-local-heldout-a",
      preparedBy: ownerA,
      plan: planA,
    });
    const localPolicyA = importedA.versions[publicPolicyId]!;
    const candidate = a.federation.inherit(importedA.id, {
      validationSetId: validationA.id,
      versionIds: [localPolicyA],
      createdBy: ownerA,
      hypothesis: "验证共享路由策略在本地任务上的效果",
    });
    expect(() => b.evolution.promote(candidate.id, { authorizedBy: ownerB })).toThrow();
    expect(a.kernel.getOrganism(organismA)!.activeGenomeId).toBe(beforeA);
    const evaluation = await a.evolution.evaluatePolicyCandidate(candidate.id);
    expect(evaluation.evaluation.verdict).toBe("eligible");
    const verifiedFork = a.federation.fork({
      versionIds: [localPolicyA],
      scope: "team:team-shared",
      createdBy: ownerA,
    });
    const verifiedPublication = a.federation.publish({
      teamId: "team-shared",
      versionIds: [verifiedFork.versions[localPolicyA]!],
      scope: "team:team-shared",
      evidenceRefs: [evaluation.evaluation.id],
      createdBy: ownerA,
    });
    const verifiedEnvelope = a.federation.exportPublication(verifiedPublication.id, ownerA);
    expect(verifiedEnvelope.bundle.evidence).toEqual([
      {
        protocolDigest: evaluation.evaluation.protocolDigest,
        verdict: "eligible",
        samples: 4,
        baseSuccessRate: 0.5,
        candidateSuccessRate: 1,
      },
    ]);
    expect(JSON.stringify(verifiedEnvelope)).not.toContain(privateGoalSentinel);
    expectNoPrivateFields(verifiedEnvelope);
    expect(() =>
      a.federation.publish({
        teamId: "team-shared",
        versionIds: [forkedParentId],
        scope: "team:team-shared",
        evidenceRefs: [evaluation.evaluation.id],
        createdBy: ownerA,
      }),
    ).toThrow(/评估未验证/);
    const promotion = a.evolution.promote(candidate.id, { authorizedBy: ownerA });
    expect(promotion.result).toBe("promoted");
    const changed = await a.runtime.submitTask({
      requestedBy: ownerA,
      goal: "请按类别整理这次改动文件并说明用途",
      inputs: [join(CFS, "inputs", "changed-files.json")],
      budget: { maxAttempts: 1, maxWallClockSeconds: 60 },
      acceptance: { outputSchema: join(CFS, "schema.json"), verifier: "stats-acceptance" },
    });
    expect(changed.state).toBe("succeeded");
    expect(
      changed.decisions.some((decision) => decision.value === "capability/changed-file-summary"),
    ).toBe(true);

    const planB = federationHeldoutPlan(ownerB);
    const validationB = b.evolution.registerValidationSet({
      familyIds: planB.cases.map((c) => c.familyId),
      devFamilyIds: [],
      sourceRef: "m4-local-heldout-b",
      preparedBy: ownerB,
      plan: planB,
    });
    const candidateB = b.federation.inherit(importedB.id, {
      validationSetId: validationB.id,
      versionIds: [importedB.versions[publicPolicyId]!],
      createdBy: ownerB,
      hypothesis: "先构造本地候选，再由成员明确拒绝",
    });
    const rejected = b.federation.rejectImport(importedB.id, {
      createdBy: ownerB,
      note: "本地验证结果不符合采用要求",
    });
    expect(rejected.state).toBe("rejected");
    expect(b.kernel.getOrganism(organismB)!.activeGenomeId).toBe(beforeB);
    expect(b.federation.importRecord(importedB.id).state).toBe("rejected");
    await expect(b.evolution.evaluatePolicyCandidate(candidateB.id)).rejects.toThrow(
      /拒绝|rejected/i,
    );
    expect(() => b.evolution.promote(candidateB.id, { authorizedBy: ownerB })).toThrow();
  });

  it("私有依赖不能经 public fork 打包；未授权发布者不能借团队名义发布", () => {
    const ownerId = "owner-private";
    const app = federationOwnerInstance("organism-private", ownerId);
    apps.push(app);
    app.kernel.createPrincipal("ungranted-publisher", "user");
    app.federation.createTeam("team-private-test", { createdBy: ownerId });
    const active = app.kernel.getOrganism("organism-private")!.activeGenomeId!;
    const base = app.kernel.resolveSnapshot(active).versions.get("routing-policy")!;
    const artifact = app.storage.getArtifact(base.artifactId)!;
    const privateDependencyArtifact = {
      id: "private-decision-view",
      kind: "decision-view",
      lineageId: artifact.lineageId,
      ownerId,
      createdAt: Date.now(),
    };
    app.storage.insertArtifact(privateDependencyArtifact);
    const dependency = registerDerivedVersion(
      { kernel: app.kernel, storage: app.storage, blobs: app.blobs, clock: { now: Date.now } },
      {
        slot: "decision-view",
        baseVersion: undefined,
        artifact: privateDependencyArtifact,
        content: { kind: "private-view" },
        createdBy: ownerId,
      },
    );
    const policyContent = {
      ...(JSON.parse(app.blobs.read(base.contentRef)) as Record<string, unknown>),
      privateMarker: "unique-private-dependent-copy",
    };
    const { digest, ref } = app.blobs.write(canonicalJson(policyContent));
    const privateDependent = app.kernel.registerVersion({
      artifact,
      schemaVersion: 2,
      contentDigest: digest,
      contentRef: ref,
      parents: [base.id],
      dependencies: [dependency.id],
      createdBy: ownerId,
    });
    expect(() => {
      const fork = app.federation.fork({
        versionIds: [privateDependent.id],
        scope: "public",
        createdBy: ownerId,
      });
      app.federation.publish({
        teamId: "team-private-test",
        versionIds: [fork.versions[privateDependent.id]!],
        scope: "public",
        createdBy: ownerId,
      });
    }).toThrow(/private|private dependency|私有/i);
    const ordinaryFork = app.federation.fork({
      versionIds: [base.id],
      scope: "public",
      createdBy: ownerId,
    });
    expect(() =>
      app.federation.publish({
        teamId: "team-private-test",
        versionIds: [ordinaryFork.versions[base.id]!],
        scope: "public",
        createdBy: "ungranted-publisher",
      }),
    ).toThrow(/publish|permission|权限|forbidden|无权操作/i);
  });
});
