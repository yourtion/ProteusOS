import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../src/storage/blobs.ts";
import type { ObservedCase } from "./observed-plan.ts";

const goals = {
  matrix: [
    "Count words, lines, bytes and Markdown headings in the narrative attachment.",
    "请将路径清单中的改动文件分类，输出每条路径和总数。",
    "The memo mentions changed files; calculate text statistics of the memo itself.",
    "只分析变更清单中的文件类别，不计算附带说明文字的篇幅。",
    "为附带的说明文档生成逐文件文本统计与总计。",
    "Inventory the changed source, test, documentation, config and other paths.",
    "Ignore repository file categories and measure the attached text document.",
    "正文只是背景资料，请为补丁路径生成类别摘要。",
    "统计笔记内容的空白分词、行、字节与标题，忽略变更清单。",
    "Classify the changed-file manifest; do not measure the narrative document.",
  ],
  confirmation: [
    "请测量附件正文的词、行、标题和字节，输出逐文件和汇总。",
    "Group each changed path into a repository file category and include the total.",
    "The handbook describes a patch; report statistics of the handbook text.",
    "发布检查需要每条变更路径的文件类别，附带的笔记不用统计。",
    "Give text totals for the attached handover note, including headings and byte count.",
    "请为提交修改的路径列表逐条标注类别，并汇总文件数量。",
    "忽略正文里提到的文件变更，只测量该正文文本。",
    "Review source/test/docs/config/other categories in the change list attachment.",
    "为维护备忘录计算文本指标，不做代码路径分类。",
    "Categorize the patch manifest instead of counting words in the accompanying memo.",
  ],
} as const;

export function diagnosticDataset(stage: keyof typeof goals): ObservedCase[] {
  return goals[stage].flatMap((goal, family) =>
    Array.from({ length: stage === "matrix" ? 1 : 2 }, (_, variant) => {
      const stats = family % 2 === 0;
      const serial = 1000 + family * 10 + variant + (stage === "confirmation" ? 200 : 0);
      const text = `# Review ${serial}\nalpha beta ${stage}\n\n## 交接\n你好 world ${variant}\n`;
      const files = [
        { path: `src/feature-${serial}.ts`, category: "source" },
        { path: `src/tests/feature-${serial}.ts`, category: "test" },
        { path: `docs/feature-${serial}.md`, category: "docs" },
        { path: `config/feature-${serial}.yaml`, category: "config" },
        { path: `assets/feature-${serial}.svg`, category: "other" },
      ];
      const totals = {
        bytes: Buffer.byteLength(text),
        lines: text.split("\n").length - 1,
        words: text.match(/\S+/gu)!.length,
        headings: text.match(/^#/gm)!.length,
      };
      return {
        id: `diagnostic-${stage}-${family}-${variant}`,
        familyId: `diagnostic-template-${stage}-${family}`,
        split: "search" as const,
        critical: stage === "confirmation" && family < 2,
        task: {
          goal,
          inputs: [
            { name: "note.md", content: text },
            {
              name: "changed-files.json",
              content: canonicalJson({
                changes: files.map(({ path }) => ({ path, changeType: "modified" })),
              }),
            },
          ],
        },
        expectedChoice: stats
          ? ("local-process" as const)
          : ("capability/changed-file-summary" as const),
        schema: readFileSync(
          fileURLToPath(
            new URL(
              `../../src/resources/${stats ? "stats-summary" : "changed-file-summary"}.schema.json`,
              import.meta.url,
            ),
          ),
          "utf8",
        ),
        expected: canonicalJson(
          stats
            ? { files: [{ path: "note.md", ...totals }], totals: { files: 1, ...totals } }
            : { summary: { total: files.length, files } },
        ),
      };
    }),
  );
}
