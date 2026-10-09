import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openInstance, type AppInstance } from "../src/app/instance.ts";
import { installSeed } from "../src/app/seed.ts";
import { ensureCapabilityGenome, registerDerivedVersion } from "../src/evolution/assets.ts";
import type { PolicyEvaluationPlan } from "../src/evolution/index.ts";
import { fixturePath, REPO_ROOT, tempInstanceRoot, upgradeJudgeToActive } from "./helpers.ts";

export const CHANGED_FILES_DIR = join(REPO_ROOT, "tests/fixtures/changed-file-summary");

export function federationOwnerInstance(organismId: string, ownerId: string): AppInstance {
  const app = openInstance(tempInstanceRoot(), { organismId, actorId: ownerId });
  installSeed(
    { kernel: app.kernel, storage: app.storage, blobs: app.blobs, clock: { now: Date.now } },
    { organismId, ownerId },
  );
  return app;
}

export function federationHeldoutPlan(owner: string): PolicyEvaluationPlan {
  return {
    cases: [
      {
        id: `${owner}-summary-validation`,
        familyId: `${owner}-summary-validation-family`,
        role: "validation",
        task: {
          goal: "整理这批改动文件的分类与用途",
          inputs: [join(CHANGED_FILES_DIR, "inputs", "changed-files.json")],
          budget: { maxAttempts: 1, maxWallClockSeconds: 60 },
          acceptance: {
            outputSchema: join(CHANGED_FILES_DIR, "schema.json"),
            verifier: "stats-acceptance",
          },
        },
        expectedChoice: "capability/changed-file-summary",
      },
      {
        id: `${owner}-stats-regression`,
        familyId: `${owner}-stats-regression-family`,
        role: "regression",
        task: {
          goal: "统计专用回归样本文本的行数和词数",
          inputs: [fixturePath("input-a")],
          budget: { maxAttempts: 1, maxWallClockSeconds: 60 },
          acceptance: {
            outputSchema: fixturePath("schemas", "stats-summary.schema.json"),
            verifier: "stats-acceptance",
          },
        },
        expectedChoice: "local-process",
      },
    ],
    repeats: 1,
    thresholds: { minSuccessRate: 1, minImprovement: 0.5, minSamples: 2 },
    requestedBy: owner,
  };
}

export function installFederationCapability(
  app: AppInstance,
  organismId: string,
  ownerId: string,
): void {
  upgradeJudgeToActive(app, organismId, ownerId);
  const organism = app.kernel.getOrganism(organismId)!;
  const genome = ensureCapabilityGenome(
    { kernel: app.kernel, storage: app.storage, blobs: app.blobs, clock: { now: Date.now } },
    {
      baseSnapshotId: organism.activeGenomeId!,
      capabilities: [
        {
          name: "changed-file-summary",
          module: {
            kind: "capability-module-v1",
            name: "changed-file-summary",
            entry: "index.mjs",
            files: [
              {
                path: "index.mjs",
                content: readFileSync(join(CHANGED_FILES_DIR, "implementation.mjs"), "utf8"),
              },
            ],
          },
        },
      ],
      createdBy: ownerId,
    },
  );
  app.storage.tx(() => {
    if (!app.kernel.installAsActive(organismId, genome.snapshot.id, organism.revision).ok) {
      throw new Error("federation capability fixture CAS conflict");
    }
  });
}

export function createChangedFilePolicyVersion(
  app: AppInstance,
  organismId: string,
  ownerId: string,
) {
  const organism = app.kernel.getOrganism(organismId)!;
  const baseSnapshot = app.kernel.resolveSnapshot(organism.activeGenomeId!);
  const base = baseSnapshot.versions.get("routing-policy")!;
  return registerDerivedVersion(
    { kernel: app.kernel, storage: app.storage, blobs: app.blobs, clock: { now: Date.now } },
    {
      slot: "routing-policy",
      baseVersion: base,
      artifact: app.storage.getArtifact(base.artifactId),
      content: {
        schemaVersion: 2,
        kind: "rule-hybrid-v1",
        featureRoutes: [{ feature: "hasChangeIntent", choose: "capability/changed-file-summary" }],
        routes: [{ when: { nodeType: "execute" }, choose: "local-process" }],
      },
      createdBy: ownerId,
    },
  );
}
