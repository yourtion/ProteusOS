import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../storage/blobs.ts";
import type { ObservedCase } from "./observed-plan.ts";

// 相同模板的材料变体始终归同一家族，不以 90 个 case 冒充 90 个独立 family。
const templates = {
  train: [
    ["stats", "请给出文本的词数、行数、字节数和标题数。"],
    ["changes", "将改动路径按源码、测试、文档、配置和其他分类。"],
    ["stats", "Count words and lines in the attached project overview."],
    ["changes", "Summarize the categories of files listed in the change manifest."],
    ["stats", "为 Markdown 简报生成文本统计概况。"],
  ],
  search: [
    ["stats", "Ignore the change manifest; count words and lines in the text attachments."],
    ["changes", "统计这批变更文件的类型，保留各个路径及其类别。"],
    ["stats", "材料是修订后的说明正文，请计算行数、词数、标题数及字节数。"],
    ["changes", "Prepare a source/test/docs/config inventory from the listed changed paths."],
    ["stats", "Measure the attached document, including headings and byte count."],
  ],
  formal: [
    ["stats", "For release notes, report text totals for words, lines, bytes and headings."],
    ["changes", "发布审计需要将变更清单的每条文件路径归类，正文不用统计。"],
    ["stats", "请数所附正文有多少行与词，并附字节及标题概况；忽略文件变更列表。"],
    ["changes", "What source, test, documentation, configuration or other files were touched?"],
    ["stats", "The document discusses changed files; measure the document text itself."],
    ["changes", "Count and classify changed-file paths; include the category of each entry."],
    ["stats", "请检查多语言笔记的字节、文本行、空白分词和 Markdown 标题统计。"],
    ["changes", "Disregard the narrative attachment and categorize the paths in the manifest."],
    ["stats", "给出附带文本文件的逐文件统计和总计，不处理变更路径分类。"],
    ["changes", "请为提交的路径清单生成文件类别摘要，而不是测量文档篇幅。"],
  ],
  regression: [
    ["stats", "Compute the text statistics of the attached maintenance memo."],
    ["changes", "审阅补丁包含的文件类型，并逐条标出所属类别。"],
    ["stats", "统计附件内容，输出每份文本的词、行、标题和字节及合计。"],
    ["changes", "Summarize the changed paths for a repository cleanup review."],
    ["stats", "Measure the attached handbook notes rather than the list of repository changes."],
  ],
} as const;

export function observedDataset(): ObservedCase[] {
  const schema = (stats: boolean) =>
    readFileSync(
      fileURLToPath(
        new URL(
          stats
            ? "../../../tests/fixtures/decision/dev/schemas/stats-summary.schema.json"
            : "../../../tests/fixtures/decision/dev/schemas/changed-file-summary.schema.json",
          import.meta.url,
        ),
      ),
      "utf8",
    );
  let serial = 0;
  return (Object.keys(templates) as Array<keyof typeof templates>).flatMap((split) =>
    templates[split].flatMap(([kind, goal], family) =>
      Array.from({ length: split === "regression" ? 2 : 4 }, (_, variant) => {
        const n = ++serial;
        const stats = kind === "stats";
        const text =
          variant === 0
            ? `# Release ${n}\nalpha beta\n`
            : variant === 1
              ? `# 笔记 ${n}\n你好 world\n\n## TODO\n`
              : variant === 2
                ? `plain words ${n}\r\nlast line`
                : `# Plan ${n}\nitem one\nitem two\n`;
        const path = "note.md";
        const typed = [
          { path: `src/module-${n}.ts`, category: "source" },
          { path: `docs/note-${n}.md`, category: "docs" },
          { path: `src/tests/verify-${n}.ts`, category: "test" },
          { path: `config/options-${n}.yaml`, category: "config" },
          { path: `assets/badge-${n}.svg`, category: "other" },
        ].slice(0, 2 + variant);
        const values = {
          bytes: Buffer.byteLength(text),
          lines: (text.match(/\n/g)?.length ?? 0) + (text.endsWith("\n") ? 0 : 1),
          words: text.match(/\S+/gu)!.length,
          headings: text.match(/^#/gm)?.length ?? 0,
        };
        return {
          id: `${split}-${family}-${variant}`,
          familyId: `template-${split}-${family}`,
          split,
          critical: split === "regression",
          task: {
            goal: `${goal}（资料批次 ${n}）`,
            inputs: [
              {
                name: "changed-files.json",
                content: canonicalJson({
                  changes: typed.map(({ path }) => ({ path, changeType: "modified" })),
                }),
              },
              { name: path, content: text },
            ],
          },
          expectedChoice: stats ? "local-process" : "capability/changed-file-summary",
          schema: schema(stats),
          expected: canonicalJson(
            stats
              ? { files: [{ path, ...values }], totals: { files: 1, ...values } }
              : { summary: { total: typed.length, files: typed } },
          ),
        };
      }),
    ),
  );
}
