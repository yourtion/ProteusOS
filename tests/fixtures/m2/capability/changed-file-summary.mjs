import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ChangedFileSummary 能力实现（测试基准实现：fake builder 的标准产出、
 * 真实 agent 按同一规范生成；collectCandidate 从工作区采集的就是这类文件）。
 * 执行合同：cwd=工作区，读 inputs/changed-files.json，写 output.json。
 */
const input = JSON.parse(readFileSync(join(process.cwd(), "inputs", "changed-files.json"), "utf8"));

function categoryOf(path) {
  if (/\.test\.[cm]?js$/.test(path) || path.includes("/tests/") || path.includes("/__tests__/")) {
    return "test";
  }
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return "source";
  if (/\.md$/.test(path)) return "docs";
  if (/\.(json|ya?ml|toml)$/.test(path)) return "config";
  return "other";
}

const files = input.changes.map((change) => ({
  path: change.path,
  category: categoryOf(change.path),
}));

writeFileSync(
  join(process.cwd(), "output.json"),
  JSON.stringify({ summary: { total: files.length, files } }, null, 2),
);
