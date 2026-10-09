import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { openInstance } from "../../src/app/instance.ts";
import { REPO_ROOT, tempInstanceRoot } from "../helpers.ts";

const execute = promisify(execFile);
const cliPath = join(REPO_ROOT, "src/app/cli.ts");
async function cli<T>(home: string, org: string, actor: string, args: string[]): Promise<T> {
  const result = await execute(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      cliPath,
      ...args,
      "--home",
      home,
      "--organism",
      org,
      "--actor",
      actor,
      "--json",
    ],
    { cwd: REPO_ROOT },
  );
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as T;
}
function ready(server: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("registry CLI startup timeout")), 10_000);
    server.once("error", reject);
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`registry CLI exited ${code}`));
    });
    server.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      try {
        const value = JSON.parse(output) as { registry: string };
        clearTimeout(timer);
        resolve(value.registry);
      } catch {
        /* Wait for the complete JSON startup record. */
      }
    });
  });
}

it(
  "CLI exchanges signed publications across homes and keeps credentials out of output",
  { timeout: 30_000 },
  async () => {
    const homeA = tempInstanceRoot();
    const homeB = tempInstanceRoot();
    const pubkeyFile = join(homeA, "public.pem");
    const tokenFile = join(homeA, "registry.token");
    const signedFile = join(homeA, "signed.json");
    const init = await cli<{ versions: Array<{ artifactId: string; versionId: string }> }>(
      homeA,
      "org-a",
      "alice",
      ["init"],
    );
    await cli(homeB, "org-b", "bob", ["init"]);
    await cli(homeA, "org-a", "alice", ["team-create", "contributors"]);
    const source = init.versions.find((v) => v.artifactId === "stats-rule")!.versionId;
    const fork = await cli<{ versions: Record<string, string> }>(homeA, "org-a", "alice", [
      "share-fork",
      "--versions",
      source,
      "--scope",
      "public",
    ]);
    const publication = await cli<{ id: string; bundleDigest: string }>(homeA, "org-a", "alice", [
      "publish",
      "--team",
      "contributors",
      "--versions",
      fork.versions[source]!,
      "--scope",
      "public",
    ]);
    const key = await cli<{ keyId: string }>(homeA, "org-a", "alice", [
      "sharing-key-create",
      "contributors",
      "--public-out",
      pubkeyFile,
    ]);
    const credential = await cli<{ id: string }>(homeA, "org-a", "alice", [
      "registry",
      "token-create",
      "--team",
      "contributors",
      "--principal",
      "alice",
      "--permission",
      "read",
      "publish",
      "--out",
      tokenFile,
    ]);
    const token = readFileSync(tokenFile, "utf8").trim();
    expect(JSON.stringify(credential)).not.toContain(token);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    await cli(homeA, "org-a", "alice", [
      "publication-sign",
      publication.id,
      "--key",
      key.keyId,
      "--out",
      signedFile,
    ]);
    const server = spawn(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        cliPath,
        "registry",
        "serve",
        "--port",
        "0",
        "--home",
        homeA,
        "--organism",
        "org-a",
        "--actor",
        "alice",
        "--json",
      ],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    server.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      const url = await ready(server);
      const args = [
        "registry",
        "publish",
        publication.id,
        "--key",
        key.keyId,
        "--registry",
        url,
        "--token-file",
        tokenFile,
      ];
      expect(await cli(homeA, "org-a", "alice", args)).toMatchObject({
        result: "created",
        digest: publication.bundleDigest,
      });
      expect(await cli(homeA, "org-a", "alice", args)).toMatchObject({ result: "exists" });
      await expect(
        cli(homeB, "org-b", "bob", [
          "registry",
          "import",
          publication.bundleDigest,
          "--registry",
          url,
        ]),
      ).rejects.toThrow();
      await cli(homeB, "org-b", "bob", [
        "sharing-key-trust",
        "contributors",
        "--publisher",
        "alice",
        "--public-key",
        pubkeyFile,
      ]);
      const imported = await cli<{ id: string }>(homeB, "org-b", "bob", [
        "registry",
        "import",
        publication.bundleDigest,
        "--registry",
        url,
      ]);
      expect(await cli(homeB, "org-b", "bob", ["share-import", signedFile])).toMatchObject({
        id: imported.id,
      });
      await cli(homeA, "org-a", "alice", ["registry", "token-revoke", credential.id]);
      await expect(cli(homeA, "org-a", "alice", args)).rejects.toThrow();
      await cli(homeB, "org-b", "bob", ["sharing-key-revoke", key.keyId]);
      await expect(
        cli(homeB, "org-b", "bob", [
          "registry",
          "import",
          publication.bundleDigest,
          "--registry",
          url,
        ]),
      ).rejects.toThrow();
      const app = openInstance(homeB, { organismId: "org-b", actorId: "bob" });
      try {
        expect(app.storage.getImportSignatureRef(imported.id)).toBeTruthy();
        expect(app.storage.listPromotions("org-b", 20)).toHaveLength(0);
      } finally {
        app.close();
      }
    } finally {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    expect(stderr).toBe("");
  },
);
