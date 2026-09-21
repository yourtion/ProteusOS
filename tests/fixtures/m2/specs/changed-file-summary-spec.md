# 能力实现规范：changed-file-summary（CHANGED-FILE-SUMMARY）

在当前工作区实现 `src/changed-file-summary.mjs`。

## 合同

- 导出 `classifyChanges(changes)`：`changes` 为 `[{ path, changeType }]` 数组，返回 `{ total, files: [{ path, category }] }`。
- `category` 取值与判定顺序：
  - `test`：路径匹配 `*.test.[cm]?js`，或含 `/tests/`、`/__tests__/` 段
  - `source`：扩展名 `.ts/.tsx/.js/.jsx/.mjs/.cjs`
  - `docs`：扩展名 `.md`
  - `config`：扩展名 `.json/.yaml/.yml/.toml`
  - `other`：以上皆否
- 作为主模块运行时（被独立进程执行，cwd=工作区）：读 `inputs/changed-files.json` 的 `changes` 字段，把 `{ summary: classifyChanges(changes) }` 写到 `output.json`。
- 只允许写当前工作区内文件；不得读写工作区之外的任何位置。

## 验收

`inputs/capability-tests/changed-file-summary.test.mjs`（node:test）必须全部通过；测试失败即构建失败。
