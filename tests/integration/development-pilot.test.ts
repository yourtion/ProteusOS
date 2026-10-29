import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDevelopmentPilot } from "../../src/app/development-pilot.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "proteus-dev-pilot-test-"));
  const sourceFile = join(root, "source.ts");
  const checksFile = join(root, "checks.mjs");
  writeFileSync(sourceFile, 'export const allowed = (value) => "constructor" in value;\n');
  writeFileSync(
    checksFile,
    `
import { pathToFileURL } from "node:url";
const { allowed } = await import(pathToFileURL(process.argv[2]).href);
const results = [
  { name: "missing", passed: allowed({}) === false },
  { name: "present", passed: allowed({ constructor: "yes" }) === true },
];
const passed = results.every((r) => r.passed);
console.log(JSON.stringify({ passed, results }));
process.exitCode = passed ? 0 : 1;
`,
  );
  return { root, sourceFile, checksFile, output: join(root, "run") };
}

describe("single-module development pilot", () => {
  it.each([
    "correct",
    "wrong",
    "edit-input-tests",
    "edit-frozen-tests",
    "extra-file",
    "symlink",
    "skip-tests",
  ] as const)("fixed host acceptance: %s", async (mode) => {
    const f = fixture();
    let calls = 0;
    const report = await runDevelopmentPilot({
      ...f,
      target: "src/module.ts",
      goal: "Fix missing field validation",
      maxWallClockSeconds: 30,
      provenance: { mode: "fixture", sourceCommit: "fixture", requestedModel: null },
      executor: {
        name: "fixture-coder",
        recoveryPolicy: "manual",
        async start(request) {
          calls++;
          const dir = join(request.workspaceDir, "output/src");
          mkdirSync(dir, { recursive: true });
          const code =
            mode === "wrong"
              ? "export const allowed = () => true;"
              : mode === "skip-tests"
                ? "process.exit(0);"
                : 'export const allowed = (value) => Object.hasOwn(value, "constructor");';
          if (mode === "symlink") symlinkSync(f.sourceFile, join(dir, "module.ts"));
          else writeFileSync(join(dir, "module.ts"), code);
          if (mode === "edit-input-tests")
            writeFileSync(join(request.workspaceDir, "inputs/checks.mjs"), "process.exit(0);");
          if (mode === "edit-frozen-tests")
            writeFileSync(join(f.output, "frozen/checks.mjs"), "process.exit(0);");
          if (mode === "extra-file")
            writeFileSync(join(request.workspaceDir, "extra.txt"), "unexpected");
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
    expect(report.activeUnchanged).toBe(true);
    expect(report.modelUsage).toBeNull();
    expect(JSON.parse(readFileSync(join(f.output, "run.json"), "utf8")).runId).toBe(
      report.summary.runId,
    );
    if (mode === "correct") {
      expect(readFileSync(join(f.output, "candidate.patch"), "utf8")).toContain(
        "+++ b/src/module.ts",
      );
    }
  });

  it("a healthy baseline never calls the executor, and an existing output never reruns", async () => {
    const f = fixture();
    writeFileSync(
      f.sourceFile,
      'export const allowed = (value) => Object.hasOwn(value, "constructor");',
    );
    let calls = 0;
    const plan = {
      ...f,
      target: "src/module.ts",
      goal: "No bug",
      maxWallClockSeconds: 30,
      provenance: { mode: "fixture" as const, sourceCommit: "fixture", requestedModel: null },
      executor: {
        name: "never",
        recoveryPolicy: "manual" as const,
        async start() {
          calls++;
          throw new Error("must not run");
        },
      },
    };
    await expect(runDevelopmentPilot(plan)).rejects.toThrow("failing baseline");
    await expect(runDevelopmentPilot(plan)).rejects.toThrow("already exists");
    expect(calls).toBe(0);
  });
});
