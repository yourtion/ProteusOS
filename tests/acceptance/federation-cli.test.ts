import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { openInstance } from "../../src/app/instance.ts";
import { REPO_ROOT, tempInstanceRoot } from "../helpers.ts";

const cliPath = fileURLToPath(new URL("../../src/app/cli.ts", import.meta.url));
const home = tempInstanceRoot();
const exportedEnvelope = join(home, "team-share.json");

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", cliPath, ...args, "--home", home, "--json"],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function cliJson<T>(args: string[]): T {
  const result = cli(args);
  if (result.status !== 0) throw new Error(`CLI failed (${result.status}): ${result.stderr}`);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as T;
}

describe("federation CLI workflow", () => {
  afterAll(() => {
    // Temporary instance directory is reclaimed by the test runner.
  });

  it("initializes two owners in one home and carries a team package through export, import, and rejection", () => {
    const initA = cliJson<{
      organismId: string;
      snapshotId: string;
      versions: Array<{ artifactId: string; versionId: string }>;
    }>(["init", "--organism", "cli-org-a", "--actor", "cli-owner-a"]);
    const initB = cliJson<{ organismId: string; snapshotId: string }>([
      "init",
      "--organism",
      "cli-org-b",
      "--actor",
      "cli-owner-b",
    ]);
    expect(initA.organismId).toBe("cli-org-a");
    expect(initB.organismId).toBe("cli-org-b");
    const sourcePolicy = initA.versions.find((v) => v.artifactId === "stats-rule")!.versionId;

    cliJson(["team-create", "cli-team", "--organism", "cli-org-a", "--actor", "cli-owner-a"]);
    cliJson([
      "team-grant",
      "cli-team",
      "cli-owner-b",
      "--permission",
      "read",
      "--organism",
      "cli-org-a",
      "--actor",
      "cli-owner-a",
    ]);
    const fork = cliJson<{ versions: Record<string, string> }>([
      "share-fork",
      "--versions",
      sourcePolicy,
      "--scope",
      "team:cli-team",
      "--organism",
      "cli-org-a",
      "--actor",
      "cli-owner-a",
    ]);
    const publication = cliJson<{ id: string; bundleDigest: string }>([
      "publish",
      "--team",
      "cli-team",
      "--versions",
      fork.versions[sourcePolicy]!,
      "--scope",
      "team:cli-team",
      "--organism",
      "cli-org-a",
      "--actor",
      "cli-owner-a",
    ]);
    const exported = cliJson<{ digest: string }>([
      "share-export",
      publication.id,
      "--out",
      exportedEnvelope,
      "--organism",
      "cli-org-a",
      "--actor",
      "cli-owner-a",
    ]);
    expect(exported.digest).toBe(publication.bundleDigest);
    const envelope = JSON.parse(readFileSync(exportedEnvelope, "utf8")) as {
      digest: string;
      bundle: { scope: string; teamId: string };
    };
    expect(envelope.bundle.scope).toBe("team:cli-team");
    expect(envelope.bundle.teamId).toBe("cli-team");

    const imported = cliJson<{ id: string; state: string; organismId: string }>([
      "share-import",
      exportedEnvelope,
      "--organism",
      "cli-org-b",
      "--actor",
      "cli-owner-b",
    ]);
    expect(imported.state).toBe("imported");
    expect(imported.organismId).toBe("cli-org-b");
    const rejected = cliJson<{ state: string }>([
      "share-reject",
      imported.id,
      "--note",
      "CLI smoke rejection",
      "--organism",
      "cli-org-b",
      "--actor",
      "cli-owner-b",
    ]);
    expect(rejected.state).toBe("rejected");

    const app = openInstance(home, { organismId: "cli-org-b", actorId: "cli-owner-b" });
    try {
      expect(app.kernel.getOrganism("cli-org-b")!.activeGenomeId).toBe(initB.snapshotId);
      expect(app.federation.importRecord(imported.id).state).toBe("rejected");
    } finally {
      app.close();
    }
  });
});
