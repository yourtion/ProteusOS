#!/usr/bin/env node
/**
 * 开发数据集生成器（organism-decision-v1，40 个开发样本）。
 *
 * 期望输出由本脚本依据两份能力规范**独立计算**（stats：字节数/行数/词数/
 * 标题数的定义；changed-file-summary：分类判定顺序），不复用、不运行受测
 * worker——"禁止只把受测 worker 的一次输出直接当标准答案"（实验规范 §5）。
 * bundle 目录名、输出内容与组别/正确选项解绑（§3.2：目录名不得绑定答案）。
 *
 * 运行：node tests/fixtures/decision/generate.mjs（在仓库内幂等重写）
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

// ---- 目标文本（goal 按 stratum 构造；词法命中情况见各注释）----

/** 每条：[caseId 后缀, 语言, goal, 文本文件内容清单] */
const definitions = [
  // explicit：明确包含基线词表词汇（8；stats/change 各 4，zh/en 各半）
  {
    id: "dev-expl-01",
    lang: "zh",
    stratum: "explicit",
    goal: "统计这批文本文件的字数、行数与标题数",
    expect: "local-process",
  },
  {
    id: "dev-expl-02",
    lang: "en",
    stratum: "explicit",
    goal: "Count words and lines for the text files in this bundle",
    expect: "local-process",
  },
  {
    id: "dev-expl-03",
    lang: "zh",
    stratum: "explicit",
    goal: "给出输入文本的字节与行数统计摘要",
    expect: "local-process",
  },
  {
    id: "dev-expl-04",
    lang: "en",
    stratum: "explicit",
    goal: "Produce a statistics summary with word count for these notes",
    expect: "local-process",
  },
  {
    id: "dev-expl-05",
    lang: "zh",
    stratum: "explicit",
    goal: "对这份变更清单按源码、测试、文档与配置分类",
    expect: "capability/changed-file-summary",
  },
  {
    id: "dev-expl-06",
    lang: "en",
    stratum: "explicit",
    goal: "Classify changes in the changed files list by category",
    expect: "capability/changed-file-summary",
  },
  {
    id: "dev-expl-07",
    lang: "zh",
    stratum: "explicit",
    goal: "汇总修改清单：哪些是源码改动，哪些是配置",
    expect: "capability/changed-file-summary",
  },
  {
    id: "dev-expl-08",
    lang: "en",
    stratum: "explicit",
    goal: "Categorize files in the change summary by source, test and docs",
    expect: "capability/changed-file-summary",
  },

  // paraphrase：同义表达，避开基线词表字面（规则预期 abstain，检验语义选择）
  {
    id: "dev-para-01",
    lang: "zh",
    stratum: "paraphrase",
    goal: "帮我看看这些笔记一共有多少段落和词汇量",
    expect: "local-process",
  },
  {
    id: "dev-para-02",
    lang: "en",
    stratum: "paraphrase",
    goal: "How many words appear across these documents in total?",
    expect: "local-process",
  },
  {
    id: "dev-para-03",
    lang: "zh",
    stratum: "paraphrase",
    goal: "数一数每个文件有多长、各占多少篇幅",
    expect: "local-process",
  },
  {
    id: "dev-para-04",
    lang: "en",
    stratum: "paraphrase",
    goal: "Measure the size of each note, including newline counts",
    expect: "local-process",
  },
  {
    id: "dev-para-05",
    lang: "zh",
    stratum: "paraphrase",
    goal: "把这批提交涉及的文件按用途归归类",
    expect: "capability/changed-file-summary",
  },
  {
    id: "dev-para-06",
    lang: "en",
    stratum: "paraphrase",
    goal: "Sort the files touched by this commit into groups by their role",
    expect: "capability/changed-file-summary",
  },
  {
    id: "dev-para-07",
    lang: "zh",
    stratum: "paraphrase",
    goal: "列一下这次提交动过的东西分别属于哪一类",
    expect: "capability/changed-file-summary",
  },
  {
    id: "dev-para-08",
    lang: "en",
    stratum: "paraphrase",
    goal: "Break down the commit file list by what each file is for",
    expect: "capability/changed-file-summary",
  },

  // distractor：目标明确，但出现另一能力的背景词或否定描述（规则双侧命中 → abstain）
  {
    id: "dev-dis-01",
    lang: "zh",
    stratum: "distractor",
    goal: "统计这些文档的字数与行数；不需要输出变更文件的分类",
    expect: "local-process",
  },
  {
    id: "dev-dis-02",
    lang: "en",
    stratum: "distractor",
    goal: "Give me the word count and line count of the notes, ignoring changed files classification",
    expect: "local-process",
  },
  {
    id: "dev-dis-03",
    lang: "zh",
    stratum: "distractor",
    goal: "文本统计任务：虽然清单里有 changed files，我要的是标题数",
    expect: "local-process",
  },
  {
    id: "dev-dis-04",
    lang: "en",
    stratum: "distractor",
    goal: "Count lines in these memos; do not summarize modified files",
    expect: "local-process",
  },
  {
    id: "dev-dis-05",
    lang: "zh",
    stratum: "distractor",
    goal: "对变更做分类汇总；字数统计这批文本不需要",
    expect: "capability/changed-file-summary",
  },
  {
    id: "dev-dis-06",
    lang: "en",
    stratum: "distractor",
    goal: "Classify changes only; skip the word count statistics",
    expect: "capability/changed-file-summary",
  },
  {
    id: "dev-dis-07",
    lang: "zh",
    stratum: "distractor",
    goal: "文件分类：源码与配置各自有哪些；行数这里用不上",
    expect: "capability/changed-file-summary",
  },
  {
    id: "dev-dis-08",
    lang: "en",
    stratum: "distractor",
    goal: "File categories for the commit, not text statistics",
    expect: "capability/changed-file-summary",
  },

  // contrast：同输入包只改变目标就应改变选择（4 对共享 bundle 与 family）
  {
    id: "dev-con-a1",
    lang: "zh",
    stratum: "contrast",
    goal: "请对这套输入做统计摘要（字数、行数）",
    expect: "local-process",
    pair: "dev-con-a2",
    bundle: "b33",
  },
  {
    id: "dev-con-a2",
    lang: "zh",
    stratum: "contrast",
    goal: "请对这套输入做变更文件的分类汇总",
    expect: "capability/changed-file-summary",
    pair: "dev-con-a1",
    bundle: "b33",
  },
  {
    id: "dev-con-b1",
    lang: "en",
    stratum: "contrast",
    goal: "Generate a statistics summary of the bundle (word count, headings)",
    expect: "local-process",
    pair: "dev-con-b2",
    bundle: "b34",
  },
  {
    id: "dev-con-b2",
    lang: "en",
    stratum: "contrast",
    goal: "Generate a category breakdown of the changed files in the bundle",
    expect: "capability/changed-file-summary",
    pair: "dev-con-b1",
    bundle: "b34",
  },
  {
    id: "dev-con-c1",
    lang: "zh",
    stratum: "contrast",
    goal: "数一数这批文件的内容规模",
    expect: "local-process",
    pair: "dev-con-c2",
    bundle: "b35",
  },
  {
    id: "dev-con-c2",
    lang: "zh",
    stratum: "contrast",
    goal: "把这批涉及的文件分门别类",
    expect: "capability/changed-file-summary",
    pair: "dev-con-c1",
    bundle: "b35",
  },
  {
    id: "dev-con-d1",
    lang: "en",
    stratum: "contrast",
    goal: "How much text is in these files?",
    expect: "local-process",
    pair: "dev-con-d2",
    bundle: "b36",
  },
  {
    id: "dev-con-d2",
    lang: "en",
    stratum: "contrast",
    goal: "Which kinds of files were touched?",
    expect: "capability/changed-file-summary",
    pair: "dev-con-d1",
    bundle: "b36",
  },

  // abstain：同时要求两种结果（4）与信息不足（4）各半
  {
    id: "dev-abs-01",
    lang: "zh",
    stratum: "abstain",
    goal: "先统计字数，再对变更文件分类，两个结果都要",
    expect: "abstain",
  },
  {
    id: "dev-abs-02",
    lang: "en",
    stratum: "abstain",
    goal: "I need the word count and the changed files classification together",
    expect: "abstain",
  },
  {
    id: "dev-abs-03",
    lang: "zh",
    stratum: "abstain",
    goal: "同时给出文本统计和文件分类",
    expect: "abstain",
  },
  {
    id: "dev-abs-04",
    lang: "en",
    stratum: "abstain",
    goal: "Produce both the line count summary and the change summary in one go",
    expect: "abstain",
  },
  {
    id: "dev-abs-05",
    lang: "zh",
    stratum: "abstain",
    goal: "帮我处理一下这些输入文件",
    expect: "abstain",
  },
  {
    id: "dev-abs-06",
    lang: "en",
    stratum: "abstain",
    goal: "Do something useful with this workspace",
    expect: "abstain",
  },
  { id: "dev-abs-07", lang: "zh", stratum: "abstain", goal: "整理这批资料", expect: "abstain" },
  {
    id: "dev-abs-08",
    lang: "en",
    stratum: "abstain",
    goal: "Handle the bundle as you see fit",
    expect: "abstain",
  },
];

// ---- 每个独立 bundle 的文本与变更清单（目录名 bXX 与组别/答案解绑）----

const bundleTexts = {
  b01: ["# 项目笔记\n\n这是第一段。\n第二段较短。\n", "附录说明：无标题行，仅正文内容。\n"],
  b02: ["# Notes\n\nSome English text here.\nMore words follow.\n\n## Section\n\nTail.\n"],
  b03: ["短文一。\n短文二。\n# 概览\n\n内容若干。\n"],
  b04: ["Memo\n====\n\nBody text with a few words.\n"],
  b05: ["# 变更记录草稿\n\n记录两条。\n", "备注\n"],
  b06: ["# Change Log\n\nEntry one.\nEntry two.\n"],
  b07: ["清单\n- 项目甲\n- 项目乙\n"],
  b08: ["# Overview\n\nA short overview document.\n"],
  b09: ["段落一。\n\n段落二。\n# 小结\n"],
  b10: ["Quick note without any heading marker.\nSecond line.\n"],
  b11: ["# 草稿\n\n文字若干。\n", "补充材料：略。\n"],
  b12: ["# Draft\n\nDraft body.\n## Details\n\nFine.\n"],
  b13: ["正文内容一。\n正文内容二。\n"],
  b14: ["Line one.\nLine two.\nLine three.\n# End\n"],
  b15: ["# 备忘\n\n两条记录。\n- 甲\n- 乙\n"],
  b16: ["Scratch text for counting purposes.\n"],
  b17: ["开头发一句。\n中间一句。\n结尾一句。\n"],
  b18: ["# Header\n\nParagraph under header.\nAnother paragraph.\n\n# Second Header\n\nMore.\n"],
  b19: ["说明：以下是正文。\n正文开始。\n"],
  b20: ["Just a plain text file.\nWith two lines.\n"],
  b21: ["# 摘要\n\n摘要内容。\n", "附注一条。\n"],
  b22: ["# Summary\n\nSummary text.\n\n## Notes\n\nDetails.\n"],
  b23: ["一句起头。\n\n# 标题在中间\n\n结尾。\n"],
  b24: ["Text block one.\n\nText block two.\n\nText block three.\n"],
  b25: ["# 台账\n\n记录三项。\n", "附表：略。\n"],
  b26: ["# Ledger\n\nRow one.\nRow two.\n"],
  b27: ["内容甲。\n内容乙。\n内容丙。\n"],
  b28: ["# Notes\n\nNote text.\n"],
  b29: ["起始段。\n# 中断的标题\n继续段。\n"],
  b30: ["Single paragraph of sample text.\n"],
  b31: ["# 材料一\n\n材料内容。\n", "材料二内容。\n"],
  b32: ["# Log\n\nLog entry A.\nLog entry B.\n\n## Detail\n\nTiny.\n"],
  b33: ["# 对照材料\n\n第一段。\n第二段。\n", "附录：一行。\n"],
  b34: ["# Pair Material\n\nFirst paragraph.\nSecond paragraph.\n"],
  b35: ["成对样本的正文。\n共两行。\n"],
  b36: ["Paired sample body text.\nWith a second line.\n# Marker\n"],
};

const bundleChanges = {
  b01: [
    { path: "src/kernel/index.ts", changeType: "modified" },
    { path: "src/kernel/kernel.test.ts", changeType: "added" },
    { path: "docs/notes.md", changeType: "modified" },
    { path: "package.json", changeType: "modified" },
    { path: "Makefile", changeType: "added" },
  ],
  b02: [
    { path: "app/main.tsx", changeType: "modified" },
    { path: "app/components/button.jsx", changeType: "added" },
    { path: "README.md", changeType: "modified" },
    { path: "tsconfig.json", changeType: "modified" },
    { path: "logo.svg", changeType: "added" },
  ],
  b03: [
    { path: "lib/core.mjs", changeType: "modified" },
    { path: "lib/__tests__/core.test.mjs", changeType: "added" },
    { path: "docs/guide.md", changeType: "modified" },
    { path: "config/app.yaml", changeType: "modified" },
    { path: "data/raw.csv", changeType: "added" },
  ],
  b04: [
    { path: "src/index.ts", changeType: "modified" },
    { path: "src/wordcount.test.mjs", changeType: "added" },
    { path: "docs/guide.md", changeType: "modified" },
    { path: "package.json", changeType: "modified" },
    { path: "LICENSE", changeType: "added" },
  ],
  b05: [
    { path: "src/server/handler.ts", changeType: "modified" },
    { path: "tests/e2e/handler.test.ts", changeType: "added" },
    { path: "CONTRIBUTING.md", changeType: "modified" },
    { path: "pyproject.toml", changeType: "modified" },
  ],
  b06: [
    { path: "scripts/build.js", changeType: "modified" },
    { path: "scripts/build.test.cjs", changeType: "added" },
    { path: "SECURITY.md", changeType: "added" },
    { path: "jest.config.json", changeType: "modified" },
    { path: "snap.bin", changeType: "modified" },
  ],
  b07: [
    { path: "src/util.ts", changeType: "modified" },
    { path: "src/util.spec.ts", changeType: "added" },
    { path: "docs/api.md", changeType: "deleted" },
    { path: "config/settings.yml", changeType: "modified" },
  ],
  b08: [
    { path: "web/src/app.tsx", changeType: "modified" },
    { path: "web/src/tests/render.test.tsx", changeType: "added" },
    { path: "web/README.md", changeType: "modified" },
    { path: "web/vite.config.ts", changeType: "modified" },
    { path: "assets/font.woff2", changeType: "added" },
  ],
  b09: [
    { path: "core/engine.ts", changeType: "modified" },
    { path: "docs/design.md", changeType: "added" },
    { path: "config/defaults.yaml", changeType: "modified" },
    { path: "tools/seed.sql", changeType: "added" },
  ],
  b10: [
    { path: "src/cli.ts", changeType: "modified" },
    { path: "src/cli.test.ts", changeType: "modified" },
    { path: "CHANGELOG.md", changeType: "modified" },
    { path: "pnpm-lock.yaml", changeType: "modified" },
    { path: "banner.txt", changeType: "added" },
  ],
  b11: [
    { path: "pkg/parser.go", changeType: "modified" },
    { path: "pkg/parser_test.go", changeType: "added" },
    { path: "docs/parser.md", changeType: "added" },
    { path: ".golangci.yml", changeType: "modified" },
  ],
  b12: [
    { path: "api/routes.py", changeType: "modified" },
    { path: "tests/test_routes.py", changeType: "modified" },
    { path: "README.md", changeType: "modified" },
    { path: "requirements.toml", changeType: "added" },
    { path: "sample.json", changeType: "deleted" },
  ],
  b13: [
    { path: "src/store.ts", changeType: "modified" },
    { path: "src/store.test.mjs", changeType: "added" },
    { path: "config/store.json", changeType: "modified" },
  ],
  b14: [
    { path: "lib/http.ts", changeType: "modified" },
    { path: "docs/http.md", changeType: "modified" },
    { path: "lib/native.node", changeType: "added" },
    { path: "config/http.yaml", changeType: "deleted" },
  ],
  b15: [
    { path: "src/graph.ts", changeType: "added" },
    { path: "src/graph.test.ts", changeType: "added" },
    { path: "docs/graph.md", changeType: "added" },
    { path: "config/graph.yaml", changeType: "added" },
    { path: "graph.dump", changeType: "added" },
  ],
  b16: [
    { path: "src/text.ts", changeType: "modified" },
    { path: "docs/text.md", changeType: "modified" },
    { path: "package.json", changeType: "modified" },
  ],
  b17: [
    { path: "src/a.ts", changeType: "modified" },
    { path: "src/b.ts", changeType: "modified" },
    { path: "src/tests/helper.ts", changeType: "added" },
    { path: "docs/a-and-b.md", changeType: "added" },
    { path: "config/a.json", changeType: "deleted" },
  ],
  b18: [
    { path: "ui/view.jsx", changeType: "modified" },
    { path: "ui/__tests__/view.test.jsx", changeType: "added" },
    { path: "ui/style.css", changeType: "modified" },
    { path: "ui/theme.json", changeType: "modified" },
  ],
  b19: [
    { path: "srv/main.ts", changeType: "modified" },
    { path: "srv/main.test.mjs", changeType: "modified" },
    { path: "docs/deploy.md", changeType: "added" },
    { path: "deploy.env", changeType: "added" },
  ],
  b20: [
    { path: "src/one.ts", changeType: "added" },
    { path: "src/two.ts", changeType: "deleted" },
    { path: "docs/migration.md", changeType: "modified" },
    { path: "config/two.json", changeType: "deleted" },
  ],
  b21: [
    { path: "db/schema.ts", changeType: "modified" },
    { path: "db/schema.test.ts", changeType: "added" },
    { path: "docs/schema.md", changeType: "modified" },
    { path: "config/schema.prisma", changeType: "modified" },
    { path: "dump.sqlite", changeType: "added" },
  ],
  b22: [
    { path: "net/client.ts", changeType: "modified" },
    { path: "docs/net.md", changeType: "deleted" },
    { path: "config/net.toml", changeType: "modified" },
  ],
  b23: [
    { path: "core/a.mjs", changeType: "modified" },
    { path: "core/a.test.mjs", changeType: "modified" },
    { path: "core/b.cjs", changeType: "added" },
    { path: "README.md", changeType: "modified" },
  ],
  b24: [
    { path: "x/y/z.ts", changeType: "added" },
    { path: "x/tests/z.test.ts", changeType: "added" },
    { path: "x/y/notes.md", changeType: "modified" },
    { path: "x/y/z.json", changeType: "modified" },
    { path: "x/y/z.map", changeType: "added" },
  ],
  b25: [
    { path: "audit/log.ts", changeType: "modified" },
    { path: "audit/log.test.ts", changeType: "added" },
    { path: "audit/policy.yaml", changeType: "modified" },
  ],
  b26: [
    { path: "fin/calc.ts", changeType: "modified" },
    { path: "fin/docs.md", changeType: "added" },
    { path: "fin/rates.json", changeType: "modified" },
    { path: "fin/data.bin", changeType: "added" },
  ],
  b27: [
    { path: "gen/seed.ts", changeType: "added" },
    { path: "gen/seed.test.mjs", changeType: "added" },
    { path: "docs/gen.md", changeType: "modified" },
    { path: "config/gen.yml", changeType: "modified" },
    { path: "gen/out.lock", changeType: "added" },
  ],
  b28: [
    { path: "io/reader.ts", changeType: "modified" },
    { path: "io/writer.ts", changeType: "modified" },
    { path: "io/reader.test.ts", changeType: "deleted" },
  ],
  b29: [
    { path: "ml/train.py", changeType: "modified" },
    { path: "tests/train_test.py", changeType: "added" },
    { path: "docs/ml.md", changeType: "added" },
    { path: "config/model.yaml", changeType: "modified" },
    { path: "weights.pt", changeType: "added" },
  ],
  b30: [
    { path: "shell/run.ts", changeType: "added" },
    { path: "docs/run.md", changeType: "modified" },
    { path: "config/run.json", changeType: "added" },
  ],
  b31: [
    { path: "kv/store.ts", changeType: "modified" },
    { path: "kv/store.test.tsx", changeType: "added" },
    { path: "kv/README.md", changeType: "modified" },
    { path: "kv/store.config.yml", changeType: "modified" },
  ],
  b32: [
    { path: "log/tail.ts", changeType: "modified" },
    { path: "log/tail.test.mjs", changeType: "modified" },
    { path: "docs/tail.md", changeType: "deleted" },
    { path: "log/format.yaml", changeType: "modified" },
    { path: "log/sample.log", changeType: "added" },
  ],
  b33: [
    { path: "src/alpha.ts", changeType: "modified" },
    { path: "src/alpha.test.ts", changeType: "added" },
    { path: "docs/alpha.md", changeType: "modified" },
    { path: "alpha.config.json", changeType: "added" },
    { path: "alpha.lock", changeType: "added" },
  ],
  b34: [
    { path: "src/beta.ts", changeType: "modified" },
    { path: "src/beta.spec.mjs", changeType: "added" },
    { path: "docs/beta.md", changeType: "added" },
    { path: "beta.settings.toml", changeType: "modified" },
  ],
  b35: [
    { path: "src/gamma.ts", changeType: "modified" },
    { path: "src/gamma.test.ts", changeType: "modified" },
    { path: "docs/gamma.md", changeType: "modified" },
    { path: "config/gamma.yaml", changeType: "added" },
    { path: "gamma.bin", changeType: "added" },
  ],
  b36: [
    { path: "src/delta.ts", changeType: "added" },
    { path: "src/delta.test.ts", changeType: "added" },
    { path: "docs/delta.md", changeType: "modified" },
    { path: "delta.config.yml", changeType: "modified" },
  ],
};

// ---- 期望输出：依据能力规范独立计算 ----

/** stats 规范：bytes=UTF-8 字节；lines 按 \n 计（结尾换行不计）；words 按空白切分；headings 为 # 开头行 */
function computeStats(bundleName, files) {
  const out = files.map(([name, content]) => ({
    path: `${bundleName}/${name}`,
    bytes: Buffer.byteLength(content, "utf8"),
    lines: content.length === 0 ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0),
    words: content.split(/\s+/).filter((w) => w.length > 0).length,
    headings: content.split("\n").filter((l) => l.startsWith("#")).length,
  }));
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const totals = out.reduce(
    (acc, f) => ({
      files: acc.files + 1,
      bytes: acc.bytes + f.bytes,
      lines: acc.lines + f.lines,
      words: acc.words + f.words,
      headings: acc.headings + f.headings,
    }),
    { files: 0, bytes: 0, lines: 0, words: 0, headings: 0 },
  );
  return { files: out, totals };
}

/** changed-file-summary 规范判定顺序：test → source → docs → config → other */
function categoryOf(path) {
  if (/\.test\.[cm]?js$/.test(path) || path.includes("/tests/") || path.includes("/__tests__/")) {
    return "test";
  }
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return "source";
  if (path.endsWith(".md")) return "docs";
  if (/\.(json|ya?ml|toml)$/.test(path)) return "config";
  return "other";
}

function computeSummary(changes) {
  // 规范：classifyChanges 按 changes 输入顺序返回 files（不重排）
  const files = changes.map((c) => ({ path: c.path, category: categoryOf(c.path) }));
  return { summary: { total: files.length, files } };
}

// ---- 落盘 ----

const DEV = join(ROOT, "dev");
rmSync(DEV, { recursive: true, force: true });
for (const sub of ["bundles", "changed-files", "expected", "schemas"]) {
  mkdirSync(join(DEV, sub), { recursive: true });
}

// bundle 名：非 contrast 按顺序 b01..b32；contrast 共享 b33..b36
let seq = 0;
const bundleOf = new Map();
for (const def of definitions) {
  if (def.bundle) continue;
  seq += 1;
  const name = `b${String(seq).padStart(2, "0")}`;
  bundleOf.set(def.id, name);
}
for (const def of definitions) {
  if (def.bundle) bundleOf.set(def.id, def.bundle);
}

// 文本文件命名与 bundle 解绑（file-a / file-b）；变更清单在各 bundle 子目录下
// 固定命名为 changed-files.json——经 prepareWorkspace 复制后位于 inputs/changed-files.json（§3.1）
const fileNames = ["file-a.md", "file-b.txt"];
for (const [bundle, texts] of Object.entries(bundleTexts)) {
  const dir = join(DEV, "bundles", bundle);
  mkdirSync(dir, { recursive: true });
  texts.forEach((content, i) => {
    writeFileSync(join(dir, fileNames[i] ?? `file-${i}.txt`), content, "utf8");
  });
  mkdirSync(join(DEV, "changed-files", bundle), { recursive: true });
  writeFileSync(
    join(DEV, "changed-files", bundle, "changed-files.json"),
    `${JSON.stringify({ changes: bundleChanges[bundle] }, null, 2)}\n`,
    "utf8",
  );
}

// schema 复制自既有受信 fixture（与 M0/M2 验收同源）
const statsSchema = readFileSync(
  join(ROOT, "..", "stats", "schemas", "stats-summary.schema.json"),
  "utf8",
);
const summarySchema = readFileSync(
  join(ROOT, "..", "m2", "schemas", "changed-file-summary.schema.json"),
  "utf8",
);
writeFileSync(join(DEV, "schemas", "stats-summary.schema.json"), statsSchema, "utf8");
writeFileSync(join(DEV, "schemas", "changed-file-summary.schema.json"), summarySchema, "utf8");

// cases.json + 期望输出
const cases = definitions.map((def) => {
  const bundle = bundleOf.get(def.id);
  const texts = bundleTexts[bundle].map((content, i) => [fileNames[i] ?? `file-${i}.txt`, content]);
  let acceptance;
  if (def.expect === "abstain") {
    acceptance = { outputSchema: "schemas/stats-summary.schema.json", expectedOutput: null };
  } else if (def.expect === "local-process") {
    acceptance = {
      outputSchema: "schemas/stats-summary.schema.json",
      expectedOutput: `expected/${def.id}.json`,
    };
    writeFileSync(
      join(DEV, "expected", `${def.id}.json`),
      `${JSON.stringify(computeStats(bundle, texts), null, 2)}\n`,
      "utf8",
    );
  } else {
    acceptance = {
      outputSchema: "schemas/changed-file-summary.schema.json",
      expectedOutput: `expected/${def.id}.json`,
    };
    writeFileSync(
      join(DEV, "expected", `${def.id}.json`),
      `${JSON.stringify(computeSummary(bundleChanges[bundle]), null, 2)}\n`,
      "utf8",
    );
  }
  return {
    caseId: def.id,
    familyId: def.stratum === "contrast" ? `family-${def.bundle}` : `family-${def.id}`,
    stratum: def.stratum,
    language: def.lang,
    goal: def.goal,
    textDir: `bundles/${bundle}`,
    changedFiles: `changed-files/${bundle}/changed-files.json`,
    expectedChoice: def.expect,
    pairedCaseId: def.pair ?? null,
    acceptance,
  };
});

writeFileSync(
  join(DEV, "cases.json"),
  `${JSON.stringify(
    {
      protocol: "organism-decision-v1",
      split: "dev",
      datasetPurpose: "development",
      cases,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

// 管道测试数据（E3 全数量 fake 演练）：由开发 fixture 派生，family 与内容相同，
// 仅 datasetPurpose 标记不同——不与独立验证结果混合（实验规范 §10）
mkdirSync(join(ROOT, "plumbing"), { recursive: true });
const plumbingCases = cases.map((c) => ({
  ...c,
  textDir: `../dev/${c.textDir}`,
  changedFiles: `../dev/${c.changedFiles}`,
  acceptance: {
    outputSchema: `../dev/${c.acceptance.outputSchema}`,
    expectedOutput: c.acceptance.expectedOutput ? `../dev/${c.acceptance.expectedOutput}` : null,
  },
}));
writeFileSync(
  join(ROOT, "plumbing", "cases.json"),
  `${JSON.stringify(
    {
      protocol: "organism-decision-v1",
      split: "plumbing",
      datasetPurpose: "plumbing-test",
      cases: plumbingCases,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

// capability 模块 JSON：包装受信 fixture 实现（受信执行实现，M2 验收同源）
const impl = readFileSync(join(ROOT, "..", "m2", "capability", "changed-file-summary.mjs"), "utf8");
mkdirSync(join(ROOT, "capability"), { recursive: true });
writeFileSync(
  join(ROOT, "capability", "changed-file-summary.module.json"),
  `${JSON.stringify(
    {
      kind: "capability-module-v1",
      name: "changed-file-summary",
      entry: "index.mjs",
      files: [{ path: "index.mjs", content: impl }],
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(
  `开发数据集已生成：${definitions.length} 个 case、${Object.keys(bundleTexts).length} 个 bundle`,
);
