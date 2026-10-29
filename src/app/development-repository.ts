import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, digestOf } from "../storage/blobs.ts";

export interface DevelopmentRepositoryPlan {
  /** Trusted historical snapshot containing src/, package.json, tsconfig.json; never sent wholesale. */
  root: string;
  /** Read-only model context, selected explicitly from the same frozen snapshot. */
  contextFiles: string[];
  api: { types: string[]; values: string[]; instances: string[] };
}
export interface DevelopmentRepositoryReview {
  version: "development-repository-review-v1";
  passed: boolean;
  repositoryIntact: boolean;
  outputDigest: string | null;
  functional: {
    passed: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    error: string | null;
    verdict: { passed: boolean; results: Array<{ name: string; passed: boolean }> } | null;
  } | null;
  repositoryTypes: {
    passed: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    error: string | null;
  } | null;
  apiCompatibility: {
    passed: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    error: string | null;
    addedSuppression: boolean;
  } | null;
  compilerVersion: string;
  error: string | null;
}
export function safeDevelopmentPath(path: string): boolean {
  return (
    /^[a-zA-Z0-9_./-]+$/.test(path) &&
    !path.startsWith("/") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** Snapshot source and numeric tool identity before any model dispatch. No repository scripts execute. */
export function prepareDevelopmentRepository(
  plan: DevelopmentRepositoryPlan,
  frozen: string,
  target: string,
  sourceDigest: string,
  checksPath: string,
) {
  if (!safeDevelopmentPath(target) || !target.endsWith(".ts"))
    throw new Error("repository review requires a safe .ts target");
  if (!Object.values(plan.api).some((names) => names.length))
    throw new Error("at least one API contract is required");
  for (const names of Object.values(plan.api))
    for (const name of names)
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) throw new Error("invalid API symbol");
  for (const path of plan.contextFiles)
    if (!safeDevelopmentPath(path) || path === target)
      throw new Error("invalid dependency context path");
  const root = join(frozen, "repository");
  mkdirSync(root);
  const files: Record<string, string> = {};
  let bytes = 0;
  function copy(relative: string) {
    const from = join(plan.root, relative),
      to = join(root, relative),
      stat = lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error("repository snapshots cannot contain symlinks");
    if (stat.isDirectory()) {
      mkdirSync(to, { recursive: true });
      for (const name of readdirSync(from).sort()) copy(`${relative}/${name}`);
    } else {
      if (!stat.isFile()) throw new Error("repository snapshot contains a non-file");
      bytes += stat.size;
      if (bytes > 32 * 1024 * 1024 || Object.keys(files).length >= 2048)
        throw new Error("repository snapshot too large");
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to);
      files[relative] = createHash("sha256").update(readFileSync(to)).digest("hex");
    }
  }
  for (const path of ["src", "package.json", "tsconfig.json"]) copy(path);
  if (files[target] !== sourceDigest)
    throw new Error("target does not match historical repository");
  const context = plan.contextFiles.map((path) => {
    if (!files[path]) throw new Error(`context is not in frozen repository: ${path}`);
    return { path, digest: files[path], content: readFileSync(join(root, path), "utf8") };
  });
  const contextPath = join(frozen, "context.json");
  writeFileSync(
    contextPath,
    JSON.stringify({ version: "development-context-v1", files: context }, null, 2),
  );
  const require = createRequire(import.meta.url);
  const nodeModules = realpathSync(fileURLToPath(new URL("../../node_modules", import.meta.url)));
  const tsPackage = require.resolve("typescript/package.json");
  const platformPackage = createRequire(tsPackage).resolve(
    `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
  );
  const compilerPath = realpathSync(
    join(dirname(platformPackage), "lib", process.platform === "win32" ? "tsc.exe" : "tsc"),
  );
  const version = spawnSync(compilerPath, ["--version"], {
    encoding: "utf8",
    env: { LANG: "C.UTF-8" },
    timeout: 5000,
  });
  if (version.status !== 0) throw new Error("trusted TypeScript compiler unavailable");
  const compiler = {
    path: compilerPath,
    digest: createHash("sha256").update(readFileSync(compilerPath)).digest("hex"),
    version: version.stdout.trim(),
  };
  const lockPath = join(nodeModules, ".pnpm/lock.yaml");
  const checkerPath = join(frozen, "repository-review.mjs");
  cpSync(
    fileURLToPath(new URL("./development-repository-review.mjs", import.meta.url)),
    checkerPath,
  );
  const config = {
    root,
    files,
    target,
    api: plan.api,
    compiler,
    nodeModules,
    checksPath,
    checksDigest: digestOf(readFileSync(checksPath, "utf8")),
    dependencyLock: existsSync(lockPath)
      ? { path: lockPath, digest: digestOf(readFileSync(lockPath, "utf8")) }
      : null,
    expectedChecks: undefined as string[] | undefined,
  };
  return {
    config,
    contextPath,
    checkerPath,
    checkerDigest: digestOf(readFileSync(checkerPath, "utf8")),
    repositoryDigest: digestOf(canonicalJson(files)),
  };
}
export function reviewDevelopmentRepository(
  prepared: ReturnType<typeof prepareDevelopmentRepository>,
  candidate: string,
): DevelopmentRepositoryReview {
  if (digestOf(readFileSync(prepared.checkerPath, "utf8")) !== prepared.checkerDigest)
    throw new Error("repository checker changed");
  const result = spawnSync(
    process.execPath,
    [prepared.checkerPath, JSON.stringify(prepared.config), candidate],
    { encoding: "utf8", env: { LANG: "C.UTF-8" }, timeout: 85000, maxBuffer: 2 * 1024 * 1024 },
  );
  if (result.error || (result.status !== 0 && result.status !== 1))
    throw new Error("repository checker failed: " + (result.error ?? result.stderr));
  return JSON.parse(result.stdout) as DevelopmentRepositoryReview;
}
