import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateSchema } from "../../src/runtime/schema-validator.ts";
import { fixturePath, tempInstanceRoot } from "../helpers.ts";

const workerPath = fileURLToPath(
  new URL("../../src/adapters/executor-process/stats-worker.mjs", import.meta.url),
);
const schema = JSON.parse(
  readFileSync(fixturePath("schemas", "stats-summary.schema.json"), "utf8"),
) as unknown;

describe("stats-worker 合同", () => {
  it("合法输入：退出 0，输出符合 schema 且 totals 一致", () => {
    const ws = tempInstanceRoot();
    mkdirSync(join(ws, "inputs"), { recursive: true });
    cpSync(fixturePath("input-a"), join(ws, "inputs", "input-a"), { recursive: true });

    const result = spawnSync(process.execPath, [workerPath, ws], { encoding: "utf8" });
    expect(result.status).toBe(0);

    const output = JSON.parse(readFileSync(join(ws, "output.json"), "utf8")) as unknown;
    expect(validateSchema(output, schema)).toEqual([]);

    const { files, totals } = output as {
      files: Array<Record<string, number>>;
      totals: Record<string, number>;
    };
    // totals.files 是文件数量；其余字段是逐文件求和
    expect(totals.files).toBe(files.length);
    for (const field of ["bytes", "lines", "words", "headings"]) {
      const sum = files.reduce((acc, f) => acc + (f[field] ?? 0), 0);
      expect(totals[field]).toBe(sum);
    }
    // 输入含 readme.md 与 notes.txt 两个文件，且 readme 有标题
    expect(totals.files).toBe(2);
    expect(totals.headings).toBeGreaterThan(0);
  });

  it("缺参数：非零退出", () => {
    const result = spawnSync(process.execPath, [workerPath], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
  });

  it("无输入文件：退出 0 但产出空结果（由验收层拒绝）", () => {
    const ws = tempInstanceRoot();
    const result = spawnSync(process.execPath, [workerPath, ws], { encoding: "utf8" });
    expect(result.status).toBe(0);
    const output = JSON.parse(readFileSync(join(ws, "output.json"), "utf8")) as {
      files: unknown[];
    };
    expect(output.files).toEqual([]);
  });
});
