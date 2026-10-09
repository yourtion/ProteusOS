import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRegistryServer, RegistryClient } from "../federation/registry.ts";
import type { AccessAction } from "../kernel/types.ts";
import type { CommonOpts } from "./commands.ts";
import { openInstance, resolveInstanceRoot } from "./instance.ts";
import { ORGANISM_ID, PRINCIPAL_ID } from "./seed.ts";

function open(opts: CommonOpts) {
  return openInstance(resolveInstanceRoot(opts.home), {
    organismId: opts.organism,
    actorId: opts.actor,
  });
}
function print(record: unknown) {
  console.log(JSON.stringify(record, null, 2));
}
function actor(opts: CommonOpts) {
  return opts.actor ?? PRINCIPAL_ID;
}

export async function accessCommand(
  kind: "grant" | "revoke",
  scope: string,
  principalId: string,
  opts: CommonOpts & { permission: string },
): Promise<void> {
  if (
    !/^(team|organism):.+$/.test(scope) ||
    !["read", "operate", "promote", "publish", "manage"].includes(opts.permission)
  )
    throw new Error(
      "scope 必须为 team/organism，permission 必须为 read/operate/promote/publish/manage",
    );
  if (
    (scope.startsWith("team:") && !["read", "publish", "manage"].includes(opts.permission)) ||
    (scope.startsWith("organism:") && opts.permission === "publish")
  )
    throw new Error("权限与目标 scope 不匹配");
  const app = open(opts);
  try {
    app.storage.tx(() => {
      app.kernel.assertOrganismAccess(opts.organism ?? ORGANISM_ID, actor(opts));
      const action = opts.permission as AccessAction;
      const changed =
        kind === "revoke"
          ? app.kernel.revokeAccess(scope, principalId, action, actor(opts))
          : (app.kernel.grantAccess(scope, principalId, action, actor(opts)), true);
      app.storage.appendEvent({
        streamId: `access-${scope}`,
        type: `access.${kind === "grant" ? "granted" : "revoked"}`,
        payload: { scope, principalId, action, authorizedBy: actor(opts), changed },
        organismId: opts.organism ?? ORGANISM_ID,
        occurredAt: Date.now(),
      });
      print({ scope, principalId, permission: action, operation: kind, changed });
    });
  } finally {
    app.close();
  }
}

export async function keyCreateCommand(
  teamId: string,
  opts: CommonOpts & { publicOut: string },
): Promise<void> {
  const app = open(opts);
  try {
    const key = app.sharingTrust.createSigningKey(teamId, { createdBy: actor(opts) });
    writeFileSync(resolve(opts.publicOut), key.publicKey, { mode: 0o644, flag: "wx" });
    print(key);
  } finally {
    app.close();
  }
}

export async function keyTrustCommand(
  teamId: string,
  opts: CommonOpts & { publisher: string; publicKey: string },
): Promise<void> {
  const app = open(opts);
  try {
    print(
      app.sharingTrust.trustKey({
        teamId,
        publisher: opts.publisher,
        publicKey: readFileSync(resolve(opts.publicKey), "utf8"),
        authorizedBy: actor(opts),
      }),
    );
  } finally {
    app.close();
  }
}

export async function keyRevokeCommand(keyId: string, opts: CommonOpts): Promise<void> {
  const app = open(opts);
  try {
    print(app.sharingTrust.revokeKey(keyId, { authorizedBy: actor(opts) }));
  } finally {
    app.close();
  }
}

export async function publicationSignCommand(
  publicationId: string,
  opts: CommonOpts & { key: string; out: string },
): Promise<void> {
  const app = open(opts);
  try {
    const pkg = app.sharingTrust.signPublication(publicationId, {
      keyId: opts.key,
      createdBy: actor(opts),
    });
    writeFileSync(resolve(opts.out), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
    print({ digest: pkg.envelope.digest, signer: pkg.signer, out: resolve(opts.out) });
  } finally {
    app.close();
  }
}

export async function registryCredentialCommand(
  opts: CommonOpts & { team: string; principal: string; permission: string[]; out: string },
): Promise<void> {
  if (!opts.permission.length || opts.permission.some((p) => p !== "read" && p !== "publish"))
    throw new Error("registry permission 必须为 read/publish");
  const app = open(opts);
  try {
    const issued = app.sharingTrust.issueRegistryCredential({
      teamId: opts.team,
      principalId: opts.principal,
      actions: opts.permission as Array<"read" | "publish">,
      authorizedBy: actor(opts),
    });
    try {
      writeFileSync(resolve(opts.out), `${issued.token}\n`, { mode: 0o600, flag: "wx" });
    } catch (error) {
      app.sharingTrust.revokeRegistryCredential(issued.credential.id, {
        authorizedBy: actor(opts),
      });
      throw error;
    }
    print({ ...issued.credential, tokenFile: resolve(opts.out) });
  } finally {
    app.close();
  }
}

export async function registryRevokeCommand(id: string, opts: CommonOpts): Promise<void> {
  const app = open(opts);
  try {
    app.sharingTrust.revokeRegistryCredential(id, { authorizedBy: actor(opts) });
    print({ id, state: "revoked" });
  } finally {
    app.close();
  }
}

function client(opts: { registry: string; tokenFile?: string }): RegistryClient {
  return new RegistryClient({
    url: opts.registry,
    token: opts.tokenFile ? readFileSync(resolve(opts.tokenFile), "utf8").trim() : undefined,
  });
}

export async function registryPublishCommand(
  publicationId: string,
  opts: CommonOpts & { key: string; registry: string; tokenFile: string },
): Promise<void> {
  const app = open(opts);
  try {
    const pkg = app.sharingTrust.signPublication(publicationId, {
      keyId: opts.key,
      createdBy: actor(opts),
    });
    print(await client(opts).publish(pkg));
  } finally {
    app.close();
  }
}

export async function registryImportCommand(
  digest: string,
  opts: CommonOpts & { registry: string; tokenFile?: string },
): Promise<void> {
  const app = open(opts);
  try {
    const pkg = await client(opts).fetchPublication(digest);
    // Even a correctly authenticated transport cannot establish publication trust.
    app.sharingTrust.verify(pkg);
    print(app.federation.importBundle(pkg, { createdBy: actor(opts) }));
  } finally {
    app.close();
  }
}

export async function registryServeCommand(opts: CommonOpts & { port: string }): Promise<void> {
  const port = Number(opts.port);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error("port 必须是 0–65535 整数");
  const app = open(opts);
  const owner = opts.organism ?? ORGANISM_ID;
  try {
    app.kernel.assertOrganismAccess(owner, actor(opts), "manage");
    const server = createRegistryServer({
      store: app.sharingTrust.registryStore(),
      verify: (input) => app.sharingTrust.verify(input),
      authorize: (token, team, action) =>
        app.sharingTrust.authorizeRegistryRequest(token, team, action),
    });
    await new Promise<void>((resolveStart, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolveStart();
      });
    });
    const address = server.address();
    print({
      registry: typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : null,
      organismId: owner,
    });
    await new Promise<void>((resolveStop, reject) => {
      const stop = () => {
        server.close();
        server.closeIdleConnections();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      const cleanup = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      };
      server.once("close", () => {
        cleanup();
        resolveStop();
      });
      server.once("error", (error) => {
        cleanup();
        reject(error);
      });
    });
  } finally {
    app.close();
  }
}
