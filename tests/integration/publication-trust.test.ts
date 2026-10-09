import { readFileSync, statSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { AppInstance } from "../../src/app/instance.ts";
import {
  createChangedFilePolicyVersion,
  federationHeldoutPlan,
  federationOwnerInstance,
  installFederationCapability,
} from "../federation-helpers.ts";
import { openInstance } from "../../src/app/instance.ts";

describe("signed publication trust", () => {
  const apps: AppInstance[] = [];
  afterAll(() => apps.forEach((app) => app.close()));

  function publication() {
    const publisher = federationOwnerInstance("trust-publisher-org", "trust-publisher");
    apps.push(publisher);
    installFederationCapability(publisher, "trust-publisher-org", "trust-publisher");
    publisher.federation.createTeam("trust-team", { createdBy: "trust-publisher" });
    const policy = createChangedFilePolicyVersion(
      publisher,
      "trust-publisher-org",
      "trust-publisher",
    );
    const fork = publisher.federation.fork({
      versionIds: [policy.id],
      scope: "public",
      createdBy: "trust-publisher",
    });
    const publicationRecord = publisher.federation.publish({
      teamId: "trust-team",
      versionIds: [fork.versions[policy.id]!],
      scope: "public",
      createdBy: "trust-publisher",
    });
    const key = publisher.sharingTrust.createSigningKey("trust-team", {
      createdBy: "trust-publisher",
    });
    return {
      publisher,
      key,
      signed: publisher.sharingTrust.signPublication(publicationRecord.id, {
        keyId: key.keyId,
        createdBy: "trust-publisher",
      }),
    };
  }

  it("authenticates Ed25519 identity and content, rejecting tampering and an embedded replacement key", () => {
    const { publisher, key, signed } = publication();
    expect(publisher.sharingTrust.verify(signed).signer.keyId).toBe(key.keyId);
    const tampered = structuredClone(signed);
    tampered.envelope.bundle.publisher = "attacker";
    expect(() => publisher.sharingTrust.verify(tampered)).toThrow();

    const other = publication();
    const impersonation = {
      ...other.signed,
      signer: { ...other.signed.signer, keyId: key.keyId },
    };
    expect(() => publisher.sharingTrust.verify(impersonation)).toThrow();
  });

  it("pins keys per organism and retains an import proof that becomes untrusted after revocation", () => {
    const { key, signed } = publication();
    const receiver = federationOwnerInstance("trust-receiver-org", "trust-receiver");
    apps.push(receiver);
    expect(() =>
      receiver.federation.importBundle(signed, { createdBy: "trust-receiver" }),
    ).toThrow();
    receiver.sharingTrust.trustKey({
      teamId: key.teamId,
      publisher: key.publisher,
      publicKey: key.publicKey,
      authorizedBy: "trust-receiver",
    });
    const imported = receiver.federation.importBundle(signed, { createdBy: "trust-receiver" });
    expect(receiver.storage.getImportSignatureRef(imported.id)).toBeTruthy();
    expect(receiver.storage.isSharedImportTrusted(imported.id, "trust-receiver-org")).toBe(true);
    receiver.sharingTrust.revokeKey(key.keyId, { authorizedBy: "trust-receiver" });
    expect(receiver.storage.getImportSignatureRef(imported.id)).toBeTruthy();
    expect(receiver.storage.isSharedImportTrusted(imported.id, "trust-receiver-org")).toBe(false);
    expect(() =>
      receiver.sharingTrust.trustKey({
        teamId: key.teamId,
        publisher: key.publisher,
        publicKey: key.publicKey,
        authorizedBy: "trust-receiver",
      }),
    ).toThrow();
  });

  it("stops inherited candidates after source-key revocation and preserves the revoked tombstone on reopen", async () => {
    const { key, signed } = publication();
    const receiver = federationOwnerInstance("trust-lifecycle-org", "trust-lifecycle-owner");
    apps.push(receiver);
    installFederationCapability(receiver, "trust-lifecycle-org", "trust-lifecycle-owner");
    const activeBefore = receiver.kernel.getOrganism("trust-lifecycle-org")!.activeGenomeId;
    receiver.sharingTrust.trustKey({
      teamId: key.teamId,
      publisher: key.publisher,
      publicKey: key.publicKey,
      authorizedBy: "trust-lifecycle-owner",
    });
    const imported = receiver.federation.importBundle(signed, {
      createdBy: "trust-lifecycle-owner",
    });
    const importedVersionId = imported.rootVersionIds[0]!;
    const plan = federationHeldoutPlan("trust-lifecycle-owner");
    const validation = receiver.evolution.registerValidationSet({
      familyIds: plan.cases.map((item) => item.familyId),
      devFamilyIds: [],
      sourceRef: "publication-trust-lifecycle",
      preparedBy: "trust-lifecycle-owner",
      plan,
    });
    const candidate = receiver.federation.inherit(imported.id, {
      validationSetId: validation.id,
      versionIds: [importedVersionId],
      createdBy: "trust-lifecycle-owner",
      hypothesis: "只有来源仍受信任时才能评估或采用",
    });

    expect(
      (await receiver.evolution.evaluatePolicyCandidate(candidate.id)).evaluation.verdict,
    ).toBe("eligible");
    receiver.sharingTrust.revokeKey(key.keyId, { authorizedBy: "trust-lifecycle-owner" });
    await expect(receiver.evolution.evaluatePolicyCandidate(candidate.id)).rejects.toMatchObject({
      code: "source_untrusted",
    });
    expect(() =>
      receiver.evolution.promote(candidate.id, {
        authorizedBy: "trust-lifecycle-owner",
      }),
    ).toThrow("共享来源签名信任已撤销");
    expect(() =>
      receiver.federation.inherit(imported.id, {
        validationSetId: validation.id,
        versionIds: [importedVersionId],
        createdBy: "trust-lifecycle-owner",
        hypothesis: "revoked source",
      }),
    ).toThrow();
    expect(() =>
      receiver.federation.importBundle(signed, {
        createdBy: "trust-lifecycle-owner",
      }),
    ).toThrow();
    expect(receiver.storage.getImportSignatureRef(imported.id)).toBeTruthy();
    expect(receiver.kernel.getOrganism("trust-lifecycle-org")!.activeGenomeId).toBe(activeBefore);

    const root = receiver.root;
    receiver.close();
    apps.splice(apps.indexOf(receiver), 1);
    const reopened = openInstance(root, {
      organismId: "trust-lifecycle-org",
      actorId: "trust-lifecycle-owner",
    });
    apps.push(reopened);
    expect(() => reopened.sharingTrust.verify(signed)).toThrow();
    expect(() =>
      reopened.sharingTrust.trustKey({
        teamId: key.teamId,
        publisher: key.publisher,
        publicKey: key.publicKey,
        authorizedBy: "trust-lifecycle-owner",
      }),
    ).toThrow();
  });

  it("keeps private signing material outside publication data and records only its public identity", () => {
    const { publisher, key, signed } = publication();
    const pemPath = `${publisher.root}/keys/${key.keyId}.pem`;
    expect(statSync(pemPath).mode & 0o777).toBe(0o600);
    const privatePem = readFileSync(pemPath, "utf8");
    expect(JSON.stringify(signed)).not.toContain(privatePem);
    const events = publisher.storage.listEvents({ streamId: "trust-trust-publisher-org" }, 100);
    expect(JSON.stringify(events)).not.toContain(privatePem);
    expect(JSON.stringify(events)).toContain(key.keyId);
  });
});
