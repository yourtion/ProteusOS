// Trusted host checker. Copied and hashed before dispatch; never supplied by the coding agent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
const config = JSON.parse(process.argv[2]);
const candidate = process.argv[3];
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const record = {
  version: "development-repository-review-v1",
  passed: false,
  repositoryIntact: false,
  outputDigest: null,
  functional: null,
  repositoryTypes: null,
  apiCompatibility: null,
  compilerVersion: config.compiler.version,
  error: null,
};
let scratch;
try {
  const actual = {};
  function visit(dir, prefix = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), "repository symlink");
      const relative = prefix + entry.name,
        path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path, relative + "/");
      else {
        assert.ok(entry.isFile(), "non-file in repository");
        actual[relative] = hash(path);
      }
    }
  }
  visit(config.root);
  assert.deepEqual(actual, config.files, "frozen repository changed");
  assert.equal(hash(config.compiler.path), config.compiler.digest, "compiler changed");
  assert.equal(hash(config.checksPath), config.checksDigest, "frozen functional checks changed");
  if (config.dependencyLock)
    assert.equal(
      hash(config.dependencyLock.path),
      config.dependencyLock.digest,
      "installed dependency lock changed",
    );
  assert.ok(
    lstatSync(candidate).isFile() && !lstatSync(candidate).isSymbolicLink(),
    "candidate must be a regular file",
  );
  record.repositoryIntact = true;
  record.outputDigest = hash(candidate);
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "proteus-repository-review-")));
  cpSync(config.root, scratch, { recursive: true });
  symlinkSync(config.nodeModules, join(scratch, "node_modules"), "dir");
  const target = join(scratch, config.target),
    original = readFileSync(target, "utf8");
  cpSync(candidate, target);
  const run = (command, args, timeout = 30000) => {
    const result = spawnSync(command, args, {
      cwd: scratch,
      encoding: "utf8",
      timeout,
      maxBuffer: 512 * 1024,
      env: { LANG: "C.UTF-8" },
    });
    return {
      exitCode: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error ? String(result.error) : null,
    };
  };
  const functional = run(
    process.execPath,
    [
      "--permission",
      `--allow-fs-read=${scratch}`,
      `--allow-fs-read=${config.nodeModules}`,
      `--allow-fs-read=${config.checksPath}`,
      config.checksPath,
      target,
    ],
    15000,
  );
  let verdict = null;
  try {
    verdict = JSON.parse(functional.stdout);
  } catch {
    /* Missing or invalid verdict is a failed test run. */
  }
  const validChecks =
    Array.isArray(verdict?.results) &&
    verdict.results.length > 0 &&
    verdict.results.every((r) => typeof r.name === "string" && typeof r.passed === "boolean") &&
    new Set(verdict.results.map((r) => r.name)).size === verdict.results.length;
  const sameChecks =
    validChecks &&
    (!config.expectedChecks ||
      JSON.stringify(verdict.results.map((r) => r.name)) === JSON.stringify(config.expectedChecks));
  record.functional = {
    ...functional,
    verdict,
    passed:
      !functional.error &&
      functional.exitCode === 0 &&
      verdict?.passed === true &&
      sameChecks &&
      verdict.results.every((r) => r.passed),
  };
  const flags = ["--noEmit", "--incremental", "false", "--pretty", "false", "--noCheck", "false"];
  const types = run(config.compiler.path, ["--project", "tsconfig.json", ...flags]);
  record.repositoryTypes = { ...types, passed: types.exitCode === 0 && !types.error };

  // Compare against the frozen original in the same module directory, preserving relative imports.
  const originalPath = join(dirname(target), "__proteus_original__.ts");
  const contractPath = join(dirname(target), "__proteus_api_contract__.ts");
  assert.ok(
    !existsSync(originalPath) && !existsSync(contractPath),
    "reserved review path already exists",
  );
  writeFileSync(originalPath, original);
  const contract = [
    `import type * as Actual from ${JSON.stringify("./" + basename(target))};`,
    'import type * as Expected from "./__proteus_original__.ts";',
    "type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;",
    "type Assert<T extends true> = T;",
    ...config.api.types.map(
      (name, i) => `export type Type${i} = Assert<Equal<Actual.${name}, Expected.${name}>>;`,
    ),
    ...config.api.values.map(
      (name, i) =>
        `export type Value${i} = Assert<typeof Actual.${name} extends typeof Expected.${name} ? true : false>;`,
    ),
    ...config.api.instances.flatMap((name, i) => [
      `export type Instance${i} = Assert<Pick<Actual.${name}, keyof Actual.${name}> extends Pick<Expected.${name}, keyof Expected.${name}> ? true : false>;`,
      `export type Constructor${i} = Assert<ConstructorParameters<typeof Expected.${name}> extends ConstructorParameters<typeof Actual.${name}> ? true : false>;`,
    ]),
  ].join("\n");
  writeFileSync(contractPath, contract);
  const apiProject = join(scratch, "proteus-api.tsconfig.json");
  assert.ok(!existsSync(apiProject), "reserved API project path already exists");
  writeFileSync(
    apiProject,
    JSON.stringify({ extends: "./tsconfig.json", files: [contractPath], include: [], exclude: [] }),
  );
  const api = run(config.compiler.path, ["--project", apiProject, ...flags]);
  const addedSuppression =
    /@ts-(?:nocheck|ignore|expect-error)/.test(readFileSync(target, "utf8")) &&
    !/@ts-(?:nocheck|ignore|expect-error)/.test(original);
  record.apiCompatibility = {
    ...api,
    passed: api.exitCode === 0 && !api.error && !addedSuppression,
    addedSuppression,
  };
  assert.equal(hash(candidate), record.outputDigest, "candidate changed during review");
  assert.equal(
    hash(config.compiler.path),
    config.compiler.digest,
    "compiler changed during review",
  );
  if (config.dependencyLock)
    assert.equal(
      hash(config.dependencyLock.path),
      config.dependencyLock.digest,
      "dependency lock changed during review",
    );
  record.passed =
    record.functional.passed && record.repositoryTypes.passed && record.apiCompatibility.passed;
} catch (error) {
  record.error = String(error);
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify(record));
process.exitCode = record.passed ? 0 : 1;
