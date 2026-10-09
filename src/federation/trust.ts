import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Clock, IdGen, Kernel } from "../kernel/index.ts";
import { canonicalJson, digestOf, type BlobStore } from "../storage/blobs.ts";
import type { Storage } from "../storage/store.ts";
import type { Federation } from "./index.ts";
import type { ShareEnvelope } from "./types.ts";
import { validateShareEnvelope } from "./package.ts";
import type { RegistryStore } from "./registry.ts";

export interface SignedShareEnvelope {
  format: "proteus-signed-share-v1";
  envelope: ShareEnvelope;
  signer: { keyId: string; teamId: string; publisher: string };
  signature: string;
}

export interface PublicationKey {
  organismId: string;
  keyId: string;
  teamId: string;
  publisher: string;
  publicKey: string;
  state: "active" | "revoked";
  localSigner: boolean;
  createdBy: string;
  createdAt: number;
}

export interface RegistryCredential {
  id: string;
  organismId: string;
  tokenDigest: string;
  teamId: string;
  principalId: string;
  actions: Array<"read" | "publish">;
  state: "active" | "revoked";
  createdBy: string;
  createdAt: number;
}

const signerSchema = z.strictObject({
  keyId: z.string().regex(/^[a-f0-9]{64}$/),
  teamId: z.string().min(1).max(256),
  publisher: z.string().min(1).max(256),
});
const signedSchema = z.strictObject({
  format: z.literal("proteus-signed-share-v1"),
  envelope: z.unknown(),
  signer: signerSchema,
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
});

function parsePublicKey(publicKey: string) {
  if (Buffer.byteLength(publicKey) > 4096 || !publicKey.startsWith("-----BEGIN PUBLIC KEY-----"))
    throw new Error("需要 Ed25519 SPKI 公钥");
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("只支持 Ed25519 公钥");
  return key;
}

export function publicationKeyId(publicKey: string): string {
  return createHash("sha256")
    .update(parsePublicKey(publicKey).export({ type: "spki", format: "der" }))
    .digest("hex");
}

function signatureMessage(
  input: Pick<SignedShareEnvelope, "format" | "envelope" | "signer">,
): Buffer {
  return Buffer.from(
    canonicalJson({ domain: input.format, digest: input.envelope.digest, ...input.signer }),
  );
}

/** Authentication is pinned externally: no key embedded in an untrusted package can grant trust. */
export function verifySignedPublication(input: unknown, publicKey: string): SignedShareEnvelope {
  const parsed = signedSchema.parse(input);
  const envelope = validateShareEnvelope(parsed.envelope);
  if (
    parsed.signer.keyId !== publicationKeyId(publicKey) ||
    parsed.signer.teamId !== envelope.bundle.teamId ||
    parsed.signer.publisher !== envelope.bundle.publisher
  )
    throw new Error("签名身份与公钥或发布身份不一致");
  const signed: SignedShareEnvelope = { ...parsed, envelope };
  if (Buffer.from(signed.signature, "base64").toString("base64") !== signed.signature)
    throw new Error("发布签名编码不规范");
  if (
    !verify(
      null,
      signatureMessage(signed),
      parsePublicKey(publicKey),
      Buffer.from(signed.signature, "base64"),
    )
  )
    throw new Error("发布签名无效");
  return signed;
}

/** Pins are receiver decisions; they authenticate provenance, never evaluation or adoption. */
export class PublicationTrust {
  private readonly deps: {
    kernel: Kernel;
    storage: Storage;
    blobs: BlobStore;
    federation: Federation;
    root: string;
    organismId: string;
    actorId: string;
    clock: Clock;
    ids: IdGen;
  };
  constructor(deps: PublicationTrust["deps"]) {
    this.deps = deps;
  }

  private actor(actor: string, action: "operate" | "manage" = "operate"): void {
    this.deps.kernel.assertOrganismAccess(this.deps.organismId, this.deps.actorId, action);
    this.deps.kernel.assertOrganismAccess(this.deps.organismId, actor, action);
  }

  createSigningKey(teamId: string, opts: { createdBy: string }): PublicationKey {
    this.actor(opts.createdBy, "manage");
    this.deps.kernel.assertScopeAccess(`team:${teamId}`, opts.createdBy, "publish");
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const keyId = publicationKeyId(publicKey);
    const key: PublicationKey = {
      organismId: this.deps.organismId,
      keyId,
      teamId,
      publisher: opts.createdBy,
      publicKey,
      state: "active",
      localSigner: true,
      createdBy: opts.createdBy,
      createdAt: this.deps.clock.now(),
    };
    const dir = join(this.deps.root, "keys");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${keyId}.pem`);
    writeFileSync(path, pair.privateKey.export({ format: "pem", type: "pkcs8" }), {
      mode: 0o600,
      flag: "wx",
    });
    try {
      this.deps.storage.tx(() => {
        this.actor(opts.createdBy, "manage");
        this.deps.kernel.assertScopeAccess(`team:${teamId}`, opts.createdBy, "publish");
        this.deps.storage.insertPublicationKey(key);
        this.event("publication.key.created", { keyId, teamId, publisher: opts.createdBy });
      });
    } catch (error) {
      unlinkSync(path);
      throw error;
    }
    return key;
  }

  trustKey(opts: {
    teamId: string;
    publisher: string;
    publicKey: string;
    authorizedBy: string;
  }): PublicationKey {
    this.actor(opts.authorizedBy, "manage");
    signerSchema.omit({ keyId: true }).parse({ teamId: opts.teamId, publisher: opts.publisher });
    const normalized = parsePublicKey(opts.publicKey)
      .export({ format: "pem", type: "spki" })
      .toString();
    const keyId = publicationKeyId(normalized);
    return this.deps.storage.tx(() => {
      this.actor(opts.authorizedBy, "manage");
      const existing = this.deps.storage.getPublicationKey(this.deps.organismId, keyId);
      if (existing) {
        if (existing.state !== "active") throw new Error("已撤销的公钥不能重新信任；须换用新密钥");
        if (existing.teamId !== opts.teamId || existing.publisher !== opts.publisher)
          throw new Error("公钥已绑定不同发布身份");
        return existing;
      }
      const key: PublicationKey = {
        organismId: this.deps.organismId,
        keyId,
        teamId: opts.teamId,
        publisher: opts.publisher,
        publicKey: normalized,
        state: "active",
        localSigner: false,
        createdBy: opts.authorizedBy,
        createdAt: this.deps.clock.now(),
      };
      this.deps.storage.insertPublicationKey(key);
      this.event("publication.key.trusted", {
        keyId,
        teamId: opts.teamId,
        publisher: opts.publisher,
      });
      return key;
    });
  }

  revokeKey(keyId: string, opts: { authorizedBy: string }): PublicationKey {
    this.actor(opts.authorizedBy, "manage");
    return this.deps.storage.tx(() => {
      this.actor(opts.authorizedBy, "manage");
      const key = this.deps.storage.getPublicationKey(this.deps.organismId, keyId);
      if (!key) throw new Error("当前个体未登记此公钥");
      this.deps.storage.revokePublicationKey(this.deps.organismId, keyId);
      this.event("publication.key.revoked", { keyId, authorizedBy: opts.authorizedBy });
      return { ...key, state: "revoked" };
    });
  }

  signPublication(
    publicationId: string,
    opts: { keyId: string; createdBy: string },
  ): SignedShareEnvelope {
    this.actor(opts.createdBy);
    const key = this.deps.storage.getPublicationKey(this.deps.organismId, opts.keyId);
    if (!key?.localSigner || key.state !== "active" || key.publisher !== opts.createdBy)
      throw new Error("当前主体没有有效本地签名密钥");
    this.deps.kernel.assertScopeAccess(`team:${key.teamId}`, opts.createdBy, "publish");
    const envelope = this.deps.federation.exportPublication(publicationId, opts.createdBy);
    if (envelope.bundle.teamId !== key.teamId || envelope.bundle.publisher !== key.publisher)
      throw new Error("密钥不属于此发布身份");
    const input = {
      format: "proteus-signed-share-v1" as const,
      envelope,
      signer: { keyId: key.keyId, teamId: key.teamId, publisher: key.publisher },
    };
    const privateKey = createPrivateKey(
      readFileSync(join(this.deps.root, "keys", `${key.keyId}.pem`)),
    );
    if (
      publicationKeyId(
        createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString(),
      ) !== key.keyId
    )
      throw new Error("本地密钥文件与登记身份不符");
    return {
      ...input,
      signature: sign(null, signatureMessage(input), privateKey).toString("base64"),
    };
  }

  verify(input: unknown): SignedShareEnvelope {
    this.actor(this.deps.actorId);
    const parsed = signedSchema.parse(input);
    const key = this.deps.storage.getPublicationKey(this.deps.organismId, parsed.signer.keyId);
    if (
      !key ||
      key.state !== "active" ||
      key.teamId !== parsed.signer.teamId ||
      key.publisher !== parsed.signer.publisher
    )
      throw new Error("发布来源未信任或已撤销");
    return verifySignedPublication(input, key.publicKey);
  }

  issueRegistryCredential(opts: {
    teamId: string;
    principalId: string;
    actions: Array<"read" | "publish">;
    authorizedBy: string;
  }): { credential: Omit<RegistryCredential, "tokenDigest">; token: string } {
    this.actor(opts.authorizedBy, "manage");
    if (!opts.actions.length || opts.actions.some((a) => a !== "read" && a !== "publish"))
      throw new Error("registry 权限只能为 read/publish");
    return this.deps.storage.tx(() => {
      this.actor(opts.authorizedBy, "manage");
      this.deps.kernel.assertScopeAccess(`team:${opts.teamId}`, opts.authorizedBy, "manage");
      for (const action of opts.actions)
        this.deps.kernel.assertScopeAccess(`team:${opts.teamId}`, opts.principalId, action);
      const token = randomBytes(32).toString("base64url");
      const credential: RegistryCredential = {
        id: this.deps.ids.next(),
        organismId: this.deps.organismId,
        tokenDigest: digestOf(token),
        teamId: opts.teamId,
        principalId: opts.principalId,
        actions: [...new Set(opts.actions)],
        state: "active",
        createdBy: opts.authorizedBy,
        createdAt: this.deps.clock.now(),
      };
      this.deps.storage.insertRegistryCredential(credential);
      this.event("registry.credential.created", {
        credentialId: credential.id,
        teamId: opts.teamId,
        principalId: opts.principalId,
        actions: credential.actions,
      });
      const { tokenDigest: _secretHash, ...metadata } = credential;
      return { credential: metadata, token };
    });
  }

  revokeRegistryCredential(id: string, opts: { authorizedBy: string }): void {
    this.actor(opts.authorizedBy, "manage");
    this.deps.storage.tx(() => {
      this.actor(opts.authorizedBy, "manage");
      const credential = this.deps.storage.getRegistryCredential(this.deps.organismId, id);
      if (!credential) throw new Error("registry 凭据不存在");
      this.deps.kernel.assertScopeAccess(`team:${credential.teamId}`, opts.authorizedBy, "manage");
      this.deps.storage.revokeRegistryCredential(id);
      this.event("registry.credential.revoked", {
        credentialId: id,
        authorizedBy: opts.authorizedBy,
      });
    });
  }

  authorizeRegistryRequest(token: string, teamId: string, action: "read" | "publish"): boolean {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const credential = this.deps.storage.findRegistryCredential(
      this.deps.organismId,
      digestOf(token),
    );
    if (
      !credential ||
      credential.state !== "active" ||
      credential.teamId !== teamId ||
      !credential.actions.includes(action)
    )
      return false;
    try {
      this.actor(this.deps.actorId);
      this.deps.kernel.assertScopeAccess(`team:${teamId}`, credential.principalId, action);
      return true;
    } catch {
      return false;
    }
  }

  registryStore(): RegistryStore {
    this.actor(this.deps.actorId);
    return {
      get: (digest) => {
        const ref = this.deps.storage.getRegistryPackageRef(this.deps.organismId, digest);
        return ref ? (JSON.parse(this.deps.blobs.read(ref)) as SignedShareEnvelope) : undefined;
      },
      put: (input, stillAuthorized) =>
        this.deps.storage.tx(() => {
          if (stillAuthorized && !stillAuthorized())
            throw Object.assign(new Error("registry 权限已撤销"), { code: "forbidden" });
          const pkg = this.verify(input);
          const previous = this.deps.storage.getRegistryPackageRef(
            this.deps.organismId,
            pkg.envelope.digest,
          );
          if (previous) {
            if (this.deps.blobs.read(previous) !== canonicalJson(pkg))
              throw new Error("registry 已保存不同签名对象，不能覆盖");
            return "exists";
          }
          const ref = this.deps.blobs.write(canonicalJson(pkg)).ref;
          this.deps.storage.insertRegistryPackage(this.deps.organismId, pkg, ref);
          this.event("registry.publication.stored", {
            digest: pkg.envelope.digest,
            keyId: pkg.signer.keyId,
          });
          return "created";
        }),
    };
  }

  private event(type: string, payload: Record<string, unknown>): void {
    this.deps.storage.appendEvent({
      streamId: `trust-${this.deps.organismId}`,
      type,
      payload,
      organismId: this.deps.organismId,
      occurredAt: this.deps.clock.now(),
    });
  }
}
