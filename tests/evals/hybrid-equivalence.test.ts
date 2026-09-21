import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateHybridOutput, evaluateStatsOutput } from "../../src/runtime/acceptance.ts";

/**
 * Evaluation 层（M2）：hybrid-acceptance-v1 与 stats-acceptance-v1 的
 * 判定等价性——hybrid 是预注册裁判（进入候选快照与评估计划），
 * 它对既有 stats 行为的判定必须与 v1 完全一致，否则"固定其中一方
 * 进行对照"（docs/evolution.md §6）不成立。构造候选前固定（roadmap：
 * 避免事后移动标准）。
 */

const M2 = fileURLToPath(new URL("../fixtures/m2", import.meta.url));
const SUMMARY_SCHEMA = JSON.parse(
  readFileSync(join(M2, "schemas", "changed-file-summary.schema.json"), "utf8"),
) as unknown;
const STATS_SCHEMA = {
  type: "object",
  required: ["files", "totals"],
  properties: { files: { type: "array" }, totals: { type: "object" } },
};

const statsCases: Array<{ name: string; output: unknown; passed: boolean; statsShaped?: boolean }> =
  [
    {
      name: "合法输出",
      output: {
        files: [
          { path: "a.md", bytes: 10, lines: 2, words: 5, headings: 1 },
          { path: "b.md", bytes: 20, lines: 4, words: 9, headings: 2 },
        ],
        totals: { files: 2, bytes: 30, lines: 6, words: 14, headings: 3 },
      },
      passed: true,
    },
    {
      name: "totals 求和不一致",
      output: {
        files: [{ path: "a.md", bytes: 10, lines: 2, words: 5, headings: 1 }],
        totals: { files: 1, bytes: 999, lines: 2, words: 5, headings: 1 },
      },
      passed: false,
    },
    {
      name: "totals.files 计数不一致",
      output: {
        files: [
          { path: "a.md", bytes: 1, lines: 1, words: 1, headings: 1 },
          { path: "b.md", bytes: 1, lines: 1, words: 1, headings: 1 },
        ],
        totals: { files: 3, bytes: 2, lines: 2, words: 2, headings: 2 },
      },
      passed: false,
    },
    {
      name: "非 stats 形态输出（数组）",
      output: [1, 2, 3],
      passed: false,
      statsShaped: false, // 非 stats 形态：hybrid 走纯 schema，checks 细节允许不同
    },
  ];

describe("Evaluation 层：hybrid 与 stats v1 判定等价（stats 形态输出）", () => {
  for (const c of statsCases) {
    it(`${c.name} → ${c.passed ? "通过" : "拒绝"}（两裁判一致）`, () => {
      const stats = evaluateStatsOutput(c.output, STATS_SCHEMA);
      const hybrid = evaluateHybridOutput(c.output, STATS_SCHEMA);
      expect(hybrid.passed).toBe(c.passed);
      expect(hybrid.passed).toBe(stats.passed);
      if (c.statsShaped !== false) {
        // stats 形态输出：check 项逐一一致（判定细节不漂移）
        expect(hybrid.checks).toEqual(stats.checks);
      }
    });
  }
});

describe("Evaluation 层：hybrid 对非 stats 形态输出走纯 schema", () => {
  it("合法 summary 输出通过（v1 会因 totals 缺失误拒）", () => {
    const output = {
      summary: {
        total: 2,
        files: [
          { path: "src/a.ts", category: "source" },
          { path: "docs/b.md", category: "docs" },
        ],
      },
    };
    expect(evaluateStatsOutput(output, SUMMARY_SCHEMA).passed).toBe(false); // v1 不适用
    const hybrid = evaluateHybridOutput(output, SUMMARY_SCHEMA);
    expect(hybrid.passed).toBe(true);
    expect(hybrid.checks.map((c) => c.name)).toEqual(["json-schema"]);
  });

  it("枚举外分类 / 缺字段 / 多余字段拒绝", () => {
    expect(
      evaluateHybridOutput(
        { summary: { total: 1, files: [{ path: "a", category: "weird" }] } },
        SUMMARY_SCHEMA,
      ).passed,
    ).toBe(false);
    expect(evaluateHybridOutput({ summary: { total: 1 } }, SUMMARY_SCHEMA).passed).toBe(false);
    expect(
      evaluateHybridOutput({ summary: { total: 0, files: [] }, extra: true }, SUMMARY_SCHEMA)
        .passed,
    ).toBe(false);
  });
});
