import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateHybridOutput } from "../../src/runtime/acceptance.ts";

describe("JSON Schema checks only output-owned fields", () => {
  it("passes the same frozen checks used by the development pilot", () => {
    const checks = fileURLToPath(
      new URL("../fixtures/development-pilot/schema-own-properties.mjs", import.meta.url),
    );
    const source = fileURLToPath(new URL("../../src/runtime/schema-validator.ts", import.meta.url));
    const result = spawnSync(process.execPath, [checks, source], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ passed: true });
    expect(result.status).toBe(0);
  });

  it("the runtime acceptance entry rejects missing required prototype names", () => {
    expect(
      evaluateHybridOutput({}, { type: "object", required: ["constructor", "toString"] }).passed,
    ).toBe(false);
    expect(
      evaluateHybridOutput(JSON.parse('{"constructor":"ok","toString":"ok"}'), {
        type: "object",
        required: ["constructor", "toString"],
      }).passed,
    ).toBe(true);
  });
});
