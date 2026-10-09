import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ChangedFileSummary 能力验收测试（builder Run 的裁判命令执行）。
 * 位于 inputs/capability-tests/，被测实现在工作区 src/changed-file-summary.mjs
 * （相对本文件 ../../）。测试失败则 builder Run failed，不能构造候选。
 */
import { classifyChanges } from "../../src/changed-file-summary.mjs";

test("按扩展名与路径特征分类变更文件", () => {
  const result = classifyChanges([
    { path: "src/index.ts", changeType: "modified" },
    { path: "src/wordcount.test.mjs", changeType: "added" },
    { path: "docs/guide.md", changeType: "modified" },
    { path: "package.json", changeType: "modified" },
    { path: "LICENSE", changeType: "added" },
  ]);
  assert.equal(result.total, 5);
  assert.deepEqual(Object.fromEntries(result.files.map((f) => [f.path, f.category])), {
    "src/index.ts": "source",
    "src/wordcount.test.mjs": "test",
    "docs/guide.md": "docs",
    "package.json": "config",
    LICENSE: "other",
  });
});

test("空变更清单返回 total=0", () => {
  const result = classifyChanges([]);
  assert.equal(result.total, 0);
  assert.deepEqual(result.files, []);
});

test("分类值限定为固定枚举", () => {
  const result = classifyChanges([{ path: "a/b/c.yaml", changeType: "added" }]);
  assert.ok(["source", "test", "docs", "config", "other"].includes(result.files[0].category));
});

test("独立进程执行合同：作为主模块运行，读 inputs/changed-files.json 写 output.json", () => {
  const impl = realpathSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "changed-file-summary.mjs"),
  );
  const dir = mkdtempSync(join(tmpdir(), "cfs-contract-"));
  mkdirSync(join(dir, "inputs"), { recursive: true });
  writeFileSync(
    join(dir, "inputs", "changed-files.json"),
    JSON.stringify({ changes: [{ path: "a.ts" }, { path: "b.md" }] }),
    "utf8",
  );
  const run = spawnSync(process.execPath, [impl], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(run.status, 0, `作为主模块执行失败：${run.stderr ?? ""}`);
  const output = JSON.parse(readFileSync(join(dir, "output.json"), "utf8"));
  assert.equal(output.summary.total, 2);
  assert.deepEqual(Object.fromEntries(output.summary.files.map((f) => [f.path, f.category])), {
    "a.ts": "source",
    "b.md": "docs",
  });
});
