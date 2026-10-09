import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { SignedShareEnvelope } from "./trust.ts";

export type RegistryStore = {
  get(digest: string): SignedShareEnvelope | undefined;
  put(pkg: SignedShareEnvelope, stillAuthorized?: () => boolean): "created" | "exists";
};

export type RegistryServerOptions = {
  store: RegistryStore;
  verify: (input: unknown) => SignedShareEnvelope;
  authorize: (token: string, teamId: string, action: "read" | "publish") => boolean;
  maxBodyBytes?: number;
};

const DEFAULT_MAX_BODY_BYTES = 16_000_000;
const DIGEST_RE = /^[a-f0-9]{64}$/i;

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

function bearer(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  const match = typeof value === "string" ? /^Bearer ([^\s]+)$/.exec(value) : null;
  return match?.[1];
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
      req.resume();
    };
    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes)
        return fail(Object.assign(new Error("too_large"), { code: "too_large" }));
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    req.on("aborted", () => {
      if (settled) return;
      settled = true;
      reject(new Error("aborted"));
    });
  });
}

function routeDigest(url: string): string | undefined {
  const match = /^\/v1\/publications\/([^/]+)$/.exec(url);
  return match?.[1];
}

export function createRegistryServer(options: RegistryServerOptions): Server {
  const maxBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid maxBodyBytes");

  const server = createServer(async (req, res) => {
    const digest = routeDigest(req.url ?? "");
    if (!digest) return json(res, 404, { error: "not_found" });
    if (!DIGEST_RE.test(digest)) return json(res, 400, { error: "invalid_digest" });

    if (req.method === "PUT") {
      const token = bearer(req);
      if (!token) return json(res, 401, { error: "unauthorized" });
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
        return json(res, 415, { error: "unsupported_media_type" });
      }
      let raw: Buffer;
      try {
        raw = await readBody(req, maxBytes);
      } catch (error) {
        return json(res, (error as { code?: string }).code === "too_large" ? 413 : 400, {
          error:
            (error as { code?: string }).code === "too_large"
              ? "payload_too_large"
              : "invalid_request",
        });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        return json(res, 400, { error: "invalid_package" });
      }
      let pkg: SignedShareEnvelope;
      try {
        pkg = options.verify(parsed);
      } catch {
        return json(res, 400, { error: "invalid_package" });
      }
      if (!pkg || pkg.envelope?.digest?.toLowerCase() !== digest.toLowerCase()) {
        return json(res, 400, { error: "digest_mismatch" });
      }
      let allowed = false;
      try {
        allowed = options.authorize(token, pkg.envelope.bundle.teamId, "publish");
      } catch {
        allowed = false;
      }
      if (!allowed) return json(res, 403, { error: "forbidden" });
      try {
        const result = options.store.put(pkg, () =>
          options.authorize(token, pkg.envelope.bundle.teamId, "publish"),
        );
        return json(res, result === "created" ? 201 : 200, { digest, result });
      } catch (error) {
        if ((error as { code?: string })?.code === "forbidden")
          return json(res, 403, { error: "forbidden" });
        return json(res, 500, { error: "registry_error" });
      }
    }

    if (req.method === "GET") {
      let pkg: SignedShareEnvelope | undefined;
      try {
        pkg = options.store.get(digest);
      } catch {
        return json(res, 500, { error: "registry_error" });
      }
      if (!pkg) return json(res, 404, { error: "not_found" });
      // Verify on every read so signer revocation is reflected immediately.
      try {
        pkg = options.verify(pkg);
      } catch {
        return json(res, 404, { error: "not_found" });
      }
      const token = bearer(req);
      if (pkg.envelope.bundle.scope !== "public") {
        if (!token) return json(res, 404, { error: "not_found" });
        let allowed = false;
        try {
          allowed = options.authorize(token, pkg.envelope.bundle.teamId, "read");
        } catch {
          allowed = false;
        }
        if (!allowed) return json(res, 404, { error: "not_found" });
      }
      return json(res, 200, pkg);
    }
    res.setHeader("allow", "GET, PUT");
    return json(res, 405, { error: "method_not_allowed" });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export type RegistryClientOptions = {
  url: string;
  token?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  fetch?: typeof globalThis.fetch;
};

function validateBaseUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid registry URL");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "Registry URL must use HTTPS (HTTP is allowed on loopback) and contain no credentials, path prefix, query, or fragment",
    );
  }
  return url;
}

async function boundedResponse(response: Response, limit: number): Promise<Buffer> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Registry response too large");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Registry response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export class RegistryClient {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly options: RegistryClientOptions;

  constructor(options: RegistryClientOptions) {
    this.options = options;
    this.baseUrl = validateBaseUrl(options.url);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      !Number.isSafeInteger(this.maxBodyBytes) ||
      this.maxBodyBytes < 1
    ) {
      throw new Error("Invalid registry client limits");
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async publish(
    pkg: SignedShareEnvelope,
  ): Promise<{ digest: string; result: "created" | "exists" }> {
    const digest = pkg?.envelope?.digest;
    if (!digest || !DIGEST_RE.test(digest)) throw new Error("Invalid publication digest");
    const body = JSON.stringify(pkg);
    if (Buffer.byteLength(body) > this.maxBodyBytes)
      throw new Error("Publication exceeds configured size limit");
    const response = await this.request(digest, "PUT", body);
    const data = await this.readJson(response);
    if (
      !response.ok ||
      (data.result !== "created" && data.result !== "exists") ||
      data.digest !== digest
    ) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Registry rejected publication");
    }
    return { digest, result: data.result };
  }

  async fetchPublication(digest: string): Promise<unknown> {
    if (!DIGEST_RE.test(digest)) throw new Error("Invalid publication digest");
    const response = await this.request(digest, "GET");
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Publication is unavailable");
    }
    const data = await this.readJson(response);
    const envelope = isRecord(data.envelope) ? data.envelope : undefined;
    const returnedDigest = envelope?.digest;
    if (
      typeof returnedDigest !== "string" ||
      returnedDigest.toLowerCase() !== digest.toLowerCase()
    ) {
      throw new Error("Registry returned a mismatched publication");
    }
    return data;
  }

  private async request(digest: string, method: "GET" | "PUT", body?: string): Promise<Response> {
    const url = new URL(`/v1/publications/${digest}`, this.baseUrl);
    try {
      return await this.fetchImpl(url, {
        method,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
        },
      });
    } catch {
      throw new Error("Registry request failed");
    }
  }

  private async readJson(response: Response): Promise<Record<string, unknown>> {
    let bytes: Buffer;
    try {
      bytes = await boundedResponse(response, this.maxBodyBytes);
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch {
      throw new Error("Invalid registry response");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
