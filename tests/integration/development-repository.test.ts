import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runDevelopmentPilot } from "../../experiments/protocols/development-pilot.ts";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "proteus-repo-check-")));
  const repository = join(root, "repository");
  mkdirSync(join(repository, "src"), { recursive: true });
  writeFileSync(join(repository, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(repository, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        types: [],
      },
      include: ["src"],
    }),
  );
  const source =
    'import type { Role } from "./types.ts";\nexport interface Person { role: Role }\nexport const allowed = (value: Record<string, unknown>) => "constructor" in value;\n';
  writeFileSync(join(repository, "src/module.ts"), source);
  writeFileSync(join(repository, "src/types.ts"), 'export type Role = "member" | "owner";\n');
  writeFileSync(
    join(repository, "src/caller.ts"),
    'import type { Person } from "./module.ts"; export const identify = (p: Person) => p.role;',
  );
  const checksFile = join(root, "checks.mjs");
  writeFileSync(
    checksFile,
    `import { pathToFileURL } from 'node:url';
const {allowed} = await import(pathToFileURL(process.argv[2]).href);
const results=[{name:'missing',passed:allowed({})===false},{name:'present',passed:allowed({constructor:1})===true}];
const passed=results.every(r=>r.passed);console.log(JSON.stringify({passed,results}));process.exitCode=passed?0:1;`,
  );
  return { root, repository, source, checksFile };
}

it.each([
  "correct",
  "widen-api",
  "type-error",
  "tamper-context",
  "tamper-repository",
  "suppress-types",
] as const)("automatic repository acceptance: %s", async (mode) => {
  const f = fixture();
  const output = join(f.root, "run");
  let calls = 0;
  const report = await runDevelopmentPilot({
    output,
    sourceFile: join(f.repository, "src/module.ts"),
    checksFile: f.checksFile,
    target: "src/module.ts",
    goal: "Fix own-property checks",
    maxWallClockSeconds: 30,
    repository: {
      root: f.repository,
      contextFiles: ["src/types.ts"],
      api: { types: ["Person"], values: ["allowed"], instances: [] },
    },
    provenance: { mode: "fixture", sourceCommit: "fixture", requestedModel: null },
    executor: {
      name: "fixture",
      recoveryPolicy: "manual",
      async start(request) {
        calls++;
        const target = join(request.workspaceDir, "output/src/module.ts");
        expect(readFileSync(target, "utf8")).toBe(f.source);
        expect(request.prompt).toContain("Preserve existing type imports");
        expect(
          JSON.parse(readFileSync(join(request.workspaceDir, "inputs/context.json"), "utf8"))
            .files[0].content,
        ).toContain('"member" | "owner"');
        let fixed = f.source.replace(
          '"constructor" in value',
          'Object.hasOwn(value, "constructor")',
        );
        if (mode === "widen-api") fixed = fixed.replace("role: Role", "role: string");
        if (mode === "type-error") fixed += '\nconst n: number = "wrong";';
        if (mode === "suppress-types") fixed = "// @ts-nocheck\n" + fixed;
        if (mode === "tamper-context")
          writeFileSync(join(request.workspaceDir, "inputs/context.json"), "{}");
        if (mode === "tamper-repository")
          writeFileSync(
            join(output, "frozen/repository/src/types.ts"),
            "export type Role = string;",
          );
        writeFileSync(target, fixed);
        return {
          ok: true,
          exitCode: 0,
          stdout: "done",
          stderr: "",
          durationMs: 1,
          outputRef: null,
        };
      },
    },
  });
  expect(calls).toBe(1);
  expect(report.passed).toBe(mode === "correct");
  expect(report.summary.state).toBe(mode === "correct" ? "succeeded" : "failed");
  const run = JSON.parse(readFileSync(join(output, "run.json"), "utf8"));
  const verified = JSON.parse(
    readFileSync(
      join(output, "instance/workspaces", run.runId, "develop/.proteus/pilot-verification.json"),
      "utf8",
    ),
  );
  if (mode === "widen-api") {
    expect(verified.repository.functional.passed).toBe(true);
    expect(verified.repository.repositoryTypes.passed).toBe(true);
    expect(verified.repository.apiCompatibility.passed).toBe(false);
  }
  if (mode === "type-error") {
    expect(verified.repository.functional.passed).toBe(true);
    expect(verified.repository.repositoryTypes.passed).toBe(false);
  }
});

it("an invalid original repository stops before any model dispatch", async () => {
  const f = fixture();
  writeFileSync(join(f.repository, "src/types.ts"), "export type Role = MissingType;");
  let calls = 0;
  await expect(
    runDevelopmentPilot({
      output: join(f.root, "run"),
      sourceFile: join(f.repository, "src/module.ts"),
      checksFile: f.checksFile,
      target: "src/module.ts",
      goal: "Fix",
      maxWallClockSeconds: 30,
      repository: {
        root: f.repository,
        contextFiles: ["src/types.ts"],
        api: { types: ["Person"], values: ["allowed"], instances: [] },
      },
      provenance: { mode: "fixture", sourceCommit: "fixture", requestedModel: null },
      executor: {
        name: "never",
        recoveryPolicy: "manual",
        async start() {
          calls++;
          throw new Error("must not execute");
        },
      },
    }),
  ).rejects.toThrow("must pass types and API");
  expect(calls).toBe(0);
});
