#!/usr/bin/env node
/**
 * stats-worker：受信本地 worker（M0 seed 配套）。
 * 用法：node stats-worker.mjs <workspaceDir>
 * 读取 <workspaceDir>/inputs/ 下递归的 .txt/.md 文件，写 <workspaceDir>/output.json。
 * 输出确定性：files 按路径排序。
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const workspaceDir = process.argv[2];
if (!workspaceDir) {
  console.error("用法：node stats-worker.mjs <workspaceDir>");
  process.exit(2);
}

try {
  const inputsRoot = join(workspaceDir, "inputs");
  const files = [];
  collect(inputsRoot, inputsRoot, files);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const totals = { files: files.length, bytes: 0, lines: 0, words: 0, headings: 0 };
  for (const f of files) {
    totals.bytes += f.bytes;
    totals.lines += f.lines;
    totals.words += f.words;
    totals.headings += f.headings;
  }

  const output = { files, totals };
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, "output.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.exit(0);
} catch (err) {
  console.error(`[stats-worker] ${String(err)}`);
  process.exit(1);
}

function collect(root, dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // 无 inputs 目录：产出空结果由验收处理
  }
  for (const name of entries.sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      collect(root, full, out);
    } else if (name.endsWith(".txt") || name.endsWith(".md")) {
      const content = readFileSync(full, "utf8");
      const lines = content.split("\n");
      out.push({
        path: relative(root, full),
        bytes: Buffer.byteLength(content, "utf8"),
        lines: content.length === 0 ? 0 : lines.length - (content.endsWith("\n") ? 1 : 0),
        words: content.split(/\s+/).filter((w) => w.length > 0).length,
        headings: lines.filter((l) => l.startsWith("#")).length,
      });
    }
  }
}
