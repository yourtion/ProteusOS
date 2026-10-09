import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AppInstance } from "../../src/app/instance.ts";
import {
  CHANGED_FILES_DIR,
  createChangedFilePolicyVersion,
  federationHeldoutPlan,
  federationOwnerInstance,
  installFederationCapability,
} from "../federation-helpers.ts";

describe("team inheritance acceptance story", () => {
  const apps: AppInstance[] = [];
  afterAll(() => apps.forEach((app) => app.close()));

  it("imports a shared policy, requires local evaluation and operator promotion, and leaves a rejecting owner unchanged", async () => {
    const a = federationOwnerInstance("accept-org-a", "accept-owner-a");
    const b = federationOwnerInstance("accept-org-b", "accept-owner-b");
    apps.push(a, b);
    installFederationCapability(a, "accept-org-a", "accept-owner-a");
    installFederationCapability(b, "accept-org-b", "accept-owner-b");
    const activeA = a.kernel.getOrganism("accept-org-a")!.activeGenomeId;
    const activeB = b.kernel.getOrganism("accept-org-b")!.activeGenomeId;

    a.kernel.createPrincipal("accept-owner-b", "user");
    a.federation.createTeam("accept-team", { createdBy: "accept-owner-a" });
    a.federation.grantTeam("accept-team", "accept-owner-b", "read", {
      authorizedBy: "accept-owner-a",
    });
    const policy = createChangedFilePolicyVersion(a, "accept-org-a", "accept-owner-a");
    const fork = a.federation.fork({
      versionIds: [policy.id],
      scope: "public",
      createdBy: "accept-owner-a",
    });
    const publication = a.federation.publish({
      teamId: "accept-team",
      versionIds: [fork.versions[policy.id]!],
      scope: "public",
      createdBy: "accept-owner-a",
    });
    const envelope = a.federation.exportPublication(publication.id, "accept-owner-a");
    const importA = a.federation.importBundle(envelope, { createdBy: "accept-owner-a" });
    const importB = b.federation.importBundle(envelope, { createdBy: "accept-owner-b" });

    expect(a.kernel.getOrganism("accept-org-a")!.activeGenomeId).toBe(activeA);
    expect(b.kernel.getOrganism("accept-org-b")!.activeGenomeId).toBe(activeB);

    const plan = federationHeldoutPlan("accept-owner-a");
    const validation = a.evolution.registerValidationSet({
      familyIds: plan.cases.map((item) => item.familyId),
      devFamilyIds: [],
      sourceRef: "team-inheritance-story",
      preparedBy: "accept-owner-a",
      plan,
    });
    const candidate = a.federation.inherit(importA.id, {
      validationSetId: validation.id,
      versionIds: [importA.versions[fork.versions[policy.id]!]!],
      createdBy: "accept-owner-a",
      hypothesis: "验证共享路由后由本地 operator 决定是否采用",
    });
    const evaluation = await a.evolution.evaluatePolicyCandidate(candidate.id);
    expect(evaluation.evaluation.verdict).toBe("eligible");
    expect(a.kernel.getOrganism("accept-org-a")!.activeGenomeId).toBe(activeA);

    const promotion = a.evolution.promote(candidate.id, { authorizedBy: "accept-owner-a" });
    expect(promotion.result).toBe("promoted");
    const result = await a.runtime.submitTask({
      requestedBy: "accept-owner-a",
      goal: "整理这些改动文件并按类别说明用途",
      inputs: [join(CHANGED_FILES_DIR, "inputs", "changed-files.json")],
      budget: { maxAttempts: 1, maxWallClockSeconds: 60 },
      acceptance: {
        outputSchema: join(CHANGED_FILES_DIR, "schema.json"),
        verifier: "stats-acceptance",
      },
    });
    expect(result.state).toBe("succeeded");
    expect(
      result.decisions.some((decision) => decision.value === "capability/changed-file-summary"),
    ).toBe(true);

    const rejected = b.federation.rejectImport(importB.id, {
      createdBy: "accept-owner-b",
      note: "本地策略不采用此共享版本",
    });
    expect(rejected.state).toBe("rejected");
    expect(b.kernel.getOrganism("accept-org-b")!.activeGenomeId).toBe(activeB);
  });
});
