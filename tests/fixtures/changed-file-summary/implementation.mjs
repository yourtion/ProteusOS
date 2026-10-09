import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * ChangedFileSummary 能力实现（测试基准实现：fake builder 的标准产出、
 * 真实 agent 按同一规范生成；collectCandidate 从工作区采集的就是这类文件）。
 * 合同：导出 classifyChanges(changes)（测试入口）；
 * 作为主模块运行时读 inputs/changed-files.json 写 output.json（执行入口）。
 */
export function classifyChanges(changes) {
  const files = changes.map((change) => ({
    path: change.path,
    category: categoryOf(change.path),
  }));
  return { total: files.length, files };
}

function categoryOf(path) {
  if (/\.test\.[cm]?js$/.test(path) || path.includes("/tests/") || path.includes("/__tests__/")) {
    return "test";
  }
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return "source";
  if (path.endsWith(".md")) return "docs";
  if (/\.(json|ya?ml|toml)$/.test(path)) return "config";
  return "other";
}

// realpath 消除符号链接差异（如 macOS /var → /private/var），否则 argv 与 import.meta.url 不等
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isMain) {
  const input = JSON.parse(
    readFileSync(join(process.cwd(), "inputs", "changed-files.json"), "utf8"),
  );
  writeFileSync(
    join(process.cwd(), "output.json"),
    JSON.stringify({ summary: classifyChanges(input.changes) }, null, 2),
  );
}
