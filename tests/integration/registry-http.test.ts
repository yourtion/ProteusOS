import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRegistryServer,
  RegistryClient,
  type RegistryStore,
} from "../../src/federation/registry.js";
import type { SignedShareEnvelope } from "../../src/federation/trust.ts";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
type FixturePackage = {
  envelope: { digest: string; bundle: { teamId: string; scope: string } };
  signer: { keyId: string; teamId: string; publisher: string };
  signature: string;
};
const fixture = (digest = digestA, scope = "public"): FixturePackage => ({
  envelope: { digest, bundle: { teamId: "team-a", scope } },
  signer: { keyId: "key-a", teamId: "team-a", publisher: "publisher-a" },
  signature: "signed-fixture",
});

function memoryStore(): RegistryStore {
  const items = new Map<string, SignedShareEnvelope>();
  return {
    get: (digest) => items.get(digest),
    put: (pkg) => {
      const digest = pkg.envelope.digest;
      if (items.has(digest)) return "exists";
      items.set(digest, pkg);
      return "created";
    },
  };
}

describe("HTTP registry contract", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    const cleanup = close;
    close = undefined;
    await cleanup?.();
  });

  async function start(options: { maxBodyBytes?: number; signerEnabled?: () => boolean } = {}) {
    const store = memoryStore();
    const server = createRegistryServer({
      store,
      maxBodyBytes: options.maxBodyBytes,
      verify(input) {
        if (!options.signerEnabled?.() && options.signerEnabled) throw new Error("revoked");
        if (
          !input ||
          typeof input !== "object" ||
          (input as FixturePackage).signature !== "signed-fixture"
        )
          throw new Error("invalid signature");
        return input as SignedShareEnvelope;
      },
      authorize(token, teamId, action) {
        return (
          (token === "publisher-token" && teamId === "team-a" && action === "publish") ||
          (token === "reader-token" && teamId === "team-a" && action === "read")
        );
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    close = () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    return { url: `http://127.0.0.1:${address.port}`, store };
  }

  it("requires publish authorization, then serves anonymous reads and immutable idempotent writes", async () => {
    const { url } = await start();
    const pkg = fixture();
    const bare = new RegistryClient({ url });
    await expect(bare.publish(pkg as SignedShareEnvelope)).rejects.toThrow(
      "Registry rejected publication",
    );
    const client = new RegistryClient({ url, token: "publisher-token" });
    expect(await client.publish(pkg as SignedShareEnvelope)).toEqual({
      digest: digestA,
      result: "created",
    });
    expect(await client.publish(pkg as SignedShareEnvelope)).toEqual({
      digest: digestA,
      result: "exists",
    });
    const anonymous = new RegistryClient({ url });
    expect(await anonymous.fetchPublication(digestA)).toEqual(pkg);
    expect(
      await new RegistryClient({ url, token: "unrelated-token" }).fetchPublication(digestA),
    ).toEqual(pkg);
  });

  it("conceals team-only reads from unauthorized tokens while allowing an authorized reader", async () => {
    const { url, store } = await start();
    store.put(fixture(digestA, "team:team-a") as SignedShareEnvelope);
    await expect(new RegistryClient({ url }).fetchPublication(digestA)).rejects.toThrow(
      "Publication is unavailable",
    );
    await expect(
      new RegistryClient({ url, token: "wrong-token" }).fetchPublication(digestA),
    ).rejects.toThrow("Publication is unavailable");
    expect(
      await new RegistryClient({ url, token: "reader-token" }).fetchPublication(digestA),
    ).toEqual(fixture(digestA, "team:team-a"));
  });

  it("checks signature validity on publication and rechecks live signer trust on each read", async () => {
    let enabled = true;
    const { url, store } = await start({ signerEnabled: () => enabled });
    const publisher = new RegistryClient({ url, token: "publisher-token" });
    await expect(
      publisher.publish({ ...fixture(), signature: "bad" } as SignedShareEnvelope),
    ).rejects.toThrow("Registry rejected publication");
    store.put(fixture(digestA, "team:team-a") as SignedShareEnvelope);
    expect(
      await new RegistryClient({ url, token: "reader-token" }).fetchPublication(digestA),
    ).toEqual(fixture(digestA, "team:team-a"));
    enabled = false;
    await expect(
      new RegistryClient({ url, token: "reader-token" }).fetchPublication(digestA),
    ).rejects.toThrow("Publication is unavailable");
  });

  it("rejects route and body digest mismatch and oversized package bodies", async () => {
    const { url } = await start({ maxBodyBytes: 300 });
    const response = await fetch(`${url}/v1/publications/${digestA}`, {
      method: "PUT",
      headers: { authorization: "Bearer publisher-token", "content-type": "application/json" },
      body: JSON.stringify({ ...fixture(digestB), filler: "x".repeat(500) }),
    });
    expect(response.status).toBe(413);
    const mismatch = await fetch(`${url}/v1/publications/${digestA}`, {
      method: "PUT",
      headers: { authorization: "Bearer publisher-token", "content-type": "application/json" },
      body: JSON.stringify(fixture(digestB)),
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual({ error: "digest_mismatch" });
  });

  it("validates registry URL schemes and rejects mismatched download content", async () => {
    expect(() => new RegistryClient({ url: "http://example.com" })).toThrow("HTTPS");
    expect(() => new RegistryClient({ url: "https://user:secret@example.com" })).toThrow("HTTPS");
    const mismatchedFetch: typeof fetch = async () =>
      new Response(JSON.stringify(fixture(digestB)), { status: 200 });
    const client = new RegistryClient({ url: "https://registry.example", fetch: mismatchedFetch });
    await expect(client.fetchPublication(digestA)).rejects.toThrow("mismatched publication");
  });

  it("uses redirect:error, times out across response reads, and never retries writes", async () => {
    let calls = 0;
    let redirectMode: string | undefined;
    const failingFetch: typeof fetch = async (_input, init) => {
      calls += 1;
      redirectMode = init?.redirect;
      throw new Error("redirect or transport failure");
    };
    const client = new RegistryClient({
      url: "https://registry.example",
      token: "secret-token",
      fetch: failingFetch,
    });
    await expect(client.publish(fixture() as SignedShareEnvelope)).rejects.toThrow(
      "Registry request failed",
    );
    expect(redirectMode).toBe("error");
    expect(calls).toBe(1);

    let bodyReadSignal: AbortSignal | undefined;
    const slowFetch: typeof fetch = async (_input, init) => {
      bodyReadSignal = init?.signal as AbortSignal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            bodyReadSignal?.addEventListener("abort", () => controller.error(new Error("aborted")));
          },
        }),
        { status: 200 },
      );
    };
    const timedClient = new RegistryClient({
      url: "https://registry.example",
      timeoutMs: 5,
      fetch: slowFetch,
    });
    await expect(timedClient.fetchPublication(digestA)).rejects.toThrow(
      "Invalid registry response",
    );
    expect(bodyReadSignal?.aborted).toBe(true);
  });
});
