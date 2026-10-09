import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { openInstance, type AppInstance } from "../../src/app/instance.ts";
import { createRegistryServer, RegistryClient } from "../../src/federation/registry.ts";
import {
  createChangedFilePolicyVersion,
  federationHeldoutPlan,
  federationOwnerInstance,
  installFederationCapability,
} from "../federation-helpers.ts";

describe("signed registry acceptance story", () => {
  const apps: AppInstance[] = [];
  afterAll(() => apps.forEach((app) => app.close()));

  it("protects actual signed team packages using current team grants and token revocation", async () => {
    const publisher = federationOwnerInstance("team-registry-publisher-org", "team-registry-alice");
    const receiver = federationOwnerInstance("team-registry-receiver-org", "team-registry-bob");
    apps.push(publisher, receiver);
    const team = "signed-private-team";
    publisher.federation.createTeam(team, { createdBy: "team-registry-alice" });
    publisher.kernel.createPrincipal("team-registry-bob", "user");
    publisher.federation.grantTeam(team, "team-registry-bob", "read", {
      authorizedBy: "team-registry-alice",
    });
    const snapshot = publisher.kernel.resolveSnapshot(
      publisher.kernel.getOrganism("team-registry-publisher-org")!.activeGenomeId!,
    );
    const source = snapshot.versions.get("routing-policy")!.id;
    const fork = publisher.federation.fork({
      versionIds: [source],
      scope: `team:${team}`,
      createdBy: "team-registry-alice",
    });
    const publication = publisher.federation.publish({
      teamId: team,
      versionIds: [fork.versions[source]!],
      scope: `team:${team}`,
      createdBy: "team-registry-alice",
    });
    const key = publisher.sharingTrust.createSigningKey(team, { createdBy: "team-registry-alice" });
    const signed = publisher.sharingTrust.signPublication(publication.id, {
      keyId: key.keyId,
      createdBy: "team-registry-alice",
    });
    const writer = publisher.sharingTrust.issueRegistryCredential({
      teamId: team,
      principalId: "team-registry-alice",
      actions: ["publish"],
      authorizedBy: "team-registry-alice",
    });
    const reader = publisher.sharingTrust.issueRegistryCredential({
      teamId: team,
      principalId: "team-registry-bob",
      actions: ["read"],
      authorizedBy: "team-registry-alice",
    });
    const server = createRegistryServer({
      store: publisher.sharingTrust.registryStore(),
      verify: (input) => publisher.sharingTrust.verify(input),
      authorize: (token, teamId, action) =>
        publisher.sharingTrust.authorizeRegistryRequest(token, teamId, action),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await new RegistryClient({ url, token: writer.token }).publish(signed);
      await expect(
        new RegistryClient({ url }).fetchPublication(signed.envelope.digest),
      ).rejects.toThrow("unavailable");
      const client = new RegistryClient({ url, token: reader.token });
      const downloaded = await client.fetchPublication(signed.envelope.digest);
      receiver.federation.createTeam(team, { createdBy: "team-registry-bob" });
      receiver.sharingTrust.trustKey({
        teamId: team,
        publisher: key.publisher,
        publicKey: key.publicKey,
        authorizedBy: "team-registry-bob",
      });
      const imported = receiver.federation.importBundle(downloaded, {
        createdBy: "team-registry-bob",
      });
      expect(receiver.storage.getImportSignatureRef(imported.id)).toBeTruthy();
      publisher.kernel.revokeAccess(
        `team:${team}`,
        "team-registry-bob",
        "read",
        "team-registry-alice",
      );
      await expect(client.fetchPublication(signed.envelope.digest)).rejects.toThrow("unavailable");
      publisher.kernel.grantAccess(
        `team:${team}`,
        "team-registry-bob",
        "read",
        "team-registry-alice",
      );
      expect(await client.fetchPublication(signed.envelope.digest)).toMatchObject({
        signature: signed.signature,
      });
      publisher.sharingTrust.revokeRegistryCredential(reader.credential.id, {
        authorizedBy: "team-registry-alice",
      });
      await expect(client.fetchPublication(signed.envelope.digest)).rejects.toThrow("unavailable");
      expect(
        receiver.storage.isSharedImportTrusted(imported.id, "team-registry-receiver-org"),
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("publishes, fetches, pins, imports and locally adopts a signed publication with live access controls", async () => {
    const publisher = federationOwnerInstance("registry-publisher-org", "registry-publisher");
    const receiver = federationOwnerInstance("registry-receiver-org", "registry-receiver");
    apps.push(publisher, receiver);
    installFederationCapability(publisher, "registry-publisher-org", "registry-publisher");
    installFederationCapability(receiver, "registry-receiver-org", "registry-receiver");
    const activeBeforePublish =
      publisher.kernel.getOrganism("registry-publisher-org")!.activeGenomeId;
    const activeBeforeReceive =
      receiver.kernel.getOrganism("registry-receiver-org")!.activeGenomeId;

    publisher.federation.createTeam("registry-team", { createdBy: "registry-publisher" });
    const policy = createChangedFilePolicyVersion(
      publisher,
      "registry-publisher-org",
      "registry-publisher",
    );
    const fork = publisher.federation.fork({
      versionIds: [policy.id],
      scope: "public",
      createdBy: "registry-publisher",
    });
    const publication = publisher.federation.publish({
      teamId: "registry-team",
      versionIds: [fork.versions[policy.id]!],
      scope: "public",
      createdBy: "registry-publisher",
    });
    const key = publisher.sharingTrust.createSigningKey("registry-team", {
      createdBy: "registry-publisher",
    });
    const signed = publisher.sharingTrust.signPublication(publication.id, {
      keyId: key.keyId,
      createdBy: "registry-publisher",
    });
    const credential = publisher.sharingTrust.issueRegistryCredential({
      teamId: "registry-team",
      principalId: "registry-publisher",
      actions: ["publish", "read"],
      authorizedBy: "registry-publisher",
    });
    expect(
      publisher.sharingTrust.authorizeRegistryRequest(credential.token, "registry-team", "publish"),
    ).toBe(true);

    const server = createRegistryServer({
      store: publisher.sharingTrust.registryStore(),
      verify: (input) => publisher.sharingTrust.verify(input),
      authorize: (token, team, action) =>
        publisher.sharingTrust.authorizeRegistryRequest(token, team, action),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const client = new RegistryClient({ url, token: credential.token });
      const first = await client.publish(signed);
      expect(first.result).toBe("created");
      expect((await client.publish(signed)).result).toBe("exists");
      expect(publisher.kernel.getOrganism("registry-publisher-org")!.activeGenomeId).toBe(
        activeBeforePublish,
      );
      expect(receiver.kernel.getOrganism("registry-receiver-org")!.activeGenomeId).toBe(
        activeBeforeReceive,
      );

      const downloaded = await new RegistryClient({ url }).fetchPublication(signed.envelope.digest);
      expect(downloaded).toMatchObject({ signature: signed.signature });
      expect(() =>
        receiver.federation.importBundle(downloaded, {
          createdBy: "registry-receiver",
        }),
      ).toThrow();
      receiver.sharingTrust.trustKey({
        teamId: key.teamId,
        publisher: key.publisher,
        publicKey: key.publicKey,
        authorizedBy: "registry-receiver",
      });
      const imported = receiver.federation.importBundle(downloaded, {
        createdBy: "registry-receiver",
      });
      expect(receiver.storage.getImportSignatureRef(imported.id)).toBeTruthy();
      expect(receiver.kernel.getOrganism("registry-receiver-org")!.activeGenomeId).toBe(
        activeBeforeReceive,
      );

      const importedVersionId = imported.versions[fork.versions[policy.id]!]!;
      const plan = federationHeldoutPlan("registry-receiver");
      const validation = receiver.evolution.registerValidationSet({
        familyIds: plan.cases.map((item) => item.familyId),
        devFamilyIds: [],
        sourceRef: "signed-registry-story",
        preparedBy: "registry-receiver",
        plan,
      });
      const candidate = receiver.federation.inherit(imported.id, {
        validationSetId: validation.id,
        versionIds: [importedVersionId],
        createdBy: "registry-receiver",
        hypothesis: "先验证导入策略，再由本地 operator 决定采用",
      });
      const evaluation = await receiver.evolution.evaluatePolicyCandidate(candidate.id);
      expect(evaluation.evaluation.verdict).toBe("eligible");
      expect(receiver.kernel.getOrganism("registry-receiver-org")!.activeGenomeId).toBe(
        activeBeforeReceive,
      );
      expect(
        receiver.evolution.promote(candidate.id, {
          authorizedBy: "registry-receiver",
        }).result,
      ).toBe("promoted");

      publisher.sharingTrust.revokeRegistryCredential(credential.credential.id, {
        authorizedBy: "registry-publisher",
      });
      expect(
        publisher.sharingTrust.authorizeRegistryRequest(credential.token, "registry-team", "read"),
      ).toBe(false);
      await expect(
        new RegistryClient({ url, token: credential.token }).publish(signed),
      ).rejects.toThrow();
      publisher.sharingTrust.revokeKey(key.keyId, { authorizedBy: "registry-publisher" });
      const revokedFetch = await fetch(`${url}/v1/publications/${signed.envelope.digest}`);
      expect(revokedFetch.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    const root = publisher.root;
    publisher.close();
    apps.splice(apps.indexOf(publisher), 1);
    const reopened = openInstance(root, {
      organismId: "registry-publisher-org",
      actorId: "registry-publisher",
    });
    apps.push(reopened);
    const persisted = reopened.sharingTrust.registryStore().get(signed.envelope.digest);
    expect(persisted?.signature).toBe(signed.signature);
    expect(() => reopened.sharingTrust.verify(signed)).toThrow();
  });
});
